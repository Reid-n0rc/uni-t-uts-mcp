import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber } from "../scpi.js";
import { readDemodType } from "./adSettings.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/research/analog-demodulation.md section 2 "Scope / time-domain display" and
// "Markers" (programming manual pp.142-150). AD module must be active. Every command here takes
// the AM|FM demod-type prefix, read fresh from :CONFigure? each call (same pattern as adSettings.ts
// / adAudio.ts / adResults.ts). Live-verified on real hardware (2026-11-12, docs/verified-hardware.md):
// window 1 (RF spectrum) and window 3's linear/log spacing commands, and the full marker set
// (mode, trace, reference marker/delta mode, peak search against a real signal, AOFF) all work as
// coded. Window 2's exact unit, and window 3's Y-axis ambiguity, were not separately exercised.
//
// Display: the AD screen has three windows (UM p.13, PM p.149): 1 RF spectrum, 2 demodulation
// waveform (time-domain "scope"), 3 modulation (AF) spectrum. Y-axis reference level and
// per-division are set per window; only window 3 has a documented linear/log spacing setting.
// Units by window (research doc section 2): window 1 is dBm (RLEVel) / dB (PDIVision); window 2 is
// modulation depth as a fraction (1 = 100%) in AM or frequency deviation in Hz in FM; window 3's
// unit is ambiguous in the manual ("likewise (RLEVel) or dB (PDIVision)") and reported as such.
//
// Markers: six markers per demod type (not ten, unlike the SA module's get_marker/set_marker).
// Trace names are AD-specific (RFSPectrum, DEMod, DAVerage, DMAXimum, DMINimum, AFSPectrum), not
// the SA module's numeric 1-6 trace slots. X is Hz for the two spectrum traces and seconds for the
// four demodulation-waveform traces; Y is dBm on the RF spectrum trace, modulation depth (AM) or Hz
// deviation (FM) on the waveform traces, and unconfirmed on the AF spectrum trace (manual's window 3
// Y-axis ambiguity above applies the same way to :Y?).

const WINDOW = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const MARKER = z.number().int().min(1).max(6).describe("Marker number, 1 to 6 (AD has six markers per demod type, not SA's ten)");

const MODES = { off: "OFF", normal: "POSition", delta: "DELTa", fixed: "FIXed" } as const;
type ModeName = keyof typeof MODES;

const TRACES = {
  rf_spectrum: "RFSPectrum",
  demod: "DEMod",
  demod_average: "DAVerage",
  demod_max: "DMAXimum",
  demod_min: "DMINimum",
  af_spectrum: "AFSPectrum",
} as const;
type TraceName = keyof typeof TRACES;
const TIME_DOMAIN_TRACES: ReadonlySet<TraceName> = new Set(["demod", "demod_average", "demod_max", "demod_min"]);

const SEARCHES = {
  peak: "MAXimum",
  next_peak: "MAXimum:NEXT",
  next_left: "MAXimum:LEFT",
  next_right: "MAXimum:RIGHt",
  minimum: "MINimum",
  peak_to_peak: "PTPeak",
} as const;

function parseMode(reply: string): ModeName {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(MODES) as Array<[ModeName, string]>) {
    const long = raw.toUpperCase();
    const short = raw.replace(/[a-z]/g, "").toUpperCase();
    if (text === long || text === short) return name;
  }
  throw new Error(`Unexpected AD marker mode ${JSON.stringify(reply)}`);
}

function parseTrace(reply: string): TraceName {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(TRACES) as Array<[TraceName, string]>) {
    const long = raw.toUpperCase();
    const short = raw.replace(/[a-z]/g, "").toUpperCase();
    if (text === long || text === short) return name;
  }
  throw new Error(`Unexpected AD marker trace ${JSON.stringify(reply)}`);
}

function parseInt1to6(what: string) {
  return (reply: string): number => {
    const n = Number(reply.trim());
    if (!/^\d+$/.test(reply.trim()) || n < 1 || n > 6) throw new Error(`Unexpected ${what} ${JSON.stringify(reply)}`);
    return n;
  };
}

/** x unit (and y unit, when it is not amplitude) depend on the trace and demod type (section 2, Markers). */
function xUnit(trace: TraceName): "Hz" | "s" {
  return TIME_DOMAIN_TRACES.has(trace) ? "s" : "Hz";
}
function yUnit(trace: TraceName, demod_type: "AM" | "FM"): string {
  if (trace === "rf_spectrum") return "dBm";
  if (TIME_DOMAIN_TRACES.has(trace)) return demod_type === "AM" ? "modulation depth (fraction, 1 = 100%)" : "Hz (frequency deviation)";
  return "unconfirmed (manual ambiguous for the AF spectrum trace's Y axis)";
}

export interface AdMarkerState {
  marker: number;
  mode: ModeName;
  trace: TraceName;
  reference_marker?: number;
  x: number | null;
  x_unit: "Hz" | "s";
  y: number | null;
  y_unit: string;
}

const M = (p: string, n: number) => `:CALCulate:${p}:MARKer${n}`;

async function readAdMarker(p: string, demod_type: "AM" | "FM", n: number): Promise<AdMarkerState> {
  const mode = await queryParsed(`${M(p, n)}:MODE?`, parseMode);
  const trace = await queryParsed(`${M(p, n)}:TRACe?`, parseTrace);
  const state: AdMarkerState = { marker: n, mode, trace, x: null, x_unit: xUnit(trace), y: null, y_unit: yUnit(trace, demod_type) };
  if (mode === "delta") state.reference_marker = await queryParsed(`${M(p, n)}:REFerence?`, parseInt1to6("reference marker"));
  if (mode !== "off") {
    state.x = await queryNumber(`${M(p, n)}:X?`);
    state.y = await queryNumber(`${M(p, n)}:Y?`);
  }
  return state;
}

function close(requested: number, actual: number): boolean {
  return Math.abs(requested - actual) <= Math.max(1e-9, 1e-5 * Math.abs(requested));
}

// ---------- set_ad_display ----------

const DISPLAY_SHAPE = {
  window: WINDOW.describe("Display window: 1 RF spectrum, 2 demodulation waveform, 3 AF (modulation) spectrum"),
  reference_level: z.number().finite().optional().describe(
    "Y-axis reference level. Unit depends on window and demod type: dBm (window 1), modulation depth fraction in AM / Hz deviation in FM (window 2), " +
      "unconfirmed (window 3, manual ambiguous)"
  ),
  per_division: z.number().finite().positive().optional().describe("Y-axis value per division, same unit as reference_level for the chosen window"),
  af_spacing: z.enum(["logarithmic", "linear"]).optional().describe("AF spectrum Y-axis spacing. Only documented for window 3 (manual, PM p.150)"),
};
type DisplayArgs = { window: 1 | 2 | 3; reference_level?: number; per_division?: number; af_spacing?: "logarithmic" | "linear" };

function validateDisplay(a: DisplayArgs): string | undefined {
  if (a.reference_level === undefined && a.per_division === undefined && a.af_spacing === undefined) {
    return "No parameters given; provide at least one of reference_level, per_division or af_spacing.";
  }
  if (a.af_spacing !== undefined && a.window !== 3) return "af_spacing is only documented for window 3.";
  return undefined;
}

async function readDisplayState(p: string, w: number, a: DisplayArgs) {
  const result: Record<string, unknown> = {};
  if (a.reference_level !== undefined) result.reference_level = await queryNumber(`:DISPlay${p}:WINDow${w}:TRACe:Y:RLEVel?`);
  if (a.per_division !== undefined) result.per_division = await queryNumber(`:DISPlay${p}:WINDow${w}:TRACe:Y:PDIVision?`);
  if (a.af_spacing !== undefined) {
    result.af_spacing = await queryParsed(`:DISPlay${p}:WINDow${w}:TRACe:Y:SPACing?`, (reply) => {
      const text = reply.trim().toUpperCase();
      if (text === "LOGARITHMIC" || text === "LOG") return "logarithmic";
      if (text === "LINEAR" || text === "LIN") return "linear";
      throw new Error(`Unexpected AF spacing reply ${JSON.stringify(reply)}`);
    });
  }
  return result;
}

export function registerAdDisplayMarkerTools(server: McpServer): void {
  defineTool(
    server,
    "set_ad_display",
    "Configure one AD display window's Y-axis reference level and/or per-division value, and (window 3 only) the AF " +
      "spectrum's linear/log spacing. AD module must be active. The unit of reference_level/per_division depends on the " +
      "window and current demod type (AM/FM, read fresh from :CONFigure? each call) — see each parameter's description. " +
      "Live-verified (2026-11-12) for window 1 and window 3's spacing setter; window 2's unit and exact clamp-vs-error " +
      "behavior were not separately exercised. Everything " +
      "requested is re-read afterwards and any instrument-adjusted value is reported in 'warnings'. Leaves the new state.",
    DISPLAY_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const demod_type = await readDemodType();
        const p = `:${demod_type}`;
        const w = args.window;
        const commands: string[] = [];
        if (args.reference_level !== undefined) commands.push(`:DISPlay${p}:WINDow${w}:TRACe:Y:RLEVel ${formatNumber(args.reference_level)}`);
        if (args.per_division !== undefined) commands.push(`:DISPlay${p}:WINDow${w}:TRACe:Y:PDIVision ${formatNumber(args.per_division)}`);
        if (args.af_spacing !== undefined) commands.push(`:DISPlay${p}:WINDow${w}:TRACe:Y:SPACing ${args.af_spacing === "logarithmic" ? "LOGarithmic" : "LINear"}`);
        await applyCommands(commands);

        const actual = await readBack(() => readDisplayState(p, w, args));
        const warnings: string[] = [];
        if (args.reference_level !== undefined && !close(args.reference_level, actual.reference_level as number)) {
          warnings.push(`reference_level adjusted by the instrument: requested ${args.reference_level}, now ${actual.reference_level}`);
        }
        if (args.per_division !== undefined && !close(args.per_division, actual.per_division as number)) {
          warnings.push(`per_division adjusted by the instrument: requested ${args.per_division}, now ${actual.per_division}`);
        }
        if (args.af_spacing !== undefined && actual.af_spacing !== args.af_spacing) {
          warnings.push(`af_spacing adjusted by the instrument: requested ${args.af_spacing}, now ${actual.af_spacing}`);
        }
        return textResult(JSON.stringify({ demod_type, window: w, ...actual, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "set_ad_display");
      }
    },
    { validate: validateDisplay, requireModule: "ad" }
  );

  defineTool(
    server,
    "ad_marker",
    "Set an AD marker's mode, trace, reference marker (delta mode) and/or position, then return its new state. AD module " +
      "must be active. Commands apply in the order mode, trace, reference, x. AD has six markers per demod type (not SA's " +
      "ten) and AD-specific traces (rf_spectrum, demod, demod_average, demod_max, demod_min, af_spectrum); x's unit is Hz " +
      "for the spectrum traces and seconds for the demodulation-waveform traces. A position set on a marker that is off " +
      "has no effect: set mode normal (or use ad_marker_search) first. Live-verified (2026-11-12) against a real signal.",
    {
      marker: MARKER,
      mode: z.enum(["off", "normal", "delta", "fixed"]).optional().describe("off, normal (position), delta or fixed"),
      trace: z.enum(["rf_spectrum", "demod", "demod_average", "demod_max", "demod_min", "af_spectrum"]).optional().describe("Trace the marker sits on"),
      x: z.number().finite().optional().describe("Marker position: Hz for rf_spectrum/af_spectrum, seconds for the demod waveform traces"),
      reference_marker: MARKER.optional().describe("Reference marker for delta mode (another marker, 1-6)"),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const demod_type = await readDemodType();
        const p = demod_type;
        const n = args.marker;
        const commands: string[] = [];
        if (args.mode !== undefined) commands.push(`${M(p, n)}:MODE ${MODES[args.mode]}`);
        if (args.trace !== undefined) commands.push(`${M(p, n)}:TRACe ${TRACES[args.trace]}`);
        if (args.reference_marker !== undefined) commands.push(`${M(p, n)}:REFerence ${args.reference_marker}`);
        if (args.x !== undefined) commands.push(`${M(p, n)}:X ${formatNumber(args.x)}`);
        await applyCommands(commands);

        const state = await readBack(() => readAdMarker(p, demod_type, n));
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
        if (args.x !== undefined) {
          if (state.mode === "off") {
            warnings.push("x has no effect while the marker is off; set mode normal first");
          } else if (state.mode !== "delta" && state.x !== null && !close(args.x, state.x)) {
            warnings.push(`x adjusted by the instrument: requested ${args.x}, now ${state.x}`);
          }
        }
        return textResult(JSON.stringify({ demod_type, marker: state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_ad_marker");
      }
    },
    {
      validate: (a) => {
        if (a.mode === undefined && a.trace === undefined && a.x === undefined && a.reference_marker === undefined) {
          return "No parameters given; provide at least one of mode, trace, x or reference_marker.";
        }
        if (a.reference_marker !== undefined && a.reference_marker === a.marker) return "reference_marker must be a different marker than marker.";
        return undefined;
      },
      requireModule: "ad",
    }
  );

  defineTool(
    server,
    "ad_marker_search",
    "Move an AD marker with a search and return its new state. AD module must be active. Actions: peak (highest), " +
      "next_peak, next_left / next_right (next peak left/right of the marker), minimum, peak_to_peak (the marker becomes " +
      "a delta marker). A search turns a marker that is off on. Live-verified (2026-11-12): peak search found a real " +
      "external signal exactly.",
    { marker: MARKER, action: z.enum(["peak", "next_peak", "next_left", "next_right", "minimum", "peak_to_peak"]).describe("Which search to run") },
    { readOnlyHint: false },
    async ({ marker, action }) => {
      try {
        const demod_type = await readDemodType();
        const p = demod_type;
        await applyCommands([`${M(p, marker)}:${SEARCHES[action]}`]);
        const state = await readBack(() => readAdMarker(p, demod_type, marker));
        const out: { demod_type: "AM" | "FM"; marker: AdMarkerState; note?: string } = { demod_type, marker: state };
        if (action === "peak_to_peak") {
          out.note = "peak_to_peak leaves the marker in delta mode: x and y are the peak-to-peak differences from its reference marker.";
        }
        return textResult(JSON.stringify(out, null, 2));
      } catch (err) {
        return setterFailure(err, "get_ad_marker");
      }
    },
    { requireModule: "ad" }
  );

  defineTool(
    server,
    "get_ad_marker",
    "Read one AD marker: mode (off, normal, delta, fixed), trace, and its position (x) and value (y) together, with " +
      "their units (which depend on the trace and current demod type). AD module must be active. A delta marker's x/y " +
      "are relative to its reference marker. An off marker has x and y null. Live-verified (2026-11-12).",
    { marker: MARKER.default(1) },
    { readOnlyHint: true },
    async ({ marker }) => {
      try {
        const demod_type = await readDemodType();
        return textResult(JSON.stringify({ demod_type, marker: await readAdMarker(demod_type, demod_type, marker) }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "ad" }
  );

  defineTool(
    server,
    "ad_markers_all_off",
    "Turn every AD marker off (:CALCulate:AM|FM:MARKer:AOFF for the current demod type) and confirm it by reading each " +
      "of the six markers' mode. AD module must be active. Live-verified (2026-11-12).",
    {},
    { readOnlyHint: false, idempotentHint: true },
    async () => {
      try {
        const demod_type = await readDemodType();
        const p = demod_type;
        await applyCommands([`:CALCulate:${p}:MARKer:AOFF`]);
        const still = await readBack(async () => {
          const on: number[] = [];
          for (let n = 1; n <= 6; n++) if ((await queryParsed(`${M(p, n)}:MODE?`, parseMode)) !== "off") on.push(n);
          return on;
        });
        const warnings = still.map((n) => `marker ${n} is still on after all-off`);
        return textResult(JSON.stringify({ demod_type, all_off: still.length === 0, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_ad_marker");
      }
    },
    { requireModule: "ad" }
  );
}
