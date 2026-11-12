import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryBool, queryNumber, queryParsed } from "../instrument.js";
import { errorResult, textResult, defineTool } from "./util.js";

// Commands: docs/research/emi-function.md section 3 (EMI chapter, programming manual pp.94-141).
// Read-only snapshot of the EMI configuration, grouped so a caller can ask for only what it needs
// (the issue's own "group parameter so one call stays short"). `scan_table` is excluded from the
// default group set: it is 10 bands x ~8 queries each, by far the most expensive group, so a caller
// must opt in explicitly. None of this has been verified live (EMI-12, #187, needs the owner present);
// field names and ranges come from the programming manual via docs/research/emi-function.md.

export const EMI_SETTING_GROUPS = [
  "standard",
  "sequence",
  "scan_table",
  "meters",
  "detectors",
  "traces",
  "search",
  "frequency",
  "amplitude",
  "trigger",
] as const;
export type EmiSettingGroup = (typeof EMI_SETTING_GROUPS)[number];

const DEFAULT_GROUPS: readonly EmiSettingGroup[] = EMI_SETTING_GROUPS.filter((g) => g !== "scan_table");

const TRACE_COUNT = 3; // EMI has 3 traces, not the SA module's 6 (docs/research/emi-function.md 3.3).
const METER_COUNT = 3;
export const BAND_COUNT = 10;

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

const STANDARDS = { NONE: "none", CISP: "cispr" } as const;
const SEQUENCES = {
  SCAN: "scan",
  SEAR: "search",
  SSAM: "scan_search_measure",
  SASE: "scan_search",
  SAME: "search_measure",
  REME: "measure",
} as const;
const REMEASURES = { CURR: "current", ALL: "all", MARK: "marked" } as const;
const SEARCH_MODES = { PONL: "peak_only", PLIM: "peak_and_limit", SLIM: "segment_and_limit" } as const;
const TRIGGER_SOURCES = { IMM: "immediate", EXT: "external", VID: "video" } as const;
const AVERAGE_TYPES = { VOLT: "voltage", POWE: "power", LOG: "log" } as const;
const TRACE_TYPES = { WRIT: "write", AVER: "average", MAXH: "max_hold", MINH: "min_hold" } as const;
const DETECTORS = { POSI: "positive", QPE: "quasi_peak", CAV: "average_continuous", AVER: "average", NEG: "negative" } as const;
const PHOLD_TYPES = { ADJ: "adjustable", INF: "infinite" } as const;

async function readStandard() {
  const standard = await queryParsed(":SENSe:EMC:STANdard:SELect?", (r) => parseEnum(r, STANDARDS, ":SENSe:EMC:STANdard:SELect?"));
  return { standard };
}

async function readSequence() {
  const sequence = await queryParsed(":SENSe:FSCan:SEQuence?", (r) => parseEnum(r, SEQUENCES, ":SENSe:FSCan:SEQuence?"));
  const remeasure = await queryParsed(":SENSe:FSCan:SEQuence:REMeasure?", (r) =>
    parseEnum(r, REMEASURES, ":SENSe:FSCan:SEQuence:REMeasure?"));
  return { sequence, remeasure };
}

export interface Band {
  band: number;
  enabled: boolean;
  start_hz: number;
  stop_hz: number;
  rbw_hz: number;
  rbw_auto: boolean;
  time_s: number;
  time_auto: boolean;
  attenuation_db: number;
  attenuation_auto: boolean;
  points: number;
  preamp: boolean;
}

export async function readBand(n: number): Promise<Band> {
  const p = `:SENSe:FSCan:SCAN${n}`;
  return {
    band: n,
    enabled: await queryBool(`${p}:STATe?`),
    start_hz: await queryNumber(`${p}:STARt?`),
    stop_hz: await queryNumber(`${p}:STOP?`),
    rbw_hz: await queryNumber(`${p}:BANDwidth:RESolution?`),
    rbw_auto: await queryBool(`${p}:BANDwidth:RESolution:AUTO?`),
    time_s: await queryNumber(`${p}:TIME?`),
    time_auto: await queryBool(`${p}:TIME:AUTO?`),
    attenuation_db: await queryNumber(`${p}:INPut:ATTenuation?`),
    attenuation_auto: await queryBool(`${p}:INPut:ATTenuation:AUTO?`),
    points: await queryNumber(`${p}:POINt?`),
    preamp: await queryBool(`${p}:POWer:GAIN:STATe?`),
  };
}

async function readScanTable() {
  const bands: Band[] = [];
  for (let n = 1; n <= BAND_COUNT; n++) bands.push(await readBand(n));
  return { scan_table: bands };
}

async function readMeters() {
  const meter_detectors: string[] = [];
  for (let n = 1; n <= METER_COUNT; n++) {
    meter_detectors.push(await queryParsed(`:SENSe:METer${n}:DETector?`, (r) => parseEnum(r, DETECTORS, `:SENSe:METer${n}:DETector?`)));
  }
  const meter_dwell_s = await queryNumber(":SENSe:METer:DETector:DWELl?");
  const peak_hold_type = await queryParsed(":SENSe:METer:PHOLd:TYPE?", (r) => parseEnum(r, PHOLD_TYPES, ":SENSe:METer:PHOLd:TYPE?"));
  const peak_hold_adjustable_s = await queryNumber(":SENSe:METer:PHOLd:ADJustable?");
  return { meter_detectors, meter_dwell_s, peak_hold_type, peak_hold_adjustable_s };
}

async function readDetectors() {
  const trace_detectors: string[] = [];
  const trace_detector_auto: boolean[] = [];
  for (let n = 1; n <= TRACE_COUNT; n++) {
    trace_detectors.push(await queryParsed(`:SENSe:FSCan:DETector:TRACe${n}?`, (r) => parseEnum(r, DETECTORS, `:SENSe:FSCan:DETector:TRACe${n}?`)));
    trace_detector_auto.push(await queryBool(`:SENSe:DETector:TRACe${n}:AUTO?`));
  }
  const average_count = await queryNumber(":SENSe:AVERage:COUNt?");
  const average_type = await queryParsed(":SENSe:AVERage:TYPE?", (r) => parseEnum(r, AVERAGE_TYPES, ":SENSe:AVERage:TYPE?"));
  return { trace_detectors, trace_detector_auto, average_count, average_type };
}

async function readTraces() {
  const trace_type: string[] = [];
  const trace_update: boolean[] = [];
  const trace_display: boolean[] = [];
  for (let n = 1; n <= TRACE_COUNT; n++) {
    trace_type.push(await queryParsed(`:TRACe${n}:TYPE?`, (r) => parseEnum(r, TRACE_TYPES, `:TRACe${n}:TYPE?`)));
    trace_update.push(await queryBool(`:TRACe${n}:UPDate:STATe?`));
    trace_display.push(await queryBool(`:TRACe${n}:DISPlay?`));
  }
  return { trace_type, trace_update, trace_display };
}

async function readSearch() {
  const search_mode = await queryParsed(":SENSe:FSCan:SEARch:MODE?", (r) => parseEnum(r, SEARCH_MODES, ":SENSe:FSCan:SEARch:MODE?"));
  const peak_count = await queryNumber(":SENSe:FSCan:SEARch:PEAK:COUNt?");
  const segment_count = await queryNumber(":SENSe:FSCan:SEARch:SUBRange:COUNt?");
  const peak_threshold_dbm = await queryNumber(":CALCulate:FSCan:MARKer:PEAK:THReshold?");
  const peak_threshold_auto = await queryBool(":CALCulate:FSCan:MARKer:PEAK:THReshold:STATe?");
  const peak_excursion_db = await queryNumber(":CALCulate:FSCan:MARKer:PEAK:EXCursion?");
  const peak_excursion_auto = await queryBool(":CALCulate:FSCan:MARKer:PEAK:EXCursion:STATe?");
  return { search_mode, peak_count, segment_count, peak_threshold_dbm, peak_threshold_auto, peak_excursion_db, peak_excursion_auto };
}

async function readFrequency() {
  const meter_center_freq_hz = await queryNumber(":SENSe:FREQuency:CENTer?");
  const meter_bandwidth_resolution_hz = await queryNumber(":SENSe:BANDwidth:RESolution?");
  const meter_bandwidth_resolution_auto = await queryBool(":SENSe:BANDwidth:RESolution:AUTO?");
  return { meter_center_freq_hz, meter_bandwidth_resolution_hz, meter_bandwidth_resolution_auto };
}

async function readAmplitude() {
  const meter_attenuation_db = await queryNumber(":SENSe:POWer:RF:ATTenuation?");
  const meter_attenuation_auto = await queryBool(":SENSe:POWer:RF:ATTenuation:AUTO?");
  const meter_preamp = await queryBool(":SENSe:POWer:RF:GAIN:STATe?");
  return { meter_attenuation_db, meter_attenuation_auto, meter_preamp };
}

async function readTrigger() {
  const trigger_source = await queryParsed(":TRIGger:SEQuence:SOURce?", (r) => parseEnum(r, TRIGGER_SOURCES, ":TRIGger:SEQuence:SOURce?"));
  const external_slope = await queryParsed(":TRIGger:SEQuence:EXTernal:SLOPe?", upper);
  const external_delay_s = await queryNumber(":TRIGger:SEQuence:EXTernal:DELay?");
  const video_level = await queryNumber(":TRIGger:SEQuence:VIDeo:LEVel?");
  return { trigger_source, external_slope, external_delay_s, video_level };
}

const READERS: Record<EmiSettingGroup, () => Promise<Record<string, unknown>>> = {
  standard: readStandard,
  sequence: readSequence,
  scan_table: readScanTable,
  meters: readMeters,
  detectors: readDetectors,
  traces: readTraces,
  search: readSearch,
  frequency: readFrequency,
  amplitude: readAmplitude,
  trigger: readTrigger,
};

export async function readEmiSettings(groups: readonly EmiSettingGroup[]): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  // Queries are serialized by the connection; read one group's fields at a time, in a fixed order.
  for (const group of groups) {
    Object.assign(result, await READERS[group]());
  }
  return result;
}

export function registerEmiSettingsTools(server: McpServer): void {
  defineTool(
    server,
    "get_emi_settings",
    "Get a read-only snapshot of the EMI module configuration: standard, scan sequence, the 10-band scan table, meter/trace " +
      "detectors, trace types, search/peak settings, meter frequency and attenuation, and trigger. EMI module must be active " +
      "(select_instrument_module). By default omits 'scan_table' (10 bands, by far the most expensive group); pass groups " +
      "including 'scan_table' to include it. A silent or malformed reply to any query is an error naming that command; no " +
      "partial snapshot is ever returned.",
    {
      groups: z
        .array(z.enum(EMI_SETTING_GROUPS))
        .optional()
        .describe(
          "Which setting groups to read. Default: all except scan_table (standard, sequence, meters, detectors, traces, " +
            "search, frequency, amplitude, trigger). Pass an explicit list (including 'scan_table') to change what is read."
        ),
    },
    { readOnlyHint: true },
    async ({ groups }) => {
      try {
        return textResult(JSON.stringify(await readEmiSettings(groups ?? DEFAULT_GROUPS), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "emi" }
  );
}
