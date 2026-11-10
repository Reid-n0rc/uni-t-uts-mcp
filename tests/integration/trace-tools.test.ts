import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerTraceTools } from "../../src/tools/trace.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Tiny stateful fake of the analyzer's trace subsystem (behavior verified on the UTS3036B). */
const fake = vi.hoisted(() => {
  const initial = () => ({
    selected: 1,
    type: ["WRITe", "WRITe", "WRITe", "WRITe", "WRITe", "WRITe"],
    update: [1, 1, 1, 0, 0, 0],
    display: [1, 1, 1, 0, 0, 0],
    avgCount: 100,
    avgType: "LOG",
    errors: [] as string[],
  });
  const state = initial();
  const calls: string[] = [];
  const reset = () => {
    Object.assign(state, initial());
    calls.length = 0;
  };
  const queryImpl = async (cmd: string, _t?: number): Promise<string> => {
    let m: RegExpExecArray | null;
    if (cmd === ":TRACe:SELect?") return String(state.selected);
    if ((m = /^:TRACe([1-6]):TYPE\?$/.exec(cmd))) return state.type[Number(m[1]) - 1];
    if ((m = /^:TRACe([1-6]):UPDate:STATe\?$/.exec(cmd))) return String(state.update[Number(m[1]) - 1]);
    if ((m = /^:TRACe([1-6]):DISPlay:STATe\?$/.exec(cmd))) return String(state.display[Number(m[1]) - 1]);
    if (cmd === ":SENSe:AVERage:COUNt?") return String(state.avgCount);
    if (cmd === ":SENSe:AVERage:TYPE?") return state.avgType;
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    throw new Error(`unexpected query ${cmd}`);
  };
  const sendImpl = async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    let m: RegExpExecArray | null;
    const bad = () => state.errors.push('-224,"Illegal parameter value"');
    const bool = (v: string) => (v === "ON" || v === "1" ? 1 : 0);
    if ((m = /^:TRACe:SELect (\S+)$/.exec(cmd))) {
      if (/^[1-6]$/.test(m[1])) state.selected = Number(m[1]); else bad();
    } else if ((m = /^:TRACe([1-6]):TYPE (\S+)$/.exec(cmd))) {
      if (["WRITe", "AVERage", "MAXHold", "MINHold"].includes(m[2])) state.type[Number(m[1]) - 1] = m[2]; else bad();
    } else if ((m = /^:TRACe([1-6]):UPDate:STATe (\S+)$/.exec(cmd))) {
      state.update[Number(m[1]) - 1] = bool(m[2]);
    } else if ((m = /^:TRACe([1-6]):DISPlay:STATe (\S+)$/.exec(cmd))) {
      state.display[Number(m[1]) - 1] = bool(m[2]);
    } else if ((m = /^:SENSe:AVERage:COUNt (\S+)$/.exec(cmd))) {
      state.avgCount = Math.max(1, Math.round(Number(m[1]))); // the unit clamps/rounds silently at the low end
    } else if ((m = /^:SENSe:AVERage:TYPE (\S+)$/.exec(cmd))) {
      if (["VOLTage", "POWEr", "LOG"].includes(m[1])) state.avgType = m[1]; else bad();
    } else if (/^:CALCulate:MATH /.test(cmd)) {
      // accepted, no readback exists
    } else {
      state.errors.push('-113,"Undefined header"');
    }
  };
  const query = vi.fn(queryImpl);
  const sendCommand = vi.fn(sendImpl);
  return { state, reset, calls, query, sendCommand, queryImpl, sendImpl };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerTraceTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  fake.query.mockImplementation(fake.queryImpl);
  fake.sendCommand.mockImplementation(fake.sendImpl);
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));

describe("tool listing", () => {
  it("registers the trace tools with correct read-only hints", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_trace", "restart_trace", "set_trace", "set_trace_math"]);
    expect(byName.get_trace.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_trace.annotations?.readOnlyHint).toBe(false);
    expect(byName.set_trace_math.annotations?.readOnlyHint).toBe(false);
    expect(byName.restart_trace.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_trace", () => {
  it("returns the selected trace, averaging and all six traces", async () => {
    fake.state.type[1] = "MAXHold";
    fake.state.avgType = "POWEr";
    const res = await callTool(client, "get_trace", {});
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.selected_trace).toBe(1);
    expect(out.average_count).toBe(100);
    expect(out.average_type).toBe("power");
    expect(out.traces).toHaveLength(6);
    expect(out.traces[0]).toEqual({ trace: 1, type: "write", update: true, display: true });
    expect(out.traces[1].type).toBe("max_hold");
    expect(out.traces[3]).toEqual({ trace: 4, type: "write", update: false, display: false });
  });

  it("maps every trace type and average type name", async () => {
    for (const [raw, name] of [["WRITe", "write"], ["AVERage", "average"], ["MAXHold", "max_hold"], ["MINHold", "min_hold"]]) {
      fake.state.type[0] = raw;
      expect(json(await callTool(client, "get_trace", { trace: 1 })).traces[0].type).toBe(name);
    }
    for (const [raw, name] of [["VOLTage", "voltage"], ["POWEr", "power"], ["LOG", "log"]]) {
      fake.state.avgType = raw;
      expect(json(await callTool(client, "get_trace", {})).average_type).toBe(name);
    }
  });

  it("reads only the requested trace and uses the per-trace query forms", async () => {
    await callTool(client, "get_trace", { trace: 3 });
    const asked = fake.query.mock.calls.map((c) => c[0]);
    expect(asked).toContain(":TRACe3:TYPE?");
    expect(asked).toContain(":TRACe3:UPDate:STATe?");
    expect(asked).toContain(":TRACe3:DISPlay:STATe?");
    expect(asked.some((c) => /^:TRACe[12456]:/.test(c))).toBe(false);
  });

  it("never asks the unsupported :CALCulate:MATH? query (it stalls the instrument)", async () => {
    await callTool(client, "get_trace", {});
    expect(fake.query.mock.calls.map((c) => c[0]).some((c) => /MATH/i.test(c))).toBe(false);
  });

  it("rejects a trace outside 1-6 without sending anything", async () => {
    for (const trace of [0, 7, 1.5]) {
      const res = await callTool(client, "get_trace", { trace });
      expect(res.isError).toBe(true);
    }
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("returns an error naming the command for an unparseable reply", async () => {
    fake.query.mockResolvedValueOnce("garbage ???");
    const res = await callTool(client, "get_trace", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("garbage ???");
  });

  it("rejects an unknown trace type reply", async () => {
    fake.state.type[0] = "BOGUS";
    const res = await callTool(client, "get_trace", { trace: 1 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":TRACe1:TYPE?");
  });

  it("surfaces connection errors", async () => {
    fake.query.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "get_trace", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
});

describe("set_trace", () => {
  it("sets the type of one trace with the per-trace form", async () => {
    const res = await callTool(client, "set_trace", { trace: 2, type: "max_hold" });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":TRACe2:TYPE MAXHold"]);
    const out = json(res);
    expect(out.warnings).toEqual([]);
    expect(out.state.traces.find((t: { trace: number }) => t.trace === 2).type).toBe("max_hold");
  });

  it.each([
    ["write", "WRITe"], ["average", "AVERage"], ["max_hold", "MAXHold"], ["min_hold", "MINHold"],
  ])("maps type %s to %s", async (name, raw) => {
    await callTool(client, "set_trace", { trace: 4, type: name });
    expect(fake.calls).toEqual([`:TRACe4:TYPE ${raw}`]);
  });

  it("sets update (view/hold) and display state", async () => {
    const res = await callTool(client, "set_trace", { trace: 4, update: true, display: true });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":TRACe4:UPDate:STATe ON", ":TRACe4:DISPlay:STATe ON"]);
    expect(json(res).state.traces[0]).toEqual({ trace: 4, type: "write", update: true, display: true });
    fake.calls.length = 0;
    await callTool(client, "set_trace", { trace: 4, update: false, display: false });
    expect(fake.calls).toEqual([":TRACe4:UPDate:STATe OFF", ":TRACe4:DISPlay:STATe OFF"]);
  });

  it("selects the current trace", async () => {
    const res = await callTool(client, "set_trace", { selected_trace: 3 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":TRACe:SELect 3"]);
    expect(json(res).state.selected_trace).toBe(3);
  });

  it("sets the average count and type (global, not per trace)", async () => {
    const res = await callTool(client, "set_trace", { average_count: 20, average_type: "power" });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":SENSe:AVERage:TYPE POWEr", ":SENSe:AVERage:COUNt 20"]);
    const out = json(res);
    expect(out.state.average_count).toBe(20);
    expect(out.state.average_type).toBe("power");
    expect(out.warnings).toEqual([]);
  });

  it("applies everything in one call in a fixed order: select, trace settings, averaging", async () => {
    await callTool(client, "set_trace", {
      average_count: 5, display: true, type: "average", trace: 5, selected_trace: 2, update: true, average_type: "voltage",
    });
    expect(fake.calls).toEqual([
      ":TRACe:SELect 2",
      ":TRACe5:TYPE AVERage",
      ":TRACe5:UPDate:STATe ON",
      ":TRACe5:DISPlay:STATe ON",
      ":SENSe:AVERage:TYPE VOLTage",
      ":SENSe:AVERage:COUNt 5",
    ]);
  });

  it("warns when the instrument did not take a trace type", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd !== "*CLS") fake.calls.push(cmd);
    });
    const res = await callTool(client, "set_trace", { trace: 2, type: "min_hold" });
    expect(json(res).warnings.join(" ")).toMatch(/type adjusted by the instrument: requested min_hold, now write/);
  });

  it("warns when the instrument kept a different average count", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd !== "*CLS") fake.calls.push(cmd);
    });
    const res = await callTool(client, "set_trace", { average_count: 10 });
    expect(json(res).warnings.join(" ")).toMatch(/average_count adjusted by the instrument: requested 10, now 100/);
  });

  it("requires a trace for type, update and display and a valid index", async () => {
    for (const args of [{ type: "write" }, { update: true }, { display: false }]) {
      const res = await callTool(client, "set_trace", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(getText(res)).toMatch(/trace/);
    }
    for (const bad of [{ trace: 0, type: "write" }, { trace: 7, type: "write" }, { trace: 1.5, type: "write" }, { selected_trace: 7 }, { selected_trace: 0 }]) {
      expect((await callTool(client, "set_trace", bad)).isError, JSON.stringify(bad)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects no parameters and a trace with nothing to set", async () => {
    expect((await callTool(client, "set_trace", {})).isError).toBe(true);
    expect((await callTool(client, "set_trace", { trace: 1 })).isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("validates the average count: integer 1 to 999 (the instrument accepts 0 and 1000 and does not clamp 1000)", async () => {
    for (const average_count of [0, 1000, 1.5, -3, 99999]) {
      const res = await callTool(client, "set_trace", { average_count });
      expect(res.isError, String(average_count)).toBe(true);
      expect(getText(res)).toMatch(/average_count/);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
    for (const average_count of [1, 999]) {
      expect((await callTool(client, "set_trace", { average_count })).isError, String(average_count)).toBeFalsy();
    }
  });

  it("rejects unknown enum values", async () => {
    expect((await callTool(client, "set_trace", { trace: 1, type: "clear" })).isError).toBe(true);
    expect((await callTool(client, "set_trace", { average_type: "rms" })).isError).toBe(true);
  });

  it("reports an instrument error and says the settings may be partially applied", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "*CLS") return;
      fake.calls.push(cmd);
      fake.state.errors.push('-224,"Illegal parameter value"');
    });
    const res = await callTool(client, "set_trace", { trace: 1, type: "average" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("-224");
    expect(getText(res)).toMatch(/partially applied/);
  });

  it("a failing read-back after the commands is not reported as a failure to set", async () => {
    fake.query.mockImplementation(async (cmd: string) => {
      if (cmd === ":SYSTem:ERRor?") return '0,"No error"';
      throw new Error(`Query timeout after 5000ms for command: ${cmd}`);
    });
    const res = await callTool(client, "set_trace", { trace: 1, type: "average" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/may already be applied/);
  });
});

describe("set_trace_math", () => {
  it("sends :CALCulate:MATH with TRACEn operands (power difference)", async () => {
    const res = await callTool(client, "set_trace_math", { trace: 1, operation: "power_difference", operand_a: 2, operand_b: 3 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":CALCulate:MATH TRACE1,PDIFference,TRACE2,TRACE3,0"]);
    expect(json(res).warnings.join(" ")).toMatch(/cannot be read back/);
  });

  it.each([
    ["log_difference", "LDIFference"], ["log_offset", "LOFFset"],
  ])("maps %s to %s and passes the offset", async (operation, raw) => {
    await callTool(client, "set_trace_math", { trace: 4, operation, operand_a: 5, operand_b: 6, offset_db: -12.5 });
    expect(fake.calls).toEqual([`:CALCulate:MATH TRACE4,${raw},TRACE5,TRACE6,-12.5`]);
  });

  it("maps power_sum to PSUM", async () => {
    await callTool(client, "set_trace_math", { trace: 4, operation: "power_sum", operand_a: 5, operand_b: 6 });
    expect(fake.calls).toEqual([":CALCulate:MATH TRACE4,PSUM,TRACE5,TRACE6,0"]);
  });

  it("turns math off for a trace without operands", async () => {
    const res = await callTool(client, "set_trace_math", { trace: 1, operation: "off" });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":CALCulate:MATH TRACE1,OFF,TRACE1,TRACE1,0"]);
  });

  it("validates trace, operands and offset", async () => {
    const bad = [
      { trace: 7, operation: "off" },
      { trace: 1, operation: "power_sum" }, // operands missing
      { trace: 1, operation: "power_sum", operand_a: 2 },
      { trace: 1, operation: "power_sum", operand_a: 0, operand_b: 2 },
      { trace: 1, operation: "log_offset", operand_a: 2, operand_b: 3, offset_db: 101 },
      { trace: 1, operation: "log_offset", operand_a: 2, operand_b: 3, offset_db: -100.5 },
      { trace: 1, operation: "power_sum", operand_a: 2, operand_b: 3, offset_db: 5 }, // offset only for log operations
      { trace: 1, operation: "nope", operand_a: 2, operand_b: 3 },
    ];
    for (const args of bad) expect((await callTool(client, "set_trace_math", args)).isError, JSON.stringify(args)).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("reports an instrument error", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "*CLS") return;
      fake.state.errors.push('-224,"Illegal parameter value"');
    });
    const res = await callTool(client, "set_trace_math", { trace: 1, operation: "off" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("-224");
  });
});

describe("restart_trace", () => {
  // Verified live (docs/verified-hardware.md): re-sending :TRACe<n>:TYPE with the trace's current type restarts its
  // max/min hold or averaging; :INITiate:RESTart and :INITiate:IMMediate do not.
  it("re-sends the current type of one trace", async () => {
    fake.state.type[1] = "MAXHold";
    const res = await callTool(client, "restart_trace", { trace: 2 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":TRACe2:TYPE MAXHold"]);
    const out = json(res);
    expect(out.restarted).toEqual([{ trace: 2, type: "max_hold" }]);
    expect(out.warnings).toEqual([]);
    expect(fake.state.type[1]).toBe("MAXHold");
  });

  it("restarts every hold and average trace when no trace is given, and skips write traces", async () => {
    fake.state.type = ["WRITe", "MAXHold", "AVERage", "MINHold", "WRITe", "WRITe"];
    const res = await callTool(client, "restart_trace", {});
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":TRACe2:TYPE MAXHold", ":TRACe3:TYPE AVERage", ":TRACe4:TYPE MINHold"]);
    expect(json(res).restarted.map((r: { trace: number }) => r.trace)).toEqual([2, 3, 4]);
  });

  it("says so when there is nothing to restart and sends no command", async () => {
    const res = await callTool(client, "restart_trace", {});
    expect(res.isError).toBeFalsy();
    expect(fake.sendCommand).not.toHaveBeenCalled();
    const out = json(res);
    expect(out.restarted).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/nothing to restart/i);
  });

  it("does what it is told for an explicitly named write trace", async () => {
    const res = await callTool(client, "restart_trace", { trace: 1 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":TRACe1:TYPE WRITe"]);
  });

  it("never uses :INITiate:RESTart (it does not restart hold on this instrument) or the sweep commands", async () => {
    fake.state.type[0] = "MAXHold";
    await callTool(client, "restart_trace", {});
    expect(fake.calls.some((c) => /INITiate/i.test(c))).toBe(false);
  });

  it("rejects a trace outside 1-6 without sending anything", async () => {
    for (const trace of [0, 7, 2.5]) expect((await callTool(client, "restart_trace", { trace })).isError).toBe(true);
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("warns when the instrument changed the type", async () => {
    fake.state.type[1] = "MAXHold";
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "*CLS") return;
      fake.calls.push(cmd);
      fake.state.type[1] = "WRITe";
    });
    const res = await callTool(client, "restart_trace", { trace: 2 });
    expect(json(res).warnings.join(" ")).toMatch(/type adjusted by the instrument: requested max_hold, now write/);
  });

  it("returns an error naming the command for a garbage type reply and sends nothing", async () => {
    fake.query.mockResolvedValueOnce("garbage ???");
    const res = await callTool(client, "restart_trace", { trace: 2 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":TRACe2:TYPE?");
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("reports an instrument error and says the settings may be partially applied", async () => {
    fake.state.type[1] = "MAXHold";
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "*CLS") return;
      fake.calls.push(cmd);
      fake.state.errors.push('-224,"Illegal parameter value"');
    });
    const res = await callTool(client, "restart_trace", { trace: 2 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("-224");
    expect(getText(res)).toMatch(/partially applied/);
  });
});
