import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerMeasurementTools, probeTuning } from "../../src/tools/measurement.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Fake of the second group of measurements (ACPR, TOI, C/N, harmonics; issue #19). Same behavior as the first group
 * (docs/verified-hardware.md, "Measurements"): `:SENSe:<meas>:*` queries answer only while that measurement is
 * active, `:SENSe:DETector:TRACe1?` only in spectrum analyzer mode, otherwise the query times out.
 */
const fake = vi.hoisted(() => {
  type Mode = "sa" | "ACPower" | "TOI" | "CNRatio" | "HARMonics";
  const common = { "AVERage:STATe": "1", "AVERage:COUNt": "10", "AVERage:TCONtrol": "EXPonential", "AVERage:TYPE": "POWEr" };
  const initialParams = (): Record<string, Record<string, string>> => ({
    ACPower: { ...common, "BANDwidth:INTegration": "2e+06", "CARRier:LIST:BANDwidth": "2e+06", "OFFSet:LIST:FREQuency": "5e+06", "OFFSet:LIST:SIDE": "BOTH" },
    TOI: { ...common },
    CNRatio: { ...common, "BANDwidth:INTegration": "2e+06", "BANDwidth:NOISe": "1e+06", OFFSet: "3e+06" },
    HARMonics: { ...common, "FREQuency:FUNDamental": "1e+08", NUMBer: "10", SWEeptime: "0.1" },
  });
  const initial = () => ({
    mode: "sa" as Mode,
    center: 1.805e9, span: 3.59e9, rbw: 3e6, rbwAuto: true, vbw: 3e6, vbwAuto: true,
    sweepTime: 2.6475e-3, sweepAuto: true, continuous: true,
    params: initialParams(),
    errors: [] as string[],
    failRead: false,
    acprSide: "BOTH",
  });
  const state = initial();
  const calls: string[] = [];
  const queries: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const flag = (b: boolean) => (b ? "1" : "0");
  function reset() { Object.assign(state, initial()); calls.length = 0; queries.length = 0; }
  const timeout = (cmd: string) => Promise.reject(new Error(`Query timeout after 1500ms for command: ${cmd}`));
  const list = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => sci(f(i))).join(",");
  const results: Record<string, () => string> = {
    "ACPower": () => "-2.0e+01,-4.0e+01,-4.5e+01",
    "ACPower:MAIN": () => "-2.0e+01",
    "ACPower:LOWer": () => (state.acprSide === "POSitive" ? "nan ,nan " : "-6.0e+01,-4.0e+01"),
    "ACPower:UPPer": () => (state.acprSide === "NEGative" ? "nan ,nan " : "-6.5e+01,-4.5e+01"),
    "TOI:LOW:TRD": () => "9.9e+07,-4.0e+01,-5.0e+01,2.0e+01",
    "TOI:UP:TRD": () => "1.02e+08,-4.1e+01,-5.1e+01,2.1e+01",
    "TOI:LOW:TONE": () => "9.95e+07,-3.0e+01",
    "TOI:UP:TONE": () => "1.005e+08,-3.1e+01",
    "CNRatio": () => "-1.0e+01,-7.0e+01,6.0e+01",
    "HARMonics:AMPLitude:ALL": () => list(10, (i) => (i >= Number(state.params.HARMonics.NUMBer) ? 84.5 : i === 0 ? -10 : -30 - i)),
    "HARMonics:FREQuency:ALL": () => list(10, (i) => 1e8 * (i + 1)),
    "HARMonics:DISTortion": () => "1.5e+00,-3.6e+01",
  };
  const query = vi.fn(async (cmd: string, _t?: number, _o?: unknown): Promise<string> => {
    queries.push(cmd);
    let m: RegExpExecArray | null;
    switch (cmd) {
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
      case ":OUTPut:STATe?": return Promise.reject(new Error(`Query timeout after 1500ms for command: ${cmd}`)); // no tracking generator option (#161)
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
    if ((m = /^:SENSe:(ACPower|TOI|CNRatio|HARMonics):(.*)\?$/.exec(cmd))) {
      const [, meas, rest] = m;
      const value = state.mode === meas ? state.params[meas][rest] : undefined;
      return value === undefined ? timeout(cmd) : value;
    }
    if ((m = /^:(READ|FETCh):(.*)\?$/.exec(cmd))) {
      const [, verb, rest] = m;
      const meas = rest.split(":")[0];
      if (state.mode !== meas || !results[rest]) return timeout(cmd);
      if (state.failRead && verb === "READ") return timeout(cmd);
      return results[rest]();
    }
    if (cmd === ":INSTrument:SELect?") return "SA";
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    let m: RegExpExecArray | null;
    if ((m = /^:CONFigure:(ACPower|TOI|CNRatio|HARMonics)(:NDEFault)?$/.exec(cmd))) {
      state.mode = m[1] as Mode;
      state.span = 3e6; state.rbw = 3e4; state.rbwAuto = true; state.vbw = 3e4; state.vbwAuto = true; state.sweepTime = 6.2e-2; state.sweepAuto = true;
      return;
    }
    if (cmd === ":CONFigure:SANalyzer") { state.mode = "sa"; return; }
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
    if ((m = /^:SENSe:(ACPower|TOI|CNRatio|HARMonics):(.*)$/.exec(head))) {
      const [, meas, rest] = m;
      if (state.mode !== meas || state.params[meas][rest] === undefined) { state.errors.push('-113,"Undefined header"'); return; }
      let value = arg;
      if (rest === "AVERage:STATE" || rest === "AVERage:STATe") value = on ? "1" : "0";
      if (meas === "HARMonics" && rest === "NUMBer") { value = String(Math.min(10, Math.max(2, Math.trunc(Number(arg))))); }
      if (meas === "ACPower" && rest === "OFFSet:LIST:SIDE") state.acprSide = arg;
      state.params[meas][rest] = value;
      return;
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
  fake.query.mockImplementation(fake.impls.query);
  fake.sendCommand.mockImplementation(fake.impls.sendCommand);
  fake.reset();
  fake.link.transport = "vxi11";
  vi.clearAllMocks();
  await callTool(client, "exit_measurement", { restore_settings: false });
  fake.reset();
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));
const AVG = { average: true, average_count: 10, average_control: "exponential", average_type: "power" };

describe("get_measurement for the new measurements", () => {
  it("returns the parameters of each", async () => {
    fake.state.mode = "ACPower";
    expect(json(await callTool(client, "get_measurement", { measurement: "acpr" }))).toEqual({
      measurement: "acpr",
      parameters: { ...AVG, integration_bandwidth_hz: 2e6, carrier_bandwidth_hz: 2e6, offset_hz: 5e6, offset_side: "both" },
    });
    fake.state.mode = "TOI";
    expect(json(await callTool(client, "get_measurement", { measurement: "toi" }))).toEqual({ measurement: "toi", parameters: AVG });
    fake.state.mode = "CNRatio";
    expect(json(await callTool(client, "get_measurement", { measurement: "cn" }))).toEqual({
      measurement: "cn",
      parameters: { ...AVG, integration_bandwidth_hz: 2e6, noise_bandwidth_hz: 1e6, offset_hz: 3e6 },
    });
    fake.state.mode = "HARMonics";
    expect(json(await callTool(client, "get_measurement", { measurement: "harmonics" }))).toEqual({
      measurement: "harmonics",
      parameters: { ...AVG, fundamental_hz: 1e8, harmonics_count: 10, sweep_time_s: 0.1 },
    });
  });
  it("a measurement that is not active is an error naming the silent query", async () => {
    fake.state.mode = "TOI";
    const res = await callTool(client, "get_measurement", { measurement: "acpr" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":SENSe:ACPower:AVERage:STATe?");
  });
});

describe("configure_measurement for the new measurements", () => {
  it("acpr: enters with the preset and sets its own parameters", async () => {
    const res = await callTool(client, "configure_measurement", {
      measurement: "acpr", integration_bandwidth_hz: 1e6, carrier_bandwidth_hz: 1.5e6, offset_hz: 4e6, offset_side: "positive",
    });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([
      ":CONFigure:ACPower", ":SENSe:ACPower:BANDwidth:INTegration 1000000", ":SENSe:ACPower:CARRier:LIST:BANDwidth 1500000",
      ":SENSe:ACPower:OFFSet:LIST:FREQuency 4000000", ":SENSe:ACPower:OFFSet:LIST:SIDE POSitive",
    ]);
    const out = json(res);
    expect(out.parameters).toMatchObject({ integration_bandwidth_hz: 1e6, carrier_bandwidth_hz: 1.5e6, offset_hz: 4e6, offset_side: "positive" });
    expect(out.warnings).toEqual([]);
  });
  it("toi enters with :NDEFault when preset=false and sets averaging", async () => {
    await callTool(client, "configure_measurement", { measurement: "toi", preset: false, average: false, average_count: 3 });
    expect(fake.calls).toEqual([":CONFigure:TOI:NDEFault", ":SENSe:TOI:AVERage:STATe OFF", ":SENSe:TOI:AVERage:COUNt 3"]);
  });
  it("cn sets integration and noise bandwidth and the offset", async () => {
    await callTool(client, "configure_measurement", { measurement: "cn", integration_bandwidth_hz: 1e6, noise_bandwidth_hz: 5e5, offset_hz: 2e6 });
    expect(fake.calls).toEqual([
      ":CONFigure:CNRatio", ":SENSe:CNRatio:BANDwidth:INTegration 1000000", ":SENSe:CNRatio:BANDwidth:NOISe 500000", ":SENSe:CNRatio:OFFSet 2000000",
    ]);
  });
  it("harmonics sets fundamental, count and sweep time", async () => {
    const res = await callTool(client, "configure_measurement", { measurement: "harmonics", fundamental_hz: 5e7, harmonics_count: 5, sweep_time_s: 0.5 });
    expect(fake.calls).toEqual([
      ":CONFigure:HARMonics", ":SENSe:HARMonics:FREQuency:FUNDamental 50000000", ":SENSe:HARMonics:SWEeptime 0.5", ":SENSe:HARMonics:NUMBer 5",
    ]);
    expect(json(res).parameters).toMatchObject({ fundamental_hz: 5e7, harmonics_count: 5, sweep_time_s: 0.5 });
  });
  it("saves and restores the spectrum analyzer settings like the first group", async () => {
    await callTool(client, "configure_measurement", { measurement: "cn" });
    expect(fake.state.span).toBe(3e6);
    const out = json(await callTool(client, "exit_measurement"));
    expect(out.restored).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(fake.state.mode).toBe("sa");
    expect(fake.state.span).toBe(3.59e9);
    expect(fake.state.center).toBe(1.805e9);
  });
  it("back-to-back measure of harmonics then toi (the #133 sequence), acpr and cn restores every setting exactly", async () => {
    fake.state.center = 433e6; fake.state.span = 10e6; fake.state.rbwAuto = false; fake.state.rbw = 3e4; fake.state.vbwAuto = false; fake.state.vbw = 1e4; fake.state.sweepAuto = false; fake.state.sweepTime = 0.5;
    const before = { ...fake.state };
    for (const measurement of ["harmonics", "toi", "acpr", "cn", "toi"]) {
      const res = await callTool(client, "measure", { measurement });
      expect(res.isError, `${measurement}: ${getText(res)}`).toBeFalsy();
      expect(json(res).warnings).toEqual([]);
      for (const k of ["mode", "center", "span", "rbw", "rbwAuto", "vbw", "vbwAuto", "sweepTime", "sweepAuto", "continuous"] as const) {
        expect(fake.state[k], `${measurement} ${k}`).toBe(before[k]);
      }
    }
  });
  it("the restore is an error naming the field when the span readback stays at the TOI preset (the 8 MHz case of #133)", async () => {
    const impl = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith(":FREQuency:SPAN ") && fake.state.mode === "sa") return;
      await impl(cmd);
    });
    const res = await callTool(client, "measure", { measurement: "toi" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/span_hz/);
  });
  it("rejects invalid parameters before sending anything", async () => {
    const bad: Array<Record<string, unknown>> = [
      { measurement: "toi", integration_bandwidth_hz: 1e6 },
      { measurement: "acpr", noise_bandwidth_hz: 1e6 },
      { measurement: "cn", carrier_bandwidth_hz: 1e6 },
      { measurement: "cn", fundamental_hz: 1e6 },
      { measurement: "harmonics", offset_hz: 1e6 },
      { measurement: "channel_power", harmonics_count: 3 },
      { measurement: "acpr", offset_side: "left" },
      { measurement: "acpr", integration_bandwidth_hz: 0 },
      { measurement: "acpr", carrier_bandwidth_hz: -1 },
      { measurement: "acpr", offset_hz: -1 },
      { measurement: "cn", noise_bandwidth_hz: 0 },
      { measurement: "harmonics", fundamental_hz: 0 },
      { measurement: "harmonics", harmonics_count: 1 },
      { measurement: "harmonics", harmonics_count: 11 },
      { measurement: "harmonics", harmonics_count: 2.5 },
      { measurement: "harmonics", sweep_time_s: 0.0005 },
      { measurement: "harmonics", sweep_time_s: 101 },
    ];
    for (const args of bad) expect((await callTool(client, "configure_measurement", args)).isError, JSON.stringify(args)).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([]);
  });
  it("warns about values the instrument adjusted", async () => {
    const impl = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => { await impl(cmd.replace("NUMBer 5", "NUMBer 7")); });
    const res = await callTool(client, "configure_measurement", { measurement: "harmonics", harmonics_count: 5 });
    expect(json(res).warnings.join(" ")).toMatch(/harmonics_count/);
  });
});

describe("read_measurement for the new measurements", () => {
  it("acpr: five labeled values", async () => {
    fake.state.mode = "ACPower";
    expect(json(await callTool(client, "read_measurement", { measurement: "acpr" }))).toEqual({
      measurement: "acpr", command: "READ", main_power_dbm: -20, lower_power_dbm: -60, lower_dbc: -40, upper_power_dbm: -65, upper_dbc: -45,
    });
    expect(fake.queries.slice(2)).toEqual([":READ:ACPower?", ":FETCh:ACPower:MAIN?", ":FETCh:ACPower:LOWer?", ":FETCh:ACPower:UPPer?"]);
  });
  it("acpr: a side that is not measured reads nan: null values and a warning", async () => {
    fake.state.mode = "ACPower";
    fake.state.acprSide = "POSitive";
    const out = json(await callTool(client, "read_measurement", { measurement: "acpr", fetch: true }));
    expect(out).toMatchObject({ main_power_dbm: -20, lower_power_dbm: null, lower_dbc: null, upper_power_dbm: -65, upper_dbc: -45 });
    expect(out.warnings.join(" ")).toMatch(/lower adjacent channel not measured/);
  });
  it("acpr: nan everywhere (no result yet) is an error", async () => {
    fake.state.mode = "ACPower";
    const impl = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (cmd: string, t?: number, o?: unknown) => (cmd === ":FETCh:ACPower:MAIN?" ? "nan " : impl(cmd, t, o)));
    const res = await callTool(client, "read_measurement", { measurement: "acpr", fetch: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":FETCh:ACPower:MAIN?");
  });
  it("cn: carrier, noise and ratio", async () => {
    fake.state.mode = "CNRatio";
    expect(json(await callTool(client, "read_measurement", { measurement: "cn", fetch: true }))).toEqual({
      measurement: "cn", command: "FETCh", carrier_dbm: -10, noise_dbm: -70, cn_db: 60,
    });
    expect(fake.queries.slice(2)).toEqual([":FETCh:CNRatio?"]);
  });
  it("toi: READ the first result, FETCh the rest of the same measurement", async () => {
    fake.state.mode = "TOI";
    const out = json(await callTool(client, "read_measurement", { measurement: "toi" }));
    expect(out).toEqual({
      measurement: "toi", command: "READ",
      lower_third_order: { frequency_hz: 9.9e7, amplitude_dbm: -40, dbc: -50, toi_dbm: 20 },
      upper_third_order: { frequency_hz: 1.02e8, amplitude_dbm: -41, dbc: -51, toi_dbm: 21 },
      lower_tone: { frequency_hz: 9.95e7, amplitude_dbm: -30 },
      upper_tone: { frequency_hz: 1.005e8, amplitude_dbm: -31 },
    });
    expect(fake.queries.slice(2)).toEqual([":READ:TOI:LOW:TRD?", ":FETCh:TOI:UP:TRD?", ":FETCh:TOI:LOW:TONE?", ":FETCh:TOI:UP:TONE?"]);
  });
  it("harmonics: fundamental in dBm, harmonics in dBc with frequencies, and distortion", async () => {
    fake.state.mode = "HARMonics";
    const out = json(await callTool(client, "read_measurement", { measurement: "harmonics" }));
    expect(out.command).toBe("READ");
    expect(out.fundamental).toEqual({ frequency_hz: 1e8, amplitude_dbm: -10 });
    expect(out.harmonics).toHaveLength(9);
    expect(out.harmonics[0]).toEqual({ order: 2, frequency_hz: 2e8, amplitude_dbc: -31 });
    expect(out.harmonics[8]).toEqual({ order: 10, frequency_hz: 1e9, amplitude_dbc: -39 });
    expect(out.thd_percent).toBe(1.5);
    expect(out.thd_dbc).toBe(-36);
    expect(fake.queries.slice(2)).toEqual([":SENSe:HARMonics:NUMBer?", ":READ:HARMonics:AMPLitude:ALL?", ":FETCh:HARMonics:FREQuency:ALL?", ":FETCh:HARMonics:DISTortion?"]);
  });
  it("harmonics returns only the configured count (the instrument pads both lists to 10 values)", async () => {
    fake.state.mode = "HARMonics";
    fake.state.params.HARMonics.NUMBer = "4";
    const out = json(await callTool(client, "read_measurement", { measurement: "harmonics" }));
    expect(out.harmonics.map((h: { order: number }) => h.order)).toEqual([2, 3, 4]);
    expect(out.harmonics.every((h: { amplitude_dbc: number }) => h.amplitude_dbc < 0)).toBe(true);
  });
  it("over raw TCP FETCh is used and a warning says so", async () => {
    fake.link.transport = "raw";
    fake.state.mode = "TOI";
    const out = json(await callTool(client, "read_measurement", { measurement: "toi" }));
    expect(out.command).toBe("FETCh");
    expect(out.warnings.join(" ")).toMatch(/READ/);
    expect(fake.queries.some((q) => q.startsWith(":READ"))).toBe(false);
  });
  it("errors when the measurement is not active, without reading", async () => {
    fake.state.mode = "TOI";
    const res = await callTool(client, "read_measurement", { measurement: "harmonics" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/not active/);
    expect(fake.queries.some((q) => q.startsWith(":READ") || q.startsWith(":FETCh"))).toBe(false);
  });
  it("errors on a malformed reply or a wrong value count, naming the command", async () => {
    fake.state.mode = "ACPower";
    const impl = fake.query.getMockImplementation()!;
    for (const reply of ["garbage", "-1.0e+01,-2.0e+01"]) {
      fake.query.mockImplementation(async (cmd: string, t?: number, o?: unknown) => (cmd === ":READ:ACPower?" ? reply : impl(cmd, t, o)));
      const res = await callTool(client, "read_measurement", { measurement: "acpr" });
      expect(res.isError, reply).toBe(true);
      expect(getText(res)).toContain(":READ:ACPower?");
    }
  });
  it("errors when harmonic amplitude and frequency lists differ in length", async () => {
    fake.state.mode = "HARMonics";
    const impl = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (cmd: string, t?: number, o?: unknown) => (cmd === ":FETCh:HARMonics:FREQuency:ALL?" ? "1e8,2e8,3e8" : impl(cmd, t, o)));
    fake.state.params.HARMonics.NUMBer = "3";
    const res = await callTool(client, "read_measurement", { measurement: "harmonics" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":FETCh:HARMonics:FREQuency:ALL?");
  });
  it("a timeout is an error naming the command", async () => {
    fake.state.mode = "CNRatio";
    fake.state.failRead = true;
    const res = await callTool(client, "read_measurement", { measurement: "cn" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":READ:CNRatio?");
  });
});

describe("measure for the new measurements", () => {
  it("measures acpr and leaves the instrument as it was", async () => {
    fake.state.center = 433e6; fake.state.span = 10e6; fake.state.rbw = 3e4; fake.state.vbw = 3e4; fake.state.sweepTime = 6.2e-2;
    const before = JSON.stringify({ ...fake.state, params: 0 });
    const res = await callTool(client, "measure", { measurement: "acpr" });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.result.main_power_dbm).toBe(-20);
    expect(out.restored).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(JSON.stringify({ ...fake.state, params: 0 })).toBe(before);
    expect(fake.state.mode).toBe("sa");
  });
  it("restores even when the read fails", async () => {
    fake.state.failRead = true;
    const res = await callTool(client, "measure", { measurement: "harmonics" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":READ:HARMonics:AMPLitude:ALL?");
    expect(fake.state.mode).toBe("sa");
    expect(fake.state.span).toBe(3.59e9);
  });
  it("with the measurement already active it only reads and puts changed parameters back", async () => {
    fake.state.mode = "CNRatio";
    const res = await callTool(client, "measure", { measurement: "cn", offset_hz: 1e6 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":SENSe:CNRatio:OFFSet 1000000", ":SENSe:CNRatio:OFFSet 3000000"]);
    expect(fake.state.mode).toBe("CNRatio");
  });
  it("refuses to start from a different active measurement", async () => {
    fake.state.mode = "TOI";
    const res = await callTool(client, "measure", { measurement: "acpr" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/exit_measurement/);
    expect(fake.calls).toEqual([]);
  });
  it("rejects invalid parameters before touching the instrument", async () => {
    const res = await callTool(client, "measure", { measurement: "toi", offset_hz: 1 });
    expect(res.isError).toBe(true);
    expect(fake.queries).toEqual([]);
  });
});
