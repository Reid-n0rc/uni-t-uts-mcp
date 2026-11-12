import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber, onOff } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: `:CALCulate:FSCan:MARKer<n>...` for mode/trace/reference/search/X/Y (programming
// manual pp.94-99; docs/research/emi-function.md section 3.6). The manual's own text suggests the
// plain, non-prefixed `:CALCulate:MARKer<n>:X?`/`:Y?` form for numeric readback, but that is WRONG
// against real firmware (live-verified 2026-11-12, issue #187, owner present): the plain form gets
// no reply at all on a query and `-113 Undefined header` with no effect on a set; only the
// FSCan-prefixed form actually works for X/Y, both get and set. Peak criteria (threshold/
// excursion) are under `:CALCulate:FSCan:MARKer:PEAK...` (section 3.4). EMI has 3 traces (not 6)
// and the research doc lists 6 markers.

const MODES = { off: "OFF", normal: "POSition", delta: "DELTa", fixed: "FIXed" } as const;
type ModeName = keyof typeof MODES;

const MARKER = z.number().int().min(1).max(6).describe("Marker number, 1 to 6 (EMI has 6 markers)");
const TRACE = z.number().int().min(1).max(3).describe("EMI trace, 1 to 3");

const SEARCHES = {
  peak: "MAXimum",
  next: "MAXimum:NEXT",
  left: "MAXimum:LEFT",
  right: "MAXimum:RIGHt",
  minimum: "MINimum",
} as const;

function parseMode(reply: string): ModeName {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(MODES) as Array<[ModeName, string]>) {
    const long = raw.toUpperCase();
    const short = raw.replace(/[a-z]/g, "").toUpperCase();
    if (text === long || text === short) return name;
  }
  throw new Error(`Unexpected marker mode ${JSON.stringify(reply)}`);
}

function parseInt1(max: number, what: string) {
  return (reply: string): number => {
    const n = Number(reply.trim());
    if (!/^\d+$/.test(reply.trim()) || n < 1 || n > max) throw new Error(`Unexpected ${what} ${JSON.stringify(reply)}`);
    return n;
  };
}

export interface EmiMarkerState {
  marker: number;
  mode: ModeName;
  trace: number;
  reference_marker?: number;
  x: number | null;
  y: number | null;
}

const FM = (n: number) => `:CALCulate:FSCan:MARKer${n}`;

async function readEmiMarker(n: number): Promise<EmiMarkerState> {
  const mode = await queryParsed(`${FM(n)}:MODE?`, parseMode);
  const trace = await queryParsed(`${FM(n)}:TRACe?`, parseInt1(3, "marker trace"));
  const state: EmiMarkerState = { marker: n, mode, trace, x: null, y: null };
  if (mode === "delta") state.reference_marker = await queryParsed(`${FM(n)}:REFerence?`, parseInt1(6, "reference marker"));
  if (mode !== "off") {
    state.x = await queryNumber(`${FM(n)}:X?`);
    state.y = await queryNumber(`${FM(n)}:Y?`);
  }
  return state;
}

function close(requested: number, actual: number): boolean {
  return Math.abs(requested - actual) <= Math.max(1e-9, 1e-5 * Math.abs(requested));
}

const SET_SHAPE = {
  marker: MARKER,
  mode: z.enum(["off", "normal", "delta", "fixed"]).optional().describe("off, normal (position), delta or fixed"),
  trace: TRACE.optional(),
  frequency_hz: z.number().finite().min(0).optional().describe("Marker position in Hz. Not clamped by the instrument"),
  reference_marker: MARKER.optional().describe("Reference marker for delta mode (another marker)"),
};

function validateSet(a: { marker?: number; mode?: string; trace?: number; frequency_hz?: number; reference_marker?: number }): string | undefined {
  if (a.mode === undefined && a.trace === undefined && a.frequency_hz === undefined && a.reference_marker === undefined) {
    return "No parameters given; provide at least one of mode, trace, frequency_hz or reference_marker.";
  }
  if (a.reference_marker !== undefined && a.reference_marker === a.marker) return "reference_marker must be a different marker than marker.";
  return undefined;
}

const PEAK = ":CALCulate:FSCan:MARKer:PEAK";

export interface EmiPeakCriteria {
  threshold_dbm: number;
  threshold_auto: boolean;
  excursion_db: number;
  excursion_auto: boolean;
}

async function readPeakCriteria(): Promise<EmiPeakCriteria> {
  const threshold_dbm = await queryNumber(`${PEAK}:THReshold?`);
  const threshold_auto = await queryBool(`${PEAK}:THReshold:STATe?`);
  const excursion_db = await queryNumber(`${PEAK}:EXCursion?`);
  const excursion_auto = await queryBool(`${PEAK}:EXCursion:STATe?`);
  return { threshold_dbm, threshold_auto, excursion_db, excursion_auto };
}

export function registerEmiMarkerTools(server: McpServer): void {
  defineTool(
    server,
    "get_emi_marker",
    "Read one EMI marker: mode (off, normal, delta, fixed), trace (1-3) and its frequency (x, Hz) and level (y, dBm by default) together. " +
      "A delta marker's x and y are relative to its reference marker. An off marker has x and y null.",
    { marker: MARKER.default(1) },
    { readOnlyHint: true },
    async ({ marker }) => {
      try {
        return textResult(JSON.stringify(await readEmiMarker(marker), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "emi" }
  );

  defineTool(
    server,
    "set_emi_marker",
    "Set an EMI marker's mode, trace, reference marker (delta mode) and/or frequency position. " +
      "Commands are applied in the order mode, trace, reference, frequency; the marker is re-read afterwards and anything " +
      "the instrument did not take is reported in 'warnings'. A position set on a marker that is off has no effect: " +
      "set mode normal (or use emi_marker_search, which turns the marker on) first.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const n = args.marker;
        const commands: string[] = [];
        if (args.mode !== undefined) commands.push(`${FM(n)}:MODE ${MODES[args.mode]}`);
        if (args.trace !== undefined) commands.push(`${FM(n)}:TRACe ${args.trace}`);
        if (args.reference_marker !== undefined) commands.push(`${FM(n)}:REFerence ${args.reference_marker}`);
        if (args.frequency_hz !== undefined) commands.push(`${FM(n)}:X ${formatNumber(args.frequency_hz)}`);
        await applyCommands(commands);

        const state = await readBack(() => readEmiMarker(n));
        const warnings: string[] = [];
        if (args.mode !== undefined && args.mode !== state.mode) {
          warnings.push(`mode adjusted by the instrument: requested ${args.mode}, now ${state.mode}`);
        }
        if (args.trace !== undefined && args.trace !== state.trace) {
          warnings.push(`trace adjusted by the instrument: requested ${args.trace}, now ${state.trace}`);
        }
        if (args.reference_marker !== undefined && state.mode === "delta" && args.reference_marker !== state.reference_marker) {
          warnings.push(`reference_marker adjusted by the instrument: requested ${args.reference_marker}, now ${state.reference_marker}`);
        }
        if (args.frequency_hz !== undefined) {
          if (state.mode === "off") {
            warnings.push("frequency_hz has no effect while the marker is off; set mode normal first");
          } else if (state.mode !== "delta" && state.x !== null && !close(args.frequency_hz, state.x)) {
            warnings.push(`frequency_hz adjusted by the instrument: requested ${args.frequency_hz} Hz, now ${state.x} Hz`);
          }
        }
        return textResult(JSON.stringify({ marker: state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_marker");
      }
    },
    { validate: validateSet, requireModule: "emi" }
  );

  defineTool(
    server,
    "emi_marker_search",
    "Move an EMI marker with a peak search and return its new frequency and level. Actions: peak (highest), next (next highest), " +
      "left / right (next peak left or right of the marker), minimum. A search turns a marker that is off on. " +
      "Peaks must satisfy the peak criteria (get_emi_peak_criteria).",
    { marker: MARKER, action: z.enum(["peak", "next", "left", "right", "minimum"]).describe("Which search to run") },
    { readOnlyHint: false },
    async ({ marker, action }) => {
      try {
        await applyCommands([`${FM(marker)}:${SEARCHES[action]}`]);
        const state = await readBack(() => readEmiMarker(marker));
        return textResult(JSON.stringify({ marker: state }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_marker");
      }
    },
    { requireModule: "emi" }
  );

  defineTool(
    server,
    "emi_markers_all_off",
    "Turn every EMI marker off (:CALCulate:FSCan:MARKer:AOFF) and confirm it by reading each marker's mode.",
    {},
    { readOnlyHint: false, idempotentHint: true },
    async () => {
      try {
        await applyCommands([":CALCulate:FSCan:MARKer:AOFF"]);
        const still = await readBack(async () => {
          const on: number[] = [];
          for (let n = 1; n <= 6; n++) if ((await queryParsed(`${FM(n)}:MODE?`, parseMode)) !== "off") on.push(n);
          return on;
        });
        const warnings = still.map((n) => `marker ${n} is still on after all-off`);
        return textResult(JSON.stringify({ all_off: still.length === 0, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_marker");
      }
    },
    { requireModule: "emi" }
  );

  defineTool(
    server,
    "get_emi_peak_criteria",
    "Read the EMI peak search criteria: threshold (dBm) and excursion (dB), each with its automatic flag. In automatic mode the instrument derives the value from the trace.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readPeakCriteria(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "emi" }
  );

  defineTool(
    server,
    "set_emi_peak_criteria",
    "Set the EMI peak search criteria. Giving threshold_dbm or excursion_db turns that criterion's automatic mode off; " +
      "threshold_auto / excursion_auto true switches it back to automatic. Values the instrument changed are reported in 'warnings'.",
    {
      threshold_dbm: z.number().finite().optional().describe("Peak threshold in dBm, -200 to 30; a peak must be above it"),
      threshold_auto: z.boolean().optional().describe("Automatic threshold on/off (not true together with threshold_dbm)"),
      excursion_db: z.number().finite().optional().describe("Peak excursion in dB, 0 to 100; a peak must rise this far above the valleys beside it"),
      excursion_auto: z.boolean().optional().describe("Automatic excursion on/off (not true together with excursion_db)"),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const commands: string[] = [];
        if (a.threshold_dbm !== undefined) commands.push(`${PEAK}:THReshold ${formatNumber(a.threshold_dbm)}`);
        if (a.threshold_auto !== undefined) commands.push(`${PEAK}:THReshold:STATe ${onOff(a.threshold_auto)}`);
        if (a.excursion_db !== undefined) commands.push(`${PEAK}:EXCursion ${formatNumber(a.excursion_db)}`);
        if (a.excursion_auto !== undefined) commands.push(`${PEAK}:EXCursion:STATe ${onOff(a.excursion_auto)}`);
        await applyCommands(commands);

        const state = await readBack(readPeakCriteria);
        const warnings: string[] = [];
        if (a.threshold_dbm !== undefined && !close(a.threshold_dbm, state.threshold_dbm)) {
          warnings.push(`threshold_dbm adjusted by the instrument: requested ${a.threshold_dbm} dBm, now ${state.threshold_dbm} dBm`);
        }
        if (a.excursion_db !== undefined && !close(a.excursion_db, state.excursion_db)) {
          warnings.push(`excursion_db adjusted by the instrument: requested ${a.excursion_db} dB, now ${state.excursion_db} dB`);
        }
        if (a.threshold_auto !== undefined && a.threshold_auto !== state.threshold_auto) {
          warnings.push(`threshold_auto adjusted by the instrument: requested ${a.threshold_auto}, now ${state.threshold_auto}`);
        }
        if (a.excursion_auto !== undefined && a.excursion_auto !== state.excursion_auto) {
          warnings.push(`excursion_auto adjusted by the instrument: requested ${a.excursion_auto}, now ${state.excursion_auto}`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_peak_criteria");
      }
    },
    {
      validate: (a) => {
        if (a.threshold_dbm === undefined && a.threshold_auto === undefined && a.excursion_db === undefined && a.excursion_auto === undefined) {
          return "No parameters given; provide at least one setting.";
        }
        if (a.threshold_dbm !== undefined && !(a.threshold_dbm >= -200 && a.threshold_dbm <= 30)) return "threshold_dbm must be between -200 and 30.";
        if (a.excursion_db !== undefined && !(a.excursion_db >= 0 && a.excursion_db <= 100)) return "excursion_db must be between 0 and 100.";
        if (a.threshold_dbm !== undefined && a.threshold_auto === true) return "threshold_dbm and threshold_auto=true conflict.";
        if (a.excursion_db !== undefined && a.excursion_auto === true) return "excursion_db and excursion_auto=true conflict.";
        return undefined;
      },
      requireModule: "emi",
    }
  );
}
