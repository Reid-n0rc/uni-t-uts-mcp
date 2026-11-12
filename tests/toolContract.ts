/**
 * Tool contract table and fake connection used by tests/integration/tool-contract.test.ts.
 *
 * EVERY registered tool must have an entry in CONTRACT. The contract test fails with the list of
 * missing tools otherwise. To add a tool:
 *   1. add `tool_name: { kind, args, invalid?, warn?, skip? }` to CONTRACT below;
 *   2. if the tool sends queries that defaultReply() cannot answer with a valid reply, add a rule to
 *      QUERY_REPLIES (the baseline "valid replies" test tells you which query is unhandled).
 * The standard being enforced is in AGENTS.md, "Error handling standard".
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { SessionLock } from "../src/sessionLock.js";

export type Kind = "getter" | "setter" | "rawQuery" | "rawCommand" | "connect" | "disconnect" | "discover";
export type Mode =
  | "notConnected" // every call fails with the not-connected error
  | "timeout" // every query times out
  | "writeFailure" // the first command (after *CLS) fails to write
  | "garbage" // every query (except *OPC? and :SYSTem:ERRor?) returns a garbage reply
  | "empty" // ... returns an empty reply
  | "instrumentError" // the error queue holds -131,"Invalid suffix" after the commands
  | "partial" // the n-th operation fails (for every n)
  | "wrongModule"; // :INSTrument:SELect? answers EMI instead of SA (#178, #191)

export interface ContractEntry {
  kind: Kind;
  /** Valid arguments that make the tool exercise its normal path. */
  args: Record<string, unknown>;
  /** Invalid argument sets: each must give isError and send nothing to the instrument. */
  invalid?: Array<Record<string, unknown>>;
  /** Setters: for each argument set the canned replies differ from the request, so a warning is required. */
  warn?: Array<Record<string, unknown>>;
  /** Modes that do not apply to this tool, with the reason. */
  skip?: Partial<Record<Mode, string>>;
  /**
   * The module this tool requires (defineTool's `requireModule`, default "sa"). Drives the fake's
   * `:INSTrument:SELect?` reply for this tool's own sessions (looked up by session label, see
   * `fakeConnection.query`), so a non-SA tool's baseline/parallel/"all tools at once" runs see the
   * module they need, and only the dedicated `wrongModule` mode sees a mismatch.
   */
  requireModule?: "SA" | "EMI" | "AD";
}

export const APPLICABLE: Record<Kind, Mode[]> = {
  getter: ["notConnected", "timeout", "garbage", "empty", "partial", "wrongModule"],
  setter: ["notConnected", "timeout", "writeFailure", "garbage", "empty", "instrumentError", "partial", "wrongModule"],
  rawQuery: ["notConnected", "timeout"],
  rawCommand: ["notConnected", "writeFailure", "instrumentError", "partial"],
  connect: ["timeout", "writeFailure"],
  disconnect: [],
  discover: [], // own UDP/TCP sockets, mocked in the contract test; never uses the instrument connection
};

export const CONTRACT: Record<string, ContractEntry> = {
  connect: {
    kind: "connect",
    args: { host: "192.168.1.100" }, invalid: [{ host: "bad host!" }, { port: 70000 }, { transport: "serial" }, { transport: "vxi11", port: 5025 }],
  },
  disconnect: { kind: "disconnect", args: {} },
  discover_instruments: { kind: "discover", args: {}, invalid: [{ timeout_ms: 50 }, { timeout_ms: 60000 }] },
  list_instruments: { kind: "discover", args: {} }, // reads the registry only, never the instrument
  identify: { kind: "getter", args: {}, skip: { wrongModule: "*IDN? works in any module (requireModule: false)" } },
  scpi_query: {
    kind: "rawQuery",
    args: { command: "*IDN?" },
    invalid: [{ command: ":FREQuency:CENTer 1 GHz" }, { command: "*IDN?;*IDN?" }],
  },
  scpi_command: {
    kind: "rawCommand",
    args: { command: ":FREQuency:CENTer 1 GHz" },
    invalid: [{ command: "*RST" }, { command: "*IDN?" }],
  },
  get_instrument_module: {
    kind: "getter",
    args: {},
    skip: { wrongModule: "reads the module in any module (requireModule: false)" },
  },
  select_instrument_module: {
    kind: "setter",
    args: { module: "sa" }, // matches the canned :INSTrument:SELect? reply "SA": no warning in the baseline case
    invalid: [{}, { module: "iq" }],
    warn: [{ module: "emi" }], // canned reply stays "SA": models the real firmware's silent refusal of an unlicensed module
    skip: { wrongModule: "this is the tool that switches module, requireModule: false" },
  },
  // enter_analog_demod/exit_analog_demod (#192): both are requireModule: false (they switch into/out of SA
  // themselves), so wrongModule's refuse-before-sending assertion does not apply to either - same reason as
  // select_instrument_module above. The canned :INSTrument:SELect? reply is fixed at "SA" for the whole
  // session (this fake has no real per-command state), so both naturally warn in the baseline case: enter
  // sends the switch to AD but reads "SA" back (a mismatch, same shape as select_instrument_module's warn
  // case), and exit sends the switch back to SA, reads "SA" back fine, but has nothing saved to restore
  // (nothing called enter_analog_demod first in this test). Both still send a real command first, so
  // writeFailure/instrumentError exercise normally.
  enter_analog_demod: {
    kind: "setter",
    args: {},
    warn: [{}],
    skip: { wrongModule: "requireModule: false; does its own module check and warns rather than refusing" },
  },
  exit_analog_demod: {
    kind: "setter",
    args: {},
    warn: [{}],
    skip: { wrongModule: "requireModule: false; does its own module check and errors with different wording" },
  },
  get_emi_settings: {
    kind: "getter",
    args: {},
    invalid: [{ groups: ["bogus"] }],
    requireModule: "EMI",
  },
  set_emi_scan_table: {
    kind: "setter",
    args: { bands: [{ band: 1, points: 1001 }] },
    invalid: [
      {},
      { bands: [{ band: 1, start_hz: 1e6, stop_hz: 1e6 + 10 }] },
      { bands: [{ band: 1, attenuation_db: 11 }] },
      { bands: [{ band: 1, points: 1001 }, { band: 1, preamp: true }] },
    ],
    warn: [{ bands: [{ band: 2, points: 999 }] }, { bands: [{ band: 3, start_hz: 2e6 }] }],
    requireModule: "EMI",
  },
  set_emi_measurement: {
    kind: "setter",
    args: { average_count: 50 },
    invalid: [
      {},
      {
        trace_detectors: [
          { index: 1, detector: "quasi_peak" },
          { index: 2, detector: "average_continuous" },
          { index: 3, detector: "average" },
        ],
      },
      { final_detectors: [{ index: 1 }] },
      { trace_detectors: [{ index: 1, detector: "positive" }, { index: 1, detector: "negative" }] },
    ],
    requireModule: "EMI",
  },
  get_emi_limit_line: { kind: "getter", args: { line: 2 }, invalid: [{ line: 0 }, { line: 7 }], requireModule: "EMI" },
  set_emi_limit_line: {
    kind: "setter",
    args: { line: 1, displayed: false, points: [{ frequency_hz: 1e8, amplitude_dbm: -50 }, { frequency_hz: 5e8, amplitude_dbm: -30, connected: false }] },
    invalid: [{}, { line: 7, displayed: true }, { trace: 7 }, { margin_db: 41 }, { points: [] }, { copy_from: 1, line: 1 }, { points: [{ frequency_hz: 5e8, amplitude_dbm: -30 }, { frequency_hz: 1e8, amplitude_dbm: -50 }] }],
    warn: [{ type: "lower" }, { trace: 2 }, { margin_db: 5 }, { margin_enabled: true }, { displayed: true }, { points: [{ frequency_hz: 2e8, amplitude_dbm: -40 }, { frequency_hz: 3e8, amplitude_dbm: -40 }] }],
    requireModule: "EMI",
  },
  delete_emi_limit_line: {
    kind: "setter",
    args: { line: 1 },
    invalid: [{}, { line: 1, all: true }, { line: 9 }],
    skip: {
      timeout: "the only readback is DATA?, which the instrument leaves unanswered on an emptied line, so a timeout there is the success signal",
      empty: "an empty DATA? reply means the same (no points), so the delete is confirmed",
    },
    requireModule: "EMI",
  },
  get_frequency: { kind: "getter", args: {} },
  set_frequency: {
    kind: "setter",
    args: { center_hz: 100e6 },
    invalid: [{}, { center_hz: -1 }, { full_span: true, zero_span: true }],
    warn: [
      { center_hz: 5e6 }, { span_hz: 5e6 }, { start_hz: 5e6 }, { stop_hz: 5e6 }, { center_step_hz: 5e6 },
      { center_step_auto: false }, { offset_hz: 5e6 }, { zero_span: true },
    ],
  },
  get_amplitude: { kind: "getter", args: {} },
  set_amplitude: {
    kind: "setter",
    args: { reference_level: -10 },
    invalid: [{}, { attenuation_db: 99 }, { scale_per_div_db: 50 }],
    warn: [
      { reference_level: -20 }, { power_unit: "W" }, { scale_per_div_db: 5 }, { scale_type: "linear" },
      { reference_level_offset_db: 3 }, { attenuation_db: 10 }, { attenuation_auto: false }, { preamp: false },
      { input_impedance_ohm: 75 },
    ],
  },
  get_bandwidth: { kind: "getter", args: {} },
  set_bandwidth: {
    kind: "setter",
    args: { rbw_hz: 100e3 },
    invalid: [{}, { rbw_hz: -5 }, { rbw_hz: 100, rbw_auto: true }],
    warn: [
      { rbw_hz: 100 }, { rbw_auto: false }, { vbw_hz: 100 }, { vbw_auto: false }, { vbw_rbw_ratio: 2 },
      { filter_shape: "flattop" },
    ],
  },
  get_sweep: { kind: "getter", args: {} },
  set_sweep: {
    kind: "setter",
    args: { sweep_points: 1001 },
    invalid: [{}, { sweep_points: 5 }, { sweep_time_s: 1, sweep_time_auto: true }],
    warn: [
      { sweep_points: 2001 }, { sweep_time_s: 2 }, { sweep_time_auto: false }, { sweep_time_rule: "accuracy" },
      { sweep_type: "fft" }, { sweep_type_auto: false }, { trigger_source: "video" },
      { trigger_video_level_dbm: -30 },
    ],
  },
  get_detector: { kind: "getter", args: {} },
  set_detector: {
    kind: "setter",
    args: { trace: 1, detector: "sample" },
    invalid: [{ trace: 1 }, { trace: 9, detector: "sample" }, { trace: 1, detector: "sample", auto: true }],
    warn: [{ trace: 1, detector: "sample" }, { trace: 1, auto: false }],
  },
  get_acquisition: { kind: "getter", args: {} },
  set_acquisition: {
    kind: "setter",
    args: { continuous: true },
    invalid: [{}, { continuous: "yes" }],
    warn: [{ continuous: false }],
  },
  start_sweep: {
    kind: "setter",
    args: { timeout_s: 0.3 },
    invalid: [{ timeout_s: -1 }, { timeout_s: 0 }],
  },
  single_sweep: {
    kind: "setter",
    args: { timeout_s: 0.3 },
    invalid: [{ timeout_s: 0 }],
  },
  wait_for_sweep_complete: {
    kind: "setter",
    args: { timeout_s: 0.3 },
    invalid: [{ timeout_s: -1 }],
    skip: {
      writeFailure: "sends no commands of its own, it only polls *OPC? (the instrument ignores commands while sweeping)",
      garbage: "its only query is the *OPC? poll, whose non-1 replies just keep it polling until the timeout",
      empty: "its only query is the *OPC? poll, whose non-1 replies just keep it polling until the timeout",
      wrongModule:
        "only polls *OPC? directly (not through queryParsed/applyCommands), for a sweep that start_sweep/single_sweep " +
        "already started under their own module guard; sweep completion itself is not module-specific",
    },
  },
  screenshot: { kind: "getter", args: {} },
  get_trace: { kind: "getter", args: {} },
  set_trace: {
    kind: "setter",
    args: { trace: 2, type: "max_hold" },
    invalid: [{}, { type: "write" }, { trace: 7, type: "write" }, { trace: 1 }, { average_count: 0 }, { average_count: 1000 }],
    warn: [
      { trace: 2, type: "max_hold" }, { trace: 2, update: false }, { trace: 2, display: false },
      { selected_trace: 2 }, { average_count: 10 }, { average_type: "power" },
    ],
  },
  restart_trace: {
    kind: "setter",
    args: { trace: 2 },
    invalid: [{ trace: 0 }, { trace: 7 }],
  },
  get_trace_data: {
    kind: "getter",
    args: { format: "ascii" },
    invalid: [{ trace: 0 }, { trace: 7 }, { max_points: 1 }, { format: "hex" }, { max_points: 2.5 }],
  },
  set_trace_math: {
    kind: "rawCommand",
    args: { trace: 1, operation: "power_sum", operand_a: 2, operand_b: 3 },
    invalid: [{ trace: 1, operation: "power_sum" }, { trace: 8, operation: "off" }, { trace: 1, operation: "power_sum", operand_a: 2, operand_b: 3, offset_db: 5 }],
  },
  get_marker: { kind: "getter", args: { marker: 2 }, invalid: [{ marker: 0 }, { marker: 11 }] },
  set_marker: {
    kind: "setter",
    args: { marker: 1, mode: "normal", x_hz: 1000 },
    invalid: [{}, { marker: 1 }, { marker: 11, mode: "off" }, { marker: 1, trace: 7 }, { marker: 1, reference_marker: 1 }, { marker: 1, x_hz: -5 }],
    warn: [{ marker: 1, mode: "delta" }, { marker: 1, trace: 3 }, { marker: 1, x_hz: 5e6 }, { marker: 1, mode: "delta", reference_marker: 4 }],
  },
  marker_search: {
    kind: "setter",
    args: { marker: 1, action: "peak" },
    invalid: [{ marker: 1, action: "nope" }, { marker: 0, action: "peak" }, { marker: 1 }],
  },
  marker_to_instrument: {
    kind: "setter",
    args: { marker: 1, target: "center" },
    invalid: [{ marker: 1, target: "x" }, { marker: 12, target: "center" }],
  },
  markers_all_off: { kind: "setter", args: {} },
  get_peak_criteria: { kind: "getter", args: {} },
  get_measurement: { kind: "getter", args: {}, invalid: [{ measurement: "nope" }] },
  configure_measurement: {
    kind: "setter",
    args: { measurement: "channel_power", integration_bandwidth_hz: 1e6 },
    invalid: [{}, { measurement: "nope" }, { measurement: "obw", integration_bandwidth_hz: 1e6 }, { measurement: "channel_power", average_count: 0 }, { measurement: "obw", xdb: 5 }, { measurement: "harmonics", harmonics_count: 11 }, { measurement: "cn", carrier_bandwidth_hz: 1e6 }],
    warn: [{ measurement: "channel_power", integration_bandwidth_hz: 5e6 }, { measurement: "channel_power", average: false }],
  },
  read_measurement: {
    kind: "getter",
    args: { measurement: "channel_power" },
    invalid: [{}, { measurement: "nope" }, { measurement: "obw", timeout_s: 0 }],
  },
  exit_measurement: {
    kind: "setter",
    args: {},
    skip: { writeFailure: "in spectrum analyzer mode (the canned replies) it sends nothing, so there is no command to fail", instrumentError: "in spectrum analyzer mode (the canned replies) it sends nothing, so no error can be queued" },
  },
  measure: {
    kind: "setter",
    args: { measurement: "channel_power" },
    invalid: [{}, { measurement: "obw", percent: 3 }, { measurement: "channel_power", timeout_s: 0 }, { measurement: "time_power", xdb: -5 }, { measurement: "toi", offset_hz: 1 }],
  },
  set_peak_criteria: {
    kind: "setter",
    args: { threshold_dbm: -50 },
    invalid: [{}, { threshold_dbm: 31 }, { excursion_db: 101 }, { threshold_dbm: -50, threshold_auto: true }],
    warn: [{ threshold_dbm: -50 }, { excursion_db: 3 }, { threshold_auto: false }, { excursion_auto: false }],
  },
  get_marker_function: { kind: "getter", args: { marker: 2 }, invalid: [{ marker: 0 }, { marker: 11 }] },
  set_marker_function: {
    kind: "setter",
    args: { marker: 1, function: "noise" },
    invalid: [{}, { marker: 1 }, { marker: 11, function: "noise" }, { marker: 1, function: "bogus" }, { marker: 1, band_span_hz: -1 }],
    warn: [{ marker: 1, function: "noise" }, { marker: 1, band_span_hz: 2e6 }],
  },
  get_marker_ndb: { kind: "getter", args: { marker: 2 }, invalid: [{ marker: 0 }, { marker: 11 }] },
  set_marker_ndb: {
    kind: "setter",
    args: { marker: 1, enabled: true, ndb: -3 },
    invalid: [{}, { marker: 1 }, { marker: 1, ndb: 3 }, { marker: 1, ndb: -141 }, { marker: 11, enabled: true }],
    warn: [{ marker: 1, enabled: false }, { marker: 1, ndb: -6 }],
  },
  get_limit_line: { kind: "getter", args: { line: 2 }, invalid: [{ line: 0 }, { line: 7 }] },
  set_limit_line: {
    kind: "setter",
    args: { line: 1, displayed: false, points: [{ frequency_hz: 1e8, amplitude_dbm: -50 }, { frequency_hz: 5e8, amplitude_dbm: -30, connected: false }] },
    invalid: [{}, { line: 7, displayed: true }, { trace: 7 }, { margin_db: 41 }, { points: [] }, { points: [{ frequency_hz: 5e8, amplitude_dbm: -30 }, { frequency_hz: 1e8, amplitude_dbm: -50 }] }],
    warn: [{ type: "lower" }, { trace: 2 }, { margin_db: 5 }, { margin_enabled: true }, { displayed: true }, { points: [{ frequency_hz: 2e8, amplitude_dbm: -40 }, { frequency_hz: 3e8, amplitude_dbm: -40 }] }],
  },
  delete_limit_line: {
    kind: "setter",
    args: { line: 1 },
    invalid: [{}, { line: 1, all: true }, { line: 9 }],
    skip: {
      timeout: "the only readback is DATA?, which the instrument leaves unanswered on an emptied line, so a timeout there is the success signal",
      empty: "an empty DATA? reply means the same (no points), so the delete is confirmed",
    },
  },
  get_frequency_counter: { kind: "getter", args: {} },
  set_frequency_counter: {
    kind: "setter",
    args: { enabled: true },
    invalid: [{}, { gate_time_s: 0 }, { gate_time_s: 1 }],
    warn: [{ enabled: false }, { gate_time_s: 0.01 }],
  },
  get_tracking_generator: { kind: "getter", args: {} },
  set_tracking_generator: {
    kind: "setter",
    args: { enabled: true, level_dbm: -20 },
    invalid: [{}, { level_dbm: 5 }, { level_dbm: -41 }, { level_offset_db: 201 }, { normalize_ref_level_db: -101 }],
    warn: [{ enabled: false }, { level_dbm: -20 }, { reference_trace: false }, { normalize: false }],
  },
};

// ---------- canned replies ----------

export const QUERY_REPLIES: Array<[RegExp, string]> = [
  [/^\*IDN\?$/, "UNI-T Technologies,UTS3036B,SN000000,V1.04.0040"],
  [/^\*OPC\?$/, "1"],
  [/^:SENSe:SWEep:TIME\?$/, "1.000000E-02"],
  [/:UNIT:POWer\?$/, "DBM"],
  [/LLINe\d:TYPE\?$/, "UPPer"],
  [/LLINe\d:(DISPlay|MARGin:STATe)\?$/, "0"],
  [/LLINe\d:TRACe\?$/, "1"],
  [/LLINe\d:MARGin\?$/, "0.000000e+00"],
  [/LLINe\d:DATA\?$/, ""], // an empty line (the real instrument stays silent there; "" is read the same way)
  [/MARKer\d+:MODE\?$/, "POSition"],
  [/MARKer\d+:TRACe\?$/, "1"],
  [/MARKer\d+:REFerence\?$/, "2"],
  [/MARKer\d+:FUNCtion\?$/, "OFF"],
  [/:SPACing\?$/, "LOGarithmic"],
  [/BANDwidth:SHAPe\?$/, "GAUSsian"],
  [/SWEep:TIME:AUTO:RULes\?$/, "NORMal"],
  [/SWEep:TYPE\?$/, "SWEep"],
  [/SOURce\?$/, "IMMediate"],
  // Static fallback for defaultReply() (used directly by tests/integration/transports-tools.test.ts's real
  // fake SCPI/VXI-11 servers, which have no session concept): always SA. The session-aware override in
  // `fakeConnection.query` above (keyed by CONTRACT[toolName].requireModule) takes precedence for the
  // in-process fake used by tool-contract.test.ts.
  [/^:INSTrument(:SELect)?\?$/, "SA"],
  [/^:SENSe:EMC:STANdard:SELect\?$/, "NONE"],
  [/^:SENSe:FSCan:SEQuence\?$/, "SCAN"],
  [/^:SENSe:FSCan:SEQuence:REMeasure\?$/, "CURRent"],
  [/^:SENSe:FSCan:SEARch:MODE\?$/, "PONLy"],
  [/^:SENSe:METer\d:DETector\?$/, "POSitive"],
  [/^:SENSe:FSCan:DETector:TRACe\d\?$/, "POSitive"],
  [/^:SENSe:FSCan:FINal:DETector\d\?$/, "POSitive"],
  [/^:SENSe:METer:PHOLd:TYPE\?$/, "ADJustable"],
  [/^:TRACe\d:DISPlay\?$/, "1"],
  [/DETector:TRACe\d\?$/, "NORMal"],
  [/^:TRACe\d:TYPE\?$/, "WRITe"],
  [/^:SYSTem:PICture:FORMat\?$/, "BMP"],
  [/^:(READ|FETCh):CHPower\?$/, "-7.366048e+01,-1.366708e+02"],
  [/^:(READ|FETCh):TPOWer\?$/, "-9.206767e+01"],
  [/AVERage:TCONtrol\?$/, "EXPonential"],
  [/^:TRACe:SELect\?$/, "1"],
  [/AVERage:TYPE\?$/, "LOG"],
  [/(:AUTO|:STATe|:CONTinuous)\?$/, "1"],
  [/^:FORMat\?$/, "ASC8"],
  [/^:TRACe:DATA\? TRACE\d$/, Array.from({ length: 1000 }, (_, i) => (-80 + (i % 7)).toFixed(3)).join(",")],
  [/\?$/, "1000"],
];

export function defaultReply(cmd: string): string {
  for (const [re, reply] of QUERY_REPLIES) if (re.test(cmd)) return reply;
  throw new Error(`toolContract: no canned reply for ${cmd}; add a rule to QUERY_REPLIES`);
}

// ---------- fake connection ----------

export const NOT_CONNECTED = "Not connected to the spectrum analyzer. Use the 'connect' tool first.";
const ERROR_QUERY = ":SYSTem:ERRor?";

export const fake = {
  mode: "ok" as Mode | "ok",
  failAt: -1,
  /** Every operation attempted, in order ("query CMD", "command CMD", "binary CMD"). */
  ops: [] as string[],
  /** Commands successfully sent, excluding *CLS. */
  sent: [] as string[],
  /** Queries that were answered with a garbage or empty reply. */
  bad: [] as string[],
  /** Commands/queries that were failed on purpose. */
  failed: [] as string[],
  connectCalls: 0,
  errorDelivered: false,
  /** Session id (see runExclusive) of each entry in `ops`; 0 = the operation ran outside any session. */
  opSessions: [] as number[],
  /** Label (tool name) of each session id. */
  sessionLabels: new Map<number, string>(),
  /** Operations that reached the instrument outside an exclusive session (a tool bypassed defineTool). */
  violations: [] as string[],
  /** Yield to the event loop inside every operation, so overlapping sessions would visibly interleave. */
  yieldOps: false,
  reset(mode: Mode | "ok" = "ok", failAt = -1) {
    Object.assign(fake, {
      mode, failAt, ops: [], sent: [], bad: [], failed: [], connectCalls: 0, errorDelivered: false,
      opSessions: [], sessionLabels: new Map(), violations: [], yieldOps: false,
    });
  },
  /** Operations that reached the instrument layer (anything at all). */
  get opCount() {
    return fake.ops.length;
  },
};

const lock = new SessionLock();
const sessionIds = new AsyncLocalStorage<number>();
let sessionCounter = 0;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function enter(label: string, cmd: string): Promise<number> {
  if (fake.yieldOps) await tick();
  const session = sessionIds.getStore() ?? 0;
  if (session === 0) fake.violations.push(`${label} ${cmd}`);
  fake.opSessions.push(session);
  fake.ops.push(`${label} ${cmd}`);
  const index = fake.ops.length - 1;
  if (fake.mode === "notConnected") throw new Error(NOT_CONNECTED);
  if (fake.failAt === index) {
    fake.failed.push(cmd);
    throw new Error(`Connection closed unexpectedly (while sending ${cmd})`);
  }
  return index;
}

export const fakeConnection = {
  /** Same lock as the real connection (src/sessionLock.ts); tags every operation with its session. */
  runExclusive<T>(fn: () => Promise<T> | T, options?: { label?: string }): Promise<T> {
    if (lock.inSession()) return lock.run(fn, options);
    return lock.run(() => {
      const id = ++sessionCounter;
      fake.sessionLabels.set(id, options?.label ?? "?");
      return sessionIds.run(id, fn);
    }, options);
  },
  isConnected: () => fake.mode !== "notConnected",
  getConnectionInfo: () => "192.168.1.100:5025",
  transportName: "raw",
  transportLabel: "raw SCPI over TCP",
  /** Capability flags of the (raw) transport, read by src/acquisition.ts to pick the sweep wait method. */
  capabilities: { syncsCommands: true, dropsInputDuringSweep: true, holdOffAfterTimeout: true, completeLargeBlocks: true },
  msSinceQueryTimeout: () => Infinity,
  disconnect: () => {},
  async connect(_host: string, _port: number, _options?: unknown) {
    fake.connectCalls++;
    if (fake.mode === "timeout") throw new Error("Connection failed: timeout connecting to 192.168.1.100:5025");
    if (fake.mode === "writeFailure") throw new Error("Connected but failed to initialize: Write failed: EPIPE");
    return defaultReply("*IDN?");
  },
  async query(cmd: string, timeoutMs = 5000, _options?: unknown): Promise<string> {
    await enter("query", cmd);
    if (fake.mode === "timeout") {
      fake.failed.push(cmd);
      throw new Error(`Query timeout after ${timeoutMs}ms for command: ${cmd}`);
    }
    if (cmd === ERROR_QUERY) {
      if (fake.mode === "instrumentError" && !fake.errorDelivered) {
        fake.errorDelivered = true;
        return '-131,"Invalid suffix"';
      }
      return '0,"No error"';
    }
    if (cmd !== "*OPC?") {
      if (fake.mode === "garbage") {
        fake.bad.push(cmd);
        return "garbage ???";
      }
      if (fake.mode === "empty") {
        fake.bad.push(cmd);
        return "";
      }
    }
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) {
      const session = sessionIds.getStore() ?? 0;
      const toolName = fake.sessionLabels.get(session);
      const required = (toolName && CONTRACT[toolName]?.requireModule) || "SA";
      if (fake.mode === "wrongModule") return required === "SA" ? "EMI" : "SA";
      return required;
    }
    return defaultReply(cmd);
  },
  async queryBinary(cmd: string, timeoutMs = 30000): Promise<Buffer> {
    await enter("binary", cmd);
    if (fake.mode === "timeout") {
      fake.failed.push(cmd);
      throw new Error(`Binary query timeout after ${timeoutMs}ms for command: ${cmd}`);
    }
    if (cmd === ":DISPlay:DATA?") return Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // PNG signature + IHDR start
    return Buffer.from([0, 1, 2, 3]);
  },
  async sendCommand(cmd: string, _options?: unknown): Promise<void> {
    await enter("command", cmd);
    if (cmd === "*CLS") return;
    if (fake.mode === "writeFailure") {
      fake.failed.push(cmd);
      throw new Error(`Write failed while sending ${cmd}: EPIPE`);
    }
    fake.sent.push(cmd);
  },
};
