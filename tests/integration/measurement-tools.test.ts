import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerMeasurementTools, probeTuning } from "../../src/tools/measurement.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Small stateful fake of the measurement modes (behavior verified on the UTS3036B, docs/verified-hardware.md):
 * - no query reports the active measurement; `:SENSe:<meas>:AVERage:STATe?` answers only while that measurement
 *   is active and `:SENSe:DETector:TRACe1?` only in spectrum analyzer mode (otherwise the query times out);
 * - `:CONFigure:<meas>` presets the span to 3 MHz and the RBW/sweep time follow it; exiting does not restore them.
 */
const fake = vi.hoisted(() => {
  type Mode = "sa" | "CHPower" | "OBWidth" | "TPOWer";
  const initial = () => ({
    mode: "sa" as Mode,
    center: 1.805e9, span: 3.59e9, rbw: 3e6, rbwAuto: true, vbw: 3e6, vbwAuto: true,
    sweepTime: 2.6475e-3, sweepAuto: true, continuous: true,
    avg: { CHPower: true, OBWidth: true, TPOWer: true } as Record<string, boolean>,
    avgCount: { CHPower: 10, OBWidth: 10, TPOWer: 10 } as Record<string, number>,
    avgTcon: { CHPower: "EXPonential", OBWidth: "EXPonential", TPOWer: "EXPonential" } as Record<string, string>,
    avgType: { CHPower: "POWEr", OBWidth: "POWEr", TPOWer: "POWEr" } as Record<string, string>,
    chBw: 2e6, obwPercent: 0.99, obwXdb: -26, tpL: 0, tpR: 0.01,
    errors: [] as string[],
    failRead: false,
  });
  const state = initial();
  const calls: string[] = [];
  const queries: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const flag = (b: boolean) => (b ? "1" : "0");
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  function reset() { Object.assign(state, initial()); calls.length = 0; queries.length = 0; }
  const timeout = (cmd: string) => Promise.reject(new Error(`Query timeout after 1500ms for command: ${cmd}`));
  const query = vi.fn(async (cmd: string, _t?: number, _o?: unknown): Promise<string> => {
    queries.push(cmd);
    let m: RegExpExecArray | null;
    switch (cmd) {
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
      case ":FREQuency:CENTer?": return sci(state.center);
      case ":FREQuency:SPAN?": return sci(state.span);
      case ":SENSe:BANDwidth:RESolution?": return sci(state.rbw);
      case ":SENSe:BANDwidth:RESolution:AUTO?": return flag(state.rbwAuto);
      case ":SENSe:BANDwidth:VIDeo?": return sci(state.vbw);
      case ":SENSe:BANDwidth:VIDeo:AUTO?": return flag(state.vbwAuto);
      case ":SENSe:SWEep:TIME?": return sci(state.sweepTime);
      case ":SENSe:SWEep:TIME:AUTO?": return flag(state.sweepAuto);
      case ":INITiate:CONTinuous?": return flag(state.continuous);
      case ":SENSe:DETector:TRACe1?": return state.mode === "sa" ? "NORMal" : timeout(cmd);
    }
    if ((m = /^:SENSe:(CHPower|OBWidth|TPOWer):(.*)\?$/.exec(cmd))) {
      const [, meas, rest] = m;
      if (state.mode !== meas) return timeout(cmd);
      switch (rest) {
        case "AVERage:STATe": return flag(state.avg[meas]);
        case "AVERage:COUNt": return String(state.avgCount[meas]);
        case "AVERage:TCONtrol": return state.avgTcon[meas];
        case "AVERage:TYPE": return state.avgType[meas];
        case "BANDwidth:INTegration": return meas === "CHPower" ? sci(state.chBw) : timeout(cmd);
        case "PERCent": return meas === "OBWidth" ? sci(state.obwPercent) : timeout(cmd);
        case "XDB": return meas === "OBWidth" ? sci(state.obwXdb) : timeout(cmd);
        case "LLIMit": return meas === "TPOWer" ? sci(state.tpL) : timeout(cmd);
        case "RLIMit": return meas === "TPOWer" ? sci(state.tpR) : timeout(cmd);
      }
    }
    if (cmd === ":READ:OBWidth?" && state.mode === "OBWidth") return "2.973026973e+06 ,-7.179511261e+01,3.000000000e+06 ,1001,3.000000000e+04 ,0.000000000e+00 ,2.997000e+06 ";
    if ((m = /^:(READ|FETCh):(CHPower|TPOWer|OBWidth)(?::(\w+))?\?$/.exec(cmd))) {
      const [, , meas, sub] = m;
      if (state.mode !== meas) return timeout(cmd);
      if (state.failRead && m[1] === "READ") return timeout(cmd);
      if (meas === "CHPower" && !sub) return "-7.366048e+01,-1.366708e+02";
      if (meas === "TPOWer" && !sub) return "-9.206767e+01";
      if (meas === "OBWidth") {
        if (sub === "OBWidth") return "2.997003e+06 ";
        if (sub === "FERRor") return "0.000000e+00";
        if (sub === "XDB") return "1.200000e+04 ";
        if (sub === "APOWr") return "-7.180824e+01";
      }
    }
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    let m: RegExpExecArray | null;
    if ((m = /^:CONFigure:(CHPower|OBWidth|TPOWer)(:NDEFault)?$/.exec(cmd))) {
      state.mode = m[1] as Mode;
      state.span = m[1] === "TPOWer" ? 0 : 3e6; state.rbw = 3e4; state.rbwAuto = true; state.vbw = 3e4; state.vbwAuto = true; state.sweepTime = 6.2e-2; state.sweepAuto = true;
      return;
    }
    if (cmd === ":CONFigure:SANalyzer") { state.mode = "sa"; return; } // verified: span etc. stay at the preset values
    const parts = /^(\S+) (\S+)$/.exec(cmd);
    if (!parts) { state.errors.push('-101,"Invalid character"'); return; }
    const [, head, arg] = parts;
    const on = arg === "ON" || arg === "1";
    switch (head) {
      case ":FREQuency:CENTer": state.center = Number(arg); return;
      case ":FREQuency:SPAN": state.span = Number(arg); if (state.rbwAuto) state.rbw = 3e6; return;
      case ":SENSe:BANDwidth:RESolution": state.rbw = Number(arg); state.rbwAuto = false; return;
      case ":SENSe:BANDwidth:RESolution:AUTO": state.rbwAuto = on; if (on) state.rbw = state.span > 1e9 ? 3e6 : 3e4; return;
      case ":SENSe:BANDwidth:VIDeo": state.vbw = Number(arg); state.vbwAuto = false; return;
      case ":SENSe:BANDwidth:VIDeo:AUTO": state.vbwAuto = on; if (on) state.vbw = state.rbw; return;
      case ":SENSe:SWEep:TIME": state.sweepTime = Number(arg); state.sweepAuto = false; return;
      case ":SENSe:SWEep:TIME:AUTO": state.sweepAuto = on; if (on) state.sweepTime = state.span > 1e9 ? 2.6475e-3 : 6.2e-2; return;
      case ":INITiate:CONTinuous": state.continuous = on; return;
    }
    if ((m = /^:SENSe:(CHPower|OBWidth|TPOWer):(.*)$/.exec(head))) {
      const [, meas, rest] = m;
      if (state.mode !== meas) { state.errors.push('-113,"Undefined header"'); return; }
      switch (rest) {
        case "AVERage:STATe": state.avg[meas] = on; return;
        case "AVERage:COUNt": state.avgCount[meas] = Math.trunc(Number(arg)); return;
        case "AVERage:TCONtrol": state.avgTcon[meas] = arg; return;
        case "AVERage:TYPE": state.avgType[meas] = arg; return;
        case "BANDwidth:INTegration": state.chBw = clamp(Number(arg), 100, 3.61e9); return;
        case "PERCent": state.obwPercent = clamp(Number(arg), 0.01, 0.9999); return;
        case "XDB": state.obwXdb = clamp(Number(arg), -100, -0.1); return;
        case "LLIMit": state.tpL = clamp(Number(arg), 0, 0.01); return;
        case "RLIMit": state.tpR = clamp(Number(arg), 0, 0.01); return;
      }
    }
    state.errors.push('-113,"Undefined header"');
  });
  const link = { transport: "vxi11" as string };
  const impls = { query: query.getMockImplementation()!, sendCommand: sendCommand.getMockImplementation()! };
  return { state, reset, calls, queries, query, sendCommand, impls, link };
});

vi.mock("../../src/connection.js", () => ({
  connection: { get transportName() { return fake.link.transport; }, query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  probeTuning.recoveryMs = 0;
  probeTuning.settleMs = 0;
  const ctx = await createTestServer(registerMeasurementTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => { await cleanup(); });
beforeEach(async () => {
  // Tests replace the mock implementations; put the fake instrument back. Leave any saved state of an
  // earlier test behind (exit_measurement forgets it in spectrum analyzer mode).
  fake.query.mockImplementation(fake.impls.query);
  fake.sendCommand.mockImplementation(fake.impls.sendCommand);
  fake.reset();
  fake.link.transport = "vxi11";
  vi.clearAllMocks();
  await callTool(client, "exit_measurement", { restore_settings: false });
  fake.reset();
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));

describe("tool listing", () => {
  it("registers the measurement tools; the readers are read-only", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(["configure_measurement", "exit_measurement", "get_measurement", "measure", "read_measurement"]);
    expect(by.get_measurement.annotations?.readOnlyHint).toBe(true);
    expect(by.read_measurement.annotations?.readOnlyHint).toBe(true);
    for (const n of ["configure_measurement", "exit_measurement", "measure"]) expect(by[n].annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_measurement", () => {
  it("reports spectrum analyzer mode with one query and no commands", async () => {
    const out = json(await callTool(client, "get_measurement"));
    expect(out).toEqual({ measurement: "spectrum_analyzer" });
    expect(fake.queries).toEqual([":SENSe:DETector:TRACe1?"]);
    expect(fake.calls).toEqual([]);
  });
  it("never scans: in a measurement mode it is an error after the one query that got no reply", async () => {
    fake.state.mode = "OBWidth";
    const res = await callTool(client, "get_measurement");
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/not in spectrum analyzer mode/);
    expect(getText(res)).toContain(":SENSe:DETector:TRACe1?");
    expect(fake.queries).toEqual([":SENSe:DETector:TRACe1?"]);
  });
  it("checks one named measurement and returns its parameters", async () => {
    fake.state.mode = "CHPower";
    expect(json(await callTool(client, "get_measurement", { measurement: "channel_power" }))).toEqual({
      measurement: "channel_power",
      parameters: { average: true, average_count: 10, average_control: "exponential", average_type: "power", integration_bandwidth_hz: 2e6 },
    });
    fake.state.mode = "OBWidth";
    expect(json(await callTool(client, "get_measurement", { measurement: "obw" }))).toEqual({
      measurement: "obw",
      parameters: { average: true, average_count: 10, average_control: "exponential", average_type: "power", percent: 0.99, xdb: -26 },
    });
    fake.state.mode = "TPOWer";
    expect(json(await callTool(client, "get_measurement", { measurement: "time_power" }))).toEqual({
      measurement: "time_power",
      parameters: { average: true, average_count: 10, average_control: "exponential", average_type: "power", left_limit_s: 0, right_limit_s: 0.01 },
    });
  });
  it("a named measurement that is not active is an error naming the silent query", async () => {
    fake.state.mode = "OBWidth";
    const res = await callTool(client, "get_measurement", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/not active/);
    expect(getText(res)).toContain(":SENSe:CHPower:AVERage:STATe?");
  });
  it("passes other failures (not connected) through instead of guessing a mode", async () => {
    fake.query.mockImplementation(async () => { throw new Error("Not connected to the spectrum analyzer. Use the 'connect' tool first."); });
    const res = await callTool(client, "get_measurement");
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
  it("rejects an unknown measurement name", async () => {
    expect((await callTool(client, "get_measurement", { measurement: "nope" })).isError).toBe(true);
  });
});

describe("configure_measurement", () => {
  it("enters channel power with the preset, sets parameters, reads them back", async () => {
    const res = await callTool(client, "configure_measurement", { measurement: "channel_power", integration_bandwidth_hz: 1e6, average_count: 5 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":CONFigure:CHPower", ":SENSe:CHPower:BANDwidth:INTegration 1000000", ":SENSe:CHPower:AVERage:COUNt 5"]);
    const out = json(res);
    expect(out.measurement).toBe("channel_power");
    expect(out.parameters.integration_bandwidth_hz).toBe(1e6);
    expect(out.parameters.average_count).toBe(5);
    expect(out.warnings).toEqual([]);
    expect(fake.state.mode).toBe("CHPower");
  });
  it("preset=false uses :NDEFault; obw and time_power parameters", async () => {
    await callTool(client, "configure_measurement", { measurement: "obw", preset: false, percent: 0.9, xdb: -20, average: false, average_type: "log", average_control: "repeat" });
    expect(fake.calls).toEqual([
      ":CONFigure:OBWidth:NDEFault", ":SENSe:OBWidth:AVERage:STATe OFF", ":SENSe:OBWidth:AVERage:TYPE LOG",
      ":SENSe:OBWidth:AVERage:TCONtrol REPeat", ":SENSe:OBWidth:PERCent 0.9", ":SENSe:OBWidth:XDB -20",
    ]);
    fake.calls.length = 0;
    await callTool(client, "configure_measurement", { measurement: "time_power", left_limit_s: 0.001, right_limit_s: 0.005 });
    expect(fake.calls).toEqual([":CONFigure:TPOWer", ":SENSe:TPOWer:LLIMit 0.001", ":SENSe:TPOWer:RLIMit 0.005"]);
  });
  it("warns about values the instrument clamped (RLIMit max 10 ms, xdB max -0.1)", async () => {
    const res = await callTool(client, "configure_measurement", { measurement: "channel_power", integration_bandwidth_hz: 1 });
    expect(json(res).warnings.join(" ")).toMatch(/integration_bandwidth_hz/);
  });
  it("rejects invalid parameters before sending anything", async () => {
    const bad: Array<Record<string, unknown>> = [
      { measurement: "channel_power", percent: 0.5 },
      { measurement: "obw", integration_bandwidth_hz: 1e6 },
      { measurement: "obw", left_limit_s: 0 },
      { measurement: "time_power", xdb: -10 },
      { measurement: "channel_power", integration_bandwidth_hz: 0 },
      { measurement: "channel_power", integration_bandwidth_hz: -5 },
      { measurement: "channel_power", average_count: 0 },
      { measurement: "channel_power", average_count: 1000 },
      { measurement: "channel_power", average_count: 2.5 },
      { measurement: "obw", percent: 0 },
      { measurement: "obw", percent: 1.5 },
      { measurement: "obw", xdb: 3 },
      { measurement: "obw", xdb: -101 },
      { measurement: "time_power", left_limit_s: -1 },
      { measurement: "time_power", right_limit_s: 0.5 },
      { measurement: "nonsense" },
    ];
    for (const args of bad) {
      const res = await callTool(client, "configure_measurement", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([]);
  });
  it("reports instrument errors and says the settings may be partially applied", async () => {
    const impl = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => { await impl(cmd); if (cmd.startsWith(":CONFigure")) fake.state.errors.push('-221,"Settings conflict"'); });
    const res = await callTool(client, "configure_measurement", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/-221/);
    expect(getText(res)).toMatch(/get_measurement/);
  });
});

describe("read_measurement", () => {
  it("channel power: READ by default, FETCh on request; power and density", async () => {
    fake.state.mode = "CHPower";
    const out = json(await callTool(client, "read_measurement", { measurement: "channel_power" }));
    expect(out).toEqual({ measurement: "channel_power", command: "READ", channel_power_dbm: -73.66048, power_density_dbm_per_hz: -136.6708 });
    expect(fake.queries).toEqual([":SENSe:CHPower:AVERage:STATe?", ":READ:CHPower?"]);
    fake.queries.length = 0;
    const f = json(await callTool(client, "read_measurement", { measurement: "channel_power", fetch: true }));
    expect(f.command).toBe("FETCh");
    expect(fake.queries).toEqual([":SENSe:CHPower:AVERage:STATe?", ":FETCh:CHPower?"]);
  });
  it("over raw TCP READ replies have no line terminator, so FETCh is used and a warning says so", async () => {
    fake.link.transport = "raw";
    fake.state.mode = "CHPower";
    const out = json(await callTool(client, "read_measurement", { measurement: "channel_power" }));
    expect(out.command).toBe("FETCh");
    expect(out.channel_power_dbm).toBe(-73.66048);
    expect(out.warnings.join(" ")).toMatch(/READ/);
    expect(fake.queries.some((q) => q.startsWith(":READ"))).toBe(false);
    fake.queries.length = 0;
    fake.state.mode = "OBWidth";
    await callTool(client, "read_measurement", { measurement: "obw" });
    expect(fake.queries.some((q) => q.startsWith(":READ"))).toBe(false);
  });
  it("time power", async () => {
    fake.state.mode = "TPOWer";
    expect(json(await callTool(client, "read_measurement", { measurement: "time_power" }))).toEqual({
      measurement: "time_power", command: "READ", power_dbm: -92.06767,
    });
  });
  it("obw: READ the first value, FETCh the rest of the same measurement", async () => {
    fake.state.mode = "OBWidth";
    const out = json(await callTool(client, "read_measurement", { measurement: "obw" }));
    expect(out).toEqual({
      measurement: "obw", command: "READ", obw_hz: 2997003, frequency_error_hz: 0, xdb_bandwidth_hz: 12000, total_power_dbm: -71.80824,
    });
    expect(fake.queries.slice(1)).toEqual([":READ:OBWidth?", ":FETCh:OBWidth:OBWidth?", ":FETCh:OBWidth:FERRor?", ":FETCh:OBWidth:XDB?", ":FETCh:OBWidth:APOWr?"]);
  });
  it("errors when the measurement is not active, without reading and without changing the mode", async () => {
    fake.state.mode = "OBWidth";
    const res = await callTool(client, "read_measurement", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/not active/);
    expect(getText(res)).toMatch(/configure_measurement/);
    expect(fake.calls).toEqual([]);
    expect(fake.queries.some((q) => q.startsWith(":READ") || q.startsWith(":FETCh"))).toBe(false);
  });
  it("errors on a malformed or missing reply naming the command", async () => {
    fake.state.mode = "CHPower";
    const impl = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (cmd: string, t?: number, o?: unknown) => (cmd === ":READ:CHPower?" ? "garbage" : impl(cmd, t, o)));
    let res = await callTool(client, "read_measurement", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":READ:CHPower?");
    fake.query.mockImplementation(async (cmd: string, t?: number, o?: unknown) => (cmd === ":READ:CHPower?" ? "-70.0" : impl(cmd, t, o)));
    res = await callTool(client, "read_measurement", { measurement: "channel_power" });
    expect(res.isError).toBe(true); // one value where two are defined: never partial data as complete
  });
  it("rejects an unknown measurement", async () => {
    expect((await callTool(client, "read_measurement", { measurement: "nope" })).isError).toBe(true);
  });
});

describe("exit_measurement", () => {
  it("is a no-op in spectrum analyzer mode", async () => {
    const out = json(await callTool(client, "exit_measurement"));
    expect(out.measurement).toBe("spectrum_analyzer");
    expect(fake.calls).toEqual([]);
  });
  it("sends :CONFigure:SANalyzer and restores the frequency/bandwidth/sweep settings saved when the measurement was entered", async () => {
    fake.state.rbwAuto = false; fake.state.rbw = 1e5; fake.state.vbw = 1e5; fake.state.continuous = false;
    await callTool(client, "configure_measurement", { measurement: "channel_power" });
    expect(fake.state.span).toBe(3e6);
    fake.calls.length = 0;
    const res = await callTool(client, "exit_measurement");
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.measurement).toBe("spectrum_analyzer");
    expect(out.restored).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(fake.calls[0]).toBe(":CONFigure:SANalyzer");
    expect(fake.state.mode).toBe("sa");
    expect(fake.state.center).toBe(1.805e9);
    expect(fake.state.span).toBe(3.59e9);
    expect(fake.state.rbw).toBe(1e5);
    expect(fake.state.rbwAuto).toBe(false);
    expect(fake.state.continuous).toBe(false);
  });
  it("restore_settings=false only leaves the mode", async () => {
    await callTool(client, "configure_measurement", { measurement: "obw" });
    fake.calls.length = 0;
    const out = json(await callTool(client, "exit_measurement", { restore_settings: false }));
    expect(out.restored).toBe(false);
    expect(fake.calls).toEqual([":CONFigure:SANalyzer"]);
    expect(fake.state.span).toBe(3e6);
  });
  it("without saved settings (measurement entered elsewhere) it only exits and says so", async () => {
    fake.state.mode = "OBWidth";
    const out = json(await callTool(client, "exit_measurement"));
    expect(out.restored).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/no saved settings/i);
  });
  it("is an error when the instrument is still in a measurement afterwards", async () => {
    fake.state.mode = "OBWidth";
    const impl = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => { if (cmd !== ":CONFigure:SANalyzer") await impl(cmd); });
    const res = await callTool(client, "exit_measurement");
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/still/i);
  });
});

describe("measure (one shot: configure, read, always restore)", () => {
  it("measures channel power and leaves the instrument as it was", async () => {
    fake.state.center = 433e6; fake.state.span = 10e6; fake.state.rbwAuto = false; fake.state.rbw = 3e4; fake.state.vbw = 3e4; fake.state.sweepAuto = true; fake.state.sweepTime = 6.2e-2;
    const before = JSON.stringify(fake.state);
    const res = await callTool(client, "measure", { measurement: "channel_power", integration_bandwidth_hz: 1e6 });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.result.channel_power_dbm).toBe(-73.66048);
    expect(out.result.command).toBe("READ");
    expect(out.restored).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(fake.state.mode).toBe("sa");
    expect(fake.state.center).toBe(433e6);
    expect(fake.state.span).toBe(10e6);
    expect(fake.state.rbw).toBe(3e4);
    expect(fake.state.rbwAuto).toBe(false);
    expect(fake.state.sweepAuto).toBe(true);
    // Everything but the measurement's own parameter (the one that was set) is back as it was.
    expect(JSON.stringify({ ...fake.state, errors: [], chBw: 0 })).toBe(JSON.stringify({ ...JSON.parse(before), errors: [], chBw: 0 }));
  });
  it("restores even when the read fails, and reports the read failure", async () => {
    fake.state.failRead = true;
    const res = await callTool(client, "measure", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":READ:CHPower?");
    expect(fake.state.mode).toBe("sa");
    expect(fake.state.span).toBe(3.59e9);
    expect(fake.state.center).toBe(1.805e9);
  });
  it("restores even when configuring fails midway", async () => {
    const impl = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith(":SENSe:OBWidth:PERCent")) throw new Error("Connection closed unexpectedly (while sending " + cmd + ")");
      await impl(cmd);
    });
    const res = await callTool(client, "measure", { measurement: "obw", percent: 0.9 });
    expect(res.isError).toBe(true);
    expect(fake.state.mode).toBe("sa");
    expect(fake.state.span).toBe(3.59e9);
  });
  it("says so when the restore itself cannot be verified", async () => {
    const impl = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => { if (cmd !== ":CONFigure:SANalyzer") await impl(cmd); });
    const res = await callTool(client, "measure", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/still/i);
  });
  describe("restore is verified by readback (#133)", () => {
    /** Make the instrument ignore :FREQuency:SPAN setters while restoring (the measurement's own values stay): `drops` times, or always when Infinity. */
    const dropSpanSetter = (drops: number) => {
      const impl = fake.sendCommand.getMockImplementation()!;
      let left = drops;
      fake.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith(":FREQuency:SPAN ") && fake.state.mode === "sa" && left > 0) { left--; return; }
        await impl(cmd);
      });
    };
    it("retries a field whose readback differs once and reports it as a warning when the retry works", async () => {
      dropSpanSetter(1);
      const res = await callTool(client, "measure", { measurement: "channel_power" });
      expect(res.isError).toBeFalsy();
      const out = json(res);
      expect(out.restored).toBe(true);
      expect(out.warnings.join(" ")).toMatch(/restore.*span_hz.*second attempt/i);
      expect(fake.state.span).toBe(3.59e9);
    });
    it("is an error naming the field when the retry fails too, never a success", async () => {
      dropSpanSetter(Infinity);
      const res = await callTool(client, "measure", { measurement: "channel_power" });
      expect(res.isError).toBe(true);
      expect(getText(res)).toMatch(/span_hz/);
      expect(getText(res)).toMatch(/3000000/);
      expect(getText(res)).toMatch(/3590000000/);
    });
    it("exit_measurement reports an unverifiable restore as an error too", async () => {
      await callTool(client, "configure_measurement", { measurement: "channel_power" });
      dropSpanSetter(Infinity);
      const res = await callTool(client, "exit_measurement");
      expect(res.isError).toBe(true);
      expect(getText(res)).toMatch(/span_hz/);
    });
    it("back-to-back measures of every kind leave the state exactly as it was", async () => {
      fake.state.center = 433e6; fake.state.span = 10e6; fake.state.rbwAuto = false; fake.state.rbw = 3e4; fake.state.vbwAuto = false; fake.state.vbw = 1e4; fake.state.sweepAuto = false; fake.state.sweepTime = 0.5;
      const before = JSON.stringify(fake.state);
      for (const measurement of ["obw", "time_power", "channel_power", "obw"]) {
        const res = await callTool(client, "measure", { measurement });
        expect(res.isError).toBeFalsy();
        expect(json(res).warnings).toEqual([]);
        expect(JSON.stringify({ ...fake.state, avg: 0 })).toBe(JSON.stringify({ ...JSON.parse(before), avg: 0 }));
      }
    });
  });
  it("refuses to start from a different active measurement (presets overwrite its span; it cannot be restored)", async () => {
    fake.state.mode = "OBWidth";
    const res = await callTool(client, "measure", { measurement: "channel_power" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/exit_measurement/);
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([":SENSe:DETector:TRACe1?", ":SENSe:CHPower:AVERage:STATe?"]); // two queries, no scan
  });
  it("with the requested measurement already active it only reads (no mode change); parameters are restored", async () => {
    fake.state.mode = "CHPower";
    const res = await callTool(client, "measure", { measurement: "channel_power", integration_bandwidth_hz: 5e5 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":SENSe:CHPower:BANDwidth:INTegration 500000", ":SENSe:CHPower:BANDwidth:INTegration 2000000"]);
    expect(fake.calls.some((c) => c.startsWith(":CONFigure"))).toBe(false);
    expect(fake.state.mode).toBe("CHPower");
    expect(fake.state.chBw).toBe(2e6);
  });
  it("rejects invalid parameters before touching the instrument", async () => {
    const res = await callTool(client, "measure", { measurement: "obw", percent: 3 });
    expect(res.isError).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([]);
  });
});
