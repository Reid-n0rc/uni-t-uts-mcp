import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack, ReplyError } from "../instrument.js";
import { formatNumber, onOff, parseBool, parseNumber, parseNumberList } from "../scpi.js";
import { defineTool, errorResult, setterFailure, textResult } from "./util.js";

// Commands: docs/programming-guide.md section 7. Behavior verified on the UTS3036B (docs/verified-hardware.md,
// "Measurements"): NO query reports the active measurement, :CONFigure:<meas> presets span/RBW/sweep and
// :CONFigure:SANalyzer does not put them back, and a query that belongs to another mode gets no reply.

// A probe that misses makes the instrument stall (about 2.15 s over raw TCP, verified-hardware.md), and writes sent
// meanwhile are lost (raw) or blocked until the stall ends (VXI-11, where a blocked write can even time out and
// drop the link). So after every miss the next probe waits out the stall, and the timeout stays short.
const PROBE_TIMEOUT_MS = 1500;
/** Pause after a probe that got no reply, and the settle time before a FETCh of a just-entered measurement. Mutable so tests do not sleep. */
export const probeTuning = { recoveryMs: 3000, settleMs: 1500 };

const DEFAULT_READ_TIMEOUT_S = 30;
const SA = "spectrum_analyzer" as const;

const MEASUREMENTS = {
  channel_power: "CHPower", time_power: "TPOWer", obw: "OBWidth", acpr: "ACPower", toi: "TOI", cn: "CNRatio", harmonics: "HARMonics",
} as const;
type Measurement = keyof typeof MEASUREMENTS;
type Mode = Measurement | typeof SA;
const MEASUREMENT_NAMES = Object.keys(MEASUREMENTS) as [Measurement, ...Measurement[]];
const MEASUREMENT = z.enum(MEASUREMENT_NAMES);

const AVERAGE_TYPES = { voltage: "VOLTage", power: "POWEr", log: "LOG" } as const;
const AVERAGE_CONTROLS = { exponential: "EXPonential", repeat: "REPeat" } as const;

const sense = (m: Measurement) => `:SENSe:${MEASUREMENTS[m]}`;

function pick<T extends string>(reply: string, table: Record<T, string>, what: string): T {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(table) as Array<[T, string]>) {
    if (raw.toUpperCase() === text) return name;
  }
  throw new Error(`Unexpected ${what} ${JSON.stringify(reply)}`);
}

const close = (requested: number, actual: number) => Math.abs(requested - actual) <= Math.max(1e-12, 1e-5 * Math.abs(requested));

// ---------------- parameters ----------------

const PARAMS = {
  average: z.boolean().optional().describe("Measurement averaging on/off"),
  average_count: z.number().finite().optional().describe("Averages, integer 1-999 (manual range)"),
  average_control: z.enum(["exponential", "repeat"]).optional().describe("Average termination control"),
  average_type: z.enum(["voltage", "power", "log"]).optional().describe("Average type"),
  integration_bandwidth_hz: z.number().finite().optional().describe("channel_power, acpr or cn: integration bandwidth in Hz (channel_power: clamped by the instrument to 100 Hz..3.61 GHz)"),
  left_limit_s: z.number().finite().optional().describe("time_power only: left limit in s, 0-0.01 (10 ms)"),
  right_limit_s: z.number().finite().optional().describe("time_power only: right limit in s, 0-0.01 (10 ms)"),
  percent: z.number().finite().optional().describe("obw only: occupied power fraction, above 0 up to 1 (0.99 = 99 %); the instrument clamps to 0.9999"),
  xdb: z.number().finite().optional().describe("obw only: x dB level in dB, -100 to -0.1"),
  carrier_bandwidth_hz: z.number().finite().optional().describe("acpr only: carrier (main channel) bandwidth in Hz"),
  offset_hz: z.number().finite().optional().describe("acpr or cn: offset of the adjacent channel (acpr) or of the noise (cn) from the carrier, in Hz, 0 or more"),
  offset_side: z.enum(["both", "negative", "positive"]).optional().describe("acpr only: which adjacent channels to measure"),
  noise_bandwidth_hz: z.number().finite().optional().describe("cn only: noise bandwidth in Hz"),
  fundamental_hz: z.number().finite().optional().describe("harmonics only: fundamental frequency in Hz"),
  harmonics_count: z.number().finite().optional().describe("harmonics only: number of results including the fundamental, integer 2-10 (the preset is 2)"),
  sweep_time_s: z.number().finite().optional().describe("harmonics only: sweep time in s, 0.001-100"),
};
type ParamArgs = { [K in keyof typeof PARAMS]?: z.infer<(typeof PARAMS)[K]> };
const PARAM_KEYS = Object.keys(PARAMS) as Array<keyof typeof PARAMS>;

// Measurement specific parameters in the order they are sent (the harmonics count last, after the sweep time).
const SPECIFIC: Record<Measurement, Array<keyof typeof PARAMS>> = {
  channel_power: ["integration_bandwidth_hz"],
  time_power: ["left_limit_s", "right_limit_s"],
  obw: ["percent", "xdb"],
  acpr: ["integration_bandwidth_hz", "carrier_bandwidth_hz", "offset_hz", "offset_side"],
  toi: [],
  cn: ["integration_bandwidth_hz", "noise_bandwidth_hz", "offset_hz"],
  harmonics: ["fundamental_hz", "sweep_time_s", "harmonics_count"],
};
const ALL_SPECIFIC = [...new Set(Object.values(SPECIFIC).flat())];

const SIDES = { both: "BOTH", negative: "NEGative", positive: "POSitive" } as const;

/** SCPI path (after :SENSe:<meas>:) of each specific parameter, per measurement. */
const PATHS: Partial<Record<keyof typeof PARAMS, Partial<Record<Measurement, string>>>> = {
  integration_bandwidth_hz: { channel_power: "BANDwidth:INTegration", acpr: "BANDwidth:INTegration", cn: "BANDwidth:INTegration" },
  left_limit_s: { time_power: "LLIMit" },
  right_limit_s: { time_power: "RLIMit" },
  percent: { obw: "PERCent" },
  xdb: { obw: "XDB" },
  carrier_bandwidth_hz: { acpr: "CARRier:LIST:BANDwidth" },
  offset_hz: { acpr: "OFFSet:LIST:FREQuency", cn: "OFFSet" },
  offset_side: { acpr: "OFFSet:LIST:SIDE" },
  noise_bandwidth_hz: { cn: "BANDwidth:NOISe" },
  fundamental_hz: { harmonics: "FREQuency:FUNDamental" },
  harmonics_count: { harmonics: "NUMBer" },
  sweep_time_s: { harmonics: "SWEeptime" },
};

function validateParams(measurement: Measurement, a: ParamArgs): string | undefined {
  for (const key of ALL_SPECIFIC) {
    if (a[key] !== undefined && !SPECIFIC[measurement].includes(key)) {
      const owners = (Object.keys(SPECIFIC) as Measurement[]).filter((m) => SPECIFIC[m].includes(key));
      return `${key} applies to ${owners.join(" or ")} only, not ${measurement}.`;
    }
  }
  if (a.average_count !== undefined && (!Number.isInteger(a.average_count) || a.average_count < 1 || a.average_count > 999)) {
    return "average_count must be an integer from 1 to 999.";
  }
  for (const key of ["integration_bandwidth_hz", "carrier_bandwidth_hz", "noise_bandwidth_hz", "fundamental_hz"] as const) {
    if (a[key] !== undefined && !(a[key]! > 0)) return `${key} must be greater than 0.`;
  }
  if (a.offset_hz !== undefined && !(a.offset_hz >= 0)) return "offset_hz must be 0 or more.";
  if (a.harmonics_count !== undefined && (!Number.isInteger(a.harmonics_count) || a.harmonics_count < 2 || a.harmonics_count > 10)) {
    return "harmonics_count must be an integer from 2 to 10.";
  }
  if (a.sweep_time_s !== undefined && !(a.sweep_time_s >= 0.001 && a.sweep_time_s <= 100)) return "sweep_time_s must be between 0.001 and 100 s.";
  for (const key of ["left_limit_s", "right_limit_s"] as const) {
    const v = a[key];
    if (v !== undefined && !(v >= 0 && v <= 0.01)) return `${key} must be between 0 and 0.01 s.`;
  }
  if (a.percent !== undefined && !(a.percent > 0 && a.percent <= 1)) return "percent must be greater than 0 and at most 1 (0.99 = 99 %).";
  if (a.xdb !== undefined && !(a.xdb >= -100 && a.xdb <= -0.1)) return "xdb must be between -100 and -0.1 dB.";
  return undefined;
}

/** Setter commands for the given parameter values (order: average settings, measurement specific, then the count). */
function paramCommands(m: Measurement, a: ParamArgs): string[] {
  const s = sense(m);
  const out: string[] = [];
  if (a.average !== undefined) out.push(`${s}:AVERage:STATe ${onOff(a.average)}`);
  if (a.average_type !== undefined) out.push(`${s}:AVERage:TYPE ${AVERAGE_TYPES[a.average_type]}`);
  if (a.average_control !== undefined) out.push(`${s}:AVERage:TCONtrol ${AVERAGE_CONTROLS[a.average_control]}`);
  for (const key of SPECIFIC[m]) {
    const v = a[key];
    if (v === undefined) continue;
    const path = PATHS[key]![m];
    out.push(`${s}:${path} ${key === "harmonics_count" ? v : key === "offset_side" ? SIDES[v as keyof typeof SIDES] : formatNumber(v as number)}`);
  }
  if (a.average_count !== undefined) out.push(`${s}:AVERage:COUNt ${a.average_count}`);
  return out;
}

type ParamState = Required<Pick<ParamArgs, "average" | "average_count" | "average_control" | "average_type">> & ParamArgs;

async function readParams(m: Measurement): Promise<ParamState> {
  const s = sense(m);
  const state: ParamState = {
    average: await queryBool(`${s}:AVERage:STATe?`),
    average_count: await queryParsed(`${s}:AVERage:COUNt?`, (r) => {
      const n = Number(r.trim());
      if (!Number.isInteger(n)) throw new Error(`Expected an integer, got ${JSON.stringify(r)}`);
      return n;
    }),
    average_control: await queryParsed(`${s}:AVERage:TCONtrol?`, (r) => pick(r, AVERAGE_CONTROLS, "average control")),
    average_type: await queryParsed(`${s}:AVERage:TYPE?`, (r) => pick(r, AVERAGE_TYPES, "average type")),
  };
  for (const key of SPECIFIC[m]) {
    const command = `${s}:${PATHS[key]![m]}?`;
    if (key === "offset_side") state.offset_side = await queryParsed(command, (r) => pick(r, SIDES, "offset side"));
    else if (key === "harmonics_count") {
      state.harmonics_count = await queryParsed(command, (r) => {
        const n = Number(r.trim());
        if (!Number.isInteger(n)) throw new Error(`Expected an integer, got ${JSON.stringify(r)}`);
        return n;
      });
    } else (state as Record<string, unknown>)[key] = await queryNumber(command);
  }
  return state;
}

function paramWarnings(requested: ParamArgs, actual: ParamArgs): string[] {
  const warnings: string[] = [];
  for (const key of PARAM_KEYS) {
    const want = requested[key];
    const got = actual[key];
    if (want === undefined) continue;
    const same = typeof want === "number" && typeof got === "number" ? close(want, got) : want === got;
    if (!same) warnings.push(`${key} adjusted by the instrument: requested ${want}, now ${got}`);
  }
  return warnings;
}

// ---------------- mode detection ----------------

const isTimeout = (err: unknown) => err instanceof Error && /^Query timeout/.test(err.message);

/** A probe that got no reply: its timeout message (which names the command). */
class ProbeMiss extends Error {}


/** Ask a query only one mode answers: its reply means that mode is active, a timeout is a ProbeMiss. Other failures propagate. */
async function probe<T>(command: string, parse: (reply: string) => T): Promise<T> {
  let reply: string;
  try {
    reply = await connection.query(command, PROBE_TIMEOUT_MS);
  } catch (err) {
    if (isTimeout(err)) {
      await new Promise((resolve) => setTimeout(resolve, probeTuning.recoveryMs));
      throw new ProbeMiss((err as Error).message);
    }
    throw err;
  }
  try {
    return parse(reply);
  } catch (err) {
    throw new ReplyError(command, reply, err instanceof Error ? err.message : String(err));
  }
}

/** Run a probe: true when the mode answered, false (with the timeout message kept in `misses`) when it did not. */
async function answers(misses: string[], command: string, parse: (reply: string) => unknown): Promise<boolean> {
  try {
    await probe(command, parse);
    return true;
  } catch (err) {
    if (err instanceof ProbeMiss) {
      misses.push(err.message);
      return false;
    }
    throw err;
  }
}

const DETECTORS = { sample: "SAMPle", positive: "POSitive", negative: "NEGative", normal: "NORMal", average: "AVERage" } as const;

/** Spectrum analyzer mode answers the per-trace detector query; the measurement modes do not (verified). */
const isSpectrumAnalyzer = (misses: string[] = []) =>
  answers(misses, ":SENSe:DETector:TRACe1?", (r) => pick(r, DETECTORS, "detector"));

const isActive = (m: Measurement, misses: string[] = []) => answers(misses, `${sense(m)}:AVERage:STATe?`, parseBool);

/**
 * There is no query for the active measurement and probing for it means asking queries that get no reply, which
 * stall the instrument (and over VXI-11 can drop the link), so the tools never scan: they ask whether the instrument is in
 * spectrum analyzer mode (one query that answers) and, only where it matters, whether ONE named measurement is active.
 */
function notSpectrumAnalyzer(misses: string[]): string {
  return `The instrument is not in spectrum analyzer mode (${misses.join("; ")}), so a measurement is active (or the instrument does not answer).`;
}

// ---------------- spectrum analyzer state (what a measurement preset overwrites) ----------------

interface SaState {
  center_hz: number;
  span_hz: number;
  rbw_hz: number;
  rbw_auto: boolean;
  vbw_hz: number;
  vbw_auto: boolean;
  sweep_time_s: number;
  sweep_time_auto: boolean;
  continuous: boolean;
}

async function readSa(): Promise<SaState> {
  return {
    center_hz: await queryNumber(":FREQuency:CENTer?"),
    span_hz: await queryNumber(":FREQuency:SPAN?"),
    rbw_hz: await queryNumber(":SENSe:BANDwidth:RESolution?"),
    rbw_auto: await queryBool(":SENSe:BANDwidth:RESolution:AUTO?"),
    vbw_hz: await queryNumber(":SENSe:BANDwidth:VIDeo?"),
    vbw_auto: await queryBool(":SENSe:BANDwidth:VIDeo:AUTO?"),
    sweep_time_s: await queryNumber(":SENSe:SWEep:TIME?"),
    sweep_time_auto: await queryBool(":SENSe:SWEep:TIME:AUTO?"),
    continuous: await queryBool(":INITiate:CONTinuous?"),
  };
}

/** Manual values are set (which turns the auto flag off); auto values are re-enabled and follow the span. */
function saCommands(s: SaState): string[] {
  return [
    `:FREQuency:CENTer ${formatNumber(s.center_hz)}`,
    `:FREQuency:SPAN ${formatNumber(s.span_hz)}`,
    s.rbw_auto ? ":SENSe:BANDwidth:RESolution:AUTO ON" : `:SENSe:BANDwidth:RESolution ${formatNumber(s.rbw_hz)}`,
    s.vbw_auto ? ":SENSe:BANDwidth:VIDeo:AUTO ON" : `:SENSe:BANDwidth:VIDeo ${formatNumber(s.vbw_hz)}`,
    s.sweep_time_auto ? ":SENSe:SWEep:TIME:AUTO ON" : `:SENSe:SWEep:TIME ${formatNumber(s.sweep_time_s)}`,
    `:INITiate:CONTinuous ${onOff(s.continuous)}`,
  ];
}

/** Fields of `got` that differ from `want`: `name` plus a description naming the actual and the wanted value. */
function saMismatches(want: SaState, got: SaState): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const add = (name: string, g: unknown, w: unknown) => out.push({ name, text: `${name} is ${g}, was ${w}` });
  const num = (name: string, w: number, g: number) => { if (!close(w, g)) add(name, g, w); };
  num("center_hz", want.center_hz, got.center_hz);
  num("span_hz", want.span_hz, got.span_hz);
  for (const [name, wantAuto, gotAuto, w, g] of [
    ["rbw", want.rbw_auto, got.rbw_auto, want.rbw_hz, got.rbw_hz],
    ["vbw", want.vbw_auto, got.vbw_auto, want.vbw_hz, got.vbw_hz],
    ["sweep_time", want.sweep_time_auto, got.sweep_time_auto, want.sweep_time_s, got.sweep_time_s],
  ] as const) {
    if (wantAuto !== gotAuto) add(`${name}_auto`, gotAuto, wantAuto);
    else if (!wantAuto) num(name === "sweep_time" ? "sweep_time_s" : `${name}_hz`, w, g);
  }
  if (want.continuous !== got.continuous) add("continuous", got.continuous, want.continuous);
  return out;
}

/** Settings saved when a measurement was entered from spectrum analyzer mode, for exit_measurement to put back. */
let savedSa: SaState | undefined;

/** For tests: forget the saved settings (the tool table runs every tool from a clean state). */
export function forgetSavedSettings(): void {
  savedSa = undefined;
}

/** Leave the measurement, check that spectrum analyzer mode is back, and (given a state) restore and verify the settings. */
async function exitMeasurement(restore: SaState | undefined): Promise<{ warnings: string[] }> {
  await applyCommands([":CONFigure:SANalyzer"]);
  const misses: string[] = [];
  if (!(await isSpectrumAnalyzer(misses))) {
    throw new Error(`The instrument is still in a measurement mode after :CONFigure:SANalyzer (${misses.join("; ")}). Check the instrument.`);
  }
  if (!restore) return { warnings: [] };
  await applyCommands(saCommands(restore));
  let mismatches = saMismatches(restore, await readBack(readSa));
  if (mismatches.length === 0) return { warnings: [] };
  // A setter can be lost (#133: the span once stayed at the measurement's 8 MHz although everything reported success): send everything once more.
  const first = mismatches;
  await new Promise((resolve) => setTimeout(resolve, probeTuning.settleMs));
  await applyCommands(saCommands(restore));
  mismatches = saMismatches(restore, await readBack(readSa));
  if (mismatches.length > 0) {
    throw new Error(
      `The settings could not be restored: ${mismatches.map((m) => m.text).join("; ")} (read back after sending them twice). ` +
        "The instrument is back in spectrum analyzer mode but these values are wrong; set them again or check the instrument."
    );
  }
  return { warnings: [`restore: ${first.map((m) => m.name).join(", ")} did not read back as saved after the first attempt (${first.map((m) => m.text).join("; ")}); the second attempt restored it`] };
}

// ---------------- configure / read ----------------

type Entry = "preset" | "ndefault" | "none";

async function configure(m: Measurement, args: ParamArgs, entry: Entry) {
  const commands: string[] = [];
  if (entry !== "none") commands.push(`:CONFigure:${MEASUREMENTS[m]}${entry === "ndefault" ? ":NDEFault" : ""}`);
  commands.push(...paramCommands(m, args));
  await applyCommands(commands);
  const parameters = await readBack(() => readParams(m));
  return { parameters, warnings: paramWarnings(args, parameters) };
}

/** Over raw TCP a READ reply has no line terminator (verified), so it can never be read as a line: use FETCh there. */
const readIsUsable = () => connection.transportName !== "raw";

async function readResult(m: Measurement, fetchRequested: boolean, timeoutS: number) {
  const warnings: string[] = [];
  let fetch = fetchRequested;
  if (!fetch && !readIsUsable()) {
    fetch = true;
    warnings.push(
      "FETCh was used instead of READ: over raw TCP the instrument ends a READ reply without a line terminator, so it cannot be read. " +
        "FETCh returns the latest result without starting a measurement; use the VXI-11 transport for READ."
    );
  }
  const verb = fetch ? "FETCh" : "READ";
  const timeoutMs = Math.round(timeoutS * 1000);
  const name = MEASUREMENTS[m];
  const listAny = async (command: string) => {
    const reply = await connection.query(command, timeoutMs);
    try {
      return parseNumberList(reply);
    } catch (err) {
      throw new ReplyError(command, reply, err instanceof Error ? err.message : String(err));
    }
  };
  function list(command: string, count: number): Promise<number[]>;
  function list(command: string, count: number, allowNan: true): Promise<Array<number | null>>;
  async function list(command: string, count: number, allowNan = false): Promise<Array<number | null>> {
    const reply = await connection.query(command, timeoutMs);
    let values: Array<number | null>;
    try {
      values = reply.split(",").map((part) => (allowNan && part.trim().toLowerCase() === "nan" ? null : parseNumber(part)));
    } catch (err) {
      throw new ReplyError(command, reply, err instanceof Error ? err.message : String(err));
    }
    if (values.length !== count) throw new ReplyError(command, reply.trim(), `expected ${count} value(s), got ${values.length}`);
    return values;
  }
  const withWarnings = <T extends object>(result: T) => (warnings.length > 0 ? { ...result, warnings } : result);
  if (m === "channel_power") {
    const [power, density] = await list(`:${verb}:${name}?`, 2);
    return withWarnings({ measurement: m, command: verb, channel_power_dbm: power, power_density_dbm_per_hz: density });
  }
  if (m === "time_power") {
    const [power] = await list(`:${verb}:${name}?`, 1);
    return withWarnings({ measurement: m, command: verb, power_dbm: power });
  }
  if (m === "acpr") {
    // The combined reply has three values on this firmware (main dBm, lower dBc, upper dBc; the manual lists five), so the
    // absolute powers come from the :MAIN?/:LOWer?/:UPPer? sub-results. READ runs the measurement with the combined query
    // (the READ sub-forms get no reply, as for OBW) and the sub-results are fetched. A side that is not measured reads nan.
    if (!fetch) await list(`:READ:${name}?`, 3, true);
    const [main] = await list(`:FETCh:${name}:MAIN?`, 1, true);
    const lower = await list(`:FETCh:${name}:LOWer?`, 2, true);
    const upper = await list(`:FETCh:${name}:UPPer?`, 2, true);
    if (main === null || (lower[0] === null && upper[0] === null)) {
      throw new ReplyError(`:FETCh:${name}:MAIN?`, "nan", "no result yet (nan); wait for a sweep to finish");
    }
    for (const [label, side] of [["lower", lower], ["upper", upper]] as const) {
      if (side[0] === null) warnings.push(`${label} adjacent channel not measured (nan); check offset_side`);
    }
    return withWarnings({
      measurement: m, command: verb, main_power_dbm: main, lower_power_dbm: lower[0], lower_dbc: lower[1], upper_power_dbm: upper[0], upper_dbc: upper[1],
    });
  }
  if (m === "cn") {
    const [carrier, noise, ratio] = await list(`:${verb}:${name}?`, 3);
    return withWarnings({ measurement: m, command: verb, carrier_dbm: carrier, noise_dbm: noise, cn_db: ratio });
  }
  // TOI: :FETCh:TOI:IPT? (documented) gets no reply on the UTS3036B and stalls it, so it is not used: each third-order product carries its TOI.
  // Results made of several queries: with READ only the first one runs the measurement (and waits), the others FETCh its results.
  const verbFor = (i: number) => (i === 0 ? verb : "FETCh");
  if (m === "toi") {
    const [lowT, upT, lowTone, upTone] = [
      await list(`:${verbFor(0)}:${name}:LOW:TRD?`, 4),
      await list(`:${verbFor(1)}:${name}:UP:TRD?`, 4),
      await list(`:${verbFor(2)}:${name}:LOW:TONE?`, 2),
      await list(`:${verbFor(3)}:${name}:UP:TONE?`, 2),
    ];
    const product = ([frequency_hz, amplitude_dbm, dbc, toi_dbm]: number[]) => ({ frequency_hz, amplitude_dbm, dbc, toi_dbm });
    const tone = ([frequency_hz, amplitude_dbm]: number[]) => ({ frequency_hz, amplitude_dbm });
    return withWarnings({
      measurement: m, command: verb, lower_third_order: product(lowT), upper_third_order: product(upT), lower_tone: tone(lowTone), upper_tone: tone(upTone),
    });
  }
  if (m === "harmonics") {
    // Both lists always hold 10 values (verified); only the first `harmonics_count` are results (the fundamental and then
    // the 2nd, 3rd, ... harmonic), the rest are placeholders (0 dBm, shown as a large positive dBc).
    const count = await queryParsed(`${sense(m)}:NUMBer?`, (r) => {
      const n = Number(r.trim());
      if (!Number.isInteger(n) || n < 2 || n > 10) throw new Error(`Expected an integer from 2 to 10, got ${JSON.stringify(r)}`);
      return n;
    });
    const ampCommand = `:${verbFor(0)}:${name}:AMPLitude:ALL?`;
    const freqCommand = `:FETCh:${name}:FREQuency:ALL?`;
    const amplitudes = await listAny(ampCommand);
    const frequencies = await listAny(freqCommand);
    if (amplitudes.length < count) throw new ReplyError(ampCommand, amplitudes.join(","), `expected at least ${count} values (harmonics_count), got ${amplitudes.length}`);
    if (frequencies.length !== amplitudes.length) throw new ReplyError(freqCommand, frequencies.join(","), `expected ${amplitudes.length} values like ${ampCommand}, got ${frequencies.length}`);
    const [thdPercent, thdDbc] = await list(`:FETCh:${name}:DISTortion?`, 2);
    return withWarnings({
      measurement: m, command: verb,
      fundamental: { frequency_hz: frequencies[0], amplitude_dbm: amplitudes[0] },
      harmonics: amplitudes.slice(1, count).map((amplitude_dbc, i) => ({ order: i + 2, frequency_hz: frequencies[i + 1], amplitude_dbc })),
      thd_percent: thdPercent, thd_dbc: thdDbc,
    });
  }
  // OBW: the combined reply has seven values of which the manual documents only four (and :READ:OBWidth:<sub>? gets
  // no reply), so READ runs the measurement with the combined query and the documented sub-results are fetched.
  if (!fetch) {
    const command = `:READ:${name}?`;
    const reply = await connection.query(command, timeoutMs);
    try {
      parseNumberList(reply);
    } catch (err) {
      throw new ReplyError(command, reply, err instanceof Error ? err.message : String(err));
    }
  }
  const [obw] = await list(`:FETCh:${name}:OBWidth?`, 1);
  const [ferror] = await list(`:FETCh:${name}:FERRor?`, 1);
  const [xdb] = await list(`:FETCh:${name}:XDB?`, 1);
  const [total] = await list(`:FETCh:${name}:APOWr?`, 1);
  return withWarnings({ measurement: m, command: verb, obw_hz: obw, frequency_error_hz: ferror, xdb_bandwidth_hz: xdb, total_power_dbm: total });
}

async function requireActive(m: Measurement): Promise<void> {
  const misses: string[] = [];
  if (!(await isActive(m, misses))) {
    throw new Error(
      `The ${m} measurement is not active (${misses.join("; ")}). Use configure_measurement to enter it first; ` +
        "get_measurement shows what is active."
    );
  }
}

const TIMEOUT = z.number().finite().optional().describe(`Seconds to wait for the result (default ${DEFAULT_READ_TIMEOUT_S}, 1-600); READ waits for the measurement, including its averages`);
const validTimeout = (t: number | undefined) => (t !== undefined && !(t >= 1 && t <= 600) ? "timeout_s must be between 1 and 600." : undefined);

export function registerMeasurementTools(server: McpServer): void {
  defineTool(
    server,
    "get_measurement",
    "Report whether the instrument is in spectrum analyzer mode, or check one measurement. The instrument has no query for the active measurement, so " +
      "without 'measurement' this asks one query that only spectrum analyzer mode answers (spectrum_analyzer, or an error that a measurement is active). " +
      "With 'measurement' (channel_power, time_power, obw, acpr, toi, cn or harmonics) it checks that measurement and returns its parameters; an error means it is not active. " +
      "A check that gets no reply costs a few seconds while the instrument recovers.",
    { measurement: MEASUREMENT.optional().describe("Check this measurement and return its parameters") },
    { readOnlyHint: true },
    async (args) => {
      try {
        const misses: string[] = [];
        if (args.measurement === undefined) {
          if (!(await isSpectrumAnalyzer(misses))) {
            return errorResult(`${notSpectrumAnalyzer(misses)} Use get_measurement with measurement=<name> (channel_power, time_power, obw, acpr, toi, cn or harmonics) to check which one.`);
          }
          return textResult(JSON.stringify({ measurement: SA }, null, 2));
        }
        await requireActive(args.measurement);
        return textResult(JSON.stringify({ measurement: args.measurement, parameters: await readParams(args.measurement) }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    {}
  );

  defineTool(
    server,
    "configure_measurement",
    "Enter a measurement (channel_power, time_power, obw, acpr, toi, cn or harmonics) and set its parameters; the instrument stays in the measurement until exit_measurement. " +
      "preset=true (default) is :CONFigure:<meas>, false is :CONFigure:<meas>:NDEFault. Either way the instrument changes the span, RBW and sweep time " +
      "(for example span 3 MHz); when entered from spectrum analyzer mode the previous frequency, bandwidth and sweep settings are saved and " +
      "exit_measurement puts them back. While a measurement is active most spectrum analyzer queries (detector, trace type) get no reply.",
    { measurement: MEASUREMENT, preset: z.boolean().optional().describe("Preset the measurement's parameters (default true)"), ...PARAMS },
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const { measurement, preset, ...params } = args;
        // Save the spectrum analyzer settings first: the preset overwrites them. Already in a measurement: keep what was saved.
        // Save the settings the preset overwrites. A silent probe means a measurement is already active (keep what was saved then).
        let saved: SaState | undefined;
        if (await isSpectrumAnalyzer([])) saved = await readSa();
        const result = await configure(measurement, params, preset === false ? "ndefault" : "preset");
        if (saved) savedSa = saved;
        return textResult(
          JSON.stringify({ measurement, parameters: result.parameters, warnings: result.warnings, saved_settings: savedSa !== undefined }, null, 2)
        );
      } catch (err) {
        return setterFailure(err, "get_measurement");
      }
    },
    { validate: (a) => validateParams(a.measurement, a) }
  );

  defineTool(
    server,
    "read_measurement",
    "Read the result of the active measurement. READ (default) runs the measurement and waits for it; fetch=true returns the latest result at once. " +
      "channel_power gives channel power (dBm) and density (dBm/Hz), time_power gives power (dBm), obw gives occupied bandwidth (Hz), frequency error (Hz), " +
      "x dB bandwidth (Hz) and total power (dBm), acpr gives main, lower and upper channel power (dBm) and lower/upper relative power (dBc), cn gives carrier and noise power (dBm) and C/N (dB), " +
      "toi gives the lower and upper third-order products and tones and the intercept, harmonics gives the fundamental, harmonics 2..n (dBc) and distortion (THD). Errors when that measurement is not active; it never changes the mode.",
    { measurement: MEASUREMENT, fetch: z.boolean().optional().describe("Return the latest result without starting a measurement"), timeout_s: TIMEOUT },
    { readOnlyHint: true },
    async (args) => {
      try {
        await requireActive(args.measurement);
        return textResult(JSON.stringify(await readResult(args.measurement, args.fetch === true, args.timeout_s ?? DEFAULT_READ_TIMEOUT_S), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { validate: (a) => validTimeout(a.timeout_s) }
  );

  defineTool(
    server,
    "exit_measurement",
    "Leave the measurement and return to spectrum analyzer mode (:CONFigure:SANalyzer). The measurement preset leaves the span, RBW and sweep time changed, " +
      "so unless restore_settings=false the frequency, bandwidth, sweep time and continuous-sweep settings saved by configure_measurement are put back " +
      "and verified (a measurement entered elsewhere has nothing saved: a warning says so). Does nothing when already in spectrum analyzer mode.",
    { restore_settings: z.boolean().optional().describe("Restore the settings saved when the measurement was entered (default true)") },
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        // Settings saved by configure_measurement mean we entered a measurement: nothing to probe. Otherwise one query
        // tells whether this is a no-op; a silent instrument is taken to be in a measurement and is sent the exit.
        const inSa = savedSa ? false : await isSpectrumAnalyzer([]);
        if (inSa) {
          savedSa = undefined;
          return textResult(JSON.stringify({ measurement: SA, restored: false, warnings: [] }, null, 2));
        }
        const wantRestore = args.restore_settings !== false;
        const saved = savedSa;
        const { warnings } = await exitMeasurement(wantRestore ? saved : undefined);
        savedSa = undefined;
        if (wantRestore && !saved) warnings.push("No saved settings (the measurement was not entered with configure_measurement): the span, RBW and sweep time keep the measurement's values.");
        return textResult(JSON.stringify({ measurement: SA, restored: wantRestore && saved !== undefined, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_measurement");
      }
    }
  );

  defineTool(
    server,
    "measure",
    "One-shot measurement that leaves the instrument as it found it: from spectrum analyzer mode it saves the frequency, bandwidth and sweep settings, enters the " +
      "measurement (channel_power, time_power, obw, acpr, toi, cn or harmonics) with the given parameters, READs the result, and ALWAYS (even on errors) exits to spectrum analyzer " +
      "mode, restores the settings and verifies. With the requested measurement already active it only reads and puts any parameters you changed back. " +
      "It refuses when the instrument is not in spectrum analyzer mode and the requested measurement is not the active one (use exit_measurement first). Takes the measurement's averaging time.",
    { measurement: MEASUREMENT, preset: z.boolean().optional().describe("Preset the measurement's parameters when entering (default true)"), timeout_s: TIMEOUT, ...PARAMS },
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const { measurement, preset, timeout_s, ...params } = args;
        const misses: string[] = [];
        const original: Mode | undefined = (await isSpectrumAnalyzer(misses)) ? SA : (await isActive(measurement, misses)) ? measurement : undefined;
        if (original === undefined) {
          return errorResult(
            `${notSpectrumAnalyzer(misses)} It is not ${measurement} either, and entering ${measurement} would overwrite the span and settings of the ` +
              "measurement that is active, which cannot be restored. Use exit_measurement first."
          );
        }
        const entry: Entry = original === measurement ? "none" : preset === false ? "ndefault" : "preset";
        const sa = original === SA ? await readSa() : undefined;
        const previous = original === measurement ? await readParams(measurement) : undefined;

        let result: Awaited<ReturnType<typeof readResult>> | undefined;
        let configureWarnings: string[] = [];
        let failure: unknown;
        try {
          configureWarnings = (await configure(measurement, params, entry)).warnings;
          // FETCh (raw TCP) returns what the instrument has now: give a freshly entered measurement time to produce its first results.
          if (entry !== "none" && !readIsUsable()) await new Promise((resolve) => setTimeout(resolve, probeTuning.settleMs));
          result = await readResult(measurement, false, timeout_s ?? DEFAULT_READ_TIMEOUT_S);
        } catch (err) {
          failure = err;
        }

        // Always put the instrument back, whatever happened above.
        let warnings: string[] = [];
        let restoreFailure: unknown;
        try {
          if (sa) {
            warnings = (await exitMeasurement(sa)).warnings;
          } else if (previous) {
            const keys = PARAM_KEYS.filter((k) => params[k] !== undefined);
            const restoreCommands = paramCommands(measurement, Object.fromEntries(keys.map((k) => [k, previous[k]])) as ParamArgs);
            if (restoreCommands.length > 0) await applyCommands(restoreCommands);
          }
        } catch (err) {
          restoreFailure = err;
        }

        const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
        if (failure !== undefined && restoreFailure !== undefined) {
          return errorResult(`${message(failure)}. Restoring the instrument also failed: ${message(restoreFailure)}. Settings sent may already be applied; use get_measurement and exit_measurement to check.`);
        }
        if (restoreFailure !== undefined) {
          return errorResult(`The measurement ran but restoring the instrument failed: ${message(restoreFailure)}. Settings sent may already be applied; use get_measurement and exit_measurement to check.`);
        }
        if (failure !== undefined) {
          return errorResult(`${message(failure)}. Settings sent before the failure may have been applied; the instrument was then restored to its previous mode and settings.`);
        }
        return textResult(JSON.stringify({ measurement, result, restored: true, warnings: [...configureWarnings, ...warnings] }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { validate: (a) => validateParams(a.measurement, a) ?? validTimeout(a.timeout_s) }
  );
}
