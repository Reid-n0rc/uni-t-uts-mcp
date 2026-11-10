import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber, onOff } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 4 (3K p.13-26) and ambiguity 10. Behavior verified on the UTS3036B
// (docs/verified-hardware.md): a search command turns an OFF marker on; peak-to-peak leaves the marker in delta
// mode; X?/Y? of a delta marker are relative to its reference marker; X? of an OFF marker is a stale value; setting
// a peak threshold or excursion value turns that criterion's automatic mode off; marker X is NOT clamped to the span.

const MODES = { off: "OFF", normal: "POSition", delta: "DELTa", fixed: "FIXed" } as const;
type ModeName = keyof typeof MODES;

const MARKER = z.number().int().min(1).max(10).describe("Marker number, 1 to 10");
const TRACE = z.number().int().min(1).max(6);

const SEARCHES = {
  peak: "MAXimum",
  next_peak: "MAXimum:NEXT",
  next_left: "MAXimum:LEFT",
  next_right: "MAXimum:RIGHt",
  minimum: "MINimum",
  peak_to_peak: "PTPeak",
} as const;

const TARGETS = {
  center: { scpi: "CENTer", query: ":FREQuency:CENTer?", unit: "Hz" },
  step: { scpi: "STEP", query: ":FREQuency:CENTer:STEP?", unit: "Hz" },
  start: { scpi: "STARt", query: ":FREQuency:STARt?", unit: "Hz" },
  stop: { scpi: "STOP", query: ":FREQuency:STOP?", unit: "Hz" },
  reference_level: { scpi: "RLEVel", query: ":DISPlay:WINDow:TRACe:Y:RLEVel?", unit: "current power unit" },
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

export interface MarkerState {
  marker: number;
  mode: ModeName;
  trace: number;
  /** Only for delta markers: the marker that x and y are relative to. */
  reference_marker?: number;
  /** Hz (seconds in zero span). Relative to the reference marker for a delta marker. null while the marker is off. */
  x: number | null;
  /** Level in the current power unit (dBm by default); relative (dB) for a delta marker. null while the marker is off. */
  y: number | null;
}

const M = (n: number) => `:CALCulate:MARKer${n}`;

async function readMarker(n: number): Promise<MarkerState> {
  // Queries are serialized by the connection; read one at a time.
  const mode = await queryParsed(`${M(n)}:MODE?`, parseMode);
  const trace = await queryParsed(`${M(n)}:TRACe?`, parseInt1(6, "marker trace"));
  const state: MarkerState = { marker: n, mode, trace, x: null, y: null };
  if (mode === "delta") state.reference_marker = await queryParsed(`${M(n)}:REFerence?`, parseInt1(10, "reference marker"));
  // An off marker still answers X? and Y?, with stale values; do not report them.
  if (mode !== "off") {
    state.x = await queryNumber(`${M(n)}:X?`);
    state.y = await queryNumber(`${M(n)}:Y?`);
  }
  return state;
}

function close(requested: number, actual: number): boolean {
  // Readbacks carry six to ten significant digits.
  return Math.abs(requested - actual) <= Math.max(1e-9, 1e-5 * Math.abs(requested));
}

const SET_SHAPE = {
  marker: MARKER,
  mode: z.enum(["off", "normal", "delta", "fixed"]).optional().describe("off, normal (position), delta or fixed"),
  trace: TRACE.optional().describe("Trace the marker sits on, 1 to 6"),
  x_hz: z.number().finite().min(0).optional().describe(
    "Marker position in Hz (seconds in zero span). Not clamped by the instrument: a value outside the sweep span is accepted but its level reading is not meaningful"
  ),
  reference_marker: MARKER.optional().describe("Reference marker for delta mode (another marker)"),
};

function validateSet(a: { marker?: number; mode?: string; trace?: number; x_hz?: number; reference_marker?: number }): string | undefined {
  if (a.mode === undefined && a.trace === undefined && a.x_hz === undefined && a.reference_marker === undefined) {
    return "No parameters given; provide at least one of mode, trace, x_hz or reference_marker.";
  }
  if (a.reference_marker !== undefined && a.reference_marker === a.marker) return "reference_marker must be a different marker than marker.";
  return undefined;
}

const PEAK = ":CALCulate:MARKer:PEAK";

export interface PeakCriteria {
  threshold_dbm: number;
  threshold_auto: boolean;
  excursion_db: number;
  excursion_auto: boolean;
}

async function readPeakCriteria(): Promise<PeakCriteria> {
  const threshold_dbm = await queryNumber(`${PEAK}:THReshold?`);
  const threshold_auto = await queryBool(`${PEAK}:THReshold:STATe?`);
  const excursion_db = await queryNumber(`${PEAK}:EXCursion?`);
  const excursion_auto = await queryBool(`${PEAK}:EXCursion:STATe?`);
  return { threshold_dbm, threshold_auto, excursion_db, excursion_auto };
}

export function registerMarkerTools(server: McpServer): void {
  defineTool(
    server,
    "get_marker",
    "Read one marker: mode (off, normal, delta, fixed), trace, and its frequency (x, Hz) and level (y, current power unit, dBm by default) together. " +
      "A delta marker's x and y are relative to its reference marker (reference_marker is included). An off marker has x and y null.",
    { marker: MARKER.default(1) },
    { readOnlyHint: true },
    async ({ marker }) => {
      try {
        return textResult(JSON.stringify(await readMarker(marker), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_marker",
    "Set a marker's mode, trace, reference marker (delta mode) and/or position. Commands are applied in the order mode, trace, reference, x; " +
      "the marker is re-read afterwards and anything the instrument did not take is reported in 'warnings'. A position set on a marker that is off has no effect: " +
      "set mode normal (or use marker_search, which turns the marker on) first.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const n = args.marker;
        const commands: string[] = [];
        if (args.mode !== undefined) commands.push(`${M(n)}:MODE ${MODES[args.mode]}`);
        if (args.trace !== undefined) commands.push(`${M(n)}:TRACe ${args.trace}`);
        if (args.reference_marker !== undefined) commands.push(`${M(n)}:REFerence ${args.reference_marker}`);
        if (args.x_hz !== undefined) commands.push(`${M(n)}:X ${formatNumber(args.x_hz)}`);
        await applyCommands(commands);

        const state = await readBack(() => readMarker(n));
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
        if (args.x_hz !== undefined) {
          if (state.mode === "off") {
            warnings.push("x_hz has no effect while the marker is off; set mode normal first");
          } else if (state.mode !== "delta" && state.x !== null && !close(args.x_hz, state.x)) {
            warnings.push(`x_hz adjusted by the instrument: requested ${args.x_hz} Hz, now ${state.x} Hz`);
          }
        }
        return textResult(JSON.stringify({ marker: state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_marker");
      }
    },
    { validate: validateSet }
  );

  defineTool(
    server,
    "marker_search",
    "Move a marker with a search and return its new frequency and level together. Actions: peak (highest), next_peak (next highest), next_left / next_right " +
      "(next peak left or right of the marker), minimum, peak_to_peak (the marker becomes a delta marker showing the peak-to-peak difference). " +
      "A search turns a marker that is off on. Peaks must satisfy the peak threshold and excursion (get_peak_criteria).",
    { marker: MARKER, action: z.enum(["peak", "next_peak", "next_left", "next_right", "minimum", "peak_to_peak"]).describe("Which search to run") },
    { readOnlyHint: false },
    async ({ marker, action }) => {
      try {
        await applyCommands([`${M(marker)}:${SEARCHES[action]}`]);
        const state = await readBack(() => readMarker(marker));
        const out: { marker: MarkerState; note?: string } = { marker: state };
        if (action === "peak_to_peak") {
          out.note = "peak_to_peak leaves the marker in delta mode: x and y are the peak-to-peak differences from its reference marker.";
        }
        return textResult(JSON.stringify(out, null, 2));
      } catch (err) {
        return setterFailure(err, "get_marker");
      }
    }
  );

  defineTool(
    server,
    "marker_to_instrument",
    "Use a marker's frequency or level to set an instrument parameter: center, step (center frequency step; turns automatic step off), start, stop " +
      "or reference_level. The marker must be on. Returns the new value of the parameter. The instrument refuses a center that would put the span outside its range.",
    { marker: MARKER, target: z.enum(["center", "step", "start", "stop", "reference_level"]).describe("Parameter to set from the marker") },
    { readOnlyHint: false },
    async ({ marker, target }) => {
      try {
        const mode = await queryParsed(`${M(marker)}:MODE?`, parseMode);
        if (mode === "off") return errorResult(`Marker ${marker} is off; turn it on with set_marker or marker_search first.`);
        const t = TARGETS[target];
        await applyCommands([`${M(marker)}:SET:${t.scpi}`]);
        const value = await readBack(() => queryNumber(t.query));
        return textResult(JSON.stringify({ marker, target, value, unit: t.unit }, null, 2));
      } catch (err) {
        return setterFailure(err, target === "reference_level" ? "get_amplitude" : "get_frequency");
      }
    }
  );

  defineTool(
    server,
    "markers_all_off",
    "Turn every marker off (:CALCulate:MARKer:AOFF) and confirm it by reading each marker's mode.",
    {},
    { readOnlyHint: false, idempotentHint: true },
    async () => {
      try {
        await applyCommands([":CALCulate:MARKer:AOFF"]);
        const still = await readBack(async () => {
          const on: number[] = [];
          for (let n = 1; n <= 10; n++) if ((await queryParsed(`${M(n)}:MODE?`, parseMode)) !== "off") on.push(n);
          return on;
        });
        const warnings = still.map((n) => `marker ${n} is still on after all-off`);
        return textResult(JSON.stringify({ all_off: still.length === 0, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_marker");
      }
    }
  );

  defineTool(
    server,
    "get_peak_criteria",
    "Read the peak search criteria: threshold (dBm) and excursion (dB), each with its automatic flag. In automatic mode the instrument derives the value from the trace.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readPeakCriteria(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_peak_criteria",
    "Set the peak search criteria. Giving threshold_dbm or excursion_db turns that criterion's automatic mode off (verified on the instrument); " +
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
        // Value first, then the automatic flag, so threshold_auto:false after a value is a no-op rather than a surprise.
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
        return setterFailure(err, "get_peak_criteria");
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
    }
  );
}
