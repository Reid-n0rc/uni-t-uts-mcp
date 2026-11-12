import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAdDisplayMarkerTools } from "../../src/tools/adDisplayMarker.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake: AD module display windows and markers, errors and *CLS/*OPC? bookkeeping. */
const fake = vi.hoisted(() => {
  const defaultMarker = () => ({ mode: "OFF", trace: "RFSPectrum", reference: 2, x: 0, y: 0 });
  const defaults = {
    module: "AD" as "SA" | "EMI" | "AD",
    demodType: "AM" as "AM" | "FM",
    windows: {
      1: { referenceLevel: -10, perDivision: 10 },
      2: { referenceLevel: 0, perDivision: 0.1 },
      3: { referenceLevel: -20, perDivision: 10, spacing: "LOGarithmic" as "LOGarithmic" | "LINear" },
    },
  };
  const state = {
    ...defaults,
    windows: { 1: { ...defaults.windows[1] }, 2: { ...defaults.windows[2] }, 3: { ...defaults.windows[3] } },
    markers: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, defaultMarker()])) as Record<number, ReturnType<typeof defaultMarker>>,
    errors: [] as string[],
  };
  const calls: string[] = [];

  function reply(cmd: string): string {
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) return state.module;
    if (/^\*OPC\?$/.test(cmd)) return "1";
    if (/^:SYSTem:ERRor\?$/.test(cmd)) {
      if (state.errors.length === 0) return `0,"No error"`;
      return state.errors.shift()!;
    }
    if (/^:CONFigure\?$/.test(cmd)) return state.demodType;
    let m = /^:DISPlay:(?:AM|FM):WINDow(\d):TRACe:Y:RLEVel\?$/.exec(cmd);
    if (m) return String(state.windows[Number(m[1]) as 1 | 2 | 3].referenceLevel);
    m = /^:DISPlay:(?:AM|FM):WINDow(\d):TRACe:Y:PDIVision\?$/.exec(cmd);
    if (m) return String(state.windows[Number(m[1]) as 1 | 2 | 3].perDivision);
    m = /^:DISPlay:(?:AM|FM):WINDow3:TRACe:Y:SPACing\?$/.exec(cmd);
    if (m) return state.windows[3].spacing;
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):MODE\?$/.exec(cmd);
    if (m) return state.markers[Number(m[1])].mode;
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):TRACe\?$/.exec(cmd);
    if (m) return state.markers[Number(m[1])].trace;
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):REFerence\?$/.exec(cmd);
    if (m) return String(state.markers[Number(m[1])].reference);
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):X\?$/.exec(cmd);
    if (m) return String(state.markers[Number(m[1])].x);
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):Y\?$/.exec(cmd);
    if (m) return String(state.markers[Number(m[1])].y);
    throw new Error(`fake: no reply for ${cmd}`);
  }

  function apply(cmd: string): void {
    if (cmd === "*CLS") {
      state.errors.length = 0;
      return;
    }
    let m = /^:DISPlay:(?:AM|FM):WINDow(\d):TRACe:Y:RLEVel ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.windows[Number(m[1]) as 1 | 2 | 3].referenceLevel = Number(m[2]); return; }
    m = /^:DISPlay:(?:AM|FM):WINDow(\d):TRACe:Y:PDIVision ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.windows[Number(m[1]) as 1 | 2 | 3].perDivision = Number(m[2]); return; }
    m = /^:DISPlay:(?:AM|FM):WINDow3:TRACe:Y:SPACing (LOGarithmic|LINear)$/.exec(cmd);
    if (m) { state.windows[3].spacing = m[1] as "LOGarithmic" | "LINear"; return; }
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):MODE (OFF|POSition|DELTa|FIXed)$/.exec(cmd);
    if (m) { state.markers[Number(m[1])].mode = m[2]!; return; }
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):TRACe (RFSPectrum|DEMod|DAVerage|DMAXimum|DMINimum|AFSPectrum)$/.exec(cmd);
    if (m) { state.markers[Number(m[1])].trace = m[2]!; return; }
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):REFerence (\d)$/.exec(cmd);
    if (m) { state.markers[Number(m[1])].reference = Number(m[2]); return; }
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):X ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.markers[Number(m[1])].x = Number(m[2]); return; }
    m = /^:CALCulate:(?:AM|FM):MARKer(\d):(MAXimum|MAXimum:NEXT|MAXimum:LEFT|MAXimum:RIGHt|MINimum|PTPeak)$/.exec(cmd);
    if (m) {
      const marker = state.markers[Number(m[1])];
      marker.mode = m[2] === "PTPeak" ? "DELTa" : "POSition";
      marker.x = 1e6;
      marker.y = -30;
      return;
    }
    m = /^:CALCulate:(?:AM|FM):MARKer:AOFF$/.exec(cmd);
    if (m) {
      for (const n of [1, 2, 3, 4, 5, 6]) state.markers[n].mode = "OFF";
      return;
    }
    throw new Error(`fake: no handler for command ${cmd}`);
  }

  const query = vi.fn(async (cmd: string) => reply(cmd));
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    apply(cmd);
  });
  function reset() {
    state.module = defaults.module;
    state.demodType = defaults.demodType;
    state.windows = { 1: { ...defaults.windows[1] }, 2: { ...defaults.windows[2] }, 3: { ...defaults.windows[3] } };
    state.markers = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, defaultMarker()]));
    state.errors.length = 0;
    calls.length = 0;
  }
  return { state, calls, query, sendCommand, reset, apply };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerAdDisplayMarkerTools);
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

describe("set_ad_display", () => {
  it("sets reference level and per-division for window 1, reads back and reports no warnings", async () => {
    const res = await callTool(client, "set_ad_display", { window: 1, reference_level: -5, per_division: 5 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.window).toBe(1);
    expect(data.reference_level).toBe(-5);
    expect(data.per_division).toBe(5);
    expect(data.warnings).toEqual([]);
    expect(fake.state.windows[1].referenceLevel).toBe(-5);
  });

  it("sets af_spacing for window 3 and reads it back", async () => {
    const res = await callTool(client, "set_ad_display", { window: 3, af_spacing: "linear" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.af_spacing).toBe("linear");
    expect(fake.state.windows[3].spacing).toBe("LINear");
  });

  it("warns when the instrument adjusts a requested value", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      fake.calls.push(cmd);
      if (!/RLEVel/.test(cmd)) fake.apply(cmd); // drop the RLEVel setter itself so the readback stays at the default
    });
    const res = await callTool(client, "set_ad_display", { window: 2, reference_level: 5 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.reference_level).toBe(0); // unchanged default
    expect(data.warnings).toEqual([expect.stringContaining("reference_level adjusted by the instrument")]);
  });

  it("rejects af_spacing outside window 3", async () => {
    const res = await callTool(client, "set_ad_display", { window: 1, af_spacing: "linear" });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_ad_display", { window: 1 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_ad_display", { window: 1, reference_level: -5 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("ad_marker", () => {
  it("sets mode, trace and position, reads back and reports no warnings", async () => {
    const res = await callTool(client, "ad_marker", { marker: 1, mode: "normal", trace: "rf_spectrum", x: 1e6 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.marker.mode).toBe("normal");
    expect(data.marker.trace).toBe("rf_spectrum");
    expect(data.marker.x).toBe(1e6);
    expect(data.marker.x_unit).toBe("Hz");
    expect(data.marker.y_unit).toBe("dBm");
    expect(data.warnings).toEqual([]);
  });

  it("reports seconds/depth units for a demod-waveform trace in AM", async () => {
    const res = await callTool(client, "ad_marker", { marker: 2, mode: "normal", trace: "demod" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.marker.x_unit).toBe("s");
    expect(data.marker.y_unit).toMatch(/modulation depth/);
  });

  it("reports Hz deviation for a demod-waveform trace in FM", async () => {
    fake.state.demodType = "FM";
    const res = await callTool(client, "ad_marker", { marker: 2, mode: "normal", trace: "demod" });
    expect(res.isError).toBeUndefined();
    expect(json(res).marker.y_unit).toBe("Hz (frequency deviation)");
  });

  it("warns that x has no effect while the marker is off", async () => {
    const res = await callTool(client, "ad_marker", { marker: 3, x: 5e6 });
    expect(res.isError).toBeUndefined();
    expect(json(res).warnings).toEqual([expect.stringContaining("x has no effect while the marker is off")]);
  });

  it("rejects reference_marker equal to marker", async () => {
    const res = await callTool(client, "ad_marker", { marker: 1, reference_marker: 1 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "ad_marker", { marker: 1 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "EMI";
    const res = await callTool(client, "ad_marker", { marker: 1, mode: "normal" });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("ad_marker_search", () => {
  it("runs a peak search and turns the marker on", async () => {
    const res = await callTool(client, "ad_marker_search", { marker: 1, action: "peak" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.marker.mode).toBe("normal");
    expect(data.marker.x).toBe(1e6);
    expect(fake.calls).toContain(":CALCulate:AM:MARKer1:MAXimum");
  });

  it("leaves a peak_to_peak search in delta mode with a note", async () => {
    const res = await callTool(client, "ad_marker_search", { marker: 1, action: "peak_to_peak" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.marker.mode).toBe("delta");
    expect(data.note).toMatch(/peak-to-peak/);
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "ad_marker_search", { marker: 1, action: "peak" });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("get_ad_marker", () => {
  it("returns null x/y for an off marker", async () => {
    const res = await callTool(client, "get_ad_marker", { marker: 1 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.marker.mode).toBe("off");
    expect(data.marker.x).toBeNull();
    expect(data.marker.y).toBeNull();
  });

  it("includes reference_marker for a delta marker", async () => {
    fake.state.markers[1] = { mode: "DELTa", trace: "RFSPectrum", reference: 2, x: 1e6, y: -30 };
    const res = await callTool(client, "get_ad_marker", { marker: 1 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.marker.mode).toBe("delta");
    expect(data.marker.reference_marker).toBe(2);
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "EMI";
    const res = await callTool(client, "get_ad_marker", {});
    expect(res.isError).toBe(true);
  });
});

describe("ad_markers_all_off", () => {
  it("turns every marker off and confirms it", async () => {
    fake.state.markers[1].mode = "POSition";
    fake.state.markers[4].mode = "DELTa";
    const res = await callTool(client, "ad_markers_all_off", {});
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.all_off).toBe(true);
    expect(data.warnings).toEqual([]);
    expect(fake.calls).toContain(":CALCulate:AM:MARKer:AOFF");
  });

  it("warns if a marker is still on after all-off", async () => {
    fake.state.markers[2].mode = "POSition";
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      fake.calls.push(cmd);
      if (!/AOFF/.test(cmd)) fake.apply(cmd);
      else fake.state.markers[1].mode = "OFF"; // AOFF applied to every marker except 2, which "stays on"
    });
    const res = await callTool(client, "ad_markers_all_off", {});
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.all_off).toBe(false);
    expect(data.warnings).toEqual([expect.stringContaining("marker 2 is still on")]);
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "ad_markers_all_off", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});
