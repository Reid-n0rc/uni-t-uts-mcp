import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiSettingsTools } from "../../src/tools/emiSettings.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Minimal fake: answers every query this tool can send, in either SA or EMI module. */
const fake = vi.hoisted(() => {
  const state = { module: "EMI" as "SA" | "EMI" };
  const calls: string[] = [];
  function reply(cmd: string): string {
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) return state.module;
    if (/^:SENSe:EMC:STANdard:SELect\?$/.test(cmd)) return "NONE";
    if (/^:SENSe:FSCan:SEQuence\?$/.test(cmd)) return "SCAN";
    if (/^:SENSe:FSCan:SEQuence:REMeasure\?$/.test(cmd)) return "CURRent";
    if (/^:SENSe:FSCan:SEARch:MODE\?$/.test(cmd)) return "PONLy";
    if (/^:SENSe:METer\d:DETector\?$/.test(cmd)) return "POSitive";
    if (/^:SENSe:FSCan:DETector:TRACe\d\?$/.test(cmd)) return "POSitive";
    if (/^:SENSe:METer:PHOLd:TYPE\?$/.test(cmd)) return "ADJustable";
    if (/^:SENSe:AVERage:TYPE\?$/.test(cmd)) return "LOG";
    if (/^:TRACe\d:TYPE\?$/.test(cmd)) return "WRITe";
    if (/^:TRIGger:SEQuence:SOURce\?$/.test(cmd)) return "IMMediate";
    if (/\?$/.test(cmd)) return "1"; // every other query: a boolean/numeric field
    throw new Error(`fake: no reply for ${cmd}`);
  }
  const query = vi.fn(async (cmd: string) => reply(cmd));
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
  });
  function reset() {
    state.module = "EMI";
    calls.length = 0;
  }
  return { state, calls, query, sendCommand, reset };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerEmiSettingsTools);
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

describe("get_emi_settings", () => {
  it("reads the default groups (excludes scan_table) while in the EMI module", async () => {
    const res = await callTool(client, "get_emi_settings", {});
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.standard).toBe("none");
    expect(data.sequence).toBe("scan");
    expect(data.remeasure).toBe("current");
    expect(data.search_mode).toBe("peak_only");
    expect(data.meter_detectors).toEqual(["positive", "positive", "positive"]);
    expect(data.trace_detectors).toEqual(["positive", "positive", "positive"]);
    expect(data.average_type).toBe("log");
    expect(data.trace_type).toEqual(["write", "write", "write"]);
    expect(data.scan_table).toBeUndefined();
  });

  it("reads scan_table only when explicitly requested, and reads all 10 bands", async () => {
    const res = await callTool(client, "get_emi_settings", { groups: ["scan_table"] });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.scan_table).toHaveLength(10);
    expect(data.scan_table[0].band).toBe(1);
    expect(data.scan_table[9].band).toBe(10);
    expect(data.standard).toBeUndefined();
  });

  it("refuses with an actionable message when the analyzer is not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "get_emi_settings", {});
    expect(res.isError).toBe(true);
    const text = getText(res);
    expect(text).toMatch(/module/i);
    expect(text).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an unknown group before sending anything", async () => {
    const res = await callTool(client, "get_emi_settings", { groups: ["bogus"] });
    expect(res.isError).toBe(true);
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("is an error naming the command when a reply cannot be parsed", async () => {
    fake.query.mockImplementationOnce(async () => "EMI").mockImplementationOnce(async () => "NOT_A_STANDARD");
    const res = await callTool(client, "get_emi_settings", { groups: ["standard"] });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":SENSe:EMC:STANdard:SELect?");
  });
});
