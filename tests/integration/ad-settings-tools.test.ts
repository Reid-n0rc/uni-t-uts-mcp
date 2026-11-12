import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAdSettingsTools } from "../../src/tools/adSettings.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake: AD module frequency/bandwidth/timing settings, errors and *CLS/*OPC? bookkeeping. */
const fake = vi.hoisted(() => {
  const defaults = {
    module: "AD" as "SA" | "EMI" | "AD",
    demodType: "AM" as "AM" | "FM",
    centerHz: 64e6,
    centerStepHz: 1e6,
    centerStepAuto: true,
    spanHz: 200e3,
    rbwHz: 1.9e3,
    rbwAuto: true,
    demodBandwidthHz: 20e3,
    afStartHz: 0,
    afStopHz: 20e3,
    afRbwHz: 100,
    afRbwAuto: true,
    windowSweepTimeS: 2e-3,
    demodTimeS: 72e-3,
    demodTimeAuto: true,
    averageState: false,
    averageCount: 1,
    inputImpedanceOhm: 50,
  };
  const state = { ...defaults, errors: [] as string[] };
  const calls: string[] = [];

  function reply(cmd: string): string {
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) return state.module;
    if (/^\*OPC\?$/.test(cmd)) return "1";
    if (/^:SYSTem:ERRor\?$/.test(cmd)) {
      if (state.errors.length === 0) return `0,"No error"`;
      return state.errors.shift()!;
    }
    if (/^:CONFigure\?$/.test(cmd)) return state.demodType;
    if (/^:FREQuency:CENTer\?$/.test(cmd)) return String(state.centerHz);
    if (/^:FREQuency:CENTer:STEP\?$/.test(cmd)) return String(state.centerStepHz);
    if (/^:FREQuency:CENTer:STEP:AUTO\?$/.test(cmd)) return state.centerStepAuto ? "1" : "0";
    if (/^:(AM|FM):FREQuency:SPAN\?$/.test(cmd)) return String(state.spanHz);
    if (/^:(AM|FM):BANDwidth:RESolution\?$/.test(cmd)) return String(state.rbwHz);
    if (/^:(AM|FM):BANDwidth:RESolution:AUTO\?$/.test(cmd)) return state.rbwAuto ? "1" : "0";
    if (/^:(AM|FM):BANDwidth:CHANnel\?$/.test(cmd)) return String(state.demodBandwidthHz);
    if (/^:(AM|FM):AFSPectrum:FREQuency:STARt\?$/.test(cmd)) return String(state.afStartHz);
    if (/^:(AM|FM):AFSPectrum:FREQuency:STOP\?$/.test(cmd)) return String(state.afStopHz);
    if (/^:(AM|FM):AFSPectrum:BANDwidth\?$/.test(cmd)) return String(state.afRbwHz);
    if (/^:(AM|FM):AFSPectrum:BANDwidth:AUTO\?$/.test(cmd)) return state.afRbwAuto ? "1" : "0";
    if (/^:(AM|FM):DWSWeep:TIME\?$/.test(cmd)) return String(state.windowSweepTimeS);
    if (/^:(AM|FM):DEMod:TIME\?$/.test(cmd)) return String(state.demodTimeS);
    if (/^:(AM|FM):DEMod:TIME:AUTO\?$/.test(cmd)) return state.demodTimeAuto ? "1" : "0";
    if (/^:(AM|FM):AVERage:STATe\?$/.test(cmd)) return state.averageState ? "1" : "0";
    if (/^:(AM|FM):AVERage:COUNt\?$/.test(cmd)) return String(state.averageCount);
    if (/^:SENSe:CORRection:IMPedance:INPut:MAGNitude\?$/.test(cmd)) return String(state.inputImpedanceOhm);
    throw new Error(`fake: no reply for ${cmd}`);
  }

  function apply(cmd: string): void {
    if (cmd === "*CLS") {
      state.errors.length = 0;
      return;
    }
    let m = /^:FREQuency:CENTer ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.centerHz = Number(m[1]); return; }
    m = /^:FREQuency:CENTer:STEP ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.centerStepHz = Number(m[1]); return; }
    m = /^:FREQuency:CENTer:STEP:AUTO (ON|OFF)$/.exec(cmd);
    if (m) { state.centerStepAuto = m[1] === "ON"; return; }
    m = /^:(AM|FM):FREQuency:SPAN ([0-9.eE+-]+)$/.exec(cmd);
    if (m) {
      const requested = Number(m[2]);
      // Test-only clamp (not a documented instrument behavior) so the warning path is exercised.
      state.spanHz = requested > 1e6 ? 1e6 : requested;
      return;
    }
    m = /^:(AM|FM):BANDwidth:RESolution:AUTO (ON|OFF)$/.exec(cmd);
    if (m) { state.rbwAuto = m[2] === "ON"; return; }
    m = /^:(AM|FM):BANDwidth:RESolution ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.rbwHz = Number(m[2]); return; }
    m = /^:(AM|FM):BANDwidth:CHANnel ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.demodBandwidthHz = Number(m[2]); return; }
    m = /^:(AM|FM):DWSWeep:TIME ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.windowSweepTimeS = Number(m[2]); return; }
    m = /^:(AM|FM):DEMod:TIME:AUTO (ON|OFF)$/.exec(cmd);
    if (m) { state.demodTimeAuto = m[2] === "ON"; return; }
    m = /^:(AM|FM):DEMod:TIME ([0-9.eE+-]+)$/.exec(cmd);
    if (m) { state.demodTimeS = Number(m[2]); return; }
    m = /^:(AM|FM):AVERage:STATe (ON|OFF)$/.exec(cmd);
    if (m) { state.averageState = m[2] === "ON"; return; }
    m = /^:(AM|FM):AVERage:COUNt (\d+)$/.exec(cmd);
    if (m) { state.averageCount = Number(m[2]); return; }
    throw new Error(`fake: no handler for command ${cmd}`);
  }

  const query = vi.fn(async (cmd: string) => reply(cmd));
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    apply(cmd);
  });
  function reset() {
    Object.assign(state, defaults, { errors: [] });
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
  const ctx = await createTestServer(registerAdSettingsTools);
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

describe("get_ad_settings", () => {
  it("returns a snapshot of frequency, bandwidth and timing settings", async () => {
    const res = await callTool(client, "get_ad_settings", {});
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.demod_type).toBe("AM");
    expect(data.center_hz).toBe(64e6);
    expect(data.span_hz).toBe(200e3);
    expect(data.rbw_hz).toBe(1.9e3);
    expect(data.demod_bandwidth_hz).toBe(20e3);
    expect(data.input_impedance_ohm).toBe(50);
  });

  it("uses the FM prefix when :CONFigure? reports FM", async () => {
    fake.state.demodType = "FM";
    const res = await callTool(client, "get_ad_settings", {});
    expect(res.isError).toBeUndefined();
    expect(json(res).demod_type).toBe("FM");
    expect(fake.calls).toEqual([]); // getter uses only queries
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "get_ad_settings", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/ad/i);
  });
});

describe("set_ad_frequency", () => {
  it("sets center, span, rbw and demod bandwidth, reads back and reports no warnings", async () => {
    const res = await callTool(client, "set_ad_frequency", { center_hz: 70e6, span_hz: 100e3, rbw_hz: 1e3, demod_bandwidth_hz: 15e3 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.center_hz).toBe(70e6);
    expect(data.span_hz).toBe(100e3);
    expect(data.rbw_hz).toBe(1e3);
    expect(data.demod_bandwidth_hz).toBe(15e3);
    expect(data.warnings).toEqual([]);
    expect(fake.state.centerHz).toBe(70e6);
  });

  it("warns when the instrument adjusts a requested value", async () => {
    const res = await callTool(client, "set_ad_frequency", { span_hz: 2e6 }); // fake clamps > 1 MHz to 1 MHz
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.span_hz).toBe(1e6);
    expect(data.warnings).toEqual([expect.stringContaining("span_hz adjusted by the instrument")]);
  });

  it("rejects center_step_hz combined with center_step_auto=true", async () => {
    const res = await callTool(client, "set_ad_frequency", { center_step_hz: 1e3, center_step_auto: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/conflict/i);
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_ad_frequency", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("uses the FM prefix for span/rbw/demod bandwidth when in FM", async () => {
    fake.state.demodType = "FM";
    const res = await callTool(client, "set_ad_frequency", { span_hz: 50e3 });
    expect(res.isError).toBeUndefined();
    expect(fake.calls).toContain(":FM:FREQuency:SPAN 50000");
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "EMI";
    const res = await callTool(client, "set_ad_frequency", { span_hz: 100e3 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("set_ad_demod_timing", () => {
  it("sets window sweep time, demod time and averaging, reads back and reports no warnings", async () => {
    const res = await callTool(client, "set_ad_demod_timing", {
      window_sweep_time_s: 5e-3,
      demod_time_auto: false,
      demod_time_s: 150e-3,
      average_state: true,
      average_count: 10,
    });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.window_sweep_time_s).toBe(5e-3);
    expect(data.demod_time_s).toBe(150e-3);
    expect(data.average_state).toBe(true);
    expect(data.average_count).toBe(10);
    expect(data.warnings).toEqual([]);
  });

  it("rejects demod_time_s combined with demod_time_auto=true", async () => {
    const res = await callTool(client, "set_ad_demod_timing", { demod_time_s: 10e-3, demod_time_auto: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/conflict/i);
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_ad_demod_timing", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects average_count out of range", async () => {
    const res = await callTool(client, "set_ad_demod_timing", { average_count: 1000 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_ad_demod_timing", { average_count: 5 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});
