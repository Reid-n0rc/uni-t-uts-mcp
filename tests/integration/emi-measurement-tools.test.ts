import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiMeasurementTools } from "../../src/tools/emiMeasurement.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface FinalDetector {
  detector: string;
  dwell_s: number;
  limit_line: number;
}

/** Stateful fake: EMI measurement configuration, errors and *CLS/*OPC? bookkeeping. */
const fake = vi.hoisted(() => {
  const state = {
    module: "EMI" as "SA" | "EMI",
    standard: "NONE",
    sequence: "SCAN",
    remeasure: "CURR",
    traceDetectors: { 1: "POS", 2: "POS", 3: "POS" } as Record<number, string>,
    meterDetectors: { 1: "POS", 2: "POS", 3: "POS" } as Record<number, string>,
    meterDwellS: 1,
    finalDetectors: {
      1: { detector: "POS", dwell_s: 1, limit_line: 1 },
      2: { detector: "POS", dwell_s: 1, limit_line: 1 },
      3: { detector: "POS", dwell_s: 1, limit_line: 1 },
    } as Record<number, FinalDetector>,
    averageCount: 100,
    averageType: "LOG",
    searchMode: "PONL",
    peakCount: 10,
    segmentCount: 10,
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
    if (/^:SENSe:EMC:STANdard:SELect\?$/.test(cmd)) return state.standard;
    if (/^:SENSe:FSCan:SEQuence\?$/.test(cmd)) return state.sequence;
    if (/^:SENSe:FSCan:SEQuence:REMeasure\?$/.test(cmd)) return state.remeasure;
    let m = /^:SENSe:FSCan:DETector:TRACe(\d+)\?$/.exec(cmd);
    if (m) return state.traceDetectors[Number(m[1])];
    m = /^:SENSe:METer(\d+):DETector\?$/.exec(cmd);
    if (m) return state.meterDetectors[Number(m[1])];
    if (/^:SENSe:METer:DETector:DWELl\?$/.test(cmd)) return String(state.meterDwellS);
    m = /^:SENSe:FSCan:FINal:DETector(\d+)\?$/.exec(cmd);
    if (m) return state.finalDetectors[Number(m[1])].detector;
    m = /^:SENSe:FSCan:FINal:DETector(\d+):DWELl\?$/.exec(cmd);
    if (m) return String(state.finalDetectors[Number(m[1])].dwell_s);
    m = /^:SENSe:FSCan:FINal:DETector(\d+):LDELta\?$/.exec(cmd);
    if (m) return String(state.finalDetectors[Number(m[1])].limit_line);
    if (/^:SENSe:AVERage:COUNt\?$/.test(cmd)) return String(state.averageCount);
    if (/^:SENSe:AVERage:TYPE\?$/.test(cmd)) return state.averageType;
    if (/^:SENSe:FSCan:SEARch:MODE\?$/.test(cmd)) return state.searchMode;
    if (/^:SENSe:FSCan:SEARch:PEAK:COUNt\?$/.test(cmd)) return String(state.peakCount);
    if (/^:SENSe:FSCan:SEARch:SUBRange:COUNt\?$/.test(cmd)) return String(state.segmentCount);
    throw new Error(`fake: no reply for ${cmd}`);
  }

  function apply(cmd: string): void {
    if (cmd === "*CLS") {
      state.errors.length = 0;
      return;
    }
    let m = /^:SENSe:EMC:STANdard:SELect (\w+)$/.exec(cmd);
    if (m) { state.standard = m[1]; return; }
    m = /^:SENSe:FSCan:SEQuence (\w+)$/.exec(cmd);
    if (m) { state.sequence = m[1]; return; }
    m = /^:SENSe:FSCan:SEQuence:REMeasure (\w+)$/.exec(cmd);
    if (m) { state.remeasure = m[1]; return; }
    m = /^:SENSe:FSCan:DETector:TRACe(\d+) (\w+)$/.exec(cmd);
    if (m) { state.traceDetectors[Number(m[1])] = m[2]; return; }
    m = /^:SENSe:METer(\d+):DETector (\w+)$/.exec(cmd);
    if (m) { state.meterDetectors[Number(m[1])] = m[2]; return; }
    m = /^:SENSe:METer:DETector:DWELl ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.meterDwellS = Number(m[1]); return; }
    m = /^:SENSe:FSCan:FINal:DETector(\d+) (\w+)$/.exec(cmd);
    if (m) { state.finalDetectors[Number(m[1])].detector = m[2]; return; }
    m = /^:SENSe:FSCan:FINal:DETector(\d+):DWELl ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.finalDetectors[Number(m[1])].dwell_s = Number(m[2]); return; }
    m = /^:SENSe:FSCan:FINal:DETector(\d+):LDELta (\d+)$/.exec(cmd);
    if (m) { state.finalDetectors[Number(m[1])].limit_line = Number(m[2]); return; }
    m = /^:SENSe:AVERage:COUNt (\d+)$/.exec(cmd);
    if (m) { state.averageCount = Number(m[1]); return; }
    m = /^:SENSe:AVERage:TYPE (\w+)$/.exec(cmd);
    if (m) { state.averageType = m[1]; return; }
    m = /^:SENSe:FSCan:SEARch:MODE (\w+)$/.exec(cmd);
    if (m) { state.searchMode = m[1]; return; }
    m = /^:SENSe:FSCan:SEARch:PEAK:COUNt (\d+)$/.exec(cmd);
    if (m) { state.peakCount = Number(m[1]); return; }
    m = /^:SENSe:FSCan:SEARch:SUBRange:COUNt (\d+)$/.exec(cmd);
    if (m) { state.segmentCount = Number(m[1]); return; }
    throw new Error(`fake: no handler for command ${cmd}`);
  }

  const query = vi.fn(async (cmd: string) => reply(cmd));
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    apply(cmd);
  });
  function reset() {
    state.module = "EMI";
    state.standard = "NONE";
    state.sequence = "SCAN";
    state.remeasure = "CURR";
    state.traceDetectors = { 1: "POS", 2: "POS", 3: "POS" };
    state.meterDetectors = { 1: "POS", 2: "POS", 3: "POS" };
    state.meterDwellS = 1;
    state.finalDetectors = {
      1: { detector: "POS", dwell_s: 1, limit_line: 1 },
      2: { detector: "POS", dwell_s: 1, limit_line: 1 },
      3: { detector: "POS", dwell_s: 1, limit_line: 1 },
    };
    state.averageCount = 100;
    state.averageType = "LOG";
    state.searchMode = "PONL";
    state.peakCount = 10;
    state.segmentCount = 10;
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
  const ctx = await createTestServer(registerEmiMeasurementTools);
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

describe("set_emi_measurement", () => {
  it("sets standard, sequence and remeasure and reads them back", async () => {
    const res = await callTool(client, "set_emi_measurement", { standard: "cispr", sequence: "scan_search_measure", remeasure: "all" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.standard).toBe("cispr");
    expect(data.sequence).toBe("scan_search_measure");
    expect(data.remeasure).toBe("all");
    expect(data.warnings).toEqual([]);
  });

  it("sets trace, meter and final detectors", async () => {
    const res = await callTool(client, "set_emi_measurement", {
      trace_detectors: [{ index: 1, detector: "quasi_peak" }],
      meter_detectors: [{ index: 2, detector: "average" }],
      final_detectors: [{ index: 3, detector: "negative", dwell_s: 2, limit_line: 4 }],
    });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.trace_detectors[1]).toBe("quasi_peak");
    expect(data.meter_detectors[2]).toBe("average");
    expect(data.final_detectors[3]).toEqual({ detector: "negative", dwell_s: 2, limit_line: 4 });
    expect(data.warnings).toEqual([]);
  });

  it("sets averaging and search parameters", async () => {
    const res = await callTool(client, "set_emi_measurement", {
      average_count: 50,
      average_type: "voltage",
      search_mode: "segment_and_limit",
      peak_count: 5,
      segment_count: 6,
    });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.average_count).toBe(50);
    expect(data.average_type).toBe("voltage");
    expect(data.search_mode).toBe("segment_and_limit");
    expect(data.peak_count).toBe(5);
    expect(data.segment_count).toBe(6);
  });

  it("reports a warning when the instrument adjusts a requested value", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      fake.calls.push(cmd);
      if (/:AVERage:COUNt /.test(cmd)) {
        fake.state.averageCount = 999; // simulate the instrument clamping to something else
        return;
      }
      fake.apply(cmd);
    });
    const res = await callTool(client, "set_emi_measurement", { average_count: 500 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.warnings.some((w: string) => w.includes("average_count"))).toBe(true);
  });

  it("rejects more than two exclusive detectors in one group before sending anything", async () => {
    const res = await callTool(client, "set_emi_measurement", {
      trace_detectors: [
        { index: 1, detector: "quasi_peak" },
        { index: 2, detector: "average_continuous" },
        { index: 3, detector: "average" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/at most two/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("allows two exclusive detectors in one group", async () => {
    const res = await callTool(client, "set_emi_measurement", {
      trace_detectors: [
        { index: 1, detector: "quasi_peak" },
        { index: 2, detector: "average" },
      ],
    });
    expect(res.isError).toBeUndefined();
  });

  it("rejects a duplicate index in one detector group", async () => {
    const res = await callTool(client, "set_emi_measurement", {
      trace_detectors: [
        { index: 1, detector: "positive" },
        { index: 1, detector: "negative" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects a final_detectors entry with no fields to change", async () => {
    const res = await callTool(client, "set_emi_measurement", { final_detectors: [{ index: 1 }] });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_emi_measurement", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_emi_measurement", { average_count: 50 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("reports an instrument error through setterFailure, naming set_emi_measurement", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      fake.calls.push(cmd);
      fake.apply(cmd);
      if (/:AVERage:COUNt /.test(cmd)) fake.state.errors.push(`-131,"Invalid suffix"`);
    });
    const res = await callTool(client, "set_emi_measurement", { average_count: 50 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/set_emi_measurement/);
  });
});
