import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerMarkerTools } from "../../src/tools/marker.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake of the analyzer's marker subsystem (behavior verified on the UTS3036B). */
const fake = vi.hoisted(() => {
  type Marker = { mode: string; trace: number; x: number; ref: number };
  const initial = () => ({
    markers: Array.from({ length: 11 }, (_, n): Marker => ({ mode: "OFF", trace: 1, x: 0, ref: n === 10 ? 1 : n + 1 })),
    center: 1.805e9, start: 1e7, stop: 3.6e9, step: 3.59e8, rlevel: 0,
    thr: -175, thrAuto: true, exc: 1, excAuto: true,
    errors: [] as string[],
  });
  const state = initial();
  const calls: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  /** Level of the fake trace at x. */
  const level = (x: number) => -50 - x / 1e9;
  function reset() {
    Object.assign(state, initial());
    calls.length = 0;
  }
  const marker = (n: number) => state.markers[n];
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    let m = /^:CALCulate:MARKer(\d+):(MODE|TRACe|X|Y|REFerence)\?$/.exec(cmd);
    if (m) {
      const n = Number(m[1]);
      if (n < 1 || n > 10) throw new Error(`Query timeout after 5000ms for command: ${cmd}`);
      const mk = marker(n);
      switch (m[2]) {
        case "MODE": return mk.mode;
        case "TRACe": return String(mk.trace);
        case "REFerence": return String(mk.ref);
        case "X": return mk.mode === "DELTa" ? sci(mk.x - marker(mk.ref).x) : sci(mk.x);
        default: return sci(mk.mode === "DELTa" ? level(mk.x) - level(marker(mk.ref).x) : level(mk.x));
      }
    }
    switch (cmd) {
      case ":FREQuency:CENTer?": return sci(state.center);
      case ":FREQuency:CENTer:STEP?": return sci(state.step);
      case ":FREQuency:STARt?": return sci(state.start);
      case ":FREQuency:STOP?": return sci(state.stop);
      case ":DISPlay:WINDow:TRACe:Y:RLEVel?": return sci(state.rlevel);
      case ":CALCulate:MARKer:PEAK:THReshold?": return sci(state.thr);
      case ":CALCulate:MARKer:PEAK:THReshold:STATe?": return state.thrAuto ? "1" : "0";
      case ":CALCulate:MARKer:PEAK:EXCursion?": return sci(state.exc);
      case ":CALCulate:MARKer:PEAK:EXCursion:STATe?": return state.excAuto ? "1" : "0";
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    const bad = () => state.errors.push('-224,"Illegal parameter value"');
    let m = /^:CALCulate:MARKer(\d+):(.+?)(?: (\S+))?$/.exec(cmd);
    if (m) {
      const n = Number(m[1]);
      const [, , head, arg] = m;
      const mk = marker(n);
      const on = () => { if (mk.mode === "OFF") mk.mode = "POSition"; };
      switch (head) {
        case "MODE":
          if (["OFF", "POSition", "DELTa", "FIXed"].includes(arg)) mk.mode = arg; else bad();
          return;
        case "TRACe": {
          const t = Number(arg);
          if (Number.isInteger(t) && t >= 1 && t <= 6) mk.trace = t; else bad();
          return;
        }
        case "X": mk.x = Number(arg); return;
        case "REFerence": {
          const r = Number(arg);
          if (Number.isInteger(r) && r >= 1 && r <= 10 && r !== n) mk.ref = r; else bad();
          return;
        }
        case "MAXimum": on(); mk.x = 3.5e9; return;
        case "MAXimum:NEXT": on(); mk.x = 3.1e9; return;
        case "MAXimum:LEFT": on(); mk.x = mk.x - 1e8; return;
        case "MAXimum:RIGHt": on(); mk.x = mk.x + 1e8; return;
        case "MINimum": on(); mk.x = 3.9e8; return;
        case "PTPeak": on(); mk.mode = "DELTa"; mk.x = 3.9e8; mk.ref = 2; marker(2).x = 3.5e9; return;
        case "SET:CENTer": state.center = mk.x; return;
        case "SET:STEP": state.step = mk.x; return;
        case "SET:STARt": state.start = mk.x; return;
        case "SET:STOP": state.stop = mk.x; return;
        case "SET:RLEVel": state.rlevel = level(mk.x); return;
        default: state.errors.push('-113,"Undefined header"'); return;
      }
    }
    m = /^(\S+) (\S+)$/.exec(cmd);
    const [, head, arg] = m ?? [];
    switch (head ?? cmd) {
      case ":CALCulate:MARKer:AOFF": for (let i = 1; i <= 10; i++) marker(i).mode = "OFF"; return;
      case ":CALCulate:MARKer:PEAK:THReshold": state.thr = clamp(Number(arg), -300, 30); state.thrAuto = false; return;
      case ":CALCulate:MARKer:PEAK:THReshold:STATe": state.thrAuto = arg === "ON"; return;
      case ":CALCulate:MARKer:PEAK:EXCursion": state.exc = clamp(Number(arg), 0, 200); state.excAuto = false; return;
      case ":CALCulate:MARKer:PEAK:EXCursion:STATe": state.excAuto = arg === "ON"; return;
      default: state.errors.push('-113,"Undefined header"');
    }
  });
  return { state, reset, calls, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerMarkerTools);
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
const M = (n: number) => `:CALCulate:MARKer${n}`;

describe("tool listing", () => {
  it("registers the marker tools; getters are read-only", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "get_marker", "get_peak_criteria", "marker_search", "marker_to_instrument", "markers_all_off", "set_marker", "set_peak_criteria",
    ]);
    expect(byName.get_marker.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_peak_criteria.annotations?.readOnlyHint).toBe(true);
    for (const n of ["set_marker", "marker_search", "marker_to_instrument", "markers_all_off", "set_peak_criteria"]) {
      expect(byName[n].annotations?.readOnlyHint).toBe(false);
    }
  });
});

describe("get_marker", () => {
  it("defaults to marker 1 and reports an off marker without stale readings", async () => {
    const res = await callTool(client, "get_marker", {});
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({ marker: 1, mode: "off", trace: 1, reference_marker: 2, x: null, y: null });
    expect(fake.query.mock.calls.map((c) => c[0])).not.toContain(`${M(1)}:X?`);
  });

  it("returns frequency and amplitude together for a normal marker", async () => {
    fake.state.markers[3] = { mode: "POSition", trace: 2, x: 1e9, ref: 4 };
    const out = json(await callTool(client, "get_marker", { marker: 3 }));
    expect(out).toMatchObject({ marker: 3, mode: "normal", trace: 2, x: 1e9 });
    expect(out.y).toBeCloseTo(-51, 4);
    expect(out.reference_marker).toBeUndefined();
  });

  it("reports delta markers' x and y as relative to the reference marker", async () => {
    fake.state.markers[1] = { mode: "DELTa", trace: 1, x: 2e9, ref: 2 };
    fake.state.markers[2] = { mode: "POSition", trace: 1, x: 1e9, ref: 3 };
    const out = json(await callTool(client, "get_marker", { marker: 1 }));
    expect(out).toMatchObject({ mode: "delta", reference_marker: 2, x: 1e9 });
    expect(out.y).toBeCloseTo(-1, 4);
  });

  it("maps fixed mode", async () => {
    fake.state.markers[5].mode = "FIXed";
    expect(json(await callTool(client, "get_marker", { marker: 5 })).mode).toBe("fixed");
  });

  it("rejects marker numbers outside 1-10 without touching the instrument", async () => {
    for (const marker of [0, 11, 1.5, -1]) {
      const res = await callTool(client, "get_marker", { marker });
      expect(res.isError).toBe(true);
    }
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("errors on a malformed reply, naming the command", async () => {
    fake.query.mockResolvedValueOnce("garbage");
    const res = await callTool(client, "get_marker", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(`${M(1)}:MODE?`);
  });
});

describe("set_marker", () => {
  it("turns a marker on in normal mode at an x position and reads back x and y", async () => {
    const res = await callTool(client, "set_marker", { marker: 1, mode: "normal", x_hz: 1e9 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([`${M(1)}:MODE POSition`, `${M(1)}:X 1000000000`]);
    const out = json(res);
    expect(out.marker).toMatchObject({ marker: 1, mode: "normal", x: 1e9 });
    expect(out.marker.y).toBeCloseTo(-51, 4);
    expect(out.warnings).toEqual([]);
  });

  it("sends mode, trace, reference marker and x in that order", async () => {
    const res = await callTool(client, "set_marker", { marker: 2, x_hz: 2e9, reference_marker: 1, trace: 3, mode: "delta" });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([`${M(2)}:MODE DELTa`, `${M(2)}:TRACe 3`, `${M(2)}:REFerence 1`, `${M(2)}:X 2000000000`]);
    expect(json(res).marker).toMatchObject({ mode: "delta", trace: 3, reference_marker: 1 });
  });

  it("maps off and fixed", async () => {
    await callTool(client, "set_marker", { marker: 4, mode: "fixed" });
    expect(fake.calls).toEqual([`${M(4)}:MODE FIXed`]);
    fake.calls.length = 0;
    const out = json(await callTool(client, "set_marker", { marker: 4, mode: "off" }));
    expect(fake.calls).toEqual([`${M(4)}:MODE OFF`]);
    expect(out.marker.mode).toBe("off");
  });

  it("warns when a position is set on a marker that is off", async () => {
    const out = json(await callTool(client, "set_marker", { marker: 6, x_hz: 1e9 }));
    expect(out.warnings.join(" ")).toMatch(/off/);
  });

  it("warns when the instrument adjusted a value", async () => {
    fake.state.markers[1].mode = "POSition";
    vi.spyOn(fake.state.markers, "at");
    fake.sendCommand.mockImplementationOnce(async (cmd: string) => { fake.calls.push(cmd); });
    const out = json(await callTool(client, "set_marker", { marker: 1, x_hz: 1e9 }));
    expect(out.warnings.join(" ")).toMatch(/x_hz/);
  });

  it("rejects invalid input without touching the instrument", async () => {
    const bad = [
      {}, { marker: 1 }, { marker: 0, mode: "off" }, { marker: 11, mode: "off" }, { marker: 1, trace: 7 }, { marker: 1, trace: 0 },
      { marker: 1, x_hz: -1 }, { marker: 1, reference_marker: 1 }, { marker: 1, reference_marker: 11 }, { marker: 1, mode: "bogus" },
    ];
    for (const args of bad) {
      const res = await callTool(client, "set_marker", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("reports an instrument error and says settings may be partially applied", async () => {
    // Reference marker equal to the marker is refused by us; make the instrument refuse trace via the fake
    fake.sendCommand.mockImplementationOnce(async (cmd: string) => { fake.calls.push(cmd); fake.state.errors.push('-224,"Illegal parameter value"'); });
    const res = await callTool(client, "set_marker", { marker: 1, mode: "normal" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/-224/);
    expect(getText(res)).toMatch(/partially applied/);
  });
});

describe("marker_search", () => {
  const cases: Array<[string, string]> = [
    ["peak", "MAXimum"], ["next_peak", "MAXimum:NEXT"], ["next_left", "MAXimum:LEFT"], ["next_right", "MAXimum:RIGHt"],
    ["minimum", "MINimum"], ["peak_to_peak", "PTPeak"],
  ];
  it.each(cases)("%s sends the right command and returns the marker", async (action, scpi) => {
    fake.state.markers[1] = { mode: "POSition", trace: 1, x: 2e9, ref: 2 };
    const res = await callTool(client, "marker_search", { marker: 1, action });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([`${M(1)}:${scpi}`]);
    expect(json(res).marker.marker).toBe(1);
  });

  it("peak search returns frequency and amplitude together and turns an off marker on", async () => {
    const out = json(await callTool(client, "marker_search", { marker: 2, action: "peak" }));
    expect(out.marker).toMatchObject({ marker: 2, mode: "normal", x: 3.5e9 });
    expect(out.marker.y).toBeCloseTo(-53.5, 4);
  });

  it("peak_to_peak leaves the marker in delta mode and says so", async () => {
    const out = json(await callTool(client, "marker_search", { marker: 1, action: "peak_to_peak" }));
    expect(out.marker.mode).toBe("delta");
    expect(out.note).toMatch(/delta/i);
  });

  it("rejects an unknown action or marker", async () => {
    for (const args of [{ marker: 1, action: "nope" }, { marker: 0, action: "peak" }, { action: "peak" }, { marker: 1 }]) {
      expect((await callTool(client, "marker_search", args)).isError).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("marker_to_instrument", () => {
  const cases: Array<[string, string, () => unknown]> = [
    ["center", "CENTer", () => fake.state.center],
    ["step", "STEP", () => fake.state.step],
    ["start", "STARt", () => fake.state.start],
    ["stop", "STOP", () => fake.state.stop],
    ["reference_level", "RLEVel", () => fake.state.rlevel],
  ];
  it.each(cases)("%s uses :SET:%s and returns the new value", async (target, scpi, read) => {
    fake.state.markers[1] = { mode: "POSition", trace: 1, x: 2e9, ref: 2 };
    const res = await callTool(client, "marker_to_instrument", { marker: 1, target });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(fake.calls).toEqual([`${M(1)}:SET:${scpi}`]);
    const out = json(res);
    expect(out.target).toBe(target);
    expect(out.value).toBeCloseTo(read() as number, 4);
  });

  it("refuses a marker that is off, before sending anything", async () => {
    const res = await callTool(client, "marker_to_instrument", { marker: 1, target: "center" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/off/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    for (const args of [{ marker: 1, target: "x" }, { marker: 12, target: "center" }, { target: "center" }]) {
      expect((await callTool(client, "marker_to_instrument", args)).isError).toBe(true);
    }
  });
});

describe("markers_all_off", () => {
  it("sends AOFF and confirms every marker is off", async () => {
    fake.state.markers[1].mode = "POSition";
    fake.state.markers[7].mode = "DELTa";
    const res = await callTool(client, "markers_all_off", {});
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":CALCulate:MARKer:AOFF"]);
    expect(json(res)).toEqual({ all_off: true, warnings: [] });
  });

  it("warns about a marker that is still on", async () => {
    fake.sendCommand.mockImplementationOnce(async (cmd: string) => { fake.calls.push(cmd); fake.state.markers[3].mode = "POSition"; });
    const out = json(await callTool(client, "markers_all_off", {}));
    expect(out.all_off).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/marker 3/);
  });
});

describe("get_peak_criteria / set_peak_criteria", () => {
  it("reads threshold and excursion with their automatic flags", async () => {
    expect(json(await callTool(client, "get_peak_criteria", {}))).toEqual({
      threshold_dbm: -175, threshold_auto: true, excursion_db: 1, excursion_auto: true,
    });
  });

  it("sets threshold and excursion; setting a value turns its automatic mode off", async () => {
    const res = await callTool(client, "set_peak_criteria", { threshold_dbm: -80, excursion_db: 5 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":CALCulate:MARKer:PEAK:THReshold -80", ":CALCulate:MARKer:PEAK:EXCursion 5"]);
    const out = json(res);
    expect(out.state).toEqual({ threshold_dbm: -80, threshold_auto: false, excursion_db: 5, excursion_auto: false });
    expect(out.warnings).toEqual([]);
  });

  it("switches automatic mode back on", async () => {
    fake.state.thrAuto = false;
    fake.state.excAuto = false;
    const res = await callTool(client, "set_peak_criteria", { threshold_auto: true, excursion_auto: true });
    expect(fake.calls).toEqual([":CALCulate:MARKer:PEAK:THReshold:STATe ON", ":CALCulate:MARKer:PEAK:EXCursion:STATe ON"]);
    expect(json(res).state).toMatchObject({ threshold_auto: true, excursion_auto: true });
  });

  it("allows turning automatic mode off without a value", async () => {
    await callTool(client, "set_peak_criteria", { excursion_auto: false });
    expect(fake.calls).toEqual([":CALCulate:MARKer:PEAK:EXCursion:STATe OFF"]);
  });

  it("warns when the instrument clamped a value", async () => {
    const out = json(await callTool(client, "set_peak_criteria", { threshold_dbm: 30, excursion_db: 100 }));
    expect(out.warnings).toEqual([]);
    fake.sendCommand.mockImplementationOnce(async (cmd: string) => { fake.calls.push(cmd); fake.state.thr = 0; });
    const out2 = json(await callTool(client, "set_peak_criteria", { threshold_dbm: -20 }));
    expect(out2.warnings.join(" ")).toMatch(/threshold_dbm/);
  });

  it("rejects invalid input without touching the instrument", async () => {
    const bad = [
      {}, { threshold_dbm: 31 }, { threshold_dbm: -201 }, { excursion_db: -1 }, { excursion_db: 101 },
      { threshold_dbm: -50, threshold_auto: true }, { excursion_db: 3, excursion_auto: true },
    ];
    for (const args of bad) expect((await callTool(client, "set_peak_criteria", args)).isError, JSON.stringify(args)).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});
