import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiMarkerTools } from "../../src/tools/emiMarker.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface Marker {
  mode: "OFF" | "POSition" | "DELTa" | "FIXed";
  trace: number;
  reference: number;
  x: number;
  y: number;
}

/** Small stateful fake of the EMI marker/peak-search subsystem. */
const fake = vi.hoisted(() => {
  const freshMarker = (): Marker => ({ mode: "OFF", trace: 1, reference: 2, x: 1_000_000, y: -60 });
  const markers: Marker[] = [];
  const peak = { threshold: -50, thresholdAuto: true, excursion: 6, excursionAuto: true };
  const state = { module: "EMI" as "SA" | "EMI", errors: [] as string[] };
  function reset() {
    markers.length = 0;
    for (let i = 0; i < 6; i++) markers.push(freshMarker());
    peak.threshold = -50;
    peak.thresholdAuto = true;
    peak.excursion = 6;
    peak.excursionAuto = true;
    state.module = "EMI";
    state.errors = [];
  }
  reset();
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    if (cmd === ":INSTrument:SELect?") return state.module;
    let m = /^:CALCulate:FSCan:MARKer(\d):(MODE|TRACe|REFerence)\?$/.exec(cmd);
    if (m) {
      const marker = markers[Number(m[1]) - 1];
      if (m[2] === "MODE") return marker.mode;
      if (m[2] === "TRACe") return String(marker.trace);
      return String(marker.reference);
    }
    m = /^:CALCulate:FSCan:MARKer(\d):(X|Y)\?$/.exec(cmd);
    if (m) {
      const marker = markers[Number(m[1]) - 1];
      return String(m[2] === "X" ? marker.x : marker.y);
    }
    // Live firmware (verified 2026-11-12, #187): the plain, non-FSCan form never replies.
    if (/^:CALCulate:MARKer\d:[XY]\?$/.test(cmd)) throw new Error("timeout");
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:THReshold?") return String(peak.threshold);
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:THReshold:STATe?") return peak.thresholdAuto ? "1" : "0";
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:EXCursion?") return String(peak.excursion);
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:EXCursion:STATe?") return peak.excursionAuto ? "1" : "0";
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    if (cmd === ":CALCulate:FSCan:MARKer:AOFF") { for (const m of markers) m.mode = "OFF"; return; }
    let m = /^:CALCulate:FSCan:MARKer(\d):MODE (OFF|POSition|DELTa|FIXed)$/.exec(cmd);
    if (m) { markers[Number(m[1]) - 1].mode = m[2] as Marker["mode"]; return; }
    m = /^:CALCulate:FSCan:MARKer(\d):TRACe (\d)$/.exec(cmd);
    if (m) { markers[Number(m[1]) - 1].trace = Number(m[2]); return; }
    m = /^:CALCulate:FSCan:MARKer(\d):REFerence (\d)$/.exec(cmd);
    if (m) { markers[Number(m[1]) - 1].reference = Number(m[2]); return; }
    m = /^:CALCulate:FSCan:MARKer(\d):X (.+)$/.exec(cmd);
    if (m) {
      const marker = markers[Number(m[1]) - 1];
      if (marker.mode === "OFF") return; // no effect, matches the live firmware
      marker.x = Number(m[2]);
      return;
    }
    // Live firmware (verified 2026-11-12, #187): the plain, non-FSCan setter gives -113 and has no effect.
    if (/^:CALCulate:MARKer\d:X /.test(cmd)) { state.errors.push('-113,"Undefined header"'); return; }
    m = /^:CALCulate:FSCan:MARKer(\d):(MAXimum|MAXimum:NEXT|MAXimum:LEFT|MAXimum:RIGHt|MINimum)$/.exec(cmd);
    if (m) {
      const marker = markers[Number(m[1]) - 1];
      marker.mode = "POSition";
      marker.x = 5_000_000;
      marker.y = -40;
      return;
    }
    if (cmd.startsWith(":CALCulate:FSCan:MARKer:PEAK:THReshold ")) { peak.threshold = Number(cmd.split(" ")[1]); peak.thresholdAuto = false; return; }
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:THReshold:STATe ON") { peak.thresholdAuto = true; return; }
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:THReshold:STATe OFF") { peak.thresholdAuto = false; return; }
    if (cmd.startsWith(":CALCulate:FSCan:MARKer:PEAK:EXCursion ")) { peak.excursion = Number(cmd.split(" ")[1]); peak.excursionAuto = false; return; }
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:EXCursion:STATe ON") { peak.excursionAuto = true; return; }
    if (cmd === ":CALCulate:FSCan:MARKer:PEAK:EXCursion:STATe OFF") { peak.excursionAuto = false; return; }
    state.errors.push('-113,"Undefined header"');
  });
  return { markers, peak, state, reset, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const ctx = await createTestServer(registerEmiMarkerTools);
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
  it("registers all six EMI marker tools with the right read-only hints", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "emi_marker_search",
      "emi_markers_all_off",
      "get_emi_marker",
      "get_emi_peak_criteria",
      "set_emi_marker",
      "set_emi_peak_criteria",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_emi_marker.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_emi_peak_criteria.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_emi_marker.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_emi_marker", () => {
  it("reads an off marker with x and y null", async () => {
    const res = await callTool(client, "get_emi_marker", { marker: 1 });
    expect(res.isError).toBeUndefined();
    const out = json(res);
    expect(out).toEqual({ marker: 1, mode: "off", trace: 1, x: null, y: null });
  });

  it("reads a delta marker with its reference marker", async () => {
    fake.markers[0].mode = "DELTa";
    const out = json(await callTool(client, "get_emi_marker", { marker: 1 }));
    expect(out.mode).toBe("delta");
    expect(out.reference_marker).toBe(2);
    expect(out.x).toBe(1_000_000);
  });

  it("rejects an out-of-range marker number", async () => {
    const res = await callTool(client, "get_emi_marker", { marker: 7 });
    expect(res.isError).toBe(true);
  });
});

describe("set_emi_marker", () => {
  it("sets mode and frequency, round-tripping both", async () => {
    const res = await callTool(client, "set_emi_marker", { marker: 3, mode: "normal", frequency_hz: 2_500_000 });
    expect(res.isError).toBeUndefined();
    const out = json(res);
    expect(out.marker.mode).toBe("normal");
    expect(out.marker.x).toBe(2_500_000);
    expect(out.warnings).toEqual([]);
    expect(fake.markers[2].x).toBe(2_500_000);
  });

  it("warns when frequency_hz has no effect on an off marker", async () => {
    const out = json(await callTool(client, "set_emi_marker", { marker: 1, frequency_hz: 123 }));
    expect(out.warnings).toEqual(["frequency_hz has no effect while the marker is off; set mode normal first"]);
  });

  it("rejects no parameters, a self-referencing delta reference, and an out-of-range trace", async () => {
    expect((await callTool(client, "set_emi_marker", { marker: 1 })).isError).toBe(true);
    expect((await callTool(client, "set_emi_marker", { marker: 1, reference_marker: 1 })).isError).toBe(true);
    expect((await callTool(client, "set_emi_marker", { marker: 1, trace: 4 })).isError).toBe(true);
  });
});

describe("emi_marker_search", () => {
  it("runs a peak search and returns the new position", async () => {
    const out = json(await callTool(client, "emi_marker_search", { marker: 2, action: "peak" }));
    expect(out.marker.mode).toBe("normal");
    expect(out.marker.x).toBe(5_000_000);
    expect(out.marker.y).toBe(-40);
  });

  it("rejects an unknown action", async () => {
    const res = await callTool(client, "emi_marker_search", { marker: 1, action: "bogus" });
    expect(res.isError).toBe(true);
  });
});

describe("emi_markers_all_off", () => {
  it("turns every marker off and confirms it", async () => {
    fake.markers[0].mode = "POSition";
    fake.markers[3].mode = "DELTa";
    const out = json(await callTool(client, "emi_markers_all_off", {}));
    expect(out).toEqual({ all_off: true, warnings: [] });
    expect(fake.markers.every((m) => m.mode === "OFF")).toBe(true);
  });
});

describe("get_emi_peak_criteria / set_emi_peak_criteria", () => {
  it("reads the baseline criteria", async () => {
    const out = json(await callTool(client, "get_emi_peak_criteria", {}));
    expect(out).toEqual({ threshold_dbm: -50, threshold_auto: true, excursion_db: 6, excursion_auto: true });
  });

  it("sets a threshold, turning its automatic flag off", async () => {
    const out = json(await callTool(client, "set_emi_peak_criteria", { threshold_dbm: -30 }));
    expect(out.state.threshold_dbm).toBe(-30);
    expect(out.state.threshold_auto).toBe(false);
    expect(out.warnings).toEqual([]);
  });

  it("rejects out-of-range values, a value given together with its own auto flag, and no parameters", async () => {
    expect((await callTool(client, "set_emi_peak_criteria", {})).isError).toBe(true);
    expect((await callTool(client, "set_emi_peak_criteria", { threshold_dbm: 31 })).isError).toBe(true);
    expect((await callTool(client, "set_emi_peak_criteria", { excursion_db: 101 })).isError).toBe(true);
    expect((await callTool(client, "set_emi_peak_criteria", { threshold_dbm: -50, threshold_auto: true })).isError).toBe(true);
  });
});

describe("wrong module", () => {
  it("refuses before sending anything when the instrument is not in EMI", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "get_emi_marker", { marker: 1 });
    expect(res.isError).toBe(true);
    expect(fake.query).toHaveBeenCalledTimes(1); // only the module check itself
  });
});
