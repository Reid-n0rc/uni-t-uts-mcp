import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiLimitLineTools } from "../../src/tools/emiLimitLines.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface Line {
  display: boolean;
  type: "UPPer" | "LOWer";
  trace: number;
  margin: number;
  marginState: boolean;
  points: Array<[number, number, number]>;
}

/** Small stateful fake of the EMI limit-line subsystem (same underlying implementation as SA limit lines). */
const fake = vi.hoisted(() => {
  const fresh = (): Line => ({ display: false, type: "UPPer", trace: 1, margin: 0, marginState: false, points: [] });
  const lines: Line[] = [];
  const state = { module: "EMI" as "SA" | "EMI", errors: [] as string[], ignoreTrace: false };
  const calls: string[] = [];
  function reset() {
    lines.length = 0;
    for (let i = 0; i < 6; i++) lines.push(fresh());
    state.module = "EMI";
    state.errors = [];
    state.ignoreTrace = false;
    calls.length = 0;
  }
  reset();
  const sci = (n: number) => n.toExponential(6);
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    if (cmd === ":INSTrument:SELect?") return state.module;
    const m = /^:CALCulate:LLINe(\d):(.+)\?$/.exec(cmd);
    if (!m) throw new Error(`unexpected query ${cmd}`);
    const l = lines[Number(m[1]) - 1];
    switch (m[2]) {
      case "DISPlay": return l.display ? "1" : "0";
      case "TYPE": return l.type;
      case "TRACe": return String(l.trace);
      case "MARGin": return sci(l.margin);
      case "MARGin:STATe": return l.marginState ? "1" : "0";
      case "DATA":
        // An empty line gives no reply at all on the instrument.
        if (l.points.length === 0) throw new Error(`Query timeout after ${_t}ms for command: ${cmd}`);
        return l.points.map(([f, a, c]) => `${sci(f)},${sci(a)},${c}`).join(",");
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    if (cmd === ":CALCulate:LLINe:ALL:DELete") { for (const l of lines) Object.assign(l, fresh()); return; }
    let m = /^:CALCulate:LLINe(\d):COPY LLINE(\d)$/.exec(cmd);
    if (m) { Object.assign(lines[Number(m[1]) - 1], JSON.parse(JSON.stringify(lines[Number(m[2]) - 1]))); return; }
    m = /^:CALCulate:LLINe(\d):BUILd TRACE(\d)$/.exec(cmd);
    if (m) { lines[Number(m[1]) - 1].points = [[1e8, -40, 1], [9e8, -40, 1]]; return; }
    m = /^:CALCulate:LLINe(\d):(\S+)(?: (.*))?$/.exec(cmd);
    if (!m) { state.errors.push('-113,"Undefined header"'); return; }
    const l = lines[Number(m[1]) - 1];
    const arg = m[3];
    switch (m[2]) {
      case "DELete": Object.assign(l, fresh()); break;
      case "DISPlay": l.display = arg === "1" || arg === "ON"; break;
      case "TYPE": l.type = arg as Line["type"]; break;
      case "TRACe": if (!state.ignoreTrace && Number(arg) >= 1 && Number(arg) <= 6) l.trace = Number(arg); break;
      case "MARGin": l.margin = Math.max(-40, Math.min(40, Number(arg))); l.marginState = true; break;
      case "MARGin:STATe": l.marginState = arg === "1" || arg === "ON"; break;
      case "DATA": {
        const n = (arg ?? "").split(",").map(Number);
        if (n.length % 3 !== 0 || n.some(Number.isNaN)) { state.errors.push('-200,"Execution error"'); break; }
        const pts: Array<[number, number, number]> = [];
        for (let i = 0; i < n.length; i += 3) pts.push([n[i], n[i + 1], n[i + 2]]);
        pts.sort((a, b) => a[0] - b[0]);
        if (pts.length) pts[0][2] = 1;
        l.points = pts;
        break;
      }
      default: state.errors.push('-113,"Undefined header"');
    }
  });
  return { lines, state, calls, reset, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const ctx = await createTestServer(registerEmiLimitLineTools);
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
const PTS = [
  { frequency_hz: 1e8, amplitude_dbm: -50 },
  { frequency_hz: 5e8, amplitude_dbm: -30 },
  { frequency_hz: 9e8, amplitude_dbm: -30, connected: false },
];

describe("tool listing", () => {
  it("registers get_emi_limit_line (read-only), set_emi_limit_line and delete_emi_limit_line", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["delete_emi_limit_line", "get_emi_limit_line", "set_emi_limit_line"]);
    expect(byName.get_emi_limit_line.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_emi_limit_line.annotations?.readOnlyHint).toBe(false);
    expect(byName.delete_emi_limit_line.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_emi_limit_line", () => {
  it("reads an empty line (the instrument does not answer DATA? then)", async () => {
    const res = await callTool(client, "get_emi_limit_line", { line: 2 });
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({ line: 2, displayed: false, type: "upper", trace: 1, margin_db: 0, margin_enabled: false, points: [] });
    expect(fake.query).toHaveBeenCalledWith(":CALCulate:LLINe2:DATA?", expect.any(Number));
  });

  it("reads the points, margin and type", async () => {
    Object.assign(fake.lines[0], { display: true, type: "LOWer", trace: 2, margin: 3, marginState: true, points: [[1e8, -50, 1], [5e8, -30, 0]] });
    const res = await callTool(client, "get_emi_limit_line", {});
    expect(json(res)).toEqual({
      line: 1, displayed: true, type: "lower", trace: 2, margin_db: 3, margin_enabled: true,
      points: [{ frequency_hz: 1e8, amplitude_dbm: -50, connected: true }, { frequency_hz: 5e8, amplitude_dbm: -30, connected: false }],
    });
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "get_emi_limit_line", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects line numbers outside 1-6", async () => {
    for (const line of [0, 7, 1.5]) expect((await callTool(client, "get_emi_limit_line", { line })).isError).toBe(true);
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe("set_emi_limit_line", () => {
  it("sends the point list in the documented form and reads everything back", async () => {
    const res = await callTool(client, "set_emi_limit_line", { line: 1, type: "lower", trace: 2, points: PTS, displayed: true });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(fake.calls).toEqual([
      ":CALCulate:LLINe1:DATA 100000000,-50,1,500000000,-30,1,900000000,-30,0",
      ":CALCulate:LLINe1:TYPE LOWer",
      ":CALCulate:LLINe1:TRACe 2",
      ":CALCulate:LLINe1:DISPlay 1",
    ]);
    const out = json(res);
    expect(out.state.points).toHaveLength(3);
    expect(out.state.type).toBe("lower");
    expect(out.warnings).toEqual([]);
  });

  it("copies another line's points, sent before other settings", async () => {
    fake.lines[2].points = [[2e8, -45, 1], [6e8, -45, 1]];
    const res = await callTool(client, "set_emi_limit_line", { line: 1, copy_from: 3, displayed: true });
    expect(fake.calls).toEqual([":CALCulate:LLINe1:COPY LLINE3", ":CALCulate:LLINe1:DISPlay 1"]);
    expect(json(res).state.points).toHaveLength(2);
    expect(json(res).warnings).toEqual([]);
  });

  it("builds from a trace, sent before other settings", async () => {
    const res = await callTool(client, "set_emi_limit_line", { line: 2, build_from_trace: 1, type: "lower" });
    expect(fake.calls).toEqual([":CALCulate:LLINe2:BUILd TRACE1", ":CALCulate:LLINe2:TYPE LOWer"]);
    expect(json(res).state.points).toHaveLength(2);
    expect(json(res).warnings).toEqual([]);
  });

  it("warns when copy_from/build_from_trace produced no points", async () => {
    const res = await callTool(client, "set_emi_limit_line", { line: 1, copy_from: 2 });
    expect(json(res).warnings.join(" ")).toMatch(/copy_from produced no points/);
  });

  it("sets the margin before its state, so the state is not switched back on", async () => {
    const res = await callTool(client, "set_emi_limit_line", { line: 3, margin_db: 3, margin_enabled: false });
    expect(fake.calls).toEqual([":CALCulate:LLINe3:MARGin 3", ":CALCulate:LLINe3:MARGin:STATe 0"]);
    expect(json(res).state.margin_enabled).toBe(false);
    expect(json(res).warnings).toEqual([]);
  });

  it("accepts a single point and a vertical step (equal frequencies)", async () => {
    expect((await callTool(client, "set_emi_limit_line", { points: [{ frequency_hz: 5e8, amplitude_dbm: -30 }] })).isError).toBeFalsy();
    const step = [{ frequency_hz: 5e8, amplitude_dbm: -30 }, { frequency_hz: 5e8, amplitude_dbm: -20 }];
    const res = await callTool(client, "set_emi_limit_line", { points: step });
    expect(json(res).warnings).toEqual([]);
    expect(json(res).state.points).toHaveLength(2);
  });

  it("warns when the margin or its state was not taken", async () => {
    const orig = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (!cmd.includes("MARGin")) await orig(cmd);
    });
    const res = await callTool(client, "set_emi_limit_line", { margin_db: 5, margin_enabled: true });
    const text = json(res).warnings.join(" ");
    expect(text).toMatch(/margin_db/);
    expect(text).toMatch(/margin_enabled/);
    fake.sendCommand.mockImplementation(orig);
  });

  it("warns when the instrument ignores the trace number", async () => {
    fake.state.ignoreTrace = true;
    const res = await callTool(client, "set_emi_limit_line", { trace: 4 });
    expect(res.isError).toBeFalsy();
    expect(json(res).warnings.join(" ")).toMatch(/trace/);
  });

  it("warns when the readback points differ", async () => {
    const orig = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await orig(cmd);
      if (cmd.includes(":DATA ")) fake.lines[0].points[1][1] += 3;
    });
    const res = await callTool(client, "set_emi_limit_line", { points: PTS });
    expect(json(res).warnings.join(" ")).toMatch(/points/);
    fake.sendCommand.mockImplementation(orig);
  });

  it("reports an instrument error with the commands sent", async () => {
    fake.sendCommand.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { fake.state.errors.push('-200,"Execution error"'); });
    const res = await callTool(client, "set_emi_limit_line", { points: PTS });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("-200");
    expect(getText(res)).toContain("get_emi_limit_line");
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_emi_limit_line", { points: PTS });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("validates before sending anything", async () => {
    const bad: Array<Record<string, unknown>> = [
      {},
      { line: 7, displayed: true },
      { trace: 7 },
      { margin_db: 41 },
      { margin_db: -41 },
      { points: [] },
      { copy_from: 1, line: 1 },
      { points: [{ frequency_hz: 5e8, amplitude_dbm: -30 }, { frequency_hz: 1e8, amplitude_dbm: -50 }] },
      { points: [{ frequency_hz: -1, amplitude_dbm: -50 }, { frequency_hz: 1e8, amplitude_dbm: -40 }] },
      { points: [{ frequency_hz: 1e8, amplitude_dbm: Number.NaN }, { frequency_hz: 2e8, amplitude_dbm: -40 }] },
      { points: Array.from({ length: 13 }, (_, i) => ({ frequency_hz: (i + 1) * 1e6, amplitude_dbm: -50 })) },
      { type: "middle" },
    ];
    for (const args of bad) {
      const res = await callTool(client, "set_emi_limit_line", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe("delete_emi_limit_line", () => {
  it("deletes one line and confirms it is empty", async () => {
    fake.lines[3].points = [[1e8, -50, 1], [2e8, -50, 1]];
    const res = await callTool(client, "delete_emi_limit_line", { line: 4 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":CALCulate:LLINe4:DELete"]);
    expect(json(res)).toEqual({ deleted: [4], warnings: [] });
  });

  it("deletes all lines", async () => {
    for (const l of fake.lines) l.points = [[1e8, -50, 1]];
    const res = await callTool(client, "delete_emi_limit_line", { all: true });
    expect(fake.calls).toEqual([":CALCulate:LLINe:ALL:DELete"]);
    expect(json(res)).toEqual({ deleted: "all", warnings: [] });
  });

  it("warns when a line still has points", async () => {
    fake.sendCommand.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => undefined);
    fake.lines[0].points = [[1e8, -50, 1], [2e8, -50, 1]];
    const res = await callTool(client, "delete_emi_limit_line", { line: 1 });
    expect(json(res).warnings.join(" ")).toMatch(/still has/);
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "delete_emi_limit_line", { line: 1 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("needs exactly one of line or all", async () => {
    for (const args of [{}, { line: 1, all: true }, { line: 9 }, { all: false }]) {
      expect((await callTool(client, "delete_emi_limit_line", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});
