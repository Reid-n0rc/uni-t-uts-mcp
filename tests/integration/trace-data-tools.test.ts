import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerTraceDataTools } from "../../src/tools/traceData.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Stateful fake of the analyzer for get_trace_data: sweep settings, trace state, the :FORMat state machine
 * (the setter needs ASCii but the query answers ASC8) and trace data in all three formats.
 */
const fake = vi.hoisted(() => {
  type Format = "ASC8" | "REAL32" | "REAL64";
  const initial = () => ({
    points: 1001, start: 10e6, stop: 3.6e9, unit: "DBM", sweepTime: 0.02,
    selected: 1,
    update: [1, 1, 1, 0, 0, 0], display: [1, 1, 1, 0, 0, 0], type: ["WRITe", "WRITe", "WRITe", "WRITe", "WRITe", "WRITe"],
    format: "ASC8" as Format, continuous: true, sweepEnd: 0,
    values: [] as number[], errors: [] as string[],
    /** Make the trace data query return this instead of the real reply. */
    asciiOverride: undefined as string | undefined,
    binaryOverride: undefined as Buffer | undefined,
    failOn: undefined as string | undefined,
    failCommand: undefined as string | undefined,
  });
  const state = initial();
  const log: string[] = [];
  const sentCommands: Array<{ cmd: string; sync?: boolean }> = [];
  const makeValues = (n: number) => Array.from({ length: n }, (_, i) => -90 + 10 * Math.sin(i / 9) + (i === 400 ? 40 : 0));
  const reset = () => {
    Object.assign(state, initial());
    state.values = makeValues(state.points);
    log.length = 0;
    sentCommands.length = 0;
  };
  const dataBlock = (bytes: 4 | 8) => {
    const data = Buffer.alloc(state.values.length * bytes);
    state.values.forEach((v, i) => (bytes === 4 ? data.writeFloatBE(v, i * 4) : data.writeDoubleBE(v, i * 8)));
    return data;
  };
  const capabilities = { syncsCommands: true, dropsInputDuringSweep: true, holdOffAfterTimeout: true };
  const query = vi.fn(async (cmd: string, _t?: number, _o?: unknown): Promise<string> => {
    log.push(`q ${cmd}`);
    if (state.failOn === cmd) throw new Error(`Query timeout after 5000ms for command: ${cmd}`);
    let m: RegExpExecArray | null;
    switch (cmd) {
      case ":SENSe:SWEep:POINts?": return String(state.points);
      case ":SENSe:FREQuency:STARt?":
      case ":FREQuency:STARt?": return state.start.toExponential(10);
      case ":SENSe:FREQuency:STOP?":
      case ":FREQuency:STOP?": return state.stop.toExponential(10);
      case ":UNIT:POWer?": return state.unit;
      case ":SENSe:SWEep:TIME?": return state.sweepTime.toExponential(6) + " ";
      case ":TRACe:SELect?": return String(state.selected);
      case ":FORMat?": return state.format;
      case ":INITiate:CONTinuous?": return state.continuous ? "1" : "0";
      case "*OPC?":
        if (Date.now() < state.sweepEnd) {
          // A transport that queues input answers when the sweep ends; one that drops it never answers in time.
          if (capabilities.dropsInputDuringSweep) throw new Error("Query timeout after 100ms for command: *OPC?");
          await new Promise((resolve) => setTimeout(resolve, state.sweepEnd - Date.now()));
        }
        return "1";
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
    }
    if ((m = /^:TRACe([1-6]):TYPE\?$/.exec(cmd))) return state.type[Number(m[1]) - 1];
    if ((m = /^:TRACe([1-6]):UPDate:STATe\?$/.exec(cmd))) return String(state.update[Number(m[1]) - 1]);
    if ((m = /^:TRACe([1-6]):DISPlay:STATe\?$/.exec(cmd))) return String(state.display[Number(m[1]) - 1]);
    if (/^:TRACe:DATA\? TRACE[1-6]$/.test(cmd)) {
      if (state.asciiOverride !== undefined) return state.asciiOverride;
      if (state.format !== "ASC8") return "#4garbled";
      return state.values.map((v) => v.toExponential(6)).join(",");
    }
    throw new Error(`unexpected query ${cmd}`);
  });
  const queryBinary = vi.fn(async (cmd: string, _t?: number): Promise<Buffer> => {
    log.push(`b ${cmd}`);
    if (state.failOn === cmd) throw new Error(`Binary query timeout after 30000ms for command: ${cmd}`);
    if (!/^:TRACe:DATA\? TRACE[1-6]$/.test(cmd)) throw new Error(`unexpected binary query ${cmd}`);
    if (state.binaryOverride) return state.binaryOverride;
    if (state.format === "ASC8") throw new Error("Expected a binary block reply: block does not start with '#'");
    return dataBlock(state.format === "REAL32" ? 4 : 8);
  });
  const sendCommand = vi.fn(async (cmd: string, o?: { sync?: boolean }) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    log.push(`c ${cmd}`);
    sentCommands.push({ cmd, sync: o?.sync });
    if (state.failCommand === cmd) throw new Error(`Write failed while sending ${cmd}: EPIPE`);
    if (cmd === ":FORMat ASCii") state.format = "ASC8";
    else if (cmd === ":FORMat REAL32") state.format = "REAL32";
    else if (cmd === ":FORMat REAL64") state.format = "REAL64";
    else if (cmd === ":INITiate:CONTinuous OFF") state.continuous = false;
    else if (cmd === ":INITiate:CONTinuous ON") state.continuous = true;
    else if (cmd === ":INITiate:IMMediate") state.sweepEnd = Date.now() + state.sweepTime * 1000;
    else state.errors.push('-224,"Illegal parameter value"');
  });
  return { state, log, sentCommands, reset, query, queryBinary, sendCommand, makeValues, capabilities };
});

vi.mock("../../src/connection.js", () => ({
  connection: {
    capabilities: fake.capabilities,
    query: fake.query,
    queryBinary: fake.queryBinary,
    sendCommand: fake.sendCommand,
    msSinceQueryTimeout: () => Infinity,
    runExclusive: (fn: () => unknown) => fn(),
  },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const c = await createTestServer(registerTraceDataTools);
  client = c.client;
  cleanup = c.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  fake.query.mockClear();
  fake.queryBinary.mockClear();
  fake.sendCommand.mockClear();
});

type Res = Awaited<ReturnType<typeof callTool>>;
const json = (r: Res) => JSON.parse(getText(r));
const ok = (r: Res) => {
  expect(r.isError, getText(r)).toBeFalsy();
  return json(r);
};
const fixtureValues = () => readFileSync(new URL("../fixtures/p2/trace1-ascii.txt", import.meta.url), "latin1").trim().split(",").map(Number);

describe("tool listing", () => {
  it("registers get_trace_data as a read-only tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_trace_data"]);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
  });
});

describe("get_trace_data: ASCII", () => {
  it("returns the values with the frequency axis, unit, trace info and statistics", async () => {
    fake.state.values = fixtureValues();
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(out.trace).toBe(1);
    expect(out.trace_type).toBe("write");
    expect(out.trace_updating).toBe(true);
    expect(out.trace_displayed).toBe(true);
    expect(out.unit).toBe("dBm");
    expect(out.format).toBe("ascii");
    expect(out.points).toBe(1001);
    expect(out.values).toHaveLength(1001);
    expect(out.values[0]).toBe(-61.12838);
    expect(out.axis).toMatchObject({ kind: "frequency", start_hz: 10e6, stop_hz: 3.6e9, points: 1001 });
    expect(out.axis.step_hz).toBeCloseTo(3.59e6, 3);
    expect(out.frequencies_hz).toHaveLength(1001);
    expect(out.frequencies_hz[0]).toBe(10e6);
    expect(out.frequencies_hz[1000]).toBe(3.6e9);
    expect(out.summary.max).toBeCloseTo(-57.8, 1);
    expect(out.summary.min).toBeCloseTo(-110.1, 1);
    expect(out.summary.peak_level).toBe(out.summary.max);
    expect(out.summary.peak_frequency_hz).toBe(out.frequencies_hz[out.summary.peak_index]);
    expect(out.decimation).toEqual({ decimated: false });
    expect(out.warnings).toEqual([]);
    // Already ASCII: the format is only queried, never set.
    expect(fake.sentCommands).toEqual([]);
    expect(fake.queryBinary).not.toHaveBeenCalled();
  });

  it("uses the selected trace by default and the trace argument when given", async () => {
    fake.state.selected = 2;
    fake.state.type[1] = "MAXHold";
    let out = ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(out.trace).toBe(2);
    expect(out.trace_type).toBe("max_hold");
    expect(fake.log).toContain("q :TRACe:DATA? TRACE2");
    out = ok(await callTool(client, "get_trace_data", { trace: 3, format: "ascii" }));
    expect(out.trace).toBe(3);
    expect(fake.log).toContain("q :TRACe:DATA? TRACE3");
  });

  it("rejects invalid trace numbers and max_points before sending anything", async () => {
    for (const args of [{ trace: 0 }, { trace: 7 }, { trace: 1.5 }, { max_points: 1 }, { max_points: 0 }, { max_points: 2.5 }, { format: "real16" }]) {
      const res = await callTool(client, "get_trace_data", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("maps the other power units", async () => {
    fake.state.unit = "DBUV";
    expect(ok(await callTool(client, "get_trace_data", { format: "ascii" })).unit).toBe("dBuV");
  });

  it("warns when the trace is frozen or hidden", async () => {
    fake.state.update[0] = 0;
    fake.state.display[0] = 0;
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(out.trace_updating).toBe(false);
    expect(out.trace_displayed).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/frozen/i);
    expect(out.warnings.join(" ")).toMatch(/hidden|not displayed/i);
  });

  it("handles a single sweep point", async () => {
    fake.state.points = 1;
    fake.state.values = [-42];
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(out.frequencies_hz).toEqual([10e6]);
    expect(out.summary).toMatchObject({ min: -42, max: -42, mean: -42, peak_frequency_hz: 10e6 });
  });

  it("returns non-finite values as null, excludes them from the statistics and warns", async () => {
    fake.state.asciiOverride = Array.from({ length: 1001 }, (_, i) => (i === 5 ? "nan" : i === 6 ? "-inf" : "-70")).join(",");
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(out.values[5]).toBeNull();
    expect(out.values[6]).toBeNull();
    expect(out.summary).toMatchObject({ points: 1001, finite_points: 999, non_finite_points: 2, min: -70, max: -70 });
    expect(out.warnings.join(" ")).toMatch(/2 .*not a finite|non-finite/i);
  });
});

describe("get_trace_data: binary formats", () => {
  it("REAL32: switches the format, reads the block and restores ASCii (the setter form, not ASC8)", async () => {
    const out = ok(await callTool(client, "get_trace_data", { format: "real32" }));
    expect(out.format).toBe("real32");
    expect(out.values).toHaveLength(1001);
    out.values.forEach((v: number, i: number) => expect(Math.abs(v - fake.state.values[i])).toBeLessThan(1e-4));
    const formatCommands = fake.sentCommands.map((c) => c.cmd).filter((c) => c.startsWith(":FORMat"));
    expect(formatCommands).toEqual([":FORMat REAL32", ":FORMat ASCii"]);
    expect(fake.state.format).toBe("ASC8");
    expect(fake.queryBinary).toHaveBeenCalledWith(":TRACe:DATA? TRACE1", expect.anything());
    // the restore is the last thing sent before the final error check
    const lastCmd = fake.log.filter((l) => l.startsWith("c ")).pop();
    expect(lastCmd).toBe("c :FORMat ASCii");
  });

  it("REAL64: exact values", async () => {
    fake.state.values = fixtureValues();
    const out = ok(await callTool(client, "get_trace_data", { format: "real64" }));
    expect(out.values).toEqual(fixtureValues());
    expect(fake.state.format).toBe("ASC8");
  });

  it("REAL32, REAL64 and ASCII agree within float tolerance on the same trace", async () => {
    fake.state.values = fixtureValues();
    const a = ok(await callTool(client, "get_trace_data", { format: "ascii" })).values as number[];
    const r32 = ok(await callTool(client, "get_trace_data", { format: "real32" })).values as number[];
    const r64 = ok(await callTool(client, "get_trace_data", { format: "real64" })).values as number[];
    a.forEach((v, i) => {
      expect(Math.abs(r32[i] - v)).toBeLessThan(1e-4);
      expect(Math.abs(r64[i] - v)).toBeLessThan(1e-9);
    });
  });

  it("restores the format the instrument was in before (not always ASCii)", async () => {
    fake.state.format = "REAL64";
    ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(fake.sentCommands.map((c) => c.cmd).filter((c) => c.startsWith(":FORMat"))).toEqual([":FORMat ASCii", ":FORMat REAL64"]);
    expect(fake.state.format).toBe("REAL64");
  });

  it("restores ASCii when the read fails, and returns the read error", async () => {
    fake.state.failOn = ":TRACe:DATA? TRACE1";
    const res = await callTool(client, "get_trace_data", { format: "real32" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":TRACe:DATA? TRACE1");
    expect(fake.state.format).toBe("ASC8");
    expect(fake.sentCommands.map((c) => c.cmd)).toContain(":FORMat ASCii");
  });

  it("says explicitly when the format could not be restored (after a successful read)", async () => {
    fake.state.failCommand = ":FORMat ASCii";
    const res = await callTool(client, "get_trace_data", { format: "real32" });
    expect(res.isError).toBe(true);
    const text = getText(res);
    expect(text).toMatch(/could not .*restore/i);
    expect(text).toContain(":FORMat ASCii");
    expect(text).toMatch(/REAL32/);
    expect(text).toContain("Write failed");
  });

  it("reports both errors when the read fails and the restore fails too", async () => {
    fake.state.failOn = ":TRACe:DATA? TRACE1";
    fake.state.failCommand = ":FORMat ASCii";
    const text = getText(await callTool(client, "get_trace_data", { format: "real64" }));
    expect(text).toContain("Binary query timeout");
    expect(text).toMatch(/could not .*restore/i);
  });

  it("does not leave the format changed when switching itself fails", async () => {
    fake.state.failCommand = ":FORMat REAL32";
    const res = await callTool(client, "get_trace_data", { format: "real32" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":FORMat REAL32");
    expect(fake.sentCommands.map((c) => c.cmd)).toContain(":FORMat ASCii");
  });

  it("rejects a binary payload whose size does not match the sweep points", async () => {
    fake.state.binaryOverride = Buffer.alloc(4000);
    const text = getText(await callTool(client, "get_trace_data", { format: "real32" }));
    expect(text).toContain(":TRACe:DATA? TRACE1");
    expect(text).toMatch(/1000 values.*1001|1001.*1000/);
    expect(fake.state.format).toBe("ASC8");
  });

  it("rejects a payload that is not a whole number of values", async () => {
    fake.state.binaryOverride = Buffer.alloc(4003);
    const res = await callTool(client, "get_trace_data", { format: "real32" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":TRACe:DATA? TRACE1");
  });
});

describe("get_trace_data: error modes", () => {
  it("reports a point count that differs from :SENSe:SWEep:POINts?", async () => {
    fake.state.asciiOverride = fake.makeValues(1000).map((v) => v.toExponential(6)).join(",");
    const res = await callTool(client, "get_trace_data", { format: "ascii" });
    expect(res.isError).toBe(true);
    const text = getText(res);
    expect(text).toContain(":TRACe:DATA? TRACE1");
    expect(text).toContain(":SENSe:SWEep:POINts?");
    expect(text).toContain("1000");
    expect(text).toContain("1001");
  });

  it("rejects a malformed ASCII reply, naming the command and the start of the reply", async () => {
    fake.state.asciiOverride = "-61.1,oops,-70";
    const text = getText(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(text).toContain(":TRACe:DATA? TRACE1");
    expect(text).toContain("-61.1,oops,-70");
  });

  it("rejects an empty reply", async () => {
    fake.state.asciiOverride = "";
    const res = await callTool(client, "get_trace_data", { format: "ascii" });
    expect(res.isError).toBe(true);
  });

  it("rejects an unexpected :FORMat? reply", async () => {
    fake.state.format = "WEIRD" as never;
    const text = getText(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(text).toContain(":FORMat?");
    expect(text).toContain("WEIRD");
  });

  it("rejects an unexpected unit", async () => {
    fake.state.unit = "furlongs";
    expect(getText(await callTool(client, "get_trace_data", {}))).toContain(":UNIT:POWer?");
  });

  it("a timeout names the command", async () => {
    fake.state.failOn = ":SENSe:SWEep:POINts?";
    expect(getText(await callTool(client, "get_trace_data", {}))).toContain(":SENSe:SWEep:POINts?");
  });
});

describe("get_trace_data: decimation", () => {
  it("decimates peak-preservingly, says so, and keeps statistics of the full trace", async () => {
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii", max_points: 100 }));
    const full = fake.state.values;
    expect(out.decimation).toMatchObject({ decimated: true, original_points: 1001, returned_points: out.values.length, max_points: 100 });
    expect(out.decimation.method).toMatch(/min.*max/i);
    expect(out.values.length).toBeLessThanOrEqual(100);
    expect(out.indices).toHaveLength(out.values.length);
    expect(out.frequencies_hz).toHaveLength(out.values.length);
    expect(Math.max(...out.values)).toBeCloseTo(Math.max(...full), 4);
    expect(out.summary.points).toBe(1001);
    expect(out.summary.peak_index).toBe(400);
    expect(out.indices).toContain(400);
    // axis values belong to the original indices
    out.indices.forEach((idx: number, i: number) => {
      expect(out.frequencies_hz[i]).toBeCloseTo(10e6 + (idx * (3.6e9 - 10e6)) / 1000, 2);
      expect(out.values[i]).toBeCloseTo(full[idx], 4);
    });
    expect(out.warnings.join(" ")).toMatch(/decimat/i);
  });

  it("does not decimate when max_points is at least the point count", async () => {
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii", max_points: 1001 }));
    expect(out.decimation).toEqual({ decimated: false });
    expect(out.indices).toBeUndefined();
  });
});

describe("get_trace_data: include_axis and zero span", () => {
  it("include_axis false leaves out the per-point axis but keeps the axis description and the peak frequency", async () => {
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii", include_axis: false }));
    expect(out.frequencies_hz).toBeUndefined();
    expect(out.axis).toMatchObject({ kind: "frequency", start_hz: 10e6, stop_hz: 3.6e9 });
    expect(typeof out.summary.peak_frequency_hz).toBe("number");
  });

  it("zero span: says so, uses a time axis from the sweep time and gives no frequency axis", async () => {
    fake.state.start = 100e6;
    fake.state.stop = 100e6;
    fake.state.sweepTime = 0.5;
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(out.axis).toMatchObject({ kind: "time", zero_span: true, center_hz: 100e6, sweep_time_s: 0.5, points: 1001 });
    expect(out.axis.note).toMatch(/zero span/i);
    expect(out.frequencies_hz).toBeUndefined();
    expect(out.times_s).toHaveLength(1001);
    expect(out.times_s[0]).toBe(0);
    expect(out.times_s[1000]).toBe(0.5);
    expect(out.summary.peak_time_s).toBe(out.times_s[out.summary.peak_index]);
    expect(out.summary.peak_frequency_hz).toBeUndefined();
    expect(out.warnings.join(" ")).toMatch(/zero span/i);
  });
});

describe("get_trace_data: fresh", () => {
  it("runs one single sweep, reads afterwards, and puts continuous mode back on", async () => {
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii", fresh: true }));
    expect(out.fresh).toMatchObject({ swept: true, continuous_restored: true });
    const order = fake.log.filter((l) => /:INITiate|TRACe:DATA|FORMat/.test(l));
    expect(order).toEqual([
      "q :INITiate:CONTinuous?",
      "c :INITiate:CONTinuous OFF",
      "c :INITiate:IMMediate",
      "q :FORMat?",
      "q :TRACe:DATA? TRACE1",
      "c :INITiate:CONTinuous ON",
    ]);
    const iImmediate = fake.log.indexOf("c :INITiate:IMMediate");
    const iData = fake.log.indexOf("q :TRACe:DATA? TRACE1");
    const iRestore = fake.log.indexOf("c :INITiate:CONTinuous ON");
    expect(iImmediate).toBeGreaterThan(-1);
    expect(iData).toBeGreaterThan(iImmediate);
    expect(iRestore).toBeGreaterThan(iData);
    expect(fake.sentCommands.find((c) => c.cmd === ":INITiate:IMMediate")?.sync).toBe(false);
    expect(fake.state.continuous).toBe(true);
  });

  it("does not switch continuous mode on when it was off", async () => {
    fake.state.continuous = false;
    const out = ok(await callTool(client, "get_trace_data", { format: "ascii", fresh: true }));
    expect(out.fresh.continuous_restored).toBe(false);
    expect(fake.state.continuous).toBe(false);
    expect(fake.sentCommands.map((c) => c.cmd)).not.toContain(":INITiate:CONTinuous ON");
  });

  it("restores continuous mode when the read fails", async () => {
    fake.state.failOn = ":TRACe:DATA? TRACE1";
    const res = await callTool(client, "get_trace_data", { format: "ascii", fresh: true });
    expect(res.isError).toBe(true);
    expect(fake.state.continuous).toBe(true);
  });

  it("says explicitly when continuous mode could not be restored", async () => {
    fake.state.failCommand = ":INITiate:CONTinuous ON";
    const res = await callTool(client, "get_trace_data", { format: "ascii", fresh: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/could not .*restore.*continuous/i);
    expect(getText(res)).toContain("set_acquisition");
  });

  it("restores both the format and continuous mode, in that order of nesting", async () => {
    const out = ok(await callTool(client, "get_trace_data", { format: "real32", fresh: true }));
    expect(out.values).toHaveLength(1001);
    expect(fake.state.format).toBe("ASC8");
    expect(fake.state.continuous).toBe(true);
  });

  it("works on a transport that queues commands during the sweep (blocking *OPC? wait)", async () => {
    Object.assign(fake.capabilities, { dropsInputDuringSweep: false });
    try {
      const out = ok(await callTool(client, "get_trace_data", { format: "ascii", fresh: true }));
      expect(out.fresh.swept).toBe(true);
    } finally {
      Object.assign(fake.capabilities, { dropsInputDuringSweep: true });
    }
  });

  it("does not sweep or change the mode when fresh is not set", async () => {
    ok(await callTool(client, "get_trace_data", { format: "ascii" }));
    expect(fake.log.some((l) => l.includes("INITiate"))).toBe(false);
  });
});
