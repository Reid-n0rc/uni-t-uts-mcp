import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerBandwidthSweepTools } from "../../src/tools/bandwidthSweep.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Small stateful fake of the bandwidth/sweep/detector/trigger subsystems (behavior verified on the UTS3036B). */
const fake = vi.hoisted(() => {
  const initial = () => ({
    rbw: 3e6, rbwAuto: true, vbw: 3e6, vbwAuto: true, ratio: 1, shape: "GAUSsian",
    time: 2.6475e-3, timeAuto: true, rule: "NORMal", type: "SWEep", typeAuto: true, points: 1001,
    det: ["NORMal", "NORMal", "NORMal", "NORMal", "NORMal", "NORMal"] as string[],
    detAuto: [true, true, true, true, true, true] as boolean[],
    trigSource: "IMMediate", trigLevel: -25,
    errors: [] as string[],
  });
  const state = initial();
  const calls: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const snap = (hz: number) => {
    const c = clamp(hz, 1, 3e6);
    const decade = 10 ** Math.floor(Math.log10(c));
    const m = c / decade;
    return decade * (m >= 10 ? 10 : m >= 3 ? 3 : 1);
  };
  const flag = (b: boolean) => (b ? "1" : "0");
  const B = ":SENSe:BANDwidth";
  const S = ":SENSe:SWEep";
  const D = ":SENSe:DETector";
  const T = ":TRIGger:SEQuence";
  function reset() { Object.assign(state, initial()); calls.length = 0; }
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    let m: RegExpExecArray | null;
    switch (cmd) {
      case `${B}:RESolution?`: return sci(state.rbw);
      case `${B}:RESolution:AUTO?`: return flag(state.rbwAuto);
      case `${B}:VIDeo?`: return sci(state.vbw);
      case `${B}:VIDeo:AUTO?`: return flag(state.vbwAuto);
      case `${B}:VIDeo:RATio?`: return sci(state.ratio);
      case `${B}:SHAPe?`: return state.shape;
      case `${S}:TIME?`: return sci(state.time) + " ";
      case `${S}:TIME:AUTO?`: return flag(state.timeAuto);
      case `${S}:TIME:AUTO:RULes?`: return state.rule;
      case `${S}:TYPE?`: return state.type;
      case `${S}:TYPE:AUTO?`: return flag(state.typeAuto);
      case `${S}:POINts?`: return String(state.points);
      case `${T}:SOURce?`: return state.trigSource;
      case `${T}:VIDeo:LEVel?`: return sci(state.trigLevel);
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
    }
    if ((m = /^:SENSe:DETector:TRACe([1-6])\?$/.exec(cmd))) return state.det[Number(m[1]) - 1];
    if ((m = /^:SENSe:DETector:TRACe([1-6]):AUTO\?$/.exec(cmd))) return flag(state.detAuto[Number(m[1]) - 1]);
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    const m = /^(\S+) (\S+)$/.exec(cmd);
    if (!m) { state.errors.push('-101,"Invalid character"'); return; }
    const [, head, arg] = m;
    const on = arg === "ON" || arg === "1";
    let d: RegExpExecArray | null;
    switch (head) {
      case `${B}:RESolution`: state.rbw = snap(Number(arg)); state.rbwAuto = false; if (state.vbwAuto) state.vbw = state.rbw * state.ratio; return;
      case `${B}:RESolution:AUTO`: state.rbwAuto = on; return;
      case `${B}:VIDeo`: state.vbw = snap(Number(arg)); state.vbwAuto = false; return;
      case `${B}:VIDeo:AUTO`: state.vbwAuto = on; return;
      case `${B}:VIDeo:RATio`: state.ratio = clamp(Number(arg), 1e-5, 3e6); return;
      case `${B}:SHAPe`:
        if (arg === "GAUSsian" || arg === "FLATtop") state.shape = arg; else state.errors.push('-224,"Illegal parameter value"');
        return;
      case `${S}:TIME`: state.time = clamp(Number(arg), 1e-3, 4000); state.timeAuto = false; return;
      case `${S}:TIME:AUTO`: state.timeAuto = on; return;
      case `${S}:TIME:AUTO:RULes`:
        if (arg === "NORMal" || arg === "ACCuracy") state.rule = arg; else state.errors.push('-224,"Illegal parameter value"');
        return;
      case `${S}:TYPE`:
        if (arg === "SWEep" || arg === "FFT") { state.type = arg; state.typeAuto = false; } else state.errors.push('-224,"Illegal parameter value"');
        return;
      case `${S}:TYPE:AUTO`: state.typeAuto = on; return;
      case `${S}:POINts`: state.points = clamp(Math.trunc(Number(arg)), 11, 40001); return;
      case `${T}:SOURce`:
        if (arg === "IMMediate" || arg === "VIDeo") state.trigSource = arg; else state.errors.push('-224,"Illegal parameter value"');
        return;
      case `${T}:VIDeo:LEVel`: state.trigLevel = clamp(Number(arg), -170, 30); state.trigSource = "VIDeo"; return; // verified: setting the level selects the video trigger
    }
    if ((d = /^:SENSe:DETector:TRACe([1-6])$/.exec(head))) {
      if (["SAMPle", "POSitive", "NEGative", "NORMal", "AVERage"].includes(arg)) {
        state.det[Number(d[1]) - 1] = arg; state.detAuto[Number(d[1]) - 1] = false;
      } else state.errors.push('-224,"Illegal parameter value"');
      return;
    }
    if ((d = /^:SENSe:DETector:TRACe([1-6]):AUTO$/.exec(head))) { state.detAuto[Number(d[1]) - 1] = on; return; }
    state.errors.push('-113,"Undefined header"');
  });
  return { state, reset, calls, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerBandwidthSweepTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => { await cleanup(); });
beforeEach(() => { fake.reset(); vi.clearAllMocks(); });

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));
const B = ":SENSe:BANDwidth";
const S = ":SENSe:SWEep";

describe("tool listing", () => {
  it("registers get/set for bandwidth, sweep and detector; getters are read-only", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual([
      "get_bandwidth", "get_detector", "get_sweep", "set_bandwidth", "set_detector", "set_sweep",
    ]);
    for (const n of ["get_bandwidth", "get_detector", "get_sweep"]) expect(by[n].annotations?.readOnlyHint).toBe(true);
    for (const n of ["set_bandwidth", "set_detector", "set_sweep"]) expect(by[n].annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_bandwidth", () => {
  it("returns RBW/VBW, auto flags, ratio and filter shape", async () => {
    expect(json(await callTool(client, "get_bandwidth"))).toEqual({
      rbw_hz: 3e6, rbw_auto: true, vbw_hz: 3e6, vbw_auto: true, vbw_rbw_ratio: 1, filter_shape: "gaussian",
    });
  });
  it("maps flat-top and manual flags", async () => {
    fake.state.shape = "FLATtop"; fake.state.rbwAuto = false;
    const out = json(await callTool(client, "get_bandwidth"));
    expect(out.filter_shape).toBe("flattop");
    expect(out.rbw_auto).toBe(false);
  });
  it("returns an error result on a bad reply or connection error", async () => {
    fake.query.mockResolvedValueOnce("garbage");
    expect((await callTool(client, "get_bandwidth")).isError).toBe(true);
    fake.query.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "get_bandwidth");
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
});

describe("set_bandwidth", () => {
  it("sets a manual RBW as a bare number (manual turns auto off) and re-reads", async () => {
    const res = await callTool(client, "set_bandwidth", { rbw_hz: 100000 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([`${B}:RESolution 100000`]);
    const out = json(res);
    expect(out.state.rbw_hz).toBe(1e5);
    expect(out.state.rbw_auto).toBe(false);
    expect(out.warnings).toEqual([]);
  });
  it("sets RBW/VBW auto toggles", async () => {
    fake.state.rbwAuto = false; fake.state.vbwAuto = false;
    await callTool(client, "set_bandwidth", { rbw_auto: true, vbw_auto: true });
    expect(fake.calls).toEqual([`${B}:RESolution:AUTO ON`, `${B}:VIDeo:AUTO ON`]);
    fake.calls.length = 0;
    await callTool(client, "set_bandwidth", { rbw_auto: false, vbw_auto: false });
    expect(fake.calls).toEqual([`${B}:RESolution:AUTO OFF`, `${B}:VIDeo:AUTO OFF`]);
  });
  it("sets VBW, ratio and filter shape; order: shape, RBW, ratio, VBW", async () => {
    await callTool(client, "set_bandwidth", { vbw_hz: 30000, vbw_rbw_ratio: 3, rbw_hz: 100000, filter_shape: "flattop" });
    expect(fake.calls).toEqual([
      `${B}:SHAPe FLATtop`, `${B}:RESolution 100000`, `${B}:VIDeo:RATio 3`, `${B}:VIDeo 30000`,
    ]);
    expect(fake.state.shape).toBe("FLATtop");
  });
  it("sends gaussian", async () => {
    fake.state.shape = "FLATtop";
    await callTool(client, "set_bandwidth", { filter_shape: "gaussian" });
    expect(fake.calls).toEqual([`${B}:SHAPe GAUSsian`]);
  });
  it("warns when the instrument snaps or clamps (1-3-10 steps, 1 Hz..3 MHz)", async () => {
    const res = await callTool(client, "set_bandwidth", { rbw_hz: 50000, vbw_hz: 1e9 });
    const w = json(res).warnings.join(" ");
    expect(w).toMatch(/rbw_hz/);
    expect(w).toMatch(/vbw_hz/);
    expect(json(res).state.rbw_hz).toBe(3e4);
  });
  it("lets VBW follow a manual RBW when VBW is auto (re-read state shows it)", async () => {
    const res = await callTool(client, "set_bandwidth", { rbw_hz: 1e5 });
    expect(json(res).state.vbw_hz).toBe(1e5);
  });
  it("reports instrument errors", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await original(cmd);
      if (cmd.startsWith(`${B}:SHAPe`)) fake.state.errors.push('-224,"Illegal parameter value"');
    });
    try {
      const res = await callTool(client, "set_bandwidth", { filter_shape: "flattop" });
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("Illegal parameter value");
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });
  it.each([
    ["no parameters", {}],
    ["zero rbw", { rbw_hz: 0 }],
    ["negative vbw", { vbw_hz: -5 }],
    ["non-finite rbw", { rbw_hz: Infinity }],
    ["zero ratio", { vbw_rbw_ratio: 0 }],
    ["rbw with rbw_auto=true", { rbw_hz: 1000, rbw_auto: true }],
    ["vbw with vbw_auto=true", { vbw_hz: 1000, vbw_auto: true }],
    ["unknown shape", { filter_shape: "blackman" }],
  ])("rejects %s without sending anything", async (_n, args) => {
    const res = await callTool(client, "set_bandwidth", args as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("get_sweep", () => {
  it("returns time, auto flags, rule, type, points and trigger", async () => {
    expect(json(await callTool(client, "get_sweep"))).toEqual({
      sweep_time_s: 2.6475e-3, sweep_time_auto: true, sweep_time_rule: "normal",
      sweep_type: "sweep", sweep_type_auto: true, sweep_points: 1001,
      trigger_source: "immediate", trigger_video_level_dbm: -25,
    });
  });
  it("maps fft/accuracy/video", async () => {
    Object.assign(fake.state, { type: "FFT", rule: "ACCuracy", trigSource: "VIDeo" });
    const out = json(await callTool(client, "get_sweep"));
    expect([out.sweep_type, out.sweep_time_rule, out.trigger_source]).toEqual(["fft", "accuracy", "video"]);
  });
  it("returns an error result on bad reply", async () => {
    fake.query.mockResolvedValueOnce("garbage");
    expect((await callTool(client, "get_sweep")).isError).toBe(true);
  });
});

describe("set_sweep", () => {
  it("sets points and returns re-read state", async () => {
    const res = await callTool(client, "set_sweep", { sweep_points: 501 });
    expect(fake.calls).toEqual([`${S}:POINts 501`]);
    expect(json(res).state.sweep_points).toBe(501);
    expect(json(res).warnings).toEqual([]);
  });
  it("sets manual sweep time (turns auto off) and auto", async () => {
    const res = await callTool(client, "set_sweep", { sweep_time_s: 0.5 });
    expect(fake.calls).toEqual([`${S}:TIME 0.5`]);
    expect(json(res).state.sweep_time_auto).toBe(false);
    fake.calls.length = 0;
    await callTool(client, "set_sweep", { sweep_time_auto: true });
    expect(fake.calls).toEqual([`${S}:TIME:AUTO ON`]);
  });
  it("sets rule, type, type auto and trigger", async () => {
    await callTool(client, "set_sweep", {
      sweep_time_rule: "accuracy", sweep_type: "fft", trigger_source: "video", trigger_video_level_dbm: -40,
    });
    expect(fake.calls).toEqual([
      `${S}:TYPE FFT`, `${S}:TIME:AUTO:RULes ACCuracy`, `:TRIGger:SEQuence:VIDeo:LEVel -40`, `:TRIGger:SEQuence:SOURce VIDeo`,
    ]);
    fake.calls.length = 0;
    await callTool(client, "set_sweep", { sweep_type_auto: true, trigger_source: "immediate" });
    expect(fake.calls).toEqual([`${S}:TYPE:AUTO ON`, `:TRIGger:SEQuence:SOURce IMMediate`]);
  });
  it("applies points, type and rule before the sweep time, so a manual time is not overridden", async () => {
    await callTool(client, "set_sweep", { sweep_time_s: 1, sweep_points: 2001, sweep_type: "sweep" });
    expect(fake.calls[fake.calls.length - 1]).toBe(`${S}:TIME 1`);
    expect(fake.calls[0]).toBe(`${S}:POINts 2001`);
  });
  it("sets the video level before the source, because the level setter switches the source to video", async () => {
    const res = await callTool(client, "set_sweep", { trigger_source: "immediate", trigger_video_level_dbm: -30 });
    expect(json(res).state.trigger_source).toBe("immediate");
    expect(json(res).warnings).toEqual([]);
  });
  it("warns on clamping", async () => {
    const res = await callTool(client, "set_sweep", { sweep_time_s: 1e6, trigger_video_level_dbm: 500 });
    const w = json(res).warnings.join(" ");
    expect(w).toMatch(/sweep_time_s/);
    expect(w).toMatch(/trigger_video_level_dbm/);
  });
  it.each([
    ["no parameters", {}],
    ["points below 11", { sweep_points: 10 }],
    ["points above 40001", { sweep_points: 40002 }],
    ["non-integer points", { sweep_points: 100.5 }],
    ["zero time", { sweep_time_s: 0 }],
    ["time with auto=true", { sweep_time_s: 1, sweep_time_auto: true }],
    ["type with type_auto=true", { sweep_type: "fft", sweep_type_auto: true }],
    ["external trigger (unsupported)", { trigger_source: "external" }],
    ["non-finite level", { trigger_video_level_dbm: Infinity }],
    ["unknown type", { sweep_type: "zoom" }],
  ])("rejects %s without sending anything", async (_n, args) => {
    const res = await callTool(client, "set_sweep", args as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
  it("reports instrument errors", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await original(cmd);
      if (cmd.startsWith(`${S}:POINts`)) fake.state.errors.push('-224,"Illegal parameter value"');
    });
    try {
      const res = await callTool(client, "set_sweep", { sweep_points: 501 });
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("Illegal parameter value");
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });
});

describe("get_detector", () => {
  it("returns all six traces using :DETector:TRACe<n>", async () => {
    fake.state.det[1] = "SAMPle"; fake.state.detAuto[1] = false;
    const out = json(await callTool(client, "get_detector"));
    expect(out.traces).toHaveLength(6);
    expect(out.traces[0]).toEqual({ trace: 1, detector: "normal", auto: true });
    expect(out.traces[1]).toEqual({ trace: 2, detector: "sample", auto: false });
    const asked = fake.query.mock.calls.map((c) => c[0]);
    expect(asked).toContain(":SENSe:DETector:TRACe6?");
    expect(asked).not.toContain(":SENSe:DETector?");
  });
  it("can read one trace", async () => {
    const out = json(await callTool(client, "get_detector", { trace: 3 }));
    expect(out.traces).toEqual([{ trace: 3, detector: "normal", auto: true }]);
  });
  it("rejects a bad trace", async () => {
    expect((await callTool(client, "get_detector", { trace: 7 })).isError).toBe(true);
  });
});

describe("set_detector", () => {
  it.each([["sample", "SAMPle"], ["positive", "POSitive"], ["negative", "NEGative"], ["normal", "NORMal"], ["average", "AVERage"]])(
    "sets %s on trace 2 via :DETector:TRACe2",
    async (name, raw) => {
      const res = await callTool(client, "set_detector", { trace: 2, detector: name });
      expect(res.isError).toBeFalsy();
      expect(fake.calls).toEqual([`:SENSe:DETector:TRACe2 ${raw}`]);
      expect(json(res).state).toEqual({ trace: 2, detector: name, auto: false });
      expect(json(res).warnings).toEqual([]);
    }
  );
  it("toggles automatic detector selection", async () => {
    fake.state.detAuto[0] = false;
    const res = await callTool(client, "set_detector", { trace: 1, auto: true });
    expect(fake.calls).toEqual([":SENSe:DETector:TRACe1:AUTO ON"]);
    expect(json(res).state.auto).toBe(true);
    fake.calls.length = 0;
    await callTool(client, "set_detector", { trace: 1, auto: false });
    expect(fake.calls).toEqual([":SENSe:DETector:TRACe1:AUTO OFF"]);
  });
  it("warns when the instrument did not take the detector", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith(":SENSe:DETector")) fake.calls.push(cmd); else await original(cmd);
    });
    try {
      const res = await callTool(client, "set_detector", { trace: 1, detector: "positive" });
      expect(json(res).warnings.join(" ")).toMatch(/detector/);
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });
  it.each([
    ["no trace", { detector: "normal" }],
    ["trace 0", { trace: 0, detector: "normal" }],
    ["trace 7", { trace: 7, detector: "normal" }],
    ["nothing to set", { trace: 1 }],
    ["detector with auto=true", { trace: 1, detector: "normal", auto: true }],
    ["unknown detector", { trace: 1, detector: "rms" }],
  ])("rejects %s without sending anything", async (_n, args) => {
    const res = await callTool(client, "set_detector", args as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});
