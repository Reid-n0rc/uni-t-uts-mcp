import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/research/analog-demodulation.md sections 2-3 (AD chapter, programming manual
// pp.147-160). AD module must be active (enter_analog_demod/select_instrument_module). Every
// AD SENSe-style command takes an `AM|FM` prefix after the root; the prefix in use is read from
// `:CONFigure?` each call rather than assumed, since AM/FM can change independently of this
// server's own calls (e.g. the front panel, or a future `enter_analog_demod` type argument).
//
// Live-verified (docs/verified-hardware.md, "Analog demodulation (AD) module (2026-11-11...)"):
// `:AM:FREQuency:SPAN?`, `:AM:BANDwidth:CHANnel?`, `:AM:BANDwidth:RESolution?`,
// `:AM:AFSPectrum:FREQuency:STARt?`/`:STOP?`, `:AM:DWSWeep:TIME?`, `:INITiate:CONTinuous?`,
// `:SENSe:CORRection:IMPedance:INPut:MAGNitude?`. NOT yet live-verified (still research-doc only):
// `:CONFigure?` itself, `:AM:DEMod:TIME?`/`:AUTO?`, `:AM:AVERage:STATe?`/`:COUNt?`, the FM-prefixed
// forms, and every setter in this file (the probe session that confirmed the getters above ran out
// of time before any setter was tried) — ranges below come from the programming manual via the
// research doc and are UNKNOWN to clamp-vs-error until probed live (section 4, risk 5: "trust no
// example without a live probe").

const DEMOD_TYPES = { AM: "AM", FM: "FM" } as const;
export type DemodType = keyof typeof DEMOD_TYPES;

/** Shared with adAudio.ts (#194): every AD SENSe-style command takes the AM|FM prefix, read fresh each call. */
export async function readDemodType(): Promise<DemodType> {
  return queryParsed(":CONFigure?", (reply) => {
    const text = reply.trim().toUpperCase();
    if (text === "AM" || text === "FM") return text;
    throw new Error(`Unexpected reply to :CONFigure?: ${JSON.stringify(reply)}`);
  });
}

export interface AdSettings {
  demod_type: DemodType;
  center_hz: number;
  center_step_hz: number;
  center_step_auto: boolean;
  span_hz: number;
  rbw_hz: number;
  rbw_auto: boolean;
  demod_bandwidth_hz: number;
  af_start_hz: number;
  af_stop_hz: number;
  af_rbw_hz: number;
  af_rbw_auto: boolean;
  window_sweep_time_s: number;
  demod_time_s: number;
  demod_time_auto: boolean;
  average_state: boolean;
  average_count: number;
  input_impedance_ohm: number;
}

async function readAdSettings(): Promise<AdSettings> {
  const demod_type = await readDemodType();
  const p = `:${demod_type}`;
  return {
    demod_type,
    center_hz: await queryNumber(":FREQuency:CENTer?"),
    center_step_hz: await queryNumber(":FREQuency:CENTer:STEP?"),
    center_step_auto: await queryBool(":FREQuency:CENTer:STEP:AUTO?"),
    span_hz: await queryNumber(`${p}:FREQuency:SPAN?`),
    rbw_hz: await queryNumber(`${p}:BANDwidth:RESolution?`),
    rbw_auto: await queryBool(`${p}:BANDwidth:RESolution:AUTO?`),
    demod_bandwidth_hz: await queryNumber(`${p}:BANDwidth:CHANnel?`),
    af_start_hz: await queryNumber(`${p}:AFSPectrum:FREQuency:STARt?`),
    af_stop_hz: await queryNumber(`${p}:AFSPectrum:FREQuency:STOP?`),
    af_rbw_hz: await queryNumber(`${p}:AFSPectrum:BANDwidth?`),
    af_rbw_auto: await queryBool(`${p}:AFSPectrum:BANDwidth:AUTO?`),
    window_sweep_time_s: await queryNumber(`${p}:DWSWeep:TIME?`),
    demod_time_s: await queryNumber(`${p}:DEMod:TIME?`),
    demod_time_auto: await queryBool(`${p}:DEMod:TIME:AUTO?`),
    average_state: await queryBool(`${p}:AVERage:STATe?`),
    average_count: await queryNumber(`${p}:AVERage:COUNt?`),
    input_impedance_ohm: await queryNumber(":SENSe:CORRection:IMPedance:INPut:MAGNitude?"),
  };
}

const hz = (description: string) => z.number().finite().positive().optional().describe(description);

const FREQUENCY_SHAPE = {
  center_hz: z.number().finite().min(50).optional().describe("Center frequency in Hz, 50 Hz to the instrument's max minus 50 Hz (manual; UNKNOWN to clamp vs error)"),
  span_hz: z.number().finite().min(100).max(12.8e6).optional().describe("RF sweep width in Hz, 100 Hz to 12.8 MHz (manual)"),
  rbw_hz: z.number().finite().min(100).max(1e6).optional().describe("RF resolution bandwidth in Hz, 100 Hz to 1 MHz (manual; exact step list is 1-1.5-2-3-5-7.5-10, ambiguous in the manual)"),
  rbw_auto: z.boolean().optional().describe("Automatic RF resolution bandwidth on/off"),
  demod_bandwidth_hz: hz("Demodulation bandwidth (DBW) in Hz, 400 Hz to 25 MHz (manual; the range text is ambiguous)"),
  center_step_hz: hz("Center frequency step in Hz; turns the automatic step off"),
  center_step_auto: z.boolean().optional().describe("Automatic center frequency step on/off"),
};
type FrequencyArgs = { [K in keyof typeof FREQUENCY_SHAPE]?: z.infer<(typeof FREQUENCY_SHAPE)[K]> };

function validateFrequency(a: FrequencyArgs): string | undefined {
  const given = Object.values(a).some((v) => v !== undefined);
  if (!given) return "No parameters given.";
  if (a.center_step_hz !== undefined && a.center_step_auto === true) {
    return "center_step_hz and center_step_auto=true conflict.";
  }
  return undefined;
}

function buildFrequencyCommands(p: string, a: FrequencyArgs): string[] {
  const commands: string[] = [];
  if (a.center_hz !== undefined) commands.push(`:FREQuency:CENTer ${formatNumber(a.center_hz)}`);
  if (a.center_step_auto !== undefined) commands.push(`:FREQuency:CENTer:STEP:AUTO ${a.center_step_auto ? "ON" : "OFF"}`);
  if (a.center_step_hz !== undefined) commands.push(`:FREQuency:CENTer:STEP ${formatNumber(a.center_step_hz)}`);
  if (a.span_hz !== undefined) commands.push(`${p}:FREQuency:SPAN ${formatNumber(a.span_hz)}`);
  if (a.rbw_auto !== undefined) commands.push(`${p}:BANDwidth:RESolution:AUTO ${a.rbw_auto ? "ON" : "OFF"}`);
  if (a.rbw_hz !== undefined) commands.push(`${p}:BANDwidth:RESolution ${formatNumber(a.rbw_hz)}`);
  if (a.demod_bandwidth_hz !== undefined) commands.push(`${p}:BANDwidth:CHANnel ${formatNumber(a.demod_bandwidth_hz)}`);
  return commands;
}

async function readFrequencyState(p: string, a: FrequencyArgs) {
  const result: Record<string, unknown> = {};
  if (a.center_hz !== undefined) result.center_hz = await queryNumber(":FREQuency:CENTer?");
  if (a.center_step_hz !== undefined) result.center_step_hz = await queryNumber(":FREQuency:CENTer:STEP?");
  if (a.center_step_auto !== undefined) result.center_step_auto = await queryBool(":FREQuency:CENTer:STEP:AUTO?");
  if (a.span_hz !== undefined) result.span_hz = await queryNumber(`${p}:FREQuency:SPAN?`);
  if (a.rbw_hz !== undefined) result.rbw_hz = await queryNumber(`${p}:BANDwidth:RESolution?`);
  if (a.rbw_auto !== undefined) result.rbw_auto = await queryBool(`${p}:BANDwidth:RESolution:AUTO?`);
  if (a.demod_bandwidth_hz !== undefined) result.demod_bandwidth_hz = await queryNumber(`${p}:BANDwidth:CHANnel?`);
  return result;
}

function warnFrequencyDifferences(a: FrequencyArgs, actual: Record<string, unknown>, warnings: string[]): void {
  const simple = (key: keyof FrequencyArgs) => {
    const want = a[key];
    if (want === undefined) return;
    const got = actual[key];
    if (got !== want) warnings.push(`${key} adjusted by the instrument: requested ${JSON.stringify(want)}, now ${JSON.stringify(got)}`);
  };
  simple("center_hz");
  simple("center_step_hz");
  simple("center_step_auto");
  simple("span_hz");
  simple("rbw_hz");
  simple("rbw_auto");
  simple("demod_bandwidth_hz");
}

const TIMING_SHAPE = {
  window_sweep_time_s: z.number().finite().min(1e-6).max(0.5).optional().describe("Demodulation window sweep time in seconds, 1 us to 500 ms (manual)"),
  demod_time_s: z.number().finite().positive().optional().describe("Demodulation time in seconds (manual gives no upper bound; auto is 36x the window sweep time)"),
  demod_time_auto: z.boolean().optional().describe("Automatic demodulation time on/off"),
  average_state: z.boolean().optional().describe("Averaging on/off"),
  average_count: z.number().int().min(1).max(999).optional().describe("Average count, 1 to 999 (manual)"),
};
type TimingArgs = { [K in keyof typeof TIMING_SHAPE]?: z.infer<(typeof TIMING_SHAPE)[K]> };

function validateTiming(a: TimingArgs): string | undefined {
  const given = Object.values(a).some((v) => v !== undefined);
  if (!given) return "No parameters given.";
  if (a.demod_time_s !== undefined && a.demod_time_auto === true) {
    return "demod_time_s and demod_time_auto=true conflict.";
  }
  return undefined;
}

function buildTimingCommands(p: string, a: TimingArgs): string[] {
  const commands: string[] = [];
  if (a.window_sweep_time_s !== undefined) commands.push(`${p}:DWSWeep:TIME ${formatNumber(a.window_sweep_time_s)}`);
  if (a.demod_time_auto !== undefined) commands.push(`${p}:DEMod:TIME:AUTO ${a.demod_time_auto ? "ON" : "OFF"}`);
  if (a.demod_time_s !== undefined) commands.push(`${p}:DEMod:TIME ${formatNumber(a.demod_time_s)}`);
  if (a.average_state !== undefined) commands.push(`${p}:AVERage:STATe ${a.average_state ? "ON" : "OFF"}`);
  if (a.average_count !== undefined) commands.push(`${p}:AVERage:COUNt ${a.average_count}`);
  return commands;
}

async function readTimingState(p: string, a: TimingArgs) {
  const result: Record<string, unknown> = {};
  if (a.window_sweep_time_s !== undefined) result.window_sweep_time_s = await queryNumber(`${p}:DWSWeep:TIME?`);
  if (a.demod_time_s !== undefined) result.demod_time_s = await queryNumber(`${p}:DEMod:TIME?`);
  if (a.demod_time_auto !== undefined) result.demod_time_auto = await queryBool(`${p}:DEMod:TIME:AUTO?`);
  if (a.average_state !== undefined) result.average_state = await queryBool(`${p}:AVERage:STATe?`);
  if (a.average_count !== undefined) result.average_count = await queryNumber(`${p}:AVERage:COUNt?`);
  return result;
}

function warnTimingDifferences(a: TimingArgs, actual: Record<string, unknown>, warnings: string[]): void {
  const simple = (key: keyof TimingArgs) => {
    const want = a[key];
    if (want === undefined) return;
    const got = actual[key];
    if (got !== want) warnings.push(`${key} adjusted by the instrument: requested ${JSON.stringify(want)}, now ${JSON.stringify(got)}`);
  };
  simple("window_sweep_time_s");
  simple("demod_time_s");
  simple("demod_time_auto");
  simple("average_state");
  simple("average_count");
}

export function registerAdSettingsTools(server: McpServer): void {
  defineTool(
    server,
    "get_ad_settings",
    "Get a read-only snapshot of the AD (analog demodulation) module's frequency, bandwidth and demod-timing settings: " +
      "current demodulation type (AM/FM, via :CONFigure?), center frequency and step, RF span and resolution bandwidth, " +
      "demodulation bandwidth, AF spectrum start/stop and bandwidth, demod window sweep time, demod time and averaging, " +
      "and input impedance. AD module must be active (enter_analog_demod/select_instrument_module). Filters, audio and " +
      "display/marker settings are not included here (separate tool groups). A silent or malformed reply to any query is " +
      "an error naming that command; no partial snapshot is ever returned. :CONFigure? and most of these getters are not " +
      "yet live-verified on this firmware (docs/verified-hardware.md); treat results as plausible, not confirmed.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readAdSettings(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "ad" }
  );

  defineTool(
    server,
    "set_ad_frequency",
    "Configure the AD module's center frequency, RF span, resolution bandwidth and demodulation bandwidth (DBW). AD module " +
      "must be active. The AM/FM prefix is read fresh from :CONFigure? each call. Ranges come from the programming manual " +
      "and are not yet live-verified: whether the instrument clamps or errors out of range is UNKNOWN. Everything requested " +
      "is re-read afterwards and any instrument-adjusted value is reported in 'warnings'. Leaves the new state (nothing is " +
      "restored).",
    FREQUENCY_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const demod_type = await readDemodType();
        const p = `:${demod_type}`;
        await applyCommands(buildFrequencyCommands(p, args));
        const actual = await readBack(() => readFrequencyState(p, args));
        const warnings: string[] = [];
        warnFrequencyDifferences(args, actual, warnings);
        return textResult(JSON.stringify({ demod_type, ...actual, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "set_ad_frequency");
      }
    },
    { validate: validateFrequency, requireModule: "ad" }
  );

  defineTool(
    server,
    "set_ad_demod_timing",
    "Configure the AD module's demodulation window sweep time, demodulation time (or automatic), and averaging state/count. " +
      "AD module must be active. The AM/FM prefix is read fresh from :CONFigure? each call. Ranges come from the programming " +
      "manual and are not yet live-verified. Everything requested is re-read afterwards and any instrument-adjusted value is " +
      "reported in 'warnings'. Leaves the new state (nothing is restored).",
    TIMING_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const demod_type = await readDemodType();
        const p = `:${demod_type}`;
        await applyCommands(buildTimingCommands(p, args));
        const actual = await readBack(() => readTimingState(p, args));
        const warnings: string[] = [];
        warnTimingDifferences(args, actual, warnings);
        return textResult(JSON.stringify({ demod_type, ...actual, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "set_ad_demod_timing");
      }
    },
    { validate: validateTiming, requireModule: "ad" }
  );
}
