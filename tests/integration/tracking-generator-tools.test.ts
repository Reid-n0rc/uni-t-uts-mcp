import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerTrackingGeneratorTools } from "../../src/tools/trackingGenerator.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake of the tracking generator ("trace source") subsystem, with the clamping seen on the UTS3036B. */
const fake = vi.hoisted(() => {
  const state = {
    out: false, level: -30, offset: 0, ref: false, nt: false, nrl: 10,
    rbwAuto: true, vbwAuto: true, rbw: 3e6, ignoreAutoOn: false, errors: [] as string[], optionAbsent: false,
  };
  const calls: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  function reset() {
    Object.assign(state, { out: false, level: -30, offset: 0, ref: false, nt: false, nrl: 10, rbwAuto: true, vbwAuto: true, rbw: 3e6, ignoreAutoOn: false, errors: [], optionAbsent: false });
    calls.length = 0;
  }
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    if (state.optionAbsent && /^:(OUTPut|SOURce|CALCulate:NTData)/.test(cmd)) throw new Error(`Query timeout after 2000ms for command: ${cmd}`);
    switch (cmd) {
      case ":OUTPut:STATe?": return state.out ? "1" : "0";
      case ":SOURce:POWer?": return sci(state.level);
      case ":SOURce:CORRection:OFFSet?": return sci(state.offset);
      case ":SOURce:TRACe:REFerence:STATe?": return state.ref ? "1" : "0";
      case ":CALCulate:NTData:STATe?": return state.nt ? "1" : "0";
      case ":DISPlay:WINDow:TRACe:Y:SCALe:NRLevel?": return sci(state.nrl);
      case ":SENSe:BANDwidth:RESolution:AUTO?": return state.rbwAuto ? "1" : "0";
      case ":SENSe:BANDwidth:RESolution?": return sci(state.rbw);
      case ":SENSe:BANDwidth:VIDeo:AUTO?": return state.vbwAuto ? "1" : "0";
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    let m = /^:OUTPut:STATe (ON|OFF)$/.exec(cmd);
    if (m) { state.out = m[1] === "ON"; if (!state.out) state.rbw = 3e5; return; } // the stale 300 kHz RBW quirk
    m = /^:SOURce:TRACe:REFerence:STATe (ON|OFF)$/.exec(cmd);
    if (m) { if (state.out) state.ref = m[1] === "ON"; return; } // only takes while the output is on
    m = /^:CALCulate:NTData:STATe (ON|OFF)$/.exec(cmd);
    if (m) { state.nt = m[1] === "ON"; return; }
    m = /^:SENSe:BANDwidth:RESolution:AUTO ON$/.exec(cmd);
    if (m) { state.rbwAuto = true; if (!state.ignoreAutoOn) state.rbw = 3e6; return; }
    m = /^:SENSe:BANDwidth:VIDeo:AUTO ON$/.exec(cmd);
    if (m) { state.vbwAuto = true; return; }
    m = /^(:SOURce:POWer|:SOURce:CORRection:OFFSet|:DISPlay:WINDow:TRACe:Y:SCALe:NRLevel) (\S+)$/.exec(cmd);
    if (!m) { state.errors.push('-113,"Undefined header"'); return; }
    const v = Number(m[2]);
    if (m[1] === ":SOURce:POWer") state.level = clamp(v, -40, 0);
    else if (m[1] === ":SOURce:CORRection:OFFSet") state.offset = clamp(v, -200, 200);
    else state.nrl = clamp(v, -100, 100);
  });
  return { state, reset, calls, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerTrackingGeneratorTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));

describe("tool listing", () => {
  it("registers get_tracking_generator (read-only) and set_tracking_generator", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_tracking_generator", "set_tracking_generator"]);
    expect(byName.get_tracking_generator.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_tracking_generator.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_tracking_generator", () => {
  it("returns the whole state", async () => {
    const res = await callTool(client, "get_tracking_generator", {});
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({
      enabled: false, level_dbm: -30, level_offset_db: 0, reference_trace: false, normalize: false, normalize_ref_level_db: 10,
    });
  });

  it("reports an absent option as an error naming the command", async () => {
    fake.state.optionAbsent = true;
    const res = await callTool(client, "get_tracking_generator", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":OUTPut:STATe?");
    expect(getText(res)).toMatch(/option|not installed|does not have/i);
  });

  it("rejects a malformed reply naming the command", async () => {
    fake.query.mockImplementationOnce(async () => "banana");
    const res = await callTool(client, "get_tracking_generator", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":OUTPut:STATe?");
  });

  it("surfaces connection errors", async () => {
    fake.query.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "get_tracking_generator", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
});

describe("set_tracking_generator", () => {
  it("sets level and offset before switching the output on", async () => {
    const res = await callTool(client, "set_tracking_generator", { enabled: true, level_dbm: -20, level_offset_db: 3.5 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":SOURce:POWer -20", ":SOURce:CORRection:OFFSet 3.5", ":OUTPut:STATe ON"]);
    const out = json(res);
    expect(out.state).toMatchObject({ enabled: true, level_dbm: -20, level_offset_db: 3.5 });
    expect(out.warnings).toEqual([]);
  });

  it("switching off re-asserts automatic RBW and VBW that were on (the stale auto bandwidth quirk)", async () => {
    fake.state.out = true;
    const res = await callTool(client, "set_tracking_generator", { enabled: false });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":OUTPut:STATe OFF", ":SENSe:BANDwidth:RESolution:AUTO ON", ":SENSe:BANDwidth:VIDeo:AUTO ON"]);
    expect(fake.state.rbw).toBe(3e6);
    expect(json(res).warnings).toEqual([]);
  });

  it("warns when the RBW did not return to its value after switching off", async () => {
    fake.state.out = true;
    fake.state.ignoreAutoOn = true;
    const res = await callTool(client, "set_tracking_generator", { enabled: false });
    expect(res.isError).toBeFalsy();
    expect(json(res).warnings.join(" ")).toMatch(/RBW/);
  }, 15000);

  it("switching off leaves a manual RBW/VBW alone", async () => {
    fake.state.out = true; fake.state.rbwAuto = false; fake.state.vbwAuto = false;
    await callTool(client, "set_tracking_generator", { enabled: false });
    expect(fake.calls).toEqual([":OUTPut:STATe OFF"]);
  });

  it("reference trace and normalization, with the normalization reference level", async () => {
    const res = await callTool(client, "set_tracking_generator", {
      enabled: true, reference_trace: true, normalize_ref_level_db: -10, normalize: true,
    });
    expect(fake.calls).toEqual([
      ":OUTPut:STATe ON", ":SOURce:TRACe:REFerence:STATe ON",
      ":DISPlay:WINDow:TRACe:Y:SCALe:NRLevel -10", ":CALCulate:NTData:STATe ON",
    ]);
    expect(json(res).state).toMatchObject({ reference_trace: true, normalize: true, normalize_ref_level_db: -10 });
  });

  it("warns when the instrument changes a requested value", async () => {
    // The tool validates the documented ranges, so provoke a clamp by making the fake clamp tighter than the tool.
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await original(cmd);
      if (cmd.startsWith(":SOURce:POWer")) fake.state.level = -35;
    });
    try {
      const res = await callTool(client, "set_tracking_generator", { level_dbm: -20 });
      const out = json(res);
      expect(out.state.level_dbm).toBe(-35);
      expect(out.warnings.join(" ")).toMatch(/level_dbm.*adjusted/);
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });

  it("warns when the reference trace does not take because the output is off", async () => {
    const res = await callTool(client, "set_tracking_generator", { reference_trace: true });
    const out = json(res);
    expect(out.state.reference_trace).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/reference_trace/);
    expect(out.warnings.join(" ")).toMatch(/output/i);
  });

  it("refuses (nothing sent) when the option is absent", async () => {
    fake.state.optionAbsent = true;
    const res = await callTool(client, "set_tracking_generator", { enabled: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/option|not installed|does not have/i);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("reports instrument errors from the error queue", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await original(cmd);
      if (cmd.startsWith(":SOURce:POWer")) fake.state.errors.push('-224,"Illegal parameter value"');
    });
    try {
      const res = await callTool(client, "set_tracking_generator", { level_dbm: -20 });
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("Illegal parameter value");
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });

  describe("validation (nothing is sent)", () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["no parameters", {}],
      ["level above 0 dBm", { level_dbm: 5 }],
      ["level below -40 dBm", { level_dbm: -41 }],
      ["non-finite level", { level_dbm: Infinity }],
      ["offset out of range", { level_offset_db: 201 }],
      ["offset below range", { level_offset_db: -201 }],
      ["normalize reference level out of range", { normalize_ref_level_db: 101 }],
      ["non-boolean enabled", { enabled: "yes" }],
    ];
    it.each(invalid)("rejects %s", async (_name, args) => {
      const res = await callTool(client, "set_tracking_generator", args);
      expect(res.isError).toBe(true);
      expect(fake.sendCommand).not.toHaveBeenCalled();
      expect(fake.query).not.toHaveBeenCalled();
    });
  });
});
