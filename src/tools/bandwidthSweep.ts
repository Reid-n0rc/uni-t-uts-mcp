import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { InstrumentError, applyCommands } from "../instrument.js";
import { formatNumber, onOff, parseBool, parseNumber } from "../scpi.js";
import { errorResult, textResult } from "./util.js";

// Commands: docs/programming-guide.md section 2 (bandwidth, sweep, detector; ambiguities 11, 17).
// Verified on the UTS3036B (docs/verified-hardware.md): every setter clamps silently (and RBW/VBW snap
// to 1-3-10 steps), setting a manual value turns the matching auto flag off, and RBW/VBW/sweep time are
// coupled to span, auto flags and each other, so state is always re-read after setting.

const B = ":SENSe:BANDwidth";
const S = ":SENSe:SWEep";
const T = ":TRIGger:SEQuence";

function close(requested: number, actual: number): boolean {
  return Math.abs(requested - actual) <= Math.max(1e-12, 1e-5 * Math.abs(requested));
}

function pick<T extends string>(reply: string, table: Record<T, string>, what: string): T {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(table) as Array<[T, string]>) {
    if (raw.toUpperCase() === text) return name;
  }
  throw new Error(`Unexpected ${what} ${JSON.stringify(reply)}`);
}

async function num(cmd: string): Promise<number> {
  return parseNumber(await connection.query(cmd));
}
async function bool(cmd: string): Promise<boolean> {
  return parseBool(await connection.query(cmd));
}

function failure(err: unknown, getter: string) {
  if (err instanceof InstrumentError) {
    return errorResult(`${err.message}. Settings may be partially applied; use ${getter} to check.`);
  }
  return errorResult(err);
}

const hasAny = (a: object) => Object.values(a).some((v) => v !== undefined);

// ---------------- bandwidth ----------------

const SHAPES = { gaussian: "GAUSsian", flattop: "FLATtop" } as const;

async function readBandwidth() {
  // Queries are serialized by the connection; read one at a time.
  return {
    rbw_hz: await num(`${B}:RESolution?`),
    rbw_auto: await bool(`${B}:RESolution:AUTO?`),
    vbw_hz: await num(`${B}:VIDeo?`),
    vbw_auto: await bool(`${B}:VIDeo:AUTO?`),
    vbw_rbw_ratio: await num(`${B}:VIDeo:RATio?`),
    filter_shape: pick(await connection.query(`${B}:SHAPe?`), SHAPES, "filter shape"),
  };
}

const BW_SHAPE = {
  rbw_hz: z.number().finite().optional().describe("Resolution bandwidth in Hz; snaps to 1-3-10 steps and is clamped to 1 Hz..max (3 MHz on the UTS3036B). Turns RBW auto off"),
  rbw_auto: z.boolean().optional().describe("Automatic RBW (follows the span); not with rbw_hz"),
  vbw_hz: z.number().finite().optional().describe("Video bandwidth in Hz (1-3-10 steps, clamped like RBW). Turns VBW auto off"),
  vbw_auto: z.boolean().optional().describe("Automatic VBW (RBW times vbw_rbw_ratio); not with vbw_hz"),
  vbw_rbw_ratio: z.number().finite().optional().describe("VBW/RBW ratio used while VBW is automatic (3e-5..3e6 on the UTS3036B; clamped)"),
  filter_shape: z.enum(["gaussian", "flattop"]).optional().describe("Resolution filter shape"),
};

// ---------------- sweep and trigger ----------------

const SWEEP_TYPES = { sweep: "SWEep", fft: "FFT" } as const;
const RULES = { normal: "NORMal", accuracy: "ACCuracy" } as const;
// EXTernal is documented but the UTS3036B rejects it with -224.
const TRIGGERS = { immediate: "IMMediate", video: "VIDeo" } as const;

async function readSweep() {
  return {
    sweep_time_s: await num(`${S}:TIME?`),
    sweep_time_auto: await bool(`${S}:TIME:AUTO?`),
    sweep_time_rule: pick(await connection.query(`${S}:TIME:AUTO:RULes?`), RULES, "sweep time rule"),
    sweep_type: pick(await connection.query(`${S}:TYPE?`), SWEEP_TYPES, "sweep type"),
    sweep_type_auto: await bool(`${S}:TYPE:AUTO?`),
    sweep_points: await num(`${S}:POINts?`),
    trigger_source: pick(await connection.query(`${T}:SOURce?`), TRIGGERS, "trigger source"),
    trigger_video_level_dbm: await num(`${T}:VIDeo:LEVel?`),
  };
}

const SWEEP_SHAPE = {
  sweep_points: z.number().finite().optional().describe("Sweep points, integer 11..40001. Changes the trace length (trace data has this many values)"),
  sweep_time_s: z.number().finite().optional().describe("Sweep time in seconds (1 ms..4000 s, clamped; zero span allows less). Turns sweep time auto off"),
  sweep_time_auto: z.boolean().optional().describe("Automatic sweep time; not with sweep_time_s"),
  sweep_time_rule: z.enum(["normal", "accuracy"]).optional().describe("Automatic sweep time rule"),
  sweep_type: z.enum(["sweep", "fft"]).optional().describe("Sweep type (turns automatic type off)"),
  sweep_type_auto: z.boolean().optional().describe("Automatic sweep type; not with sweep_type"),
  trigger_source: z.enum(["immediate", "video"]).optional().describe("Trigger source: immediate (free run) or video. External is rejected by the UTS3036B"),
  trigger_video_level_dbm: z.number().finite().optional().describe("Video trigger level in dBm (clamped to -170..30)"),
};

// ---------------- detector ----------------

const DETECTORS = { sample: "SAMPle", positive: "POSitive", negative: "NEGative", normal: "NORMal", average: "AVERage" } as const;
type DetectorName = keyof typeof DETECTORS;

async function readDetector(trace: number) {
  // Per-trace form (ambiguity 11): :DETector[:FUNCtion] is for measurements, not for spectrum traces.
  const detector = pick(await connection.query(`:SENSe:DETector:TRACe${trace}?`), DETECTORS, "detector");
  const auto = await bool(`:SENSe:DETector:TRACe${trace}:AUTO?`);
  return { trace, detector, auto };
}

const TRACE = z.number().int().min(1).max(6);

export function registerBandwidthSweepTools(server: McpServer): void {
  server.tool(
    "get_bandwidth",
    "Get resolution and video bandwidth (Hz) with their auto flags, the VBW/RBW ratio and the filter shape (gaussian or flattop).",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readBandwidth(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "set_bandwidth",
    "Set RBW, VBW, the VBW/RBW ratio and the filter shape. Manual values turn the matching auto flag off. The instrument snaps/clamps " +
      "values and couples RBW, VBW and sweep time to the span and auto flags, so everything is re-read afterwards and any change is reported in 'warnings'.",
    BW_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        if (!hasAny(args)) return errorResult("No parameters given; provide at least one setting.");
        for (const k of ["rbw_hz", "vbw_hz", "vbw_rbw_ratio"] as const) {
          if (args[k] !== undefined && !(args[k]! > 0)) return errorResult(`${k} must be greater than 0.`);
        }
        if (args.rbw_hz !== undefined && args.rbw_auto === true) return errorResult("rbw_hz and rbw_auto=true conflict.");
        if (args.vbw_hz !== undefined && args.vbw_auto === true) return errorResult("vbw_hz and vbw_auto=true conflict.");

        // Order: shape, RBW (VBW auto follows it), ratio, then VBW.
        const commands: string[] = [];
        if (args.filter_shape !== undefined) commands.push(`${B}:SHAPe ${SHAPES[args.filter_shape]}`);
        if (args.rbw_hz !== undefined) commands.push(`${B}:RESolution ${formatNumber(args.rbw_hz)}`);
        if (args.rbw_auto !== undefined) commands.push(`${B}:RESolution:AUTO ${onOff(args.rbw_auto)}`);
        if (args.vbw_rbw_ratio !== undefined) commands.push(`${B}:VIDeo:RATio ${formatNumber(args.vbw_rbw_ratio)}`);
        if (args.vbw_hz !== undefined) commands.push(`${B}:VIDeo ${formatNumber(args.vbw_hz)}`);
        if (args.vbw_auto !== undefined) commands.push(`${B}:VIDeo:AUTO ${onOff(args.vbw_auto)}`);
        await applyCommands(commands);

        const state = await readBandwidth();
        const warnings: string[] = [];
        const checks: Array<[string, number | undefined, number, string]> = [
          ["rbw_hz", args.rbw_hz, state.rbw_hz, "Hz"],
          ["vbw_hz", args.vbw_hz, state.vbw_hz, "Hz"],
          ["vbw_rbw_ratio", args.vbw_rbw_ratio, state.vbw_rbw_ratio, ""],
        ];
        for (const [name, requested, actual, unit] of checks) {
          if (requested !== undefined && !close(requested, actual)) {
            warnings.push(`${name} adjusted by the instrument: requested ${requested} ${unit}, now ${actual} ${unit}`.trim());
          }
        }
        if (args.filter_shape !== undefined && args.filter_shape !== state.filter_shape) {
          warnings.push(`filter_shape adjusted by the instrument: requested ${args.filter_shape}, now ${state.filter_shape}`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return failure(err, "get_bandwidth");
      }
    }
  );

  server.tool(
    "get_sweep",
    "Get sweep settings: sweep time (s) with auto flag and auto rule, sweep type (sweep/fft) with auto flag, sweep points (the trace length), " +
      "trigger source (immediate/video) and video trigger level (dBm).",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readSweep(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "set_sweep",
    "Set sweep points, sweep time, sweep type, trigger source and video trigger level. Points, type and rule are applied before the sweep time so a manual " +
      "time is not overridden by the auto coupling. Changing sweep_points changes the trace length. Out-of-range values are clamped silently by the " +
      "instrument; settings are re-read afterwards and any change is reported in 'warnings'.",
    SWEEP_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        if (!hasAny(args)) return errorResult("No parameters given; provide at least one setting.");
        if (args.sweep_points !== undefined && (!Number.isInteger(args.sweep_points) || args.sweep_points < 11 || args.sweep_points > 40001)) {
          return errorResult("sweep_points must be an integer from 11 to 40001.");
        }
        if (args.sweep_time_s !== undefined && !(args.sweep_time_s > 0)) return errorResult("sweep_time_s must be greater than 0.");
        if (args.sweep_time_s !== undefined && args.sweep_time_auto === true) return errorResult("sweep_time_s and sweep_time_auto=true conflict.");
        if (args.sweep_type !== undefined && args.sweep_type_auto === true) return errorResult("sweep_type and sweep_type_auto=true conflict.");

        const commands: string[] = [];
        if (args.sweep_points !== undefined) commands.push(`${S}:POINts ${args.sweep_points}`);
        if (args.sweep_type !== undefined) commands.push(`${S}:TYPE ${SWEEP_TYPES[args.sweep_type]}`);
        if (args.sweep_type_auto !== undefined) commands.push(`${S}:TYPE:AUTO ${onOff(args.sweep_type_auto)}`);
        if (args.sweep_time_rule !== undefined) commands.push(`${S}:TIME:AUTO:RULes ${RULES[args.sweep_time_rule]}`);
        if (args.sweep_time_auto !== undefined) commands.push(`${S}:TIME:AUTO ${onOff(args.sweep_time_auto)}`);
        if (args.trigger_source !== undefined) commands.push(`${T}:SOURce ${TRIGGERS[args.trigger_source]}`);
        if (args.trigger_video_level_dbm !== undefined) commands.push(`${T}:VIDeo:LEVel ${formatNumber(args.trigger_video_level_dbm)}`);
        if (args.sweep_time_s !== undefined) commands.push(`${S}:TIME ${formatNumber(args.sweep_time_s)}`);
        await applyCommands(commands);

        const state = await readSweep();
        const warnings: string[] = [];
        const checks: Array<[string, number | undefined, number, string]> = [
          ["sweep_points", args.sweep_points, state.sweep_points, ""],
          ["sweep_time_s", args.sweep_time_s, state.sweep_time_s, "s"],
          ["trigger_video_level_dbm", args.trigger_video_level_dbm, state.trigger_video_level_dbm, "dBm"],
        ];
        for (const [name, requested, actual, unit] of checks) {
          if (requested !== undefined && !close(requested, actual)) {
            warnings.push(`${name} adjusted by the instrument: requested ${requested} ${unit}, now ${actual} ${unit}`.trim());
          }
        }
        for (const [name, requested, actual] of [
          ["sweep_type", args.sweep_type, state.sweep_type],
          ["sweep_time_rule", args.sweep_time_rule, state.sweep_time_rule],
          ["trigger_source", args.trigger_source, state.trigger_source],
        ] as const) {
          if (requested !== undefined && requested !== actual) {
            warnings.push(`${name} adjusted by the instrument: requested ${requested}, now ${actual}`);
          }
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return failure(err, "get_sweep");
      }
    }
  );

  server.tool(
    "get_detector",
    "Get the detector (sample, positive, negative, normal, average) and its auto flag for one trace (1-6) or all six, via :SENSe:DETector:TRACe<n>.",
    { trace: TRACE.optional().describe("Trace number 1-6; all traces when omitted") },
    { readOnlyHint: true },
    async ({ trace }) => {
      try {
        const traces = [];
        for (const n of trace !== undefined ? [trace] : [1, 2, 3, 4, 5, 6]) traces.push(await readDetector(n));
        return textResult(JSON.stringify({ traces }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "set_detector",
    "Set the detector of one trace (1-6): sample, positive, negative, normal or average (turns that trace's automatic detector off), or switch automatic selection on/off.",
    {
      trace: TRACE.describe("Trace number 1-6"),
      detector: z.enum(["sample", "positive", "negative", "normal", "average"]).optional().describe("Detector mode"),
      auto: z.boolean().optional().describe("Automatic detector selection for the trace; not with detector=..."),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ trace, detector, auto }) => {
      try {
        if (detector === undefined && auto === undefined) return errorResult("No parameters given; provide detector or auto.");
        if (detector !== undefined && auto === true) return errorResult("detector and auto=true conflict.");
        const commands: string[] = [];
        if (detector !== undefined) commands.push(`:SENSe:DETector:TRACe${trace} ${DETECTORS[detector]}`);
        if (auto !== undefined) commands.push(`:SENSe:DETector:TRACe${trace}:AUTO ${onOff(auto)}`);
        await applyCommands(commands);

        const state = await readDetector(trace);
        const warnings: string[] = [];
        if (detector !== undefined && (state.detector as DetectorName) !== detector) {
          warnings.push(`detector adjusted by the instrument: requested ${detector}, now ${state.detector}`);
        }
        if (auto !== undefined && state.auto !== auto) {
          warnings.push(`auto adjusted by the instrument: requested ${auto}, now ${state.auto}`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return failure(err, "get_detector");
      }
    }
  );
}
