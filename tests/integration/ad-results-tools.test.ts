import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAdResultTools } from "../../src/tools/adResults.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake: AD module demod type, and a canned :FETCh:AM?/:FETCh:FM? metrics line. */
const fake = vi.hoisted(() => {
  const defaults = {
    module: "AD" as "SA" | "EMI" | "AD",
    demodType: "AM" as "AM" | "FM",
    metricsLine:
      "6.400000000e+07,-9.835685e+01,nan,1.146127224e+01,-1.408944e+01,5.063745e+00,6.787261e-01," +
      "1.1e-01,-1.2e-01,1.15e-01,8.1e-02,1.3e-01,-1.4e-01,1.35e-01,9.0e-02",
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
    if (/^:FETCh:(AM|FM)\?$/.test(cmd)) return state.metricsLine;
    throw new Error(`fake: no reply for ${cmd}`);
  }

  const query = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    return reply(cmd);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "*CLS") state.errors.length = 0;
  });
  function reset() {
    Object.assign(state, defaults, { errors: [] });
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
  const ctx = await createTestServer(registerAdResultTools);
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

describe("get_demod_result", () => {
  it("parses the 15-value metrics line into named fields", async () => {
    const res = await callTool(client, "get_demod_result", {});
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.demod_type).toBe("AM");
    expect(data.center_frequency_hz).toBe(6.4e7);
    expect(data.carrier_power).toBeCloseTo(-98.35685, 4);
    expect(data.carrier_frequency_error_hz).toBeNull(); // nan -> JSON null
    expect(data.sinad_db).toBeCloseTo(-14.08944, 4);
    expect(data.thd_percent).toBeCloseTo(0.6787261, 6);
    expect(data.current).toEqual({ peak_plus: 0.11, peak_minus: -0.12, pk_pk_over_2: 0.115, rms: 0.081 });
    expect(data.max_hold).toEqual({ peak_plus: 0.13, peak_minus: -0.14, pk_pk_over_2: 0.135, rms: 0.09 });
    expect(fake.calls).toEqual([":INSTrument:SELect?", ":CONFigure?", ":FETCh:AM?"]); // getter uses only queries
  });

  it("uses the FM prefix when :CONFigure? reports FM", async () => {
    fake.state.demodType = "FM";
    const res = await callTool(client, "get_demod_result", {});
    expect(res.isError).toBeUndefined();
    expect(json(res).demod_type).toBe("FM");
    expect(fake.calls).toEqual([":INSTrument:SELect?", ":CONFigure?", ":FETCh:FM?"]);
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "get_demod_result", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/ad/i);
  });

  it("errors on a reply with the wrong field count", async () => {
    fake.state.metricsLine = "1,2,3";
    const res = await callTool(client, "get_demod_result", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/15/);
  });

  it("errors on a garbage reply", async () => {
    fake.state.metricsLine = "not,a,number,line,here,at,all,x,x,x,x,x,x,x,x";
    const res = await callTool(client, "get_demod_result", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/number/i);
  });
});
