import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiScanTableTools } from "../../src/tools/emiScanTable.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface BandState {
  enabled: boolean;
  start_hz: number;
  stop_hz: number;
  rbw_hz: number;
  rbw_auto: boolean;
  time_s: number;
  time_auto: boolean;
  attenuation_db: number;
  attenuation_auto: boolean;
  points: number;
  preamp: boolean;
}

function defaultBand(n: number): BandState {
  return {
    enabled: n === 1,
    start_hz: n * 1e6,
    stop_hz: n * 1e6 + 1e6,
    rbw_hz: 120e3,
    rbw_auto: true,
    time_s: 1,
    time_auto: true,
    attenuation_db: 10,
    attenuation_auto: true,
    points: 401,
    preamp: false,
  };
}

const PRESET_RANGES: Record<string, [number, number]> = {
  CISA: [9e3, 150e3],
  CISB: [150e3, 30e6],
  CISC: [30e6, 300e6],
  CISD: [300e6, 1e9],
  CISCD: [30e6, 1e9],
  CISE: [1e9, 3.6e9],
};

/** Stateful fake: 10 EMI scan bands, errors and *CLS/*OPC? bookkeeping. */
const fake = vi.hoisted(() => {
  const state = {
    module: "EMI" as "SA" | "EMI",
    bands: new Map<number, BandState>(Array.from({ length: 10 }, (_, i) => [i + 1, defaultBand(i + 1)])),
    errors: [] as string[],
  };
  const calls: string[] = [];

  function band(n: number): BandState {
    const b = state.bands.get(n);
    if (!b) throw new Error(`fake: no band ${n}`);
    return b;
  }

  function reply(cmd: string): string {
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) return state.module;
    if (/^\*OPC\?$/.test(cmd)) return "1";
    if (/^:SYSTem:ERRor\?$/.test(cmd)) {
      if (state.errors.length === 0) return `0,"No error"`;
      return state.errors.shift()!;
    }
    let m = /^:SENSe:FSCan:SCAN(\d+):STARt\?$/.exec(cmd);
    if (m) return String(band(Number(m[1])).start_hz);
    m = /^:SENSe:FSCan:SCAN(\d+):STOP\?$/.exec(cmd);
    if (m) return String(band(Number(m[1])).stop_hz);
    m = /^:SENSe:FSCan:SCAN(\d+):STATe\?$/.exec(cmd);
    if (m) return band(Number(m[1])).enabled ? "1" : "0";
    m = /^:SENSe:FSCan:SCAN(\d+):BANDwidth:RESolution\?$/.exec(cmd);
    if (m) return String(band(Number(m[1])).rbw_hz);
    m = /^:SENSe:FSCan:SCAN(\d+):BANDwidth:RESolution:AUTO\?$/.exec(cmd);
    if (m) return band(Number(m[1])).rbw_auto ? "1" : "0";
    m = /^:SENSe:FSCan:SCAN(\d+):TIME\?$/.exec(cmd);
    if (m) return String(band(Number(m[1])).time_s);
    m = /^:SENSe:FSCan:SCAN(\d+):TIME:AUTO\?$/.exec(cmd);
    if (m) return band(Number(m[1])).time_auto ? "1" : "0";
    m = /^:SENSe:FSCan:SCAN(\d+):INPut:ATTenuation\?$/.exec(cmd);
    if (m) return String(band(Number(m[1])).attenuation_db);
    m = /^:SENSe:FSCan:SCAN(\d+):INPut:ATTenuation:AUTO\?$/.exec(cmd);
    if (m) return band(Number(m[1])).attenuation_auto ? "1" : "0";
    m = /^:SENSe:FSCan:SCAN(\d+):POINt\?$/.exec(cmd);
    if (m) return String(band(Number(m[1])).points);
    m = /^:SENSe:FSCan:SCAN(\d+):POWer:GAIN:STATe\?$/.exec(cmd);
    if (m) return band(Number(m[1])).preamp ? "1" : "0";
    throw new Error(`fake: no reply for ${cmd}`);
  }

  function apply(cmd: string): void {
    if (cmd === "*CLS") {
      state.errors.length = 0;
      return;
    }
    let m = /^:SENSe:FSCan:SCAN(\d+):STARt ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { band(Number(m[1])).start_hz = Number(m[2]); return; }
    m = /^:SENSe:FSCan:SCAN(\d+):STOP ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { band(Number(m[1])).stop_hz = Number(m[2]); return; }
    m = /^:SENSe:FSCan:SCAN(\d+):STATe ([01])$/.exec(cmd);
    if (m) { band(Number(m[1])).enabled = m[2] === "1"; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):BANDwidth:RESolution ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { band(Number(m[1])).rbw_hz = Number(m[2]); band(Number(m[1])).rbw_auto = false; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):BANDwidth:RESolution:AUTO ([01])$/.exec(cmd);
    if (m) { band(Number(m[1])).rbw_auto = m[2] === "1"; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):TIME ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { band(Number(m[1])).time_s = Number(m[2]); band(Number(m[1])).time_auto = false; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):TIME:AUTO ([01])$/.exec(cmd);
    if (m) { band(Number(m[1])).time_auto = m[2] === "1"; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):INPut:ATTenuation ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { band(Number(m[1])).attenuation_db = Number(m[2]); band(Number(m[1])).attenuation_auto = false; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):INPut:ATTenuation:AUTO ([01])$/.exec(cmd);
    if (m) { band(Number(m[1])).attenuation_auto = m[2] === "1"; return; }
    m = /^:SENSe:FSCan:SCAN(\d+):POINt (\d+)$/.exec(cmd);
    if (m) { band(Number(m[1])).points = Number(m[2]); return; }
    m = /^:SENSe:FSCan:SCAN(\d+):POWer:GAIN:STATe ([01])$/.exec(cmd);
    if (m) { band(Number(m[1])).preamp = m[2] === "1"; return; }
    m = /^:SENSe:FSCan:RANGe(\d+):PREset (CIS\w+)$/.exec(cmd);
    if (m) {
      const [start, stop] = PRESET_RANGES[m[2]];
      band(Number(m[1])).start_hz = start;
      band(Number(m[1])).stop_hz = stop;
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
    state.module = "EMI";
    state.bands = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, defaultBand(i + 1)]));
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
  const ctx = await createTestServer(registerEmiScanTableTools);
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

describe("set_emi_scan_table", () => {
  it("edits one band and reads the whole table back", async () => {
    const res = await callTool(client, "set_emi_scan_table", {
      bands: [{ band: 2, start_hz: 100e6, stop_hz: 200e6, points: 1001, preamp: true }],
    });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.scan_table).toHaveLength(10);
    const b2 = data.scan_table.find((b: { band: number }) => b.band === 2);
    expect(b2.start_hz).toBe(100e6);
    expect(b2.stop_hz).toBe(200e6);
    expect(b2.points).toBe(1001);
    expect(b2.preamp).toBe(true);
    expect(data.warnings).toEqual([]);
  });

  it("loads a CISPR preset", async () => {
    const res = await callTool(client, "set_emi_scan_table", { presets: [{ band: 3, cis: "B" }] });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    const b3 = data.scan_table.find((b: { band: number }) => b.band === 3);
    expect(b3.start_hz).toBe(150e3);
    expect(b3.stop_hz).toBe(30e6);
  });

  it("reports a warning when the instrument adjusts a requested value", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      fake.calls.push(cmd);
      if (/:SCAN4:POINt /.test(cmd)) {
        fake.state.bands.get(4)!.points = 999; // simulate the instrument clamping to something else
        return;
      }
      fake.apply(cmd);
    });
    const res = await callTool(client, "set_emi_scan_table", { bands: [{ band: 4, points: 1001 }] });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.warnings.some((w: string) => w.includes("band 4 points"))).toBe(true);
  });

  it("warns when an untouched band's range moved (neighbor-band coupling)", async () => {
    const before2 = { ...fake.state.bands.get(2)! };
    fake.sendCommand.mockImplementationOnce(async (cmd: string) => {
      fake.calls.push(cmd);
      fake.state.bands.get(1)!.stop_hz = 50e6;
      fake.state.bands.get(2)!.start_hz = 50e6; // band 2 coupled away from its old start
    });
    const res = await callTool(client, "set_emi_scan_table", { bands: [{ band: 1, stop_hz: 50e6 }] });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.warnings.some((w: string) => w.includes("band 2") && w.includes("not edited"))).toBe(true);
    expect(before2.start_hz).not.toBe(fake.state.bands.get(2)!.start_hz);
  });

  it("rejects stop_hz too close to start_hz before sending anything", async () => {
    const res = await callTool(client, "set_emi_scan_table", { bands: [{ band: 1, start_hz: 1e6, stop_hz: 1e6 + 50 }] });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an odd attenuation value before sending anything", async () => {
    const res = await callTool(client, "set_emi_scan_table", { bands: [{ band: 1, attenuation_db: 11 }] });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects a duplicate band number in one call", async () => {
    const res = await callTool(client, "set_emi_scan_table", {
      bands: [{ band: 1, points: 1001 }, { band: 1, preamp: true }],
    });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_emi_scan_table", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_emi_scan_table", { bands: [{ band: 1, points: 1001 }] });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("reports an instrument error through setterFailure, naming get_emi_settings", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      fake.calls.push(cmd);
      fake.apply(cmd);
      if (/:SCAN1:POINt /.test(cmd)) fake.state.errors.push(`-131,"Invalid suffix"`);
    });
    const res = await callTool(client, "set_emi_scan_table", { bands: [{ band: 1, points: 1001 }] });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/get_emi_settings/);
  });
});
