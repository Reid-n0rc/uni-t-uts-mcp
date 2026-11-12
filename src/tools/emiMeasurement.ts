import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/research/emi-function.md section 3.1, 3.3, 3.4 (EMI chapter, programming manual
// pp.94-141). Behavior not yet verified live (EMI-12, #187, needs the owner present): field names,
// ranges and the detector-exclusivity rule come from the programming manual via the research
// document. The manual says quasi-peak, EMI average and average are mutually exclusive and at most
// two can be selected together (UM p.15), and that the instrument may adjust a detector silently;
// this tool re-reads everything it touched and reports any such adjustment as a warning.

const FINAL_DETECTOR_COUNT = 3;
const TRACE_DETECTOR_COUNT = 3; // EMI has 3 traces, not the SA module's 6.
const METER_DETECTOR_COUNT = 3;

function upper(reply: string): string {
  return reply.trim().toUpperCase();
}

function parseEnum<T extends string>(reply: string, choices: Record<string, T>, command: string): T {
  const text = upper(reply);
  for (const [prefix, value] of Object.entries(choices)) {
    if (text === prefix || text.startsWith(prefix)) return value;
  }
  throw new Error(`Unexpected reply to ${command}: ${JSON.stringify(reply)}`);
}

const STANDARDS = { none: "NONE", cispr: "CISP" } as const;
const SEQUENCES = {
  scan: "SCAN",
  search: "SEAR",
  scan_search_measure: "SSAM",
  scan_search: "SASE",
  search_measure: "SAME",
  measure: "REME",
} as const;
const REMEASURES = { current: "CURR", all: "ALL", marked: "MARK" } as const;
const SEARCH_MODES = { peak_only: "PONL", peak_and_limit: "PLIM", segment_and_limit: "SLIM" } as const;
const AVERAGE_TYPES = { voltage: "VOLT", power: "POWE", log: "LOG" } as const;
const DETECTORS = { positive: "POS", quasi_peak: "QPE", average_continuous: "CAV", average: "AVER", negative: "NEG" } as const;

const STANDARD_READ = { NONE: "none", CISP: "cispr" } as const;
const SEQUENCE_READ = {
  SCAN: "scan",
  SEAR: "search",
  SSAM: "scan_search_measure",
  SASE: "scan_search",
  SAME: "search_measure",
  REME: "measure",
} as const;
const REMEASURE_READ = { CURR: "current", ALL: "all", MARK: "marked" } as const;
const SEARCH_MODE_READ = { PONL: "peak_only", PLIM: "peak_and_limit", SLIM: "segment_and_limit" } as const;
const AVERAGE_TYPE_READ = { VOLT: "voltage", POWE: "power", LOG: "log" } as const;
const DETECTOR_READ = { POSI: "positive", QPE: "quasi_peak", CAV: "average_continuous", AVER: "average", NEG: "negative" } as const;

type Standard = (typeof STANDARD_READ)[keyof typeof STANDARD_READ];
type Sequence = (typeof SEQUENCE_READ)[keyof typeof SEQUENCE_READ];
type Remeasure = (typeof REMEASURE_READ)[keyof typeof REMEASURE_READ];
type SearchMode = (typeof SEARCH_MODE_READ)[keyof typeof SEARCH_MODE_READ];
type AverageType = (typeof AVERAGE_TYPE_READ)[keyof typeof AVERAGE_TYPE_READ];
type Detector = (typeof DETECTOR_READ)[keyof typeof DETECTOR_READ];

const DETECTOR_ENUM = z.enum(["positive", "quasi_peak", "average_continuous", "average", "negative"]);

const FINAL_DETECTOR = z.object({
  index: z.number().int().min(1).max(FINAL_DETECTOR_COUNT).describe(`Final-measurement detector index, 1 to ${FINAL_DETECTOR_COUNT}`),
  detector: DETECTOR_ENUM.optional().describe("Detector type for this final-measurement slot"),
  dwell_s: z.number().finite().min(1e-3).max(60).optional().describe("Dwell time in seconds, 0.001 to 60"),
  limit_line: z.number().int().min(1).max(6).optional().describe("Limit line (1-6) whose difference this detector's column reports"),
});
type FinalDetectorEdit = z.infer<typeof FINAL_DETECTOR>;

const SET_SHAPE = {
  standard: z.enum(["none", "cispr"]).optional().describe("NONE allows 1-3-10 RBW steps 1 kHz-3 MHz; CISPr fixes RBW to 200 Hz/9 kHz/120 kHz/1 MHz and filter type to EMI (6 dB)"),
  sequence: z
    .enum(["scan", "search", "scan_search_measure", "scan_search", "search_measure", "measure"])
    .optional()
    .describe("Sweep sequence: scan only, search only, scan+search+measure, scan+search, search+measure, measure only"),
  remeasure: z.enum(["current", "all", "marked"]).optional().describe("What the measure step covers"),
  trace_detectors: z
    .array(z.object({ index: z.number().int().min(1).max(TRACE_DETECTOR_COUNT), detector: DETECTOR_ENUM }))
    .optional()
    .describe(`Per-trace detector (trace index 1 to ${TRACE_DETECTOR_COUNT})`),
  meter_detectors: z
    .array(z.object({ index: z.number().int().min(1).max(METER_DETECTOR_COUNT), detector: DETECTOR_ENUM }))
    .optional()
    .describe(`Per-meter detector (meter index 1 to ${METER_DETECTOR_COUNT})`),
  meter_dwell_s: z.number().finite().min(1e-3).max(100).optional().describe("Meter detector dwell time in seconds, 0.001 to 100 (one value for all meters)"),
  final_detectors: z.array(FINAL_DETECTOR).optional().describe("Final-measurement detector edits"),
  average_count: z.number().int().min(1).max(999).optional().describe("Average count, 1 to 999"),
  average_type: z.enum(["voltage", "power", "log"]).optional().describe("Averaging type"),
  search_mode: z.enum(["peak_only", "peak_and_limit", "segment_and_limit"]).optional().describe("Peak-search mode for the signal table"),
  peak_count: z.number().int().min(1).max(50).optional().describe("Search peak count, 1 to 50"),
  segment_count: z.number().int().min(1).max(50).optional().describe("Search segment count, 1 to 50"),
};
type SetArgs = {
  standard?: "none" | "cispr";
  sequence?: Sequence;
  remeasure?: Remeasure;
  trace_detectors?: Array<{ index: number; detector: Detector }>;
  meter_detectors?: Array<{ index: number; detector: Detector }>;
  meter_dwell_s?: number;
  final_detectors?: FinalDetectorEdit[];
  average_count?: number;
  average_type?: AverageType;
  search_mode?: SearchMode;
  peak_count?: number;
  segment_count?: number;
};

export function validateSet(a: SetArgs): string | undefined {
  const anyField =
    a.standard !== undefined ||
    a.sequence !== undefined ||
    a.remeasure !== undefined ||
    (a.trace_detectors?.length ?? 0) > 0 ||
    (a.meter_detectors?.length ?? 0) > 0 ||
    a.meter_dwell_s !== undefined ||
    (a.final_detectors?.length ?? 0) > 0 ||
    a.average_count !== undefined ||
    a.average_type !== undefined ||
    a.search_mode !== undefined ||
    a.peak_count !== undefined ||
    a.segment_count !== undefined;
  if (!anyField) return "No parameters given.";

  // Detector exclusivity (UM p.15): at most two of quasi_peak/average_continuous/average among the
  // detectors requested in a single call (checked per group, since each group is an independent set
  // of physical detectors; a cross-group check would reject legitimate independent choices).
  const exclusiveGroup = new Set(["quasi_peak", "average_continuous", "average"]);
  const checkExclusivity = (detectors: Detector[] | undefined, label: string): string | undefined => {
    if (!detectors) return undefined;
    const exclusiveChosen = new Set(detectors.filter((d) => exclusiveGroup.has(d)));
    if (exclusiveChosen.size > 2) {
      return `${label}: at most two of quasi_peak, average_continuous, average may be selected together (requested ${[...exclusiveChosen].join(", ")}).`;
    }
    return undefined;
  };
  const traceErr = checkExclusivity(a.trace_detectors?.map((d) => d.detector), "trace_detectors");
  if (traceErr) return traceErr;
  const meterErr = checkExclusivity(a.meter_detectors?.map((d) => d.detector), "meter_detectors");
  if (meterErr) return meterErr;
  const finalErr = checkExclusivity(
    a.final_detectors?.filter((d): d is FinalDetectorEdit & { detector: Detector } => d.detector !== undefined).map((d) => d.detector),
    "final_detectors"
  );
  if (finalErr) return finalErr;

  const seen = new Set<number>();
  for (const d of a.trace_detectors ?? []) {
    if (seen.has(d.index)) return `trace_detectors: index ${d.index} appears more than once.`;
    seen.add(d.index);
  }
  seen.clear();
  for (const d of a.meter_detectors ?? []) {
    if (seen.has(d.index)) return `meter_detectors: index ${d.index} appears more than once.`;
    seen.add(d.index);
  }
  seen.clear();
  for (const d of a.final_detectors ?? []) {
    if (seen.has(d.index)) return `final_detectors: index ${d.index} appears more than once.`;
    seen.add(d.index);
    const given = d.detector !== undefined || d.dwell_s !== undefined || d.limit_line !== undefined;
    if (!given) return `final_detectors entry for index ${d.index} has no fields to change.`;
  }
  return undefined;
}

function buildCommands(a: SetArgs): string[] {
  const commands: string[] = [];
  // Standard first: it changes the legal RBW set for the scan table (manual p.128), so any later
  // reliance on RBW validity benefits from the standard already being in effect.
  if (a.standard !== undefined) commands.push(`:SENSe:EMC:STANdard:SELect ${STANDARDS[a.standard]}`);
  if (a.sequence !== undefined) commands.push(`:SENSe:FSCan:SEQuence ${SEQUENCES[a.sequence]}`);
  if (a.remeasure !== undefined) commands.push(`:SENSe:FSCan:SEQuence:REMeasure ${REMEASURES[a.remeasure]}`);
  for (const d of a.trace_detectors ?? []) commands.push(`:SENSe:FSCan:DETector:TRACe${d.index} ${DETECTORS[d.detector]}`);
  for (const d of a.meter_detectors ?? []) commands.push(`:SENSe:METer${d.index}:DETector ${DETECTORS[d.detector]}`);
  if (a.meter_dwell_s !== undefined) commands.push(`:SENSe:METer:DETector:DWELl ${formatNumber(a.meter_dwell_s)}`);
  for (const d of a.final_detectors ?? []) {
    if (d.detector !== undefined) commands.push(`:SENSe:FSCan:FINal:DETector${d.index} ${DETECTORS[d.detector]}`);
    if (d.dwell_s !== undefined) commands.push(`:SENSe:FSCan:FINal:DETector${d.index}:DWELl ${formatNumber(d.dwell_s)}`);
    if (d.limit_line !== undefined) commands.push(`:SENSe:FSCan:FINal:DETector${d.index}:LDELta ${d.limit_line}`);
  }
  if (a.average_count !== undefined) commands.push(`:SENSe:AVERage:COUNt ${a.average_count}`);
  if (a.average_type !== undefined) commands.push(`:SENSe:AVERage:TYPE ${AVERAGE_TYPES[a.average_type]}`);
  if (a.search_mode !== undefined) commands.push(`:SENSe:FSCan:SEARch:MODE ${SEARCH_MODES[a.search_mode]}`);
  if (a.peak_count !== undefined) commands.push(`:SENSe:FSCan:SEARch:PEAK:COUNt ${a.peak_count}`);
  if (a.segment_count !== undefined) commands.push(`:SENSe:FSCan:SEARch:SUBRange:COUNt ${a.segment_count}`);
  return commands;
}

async function readState(a: SetArgs) {
  const result: Record<string, unknown> = {};
  if (a.standard !== undefined) {
    result.standard = await queryParsed(":SENSe:EMC:STANdard:SELect?", (r) => parseEnum(r, STANDARD_READ, ":SENSe:EMC:STANdard:SELect?"));
  }
  if (a.sequence !== undefined) {
    result.sequence = await queryParsed(":SENSe:FSCan:SEQuence?", (r) => parseEnum(r, SEQUENCE_READ, ":SENSe:FSCan:SEQuence?"));
  }
  if (a.remeasure !== undefined) {
    result.remeasure = await queryParsed(":SENSe:FSCan:SEQuence:REMeasure?", (r) => parseEnum(r, REMEASURE_READ, ":SENSe:FSCan:SEQuence:REMeasure?"));
  }
  if (a.trace_detectors?.length) {
    const read: Record<number, Detector> = {};
    for (const d of a.trace_detectors) {
      read[d.index] = await queryParsed(`:SENSe:FSCan:DETector:TRACe${d.index}?`, (r) =>
        parseEnum(r, DETECTOR_READ, `:SENSe:FSCan:DETector:TRACe${d.index}?`)
      );
    }
    result.trace_detectors = read;
  }
  if (a.meter_detectors?.length) {
    const read: Record<number, Detector> = {};
    for (const d of a.meter_detectors) {
      read[d.index] = await queryParsed(`:SENSe:METer${d.index}:DETector?`, (r) =>
        parseEnum(r, DETECTOR_READ, `:SENSe:METer${d.index}:DETector?`)
      );
    }
    result.meter_detectors = read;
  }
  if (a.meter_dwell_s !== undefined) result.meter_dwell_s = await queryNumber(":SENSe:METer:DETector:DWELl?");
  if (a.final_detectors?.length) {
    const read: Record<number, { detector: Detector; dwell_s: number; limit_line: number }> = {};
    for (const d of a.final_detectors) {
      read[d.index] = {
        detector: await queryParsed(`:SENSe:FSCan:FINal:DETector${d.index}?`, (r) =>
          parseEnum(r, DETECTOR_READ, `:SENSe:FSCan:FINal:DETector${d.index}?`)
        ),
        dwell_s: await queryNumber(`:SENSe:FSCan:FINal:DETector${d.index}:DWELl?`),
        limit_line: await queryNumber(`:SENSe:FSCan:FINal:DETector${d.index}:LDELta?`),
      };
    }
    result.final_detectors = read;
  }
  if (a.average_count !== undefined) result.average_count = await queryNumber(":SENSe:AVERage:COUNt?");
  if (a.average_type !== undefined) {
    result.average_type = await queryParsed(":SENSe:AVERage:TYPE?", (r) => parseEnum(r, AVERAGE_TYPE_READ, ":SENSe:AVERage:TYPE?"));
  }
  if (a.search_mode !== undefined) {
    result.search_mode = await queryParsed(":SENSe:FSCan:SEARch:MODE?", (r) => parseEnum(r, SEARCH_MODE_READ, ":SENSe:FSCan:SEARch:MODE?"));
  }
  if (a.peak_count !== undefined) result.peak_count = await queryNumber(":SENSe:FSCan:SEARch:PEAK:COUNt?");
  if (a.segment_count !== undefined) result.segment_count = await queryNumber(":SENSe:FSCan:SEARch:SUBRange:COUNt?");
  return result;
}

function warnDifferences(a: SetArgs, actual: Record<string, unknown>, warnings: string[]): void {
  const simple = (key: keyof SetArgs, label: string) => {
    const want = a[key];
    if (want === undefined) return;
    const got = actual[label];
    if (got !== want) warnings.push(`${label} adjusted by the instrument: requested ${JSON.stringify(want)}, now ${JSON.stringify(got)}`);
  };
  simple("standard", "standard");
  simple("sequence", "sequence");
  simple("remeasure", "remeasure");
  simple("meter_dwell_s", "meter_dwell_s");
  simple("average_count", "average_count");
  simple("average_type", "average_type");
  simple("search_mode", "search_mode");
  simple("peak_count", "peak_count");
  simple("segment_count", "segment_count");

  for (const d of a.trace_detectors ?? []) {
    const got = (actual.trace_detectors as Record<number, Detector> | undefined)?.[d.index];
    if (got !== d.detector) warnings.push(`trace_detectors[${d.index}] adjusted by the instrument: requested ${d.detector}, now ${got}`);
  }
  for (const d of a.meter_detectors ?? []) {
    const got = (actual.meter_detectors as Record<number, Detector> | undefined)?.[d.index];
    if (got !== d.detector) warnings.push(`meter_detectors[${d.index}] adjusted by the instrument: requested ${d.detector}, now ${got}`);
  }
  for (const d of a.final_detectors ?? []) {
    const got = (actual.final_detectors as Record<number, { detector: Detector; dwell_s: number; limit_line: number }> | undefined)?.[
      d.index
    ];
    if (!got) continue;
    if (d.detector !== undefined && got.detector !== d.detector) {
      warnings.push(`final_detectors[${d.index}].detector adjusted by the instrument: requested ${d.detector}, now ${got.detector}`);
    }
    if (d.dwell_s !== undefined && got.dwell_s !== d.dwell_s) {
      warnings.push(`final_detectors[${d.index}].dwell_s adjusted by the instrument: requested ${d.dwell_s}, now ${got.dwell_s}`);
    }
    if (d.limit_line !== undefined && got.limit_line !== d.limit_line) {
      warnings.push(`final_detectors[${d.index}].limit_line adjusted by the instrument: requested ${d.limit_line}, now ${got.limit_line}`);
    }
  }
}

export function registerEmiMeasurementTools(server: McpServer): void {
  defineTool(
    server,
    "set_emi_measurement",
    "Configure the EMI module's measurement: standard (none/cispr), sweep sequence and re-measure mode, trace/meter/final " +
      "detectors, meter dwell time, averaging, and search mode/counts. EMI module must be active (select_instrument_module). " +
      "At most two of quasi_peak/average_continuous/average may be selected together per detector group (the manual documents " +
      "this as mutually exclusive). Everything requested is re-read afterwards and any instrument-adjusted value is reported " +
      "in 'warnings'. Leaves the new state (nothing is restored).",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        await applyCommands(buildCommands(args));
        const actual = await readBack(() => readState(args));
        const warnings: string[] = [];
        warnDifferences(args, actual, warnings);
        return textResult(JSON.stringify({ ...actual, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "set_emi_measurement");
      }
    },
    { validate: validateSet, requireModule: "emi" }
  );
}
