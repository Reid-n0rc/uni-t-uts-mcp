import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerMarkerFunctionTools } from "../../src/tools/markerFunctions.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake of the marker function, N-dB and frequency counter subsystems. */
const fake = vi.hoisted(() => {
  const initial = () => ({
    fn: Array.from({ length: 11 }, () => "OFF"),
    span: Array.from({ length: 11 }, () => 1e6),
    ndbOn: Array.from({ length: 11 }, () => false),
    ndb: Array.from({ length: 11 }, () => -3),
    fcOn: false, gate: 1e-3,
    errors: [] as string[],
  });
  const state = initial();
  const calls: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  function reset() { Object.assign(state, initial()); calls.length = 0; }
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    const m = /^:CALCulate:MARKer(\d+):(.+)\?$/.exec(cmd);
    if (m) {
      const n = Number(m[1]);
      if (n < 1 || n > 10) throw new Error(`Query timeout after 5000ms for command: ${cmd}`);
      switch (m[2]) {
        case "FUNCtion": return state.fn[n];
        case "FUNCtion:BAND:SPAN": return sci(state.span[n]);
        case "BANDwidth:STATe": return state.ndbOn[n] ? "1" : "0";
        case "BANDwidth:NDB": return sci(state.ndb[n]);
        case "BANDwidth:RESult": return sci(state.ndb[n] === -3 ? 120000 : 250000);
      }
    }
    switch (cmd) {
      case ":CALCulate:MARKer:FCOunt:STATe?": return state.fcOn ? "1" : "0";
      case ":CALCulate:MARKer:FCOunt:GATetime?": return sci(state.gate);
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    const m = /^:CALCulate:MARKer(\d+):(.+?) (\S+)$/.exec(cmd);
    if (m) {
      const n = Number(m[1]);
      const arg = m[3];
      switch (m[2]) {
        case "FUNCtion":
          if (["OFF", "NOISe", "BPOWer", "BDENsity"].includes(arg)) state.fn[n] = arg; else state.errors.push('-224,"Illegal parameter value"');
          return;
        case "FUNCtion:BAND:SPAN": state.span[n] = Number(arg); return;
        case "BANDwidth:STATe": state.ndbOn[n] = arg === "ON"; return;
        case "BANDwidth:NDB": state.ndb[n] = Number(arg); return;
      }
    }
    const f = /^(:CALCulate:MARKer:FCOunt:\S+) (\S+)$/.exec(cmd);
    if (f?.[1] === ":CALCulate:MARKer:FCOunt:STATe") { state.fcOn = f[2] === "ON"; return; }
    if (f?.[1] === ":CALCulate:MARKer:FCOunt:GATetime") { state.gate = Number(f[2]); return; }
    state.errors.push('-113,"Undefined header"');
  });
  return { state, reset, calls, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const ctx = await createTestServer(registerMarkerFunctionTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => { await cleanup(); });
beforeEach(() => { fake.reset(); vi.clearAllMocks(); });

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));
const M = (n: number) => `:CALCulate:MARKer${n}`;
function interceptCommand(fn: (cmd: string) => Promise<void>) {
  fake.sendCommand.mockImplementationOnce(async () => { fake.state.errors.length = 0; });
  fake.sendCommand.mockImplementationOnce(fn);
}

describe("tool listing", () => {
  it("registers the tools; getters are read-only", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual([
      "get_frequency_counter", "get_marker_function", "get_marker_ndb", "set_frequency_counter", "set_marker_function", "set_marker_ndb",
    ]);
    for (const n of ["get_frequency_counter", "get_marker_function", "get_marker_ndb"]) expect(by[n].annotations?.readOnlyHint).toBe(true);
    for (const n of ["set_frequency_counter", "set_marker_function", "set_marker_ndb"]) expect(by[n].annotations?.readOnlyHint).toBe(false);
  });
});

describe("marker function", () => {
  it("reads the function and band span, defaulting to marker 1", async () => {
    expect(json(await callTool(client, "get_marker_function", {}))).toEqual({ marker: 1, function: "off", band_span_hz: 1e6 });
  });

  it.each([["noise", "NOISe"], ["band_power", "BPOWer"], ["band_density", "BDENsity"], ["off", "OFF"]])("%s sends %s", async (name, scpi) => {
    const res = await callTool(client, "set_marker_function", { marker: 2, function: name });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(fake.calls).toEqual([`${M(2)}:FUNCtion ${scpi}`]);
    expect(json(res)).toEqual({ state: { marker: 2, function: name, band_span_hz: 1e6 }, warnings: [] });
  });

  it("sets the band span before the function", async () => {
    const res = await callTool(client, "set_marker_function", { marker: 1, function: "band_power", band_span_hz: 2e6 });
    expect(fake.calls).toEqual([`${M(1)}:FUNCtion:BAND:SPAN 2000000`, `${M(1)}:FUNCtion BPOWer`]);
    expect(json(res).state).toMatchObject({ function: "band_power", band_span_hz: 2e6 });
  });

  it("warns when the instrument did not take the value", async () => {
    interceptCommand(async (cmd) => { fake.calls.push(cmd); });
    const out = json(await callTool(client, "set_marker_function", { marker: 1, function: "noise" }));
    expect(out.warnings.join(" ")).toMatch(/function/);
  });

  it("rejects invalid input without touching the instrument", async () => {
    for (const args of [{}, { marker: 1 }, { marker: 0, function: "noise" }, { marker: 11, function: "noise" }, { marker: 1, function: "bogus" }, { marker: 1, band_span_hz: 0 }, { marker: 1, band_span_hz: -5 }]) {
      expect((await callTool(client, "set_marker_function", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect((await callTool(client, "get_marker_function", { marker: 11 })).isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("errors on a malformed function reply, naming the command", async () => {
    fake.query.mockResolvedValueOnce("garbage");
    const res = await callTool(client, "get_marker_function", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(`${M(1)}:FUNCtion?`);
  });

  it("reports an instrument error as possibly partially applied", async () => {
    interceptCommand(async (cmd) => { fake.calls.push(cmd); fake.state.errors.push('-224,"Illegal parameter value"'); });
    const res = await callTool(client, "set_marker_function", { marker: 1, function: "noise" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/partially applied/);
  });
});

describe("N-dB bandwidth", () => {
  it("reports no bandwidth while off and does not query the result", async () => {
    expect(json(await callTool(client, "get_marker_ndb", { marker: 3 }))).toEqual({ marker: 3, enabled: false, ndb: -3, bandwidth_hz: null });
    expect(fake.query.mock.calls.map((c) => c[0])).not.toContain(`${M(3)}:BANDwidth:RESult?`);
  });

  it("sets N then turns it on and returns the measured bandwidth", async () => {
    const res = await callTool(client, "set_marker_ndb", { marker: 1, enabled: true, ndb: -6 });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(fake.calls).toEqual([`${M(1)}:BANDwidth:NDB -6`, `${M(1)}:BANDwidth:STATe ON`]);
    expect(json(res)).toEqual({ state: { marker: 1, enabled: true, ndb: -6, bandwidth_hz: 250000 }, warnings: [] });
  });

  it("turns it off", async () => {
    fake.state.ndbOn[1] = true;
    const out = json(await callTool(client, "set_marker_ndb", { marker: 1, enabled: false }));
    expect(fake.calls).toEqual([`${M(1)}:BANDwidth:STATe OFF`]);
    expect(out.state.bandwidth_hz).toBeNull();
  });

  it("rejects invalid input", async () => {
    for (const args of [{}, { marker: 1 }, { marker: 1, ndb: 3 }, { marker: 1, ndb: 0 }, { marker: 1, ndb: -141 }, { marker: 12, enabled: true }]) {
      expect((await callTool(client, "set_marker_ndb", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("warns when the value was adjusted", async () => {
    interceptCommand(async (cmd) => { fake.calls.push(cmd); fake.state.ndb[1] = -10; });
    const out = json(await callTool(client, "set_marker_ndb", { marker: 1, ndb: -6 }));
    expect(out.warnings.join(" ")).toMatch(/ndb/);
  });

  it("errors on a malformed result reply", async () => {
    fake.state.ndbOn[1] = true;
    fake.query.mockResolvedValueOnce("1").mockResolvedValueOnce("-3.000000e+00").mockResolvedValueOnce("junk");
    const res = await callTool(client, "get_marker_ndb", { marker: 1 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("RESult?");
  });
});

describe("frequency counter", () => {
  it("reads state and gate time", async () => {
    expect(json(await callTool(client, "get_frequency_counter", {}))).toEqual({ enabled: false, gate_time_s: 1e-3 });
  });

  it("sets gate time then enables", async () => {
    const res = await callTool(client, "set_frequency_counter", { enabled: true, gate_time_s: 0.01 });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(fake.calls).toEqual([":CALCulate:MARKer:FCOunt:GATetime 0.01", ":CALCulate:MARKer:FCOunt:STATe ON"]);
    expect(json(res)).toEqual({ state: { enabled: true, gate_time_s: 0.01 }, warnings: [] });
  });

  it("rejects invalid input", async () => {
    for (const args of [{}, { gate_time_s: 0 }, { gate_time_s: 1 }, { gate_time_s: 1e-7 }]) {
      expect((await callTool(client, "set_frequency_counter", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("warns when the instrument adjusted the gate time", async () => {
    interceptCommand(async (cmd) => { fake.calls.push(cmd); fake.state.gate = 0.5; });
    const out = json(await callTool(client, "set_frequency_counter", { gate_time_s: 0.1 }));
    expect(out.warnings.join(" ")).toMatch(/gate_time_s/);
  });
});
