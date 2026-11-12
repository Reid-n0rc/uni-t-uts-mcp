/**
 * Table of happy-path calls for tests/e2e/stdio.test.ts: EVERY registered tool needs an entry (the test fails
 * with the list of missing tools, like the CONTRACT table in tests/toolContract.ts). To add a tool:
 *   1. add `tool_name: { steps: [...] }` to E2E and its name to ORDER (state carries over from entry to entry,
 *      so put a tool after the ones whose state it reads);
 *   2. each step is one real tool call through stdio plus a `check` of the result and, for setters, of the
 *      fake analyzer's state (`ctx.fake.model`), so a set/get round trip is proven, not just "no error";
 *   3. if the fake (tests/fakeUts.ts) does not understand a command the tool sends, teach it there, with the
 *      docs/verified-hardware.md section the behavior comes from.
 * A tool that cannot run hermetically gets `skip: "reason"`.
 */
import { expect } from "vitest";
import type { FakeUts } from "../fakeUts.js";

export interface E2eResult {
  isError: boolean;
  text: string;
  json: any;
}
export interface E2eContext {
  fake: FakeUts;
  port: number;
  call(name: string, args?: Record<string, unknown>): Promise<E2eResult>;
}
export interface Step {
  /** Tool to call; defaults to the entry's own name. */
  tool?: string;
  args: Record<string, unknown> | ((c: E2eContext) => Record<string, unknown>);
  check: (res: E2eResult, c: E2eContext) => void;
}
export interface Entry {
  steps: Step[];
  skip?: string;
  timeoutMs?: number;
}

const ok = (r: E2eResult) => expect(r.isError, r.text).toBe(false);
const m = (c: E2eContext) => c.fake.model;
const warns = (r: E2eResult): string[] => r.json?.warnings ?? [];
/** The spectrum analyzer settings a measurement preset overwrites (what exit_measurement/measure must put back). */
const snapshot = (c: E2eContext) => {
  const x = c.fake.model;
  return { fc: x.num("fc"), span: x.num("span"), rbw: x.num("rbw"), rbwAuto: x.bool("rbw.auto"), vbw: x.num("vbw"), vbwAuto: x.bool("vbw.auto"), swtAuto: x.bool("swt.auto"), swt: x.sweepTimeS, cont: x.bool("cont") };
};
let sa: ReturnType<typeof snapshot> | undefined;
/** Separate from `sa` above (the measurement group's shared snapshot): enter_analog_demod/exit_analog_demod's own. */
let adSa: ReturnType<typeof snapshot> | undefined;
const expectRestored = (c: E2eContext) => {
  expect(c.fake.model.mode).toBe("SA");
  expect(snapshot(c)).toEqual(sa);
};
const ping = async (c: E2eContext) => expect((await c.call("scpi_query", { command: "*IDN?" })).text).toContain("UTS3036B");

export const E2E: Record<string, Entry> = {
  connect: {
    steps: [{
      args: (c) => ({ host: "127.0.0.1", port: c.port, transport: "raw" }),
      check: (r) => { ok(r); expect(r.text).toContain("UTS3036B"); },
    }],
  },
  disconnect: {
    steps: [
      { args: {}, check: (r) => ok(r) },
      { tool: "get_frequency", args: {}, check: (r) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/not connected/i); } },
    ],
  },
  discover_instruments: {
    steps: [],
    skip: "scans the local network (UDP broadcast and TCP probes), which a hermetic test must not do; covered with fakes in tests/integration/discover-tools.test.ts",
  },
  list_instruments: {
    steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.instruments).toEqual([expect.objectContaining({ name: "default", connected: true, isDefault: true })]); } }],
  },
  identify: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.text).toMatch(/UTS3036B/); expect(r.text).toMatch(/V1\.04\.0040/); } }] },
  scpi_query: {
    steps: [
      { args: { command: "*IDN?" }, check: (r) => { ok(r); expect(r.text).toContain("UNI-TREND,UTS3036B"); } },
      { args: { command: ":FORMat?" }, check: (r) => { ok(r); expect(r.text).toContain("ASC8"); } },
    ],
  },
  scpi_command: {
    steps: [{ args: { command: ":FREQuency:CENTer 1 GHz" }, check: (r, c) => { ok(r); expect(m(c).num("fc")).toBe(1e9); } }],
  },
  get_frequency: {
    steps: [{ args: {}, check: (r, c) => { ok(r); expect(r.json.center_hz).toBe(m(c).num("fc")); expect(r.json.span_hz).toBe(m(c).num("span")); } }],
  },
  set_frequency: {
    steps: [
      { args: { center_hz: 100e6, span_hz: 10e6 }, check: (r, c) => { ok(r); expect(m(c).num("fc")).toBe(1e8); expect(m(c).num("start")).toBe(95e6); expect(warns(r)).toEqual([]); } },
      { tool: "get_frequency", args: {}, check: (r) => { ok(r); expect(r.json.start_hz).toBe(95e6); expect(r.json.stop_hz).toBe(105e6); } },
      // the instrument clamps silently; the tool reads back and warns (docs: "Live check of the error handling standard")
      { args: { center_hz: 1.805e9 }, check: (r) => ok(r) },
      { args: { span_hz: 10e9 }, check: (r, c) => { ok(r); expect(m(c).num("span")).toBe(3.61e9); expect(warns(r).join(" ")).toMatch(/span/i); } },
      { args: { full_span: true }, check: (r, c) => { ok(r); expect(m(c).num("start")).toBe(1e7); expect(m(c).num("stop")).toBe(3.6e9); } },
    ],
  },
  get_amplitude: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.text).toMatch(/"reference_level"/); } }] },
  set_amplitude: {
    steps: [
      { args: { reference_level: -10, attenuation_db: 20 }, check: (r, c) => { ok(r); expect(m(c).num("rl")).toBe(-10); expect(m(c).num("att")).toBe(20); expect(m(c).bool("att.auto")).toBe(false); } },
      { args: { reference_level: 100 }, check: (r, c) => { ok(r); expect(m(c).num("rl")).toBe(30); expect(warns(r).join(" ")).toMatch(/reference/i); } },
      { args: { reference_level: 0, attenuation_auto: true }, check: (r, c) => { ok(r); expect(m(c).num("rl")).toBe(0); expect(m(c).bool("att.auto")).toBe(true); } },
    ],
  },
  get_bandwidth: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.text).toMatch(/rbw_hz/); } }] },
  set_bandwidth: {
    steps: [
      { args: { rbw_hz: 100e3 }, check: (r, c) => { ok(r); expect(m(c).num("rbw")).toBe(1e5); expect(m(c).bool("rbw.auto")).toBe(false); } },
      { args: { rbw_hz: 50e3 }, check: (r, c) => { ok(r); expect(m(c).num("rbw")).toBe(3e4); expect(warns(r).join(" ")).toMatch(/rbw/i); } }, // snaps to 1-3-10
      { args: { rbw_auto: true, vbw_auto: true }, check: (r, c) => { ok(r); expect(m(c).bool("rbw.auto")).toBe(true); expect(m(c).num("rbw")).toBe(3e6); } },
    ],
  },
  get_sweep: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.text).toMatch(/sweep_points/); } }] },
  set_sweep: {
    steps: [
      { args: { sweep_points: 501 }, check: (r, c) => { ok(r); expect(m(c).num("pts")).toBe(501); } },
      { args: { sweep_points: 1001 }, check: (r, c) => { ok(r); expect(m(c).num("pts")).toBe(1001); } },
    ],
  },
  get_detector: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.text).toMatch(/normal/i); } }] },
  set_detector: {
    steps: [
      { args: { trace: 1, detector: "sample" }, check: (r, c) => { ok(r); expect(m(c).str("det", 1)).toBe("SAMPle"); expect(m(c).bool("det.auto", 1)).toBe(false); } },
      { args: { trace: 1, auto: true }, check: (r, c) => { ok(r); expect(m(c).bool("det.auto", 1)).toBe(true); } },
    ],
  },
  get_acquisition: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.continuous).toBe(true); } }] },
  set_acquisition: {
    steps: [
      { args: { continuous: false }, check: (r, c) => { ok(r); expect(m(c).bool("cont")).toBe(false); } },
      { args: { continuous: true }, check: (r, c) => { ok(r); expect(m(c).bool("cont")).toBe(true); } },
    ],
  },
  start_sweep: { steps: [{ args: { timeout_s: 3 }, check: (r, c) => { ok(r); expect(r.json.started).toBe(true); expect(m(c).received).toContain(":INITiate:IMMediate"); } }] },
  single_sweep: {
    // Whether the first *OPC? poll lands inside the 2.6 ms sweep depends on machine speed, so the ignored-commands
    // window is asserted with the fake's clock in tests/unit/fakeUts.test.ts, not here.
    steps: [{ args: { timeout_s: 3 }, check: (r, c) => { ok(r); expect(m(c).bool("cont")).toBe(false); } }],
  },
  wait_for_sweep_complete: { steps: [{ args: { timeout_s: 3 }, check: (r) => ok(r) }] },
  screenshot: {
    // Over raw TCP the instrument stops after 144,800 bytes, so the tool refuses and says how to get a screenshot.
    steps: [{ args: {}, check: (r) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/144,800/); expect(r.text).toMatch(/vxi11/i); } }],
  },
  get_trace: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.selected_trace).toBe(1); expect(r.json.traces).toHaveLength(6); } }] },
  set_trace: {
    steps: [
      { args: { trace: 2, type: "max_hold" }, check: (r, c) => { ok(r); expect(m(c).str("tr.type", 2)).toBe("MAXHold"); } },
      { args: { selected_trace: 2 }, check: (r, c) => { ok(r); expect(m(c).num("tr.sel")).toBe(2); } },
      { args: { trace: 2, type: "write" }, check: (r, c) => { ok(r); expect(m(c).str("tr.type", 2)).toBe("WRITe"); } },
      { args: { selected_trace: 1 }, check: (r) => ok(r) },
    ],
  },
  restart_trace: { steps: [{ args: { trace: 2 }, check: (r) => ok(r) }] },
  set_trace_math: {
    steps: [
      { args: { trace: 4, operation: "power_sum", operand_a: 1, operand_b: 2 }, check: (r, c) => { ok(r); expect(m(c).bool("tr.disp", 4)).toBe(true); } },
      { args: { trace: 4, operation: "off" }, check: (r) => ok(r) },
    ],
  },
  get_trace_data: {
    steps: [
      { args: { format: "ascii" }, check: (r) => { ok(r); expect(r.json.points).toBe(1001); expect(r.json.format).toBe("ascii"); } },
      // binary formats switch :FORMat for the read and always put it back
      { args: { format: "real32" }, check: (r, c) => { ok(r); expect(r.json.points).toBe(1001); expect(m(c).str("fmt")).toBe("ASCii"); } },
      { args: { format: "real64" }, check: (r, c) => { ok(r); expect(r.json.points).toBe(1001); expect(m(c).str("fmt")).toBe("ASCii"); } },
    ],
  },
  set_marker: {
    steps: [
      { args: { marker: 1, mode: "normal", x_hz: 1e9 }, check: (r, c) => { ok(r); expect(m(c).str("mk.mode", 1)).toBe("POSition"); expect(m(c).num("mk.x", 1)).toBe(1e9); } },
      { args: { marker: 2, mode: "delta", reference_marker: 1 }, check: (r, c) => { ok(r); expect(m(c).str("mk.mode", 2)).toBe("DELTa"); expect(m(c).num("mk.ref", 2)).toBe(1); } },
    ],
  },
  get_marker: { steps: [{ args: { marker: 1 }, check: (r) => { ok(r); expect(r.json.mode).toBe("normal"); expect(r.json.x).toBe(1e9); } }] },
  marker_search: {
    steps: [{ args: { marker: 3, action: "peak" }, check: (r, c) => { ok(r); expect(m(c).str("mk.mode", 3)).toBe("POSition"); expect(r.json.marker.mode).toBe("normal"); } }],
  },
  marker_to_instrument: {
    steps: [{ args: { marker: 1, target: "center" }, check: (r, c) => { ok(r); expect(m(c).num("fc")).toBe(1e9); } }],
  },
  markers_all_off: { steps: [{ args: {}, check: (r, c) => { ok(r); for (let n = 1; n <= 10; n++) expect(m(c).str("mk.mode", n)).toBe("OFF"); } }] },
  get_peak_criteria: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.threshold_auto).toBe(false); expect(r.json.threshold_dbm).toBe(-50); } }] },
  set_peak_criteria: {
    steps: [{ args: { threshold_dbm: -50, excursion_db: 3 }, check: (r, c) => { ok(r); expect(m(c).num("pk.thr")).toBe(-50); expect(m(c).bool("pk.thr.auto")).toBe(false); expect(m(c).num("pk.exc")).toBe(3); } }],
  },
  get_marker_function: { steps: [{ args: { marker: 1 }, check: (r) => { ok(r); expect(r.json.function).toBe("noise"); expect(r.json.band_span_hz).toBe(1e6); } }] },
  set_marker_function: {
    steps: [{ args: { marker: 1, function: "noise", band_span_hz: 1e6 }, check: (r, c) => { ok(r); expect(m(c).str("mf.fn", 1)).toBe("NOISe"); expect(m(c).num("mf.span", 1)).toBe(1e6); } }],
  },
  get_marker_ndb: { steps: [{ args: { marker: 1 }, check: (r) => { ok(r); expect(r.json.enabled).toBe(false); expect(r.json.ndb).toBe(-6); } }] },
  set_marker_ndb: {
    steps: [
      { args: { marker: 1, enabled: true, ndb: -6 }, check: (r, c) => { ok(r); expect(m(c).bool("nd.on", 1)).toBe(true); expect(m(c).num("nd.n", 1)).toBe(-6); } },
      { args: { marker: 1, enabled: false }, check: (r) => ok(r) },
    ],
  },
  get_frequency_counter: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.enabled).toBe(false); expect(r.json.gate_time_s).toBe(0.01); } }] },
  set_frequency_counter: {
    steps: [
      { args: { enabled: true, gate_time_s: 0.01 }, check: (r, c) => { ok(r); expect(m(c).bool("fc.on")).toBe(true); expect(m(c).num("fc.gate")).toBe(0.01); } },
      { args: { enabled: false }, check: (r) => ok(r) },
    ],
  },
  set_limit_line: {
    steps: [{
      args: { line: 1, type: "upper", displayed: true, points: [{ frequency_hz: 1e8, amplitude_dbm: -50 }, { frequency_hz: 5e8, amplitude_dbm: -30, connected: false }] },
      check: (r, c) => { ok(r); expect(m(c).limitPoints.get(1)).toHaveLength(6); expect(m(c).limitPoints.get(1)![0]).toBe(1e8); expect(m(c).limitPoints.get(1)![2]).toBe(1); expect(m(c).bool("ll.disp", 1)).toBe(true); },
    }],
    timeoutMs: 30_000,
  },
  get_limit_line: {
    steps: [{ args: { line: 1 }, check: (r) => { ok(r); expect(r.json.points).toHaveLength(2); expect(r.json.points[0].frequency_hz).toBe(1e8); } }],
    timeoutMs: 30_000,
  },
  delete_limit_line: {
    // the empty line's DATA? is silent, so the tool's readback takes its timeout (a stall in the fake, like the instrument)
    steps: [{ args: { line: 1 }, check: (r, c) => { ok(r); expect(m(c).limitPoints.get(1)).toBeUndefined(); } }],
    timeoutMs: 60_000,
  },
  get_tracking_generator: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.enabled).toBe(false); expect(r.json.level_dbm).toBe(-20); } }], timeoutMs: 30_000 },
  set_tracking_generator: {
    steps: [
      { args: { enabled: true, level_dbm: -20 }, check: (r, c) => { ok(r); expect(m(c).bool("tg.out")).toBe(true); expect(m(c).num("tg.level")).toBe(-20); } },
      { args: { enabled: false }, check: (r, c) => { ok(r); expect(m(c).bool("tg.out")).toBe(false); } },
    ],
    timeoutMs: 60_000,
  },
  // Measurement function module (#177): :INSTrument[:SELect]. The fake always accepts the switch (ASSUMED: unlike the real
  // analyzer, every module is licensed in the fake; no settle delay).
  get_instrument_module: { steps: [{ args: {}, check: (r) => { ok(r); expect(r.json.module).toBe("spectrum_analyzer"); } }], timeoutMs: 30_000 },
  get_ad_settings: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's frequency/bandwidth/timing subsystem (docs/research/analog-demodulation.md); " +
      "most of these getters have not been live-verified (docs/verified-hardware.md). Covered with a dedicated fake in " +
      "tests/integration/ad-settings-tools.test.ts.",
  },
  set_ad_frequency: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's frequency/bandwidth subsystem (docs/research/analog-demodulation.md); the " +
      "setter ranges/clamp-vs-error behavior have not been live-verified. Covered with a dedicated fake in " +
      "tests/integration/ad-settings-tools.test.ts.",
  },
  set_ad_demod_timing: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's demod-timing subsystem (docs/research/analog-demodulation.md); the setter " +
      "ranges/clamp-vs-error behavior have not been live-verified. Covered with a dedicated fake in " +
      "tests/integration/ad-settings-tools.test.ts.",
  },
  set_ad_filters: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's filter subsystem (docs/research/analog-demodulation.md); the filter " +
      "mutual-exclusion behavior has not been live-verified. Covered with a dedicated fake in tests/integration/ad-audio-tools.test.ts.",
  },
  set_ad_audio: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's speaker/volume subsystem (docs/research/analog-demodulation.md risk 3); " +
      "intentionally never exercised against the real analyzer outside a confirmed, supervised live session. Covered with a " +
      "dedicated fake in tests/integration/ad-audio-tools.test.ts.",
  },
  get_demod_result: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's :FETCh:AM?/:FETCh:FM? results readback (docs/research/analog-demodulation.md " +
      "section 6a); live-verified once (docs/verified-hardware.md) but not against this fake. Covered with a dedicated fake in " +
      "tests/integration/ad-results-tools.test.ts.",
  },
  set_ad_display: {
    // steps[0].args is still used (not executed, since skip below makes the ORDER loop it.skip this entry) by the
    // "every instrument tool refuses an unknown instrument" test, which needs valid args for a tool whose shape has
    // a required field (window) with no default.
    steps: [{ args: { window: 1, reference_level: -10 }, check: () => {} }],
    skip:
      "fakeUts.ts does not model the AD module's display/window subsystem (docs/research/analog-demodulation.md section 2); not " +
      "yet live-verified. Covered with a dedicated fake in tests/integration/ad-display-marker-tools.test.ts.",
  },
  ad_marker: {
    steps: [{ args: { marker: 1, mode: "normal" }, check: () => {} }], // see set_ad_display's comment
    skip:
      "fakeUts.ts does not model the AD module's marker subsystem (docs/research/analog-demodulation.md section 2); not yet " +
      "live-verified. Covered with a dedicated fake in tests/integration/ad-display-marker-tools.test.ts.",
  },
  ad_marker_search: {
    steps: [{ args: { marker: 1, action: "peak" }, check: () => {} }], // see set_ad_display's comment
    skip:
      "fakeUts.ts does not model the AD module's marker subsystem; not yet live-verified. Covered with a dedicated fake in " +
      "tests/integration/ad-display-marker-tools.test.ts.",
  },
  get_ad_marker: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's marker subsystem; not yet live-verified. Covered with a dedicated fake in " +
      "tests/integration/ad-display-marker-tools.test.ts.",
  },
  ad_markers_all_off: {
    steps: [],
    skip:
      "fakeUts.ts does not model the AD module's marker subsystem; not yet live-verified. Covered with a dedicated fake in " +
      "tests/integration/ad-display-marker-tools.test.ts.",
  },
  get_emi_settings: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (its ~30 undocumented-live-behavior SCPI queries, docs/research/emi-function.md); " +
      "EMI-12 (#187) hardware verification has not run. Covered with a dedicated fake in tests/integration/emi-settings-tools.test.ts.",
  },
  set_emi_scan_table: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-scan-table-tools.test.ts.",
  },
  set_emi_measurement: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-measurement-tools.test.ts.",
  },
  get_emi_limit_line: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-limit-line-tools.test.ts.",
  },
  set_emi_limit_line: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-limit-line-tools.test.ts.",
  },
  delete_emi_limit_line: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-limit-line-tools.test.ts.",
  },
  get_emi_correction: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); the 10-point cap was live-verified " +
      "(2026-11-12) but EMI-12 (#187)'s full hardware verification pass has not run. Covered with a dedicated fake in " +
      "tests/integration/emi-correction-tools.test.ts.",
  },
  set_emi_correction: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); the 10-point cap was live-verified " +
      "(2026-11-12) but EMI-12 (#187)'s full hardware verification pass has not run. Covered with a dedicated fake in " +
      "tests/integration/emi-correction-tools.test.ts.",
  },
  get_emi_marker: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-marker-tools.test.ts.",
  },
  set_emi_marker: {
    // steps[0].args is still used (not executed, see set_ad_display's comment) by the "every instrument tool
    // refuses an unknown instrument" test, which needs valid args for a tool whose shape has a required field
    // (marker) with no default.
    steps: [{ args: { marker: 1, mode: "normal" }, check: () => {} }],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-marker-tools.test.ts.",
  },
  emi_marker_search: {
    steps: [{ args: { marker: 1, action: "peak" }, check: () => {} }], // see set_ad_display's comment
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-marker-tools.test.ts.",
  },
  emi_markers_all_off: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-marker-tools.test.ts.",
  },
  get_emi_peak_criteria: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-marker-tools.test.ts.",
  },
  set_emi_peak_criteria: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-marker-tools.test.ts.",
  },
  emi_signal_list: {
    // steps[0].args is still used (not executed, see set_ad_display's comment) by the "every instrument tool
    // refuses an unknown instrument" test, which needs valid args for a tool whose shape has a required field
    // (action) with no default.
    steps: [{ args: { action: "mark_all" }, check: () => {} }],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-signal-list-tools.test.ts.",
  },
  get_emi_signal_list_sort: {
    steps: [],
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-signal-list-tools.test.ts.",
  },
  set_emi_signal_list_sort: {
    steps: [{ args: { sort_type: "frequency" }, check: () => {} }], // see set_ad_display's comment
    skip:
      "fakeUts.ts does not model the EMI subsystem (docs/research/emi-function.md); EMI-12 (#187) hardware verification has not run. " +
      "Covered with a dedicated fake in tests/integration/emi-signal-list-tools.test.ts.",
  },
  select_instrument_module: {
    steps: [
      { args: { module: "emi" }, check: (r, c) => { ok(r); expect(r.json.module).toBe("EMI"); expect(m(c).str("module")).toBe("EMI"); } },
      { args: { module: "sa" }, check: (r, c) => { ok(r); expect(r.json.module).toBe("SA"); expect(m(c).str("module")).toBe("SA"); } },
    ],
    timeoutMs: 30_000,
  },
  // Analog demodulation module (#192): :INSTrument:SELect AD/SA plus the same SA-state save/restore
  // exit_measurement uses. Own snapshot variable (`adSa`), not the measurement group's shared `sa`/`expectRestored`.
  enter_analog_demod: {
    steps: [
      {
        args: (c) => { adSa = snapshot(c); return {}; },
        check: (r, c) => {
          ok(r);
          expect(m(c).str("module")).toBe("AD");
          expect(r.json.module).toBe("analog_demod");
          expect(r.json.saved_settings).toBe(true);
          expect(warns(r)).toEqual([]);
        },
      },
    ],
    timeoutMs: 30_000,
  },
  exit_analog_demod: {
    steps: [
      {
        args: (c) => { m(c).set("fc", adSa!.fc + 1e6); return {}; }, // drift while in AD, as if someone touched the panel
        check: (r, c) => {
          ok(r);
          expect(m(c).str("module")).toBe("SA");
          expect(r.json.module).toBe("spectrum_analyzer");
          expect(r.json.restored).toBe(true);
          expect(warns(r)).toEqual([]);
          expect(snapshot(c)).toEqual(adSa);
        },
      },
      // nothing left to restore the second time; still switches, just warns
      {
        tool: "select_instrument_module",
        args: { module: "ad" },
        check: (r, c) => { ok(r); expect(m(c).str("module")).toBe("AD"); },
      },
      {
        args: {},
        check: (r, c) => {
          ok(r);
          expect(m(c).str("module")).toBe("SA");
          expect(r.json.restored).toBe(false);
          expect(warns(r).join(" ")).toMatch(/enter_analog_demod/);
        },
      },
    ],
    timeoutMs: 30_000,
  },
  // Measurements (#150). The fake models the modes of docs/verified-hardware.md "Measurements". Over raw TCP the tools use
  // FETCh (READ has no line terminator there) and `measure` settles 1.5 s after entering, so these entries take a few seconds.
  get_measurement: {
    steps: [
      { args: {}, check: (r) => { ok(r); expect(r.json.measurement).toBe("spectrum_analyzer"); } },
      // only the active measurement answers its average-state query: this one gets no reply, so it is an error after the probe timeout
      { args: { measurement: "channel_power" }, check: (r) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/not active/); } },
    ],
    timeoutMs: 30_000,
  },
  configure_measurement: {
    steps: [
      { args: { measurement: "channel_power", percent: 0.5 }, check: (r) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/obw only/); } },
      {
        args: (c) => { sa = snapshot(c); return { measurement: "channel_power", integration_bandwidth_hz: 1e6, average_count: 5 }; },
        check: (r, c) => {
          ok(r);
          expect(m(c).mode).toBe("CHPower");
          expect(m(c).num("span")).toBe(3e6); // the preset span; the center stays
          expect(m(c).num("fc")).toBe(sa!.fc);
          expect(r.json.saved_settings).toBe(true);
          expect(r.json.parameters.integration_bandwidth_hz).toBe(1e6);
          expect(r.json.parameters.average_count).toBe(5);
          expect(warns(r)).toEqual([]);
        },
      },
      { tool: "get_measurement", args: { measurement: "channel_power" }, check: (r) => { ok(r); expect(r.json.parameters.average).toBe(true); expect(r.json.parameters.average_type).toBe("power"); } },
    ],
    timeoutMs: 30_000,
  },
  read_measurement: {
    steps: [{
      args: { measurement: "channel_power" },
      check: (r) => {
        ok(r);
        expect(r.json.command).toBe("FETCh");
        expect(r.json.warnings.join(" ")).toMatch(/FETCh was used instead of READ/);
        expect(r.json.channel_power_dbm).toBeCloseTo(-74, 0); // noise floor, docs "Results"
        expect(r.json.power_density_dbm_per_hz).toBeCloseTo(-134, 0); // -74 dBm over the 1 MHz integration bandwidth
      },
    }],
  },
  exit_measurement: {
    steps: [
      // a setter lost once: the first readback finds the span wrong, the second attempt restores it (#133)
      {
        args: (c) => { m(c).loseNext("span", 1); return {}; },
        check: (r, c) => { ok(r); expect(r.json.restored).toBe(true); expect(warns(r).join(" ")).toMatch(/span_hz did not read back/); expectRestored(c); },
      },
      { tool: "configure_measurement", args: { measurement: "obw", percent: 0.9 }, check: (r, c) => { ok(r); expect(m(c).mode).toBe("OBWidth"); expect(r.json.parameters.percent).toBe(0.9); } },
      // lost twice: the readback after the resend still differs, so an error names the field (never success)
      {
        args: (c) => { m(c).loseNext("span", 2); return {}; },
        check: (r, c) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/could not be restored.*span_hz/); expect(m(c).mode).toBe("SA"); expect(m(c).num("span")).toBe(3e6); },
      },
      // the instrument is still usable: exiting again resends the saved settings
      { args: {}, check: (r, c) => { ok(r); expect(r.json.restored).toBe(true); expectRestored(c); } },
    ],
    timeoutMs: 60_000,
  },
  measure: {
    steps: [
      { args: { measurement: "harmonics", harmonics_count: 5 }, check: (r, c) => { ok(r); expect(r.json.restored).toBe(true); expect(r.json.result.harmonics).toHaveLength(4); expect(r.json.result.thd_percent).toEqual(expect.any(Number)); expectRestored(c); } },
      { args: { measurement: "acpr", offset_side: "positive" }, check: (r, c) => { ok(r); expect(r.json.result.lower_power_dbm).toBeNull(); expect(r.json.result.upper_dbc).toEqual(expect.any(Number)); expect(r.json.result.warnings.join(" ")).toMatch(/lower adjacent channel not measured/); expectRestored(c); } },
      { args: { measurement: "time_power" }, check: (r, c) => { ok(r); expect(r.json.result.power_dbm).toEqual(expect.any(Number)); expectRestored(c); } }, // zero span, then restored
      { args: { measurement: "toi" }, check: (r, c) => { ok(r); expect(r.json.result.lower_third_order.toi_dbm).toEqual(expect.any(Number)); expectRestored(c); } },
      { args: { measurement: "obw" }, check: (r, c) => { ok(r); expect(r.json.result.obw_hz).toEqual(expect.any(Number)); expectRestored(c); } },
      // restore-by-readback inside the one-shot tool: one lost setter is resent and reported as a warning
      {
        args: (c) => { m(c).loseNext("span", 1); return { measurement: "cn" }; },
        check: (r, c) => { ok(r); expect(r.json.result.cn_db).toEqual(expect.any(Number)); expect(r.json.warnings.join(" ")).toMatch(/span_hz did not read back/); expectRestored(c); },
      },
      // #161: entering a measurement switches the generator output off; measure/exit_measurement put it back
      { tool: "set_tracking_generator", args: { enabled: true, level_dbm: -25, level_offset_db: 1.5 }, check: (r, c) => { ok(r); expect(m(c).bool("tg.out")).toBe(true); } },
      {
        args: { measurement: "cn" },
        check: (r, c) => {
          ok(r);
          expect(warns(r)).toEqual([]);
          expect(m(c).mode).toBe("SA");
          expect([m(c).bool("tg.out"), m(c).num("tg.level"), m(c).num("tg.off")]).toEqual([true, -25, 1.5]);
        },
      },
      { tool: "configure_measurement", args: { measurement: "cn" }, check: (r, c) => { ok(r); expect(m(c).bool("tg.out")).toBe(false); } },
      // while a measurement is active the generator cannot be read or changed: say so (not "no tracking generator option")
      {
        tool: "set_tracking_generator", args: { enabled: true },
        check: (r, c) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/cannot be changed while a measurement is active.*exit_measurement/); expect(r.text).not.toMatch(/probably/); expect(m(c).bool("tg.out")).toBe(false); },
      },
      { tool: "get_tracking_generator", args: {}, check: (r) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/while a measurement is active.*exit_measurement/); } },
      { tool: "exit_measurement", args: {}, check: (r, c) => { ok(r); expect(warns(r)).toEqual([]); expect([m(c).bool("tg.out"), m(c).num("tg.level"), m(c).num("tg.off")]).toEqual([true, -25, 1.5]); } },
      // a lost output setter: resent once, reported with the field name
      {
        tool: "measure", args: (c) => { m(c).loseNext("tg.out", 1); return { measurement: "obw" }; },
        check: (r, c) => { ok(r); expect(warns(r).join(" ")).toMatch(/tracking generator.*enabled/); expect(m(c).bool("tg.out")).toBe(true); },
      },
      // entered outside this server: no memory of it, the generator tools still blame the measurement, not a missing option
      { tool: "scpi_command", args: { command: ":CONFigure:CHPower" }, check: (r) => ok(r) },
      { tool: "set_tracking_generator", args: { enabled: false }, check: (r) => { expect(r.isError).toBe(true); expect(r.text).toMatch(/measurement is active.*exit_measurement|exit_measurement.*measurement/s); } },
      { tool: "exit_measurement", args: {}, check: (r, c) => { ok(r); expect(m(c).mode).toBe("SA"); expect(warns(r).join(" ")).toMatch(/tracking generator/); } },
      { tool: "set_tracking_generator", args: { enabled: false }, check: (r, c) => { ok(r); expect(m(c).bool("tg.out")).toBe(false); } },
    ],
    timeoutMs: 120_000,
  },
};

/** Execution order: connect first, disconnect last; state carries over, so a getter follows its setter. */
export const ORDER = [
  "connect", "identify", "scpi_query", "scpi_command",
  "set_frequency", "get_frequency", "set_amplitude", "get_amplitude", "set_bandwidth", "get_bandwidth",
  "set_sweep", "get_sweep", "set_detector", "get_detector", "set_acquisition", "get_acquisition",
  "start_sweep", "single_sweep", "wait_for_sweep_complete", "screenshot",
  "set_trace", "get_trace", "restart_trace", "set_trace_math", "get_trace_data",
  "set_marker", "get_marker", "marker_search", "marker_to_instrument", "markers_all_off",
  "set_peak_criteria", "get_peak_criteria", "set_marker_function", "get_marker_function",
  "set_marker_ndb", "get_marker_ndb", "set_frequency_counter", "get_frequency_counter",
  "set_limit_line", "get_limit_line", "delete_limit_line", "set_tracking_generator", "get_tracking_generator",
  "get_instrument_module", "select_instrument_module", "enter_analog_demod", "exit_analog_demod",
  "get_ad_settings", "set_ad_frequency", "set_ad_demod_timing", "set_ad_filters", "set_ad_audio", "get_demod_result",
  "set_ad_display", "ad_marker", "ad_marker_search", "get_ad_marker", "ad_markers_all_off",
  "get_emi_settings", "set_emi_scan_table", "set_emi_measurement",
  "get_emi_limit_line", "set_emi_limit_line", "delete_emi_limit_line",
  "get_emi_correction", "set_emi_correction",
  "get_emi_marker", "set_emi_marker", "emi_marker_search", "emi_markers_all_off",
  "get_emi_peak_criteria", "set_emi_peak_criteria",
  "emi_signal_list", "get_emi_signal_list_sort", "set_emi_signal_list_sort",
  "get_measurement", "configure_measurement", "read_measurement", "exit_measurement", "measure",
  "discover_instruments", "list_instruments", "disconnect",
];
