import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiRunTools } from "../../src/tools/emiRun.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Stateful fake modeling the live-verified EMI scan behavior (docs/verified-hardware.md,
 * 2026-11-12): while a scan runs, EVERY query (including `*OPC?` and `:SYSTem:ERRor?`) times out
 * with no reply; after `silentPolls` such attempts the instrument answers again on its own.
 */
const fake = vi.hoisted(() => {
  const state = {
    module: "EMI" as "SA" | "EMI",
    errors: [] as string[],
    silentPolls: 0, // how many *OPC?/:SYSTem:ERRor? calls stay silent before the scan is "done"
    alwaysSilent: false, // never answers (models a scan that never finishes within the test's timeout)
  };
  const calls: string[] = [];
  function reset() {
    state.module = "EMI";
    state.errors = [];
    state.silentPolls = 0;
    state.alwaysSilent = false;
    calls.length = 0;
  }
  reset();

  const query = vi.fn(async (cmd: string, timeoutMs?: number): Promise<string> => {
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) return state.module;
    if (cmd === "*OPC?" || cmd === ":SYSTem:ERRor?") {
      if (state.alwaysSilent || state.silentPolls > 0) {
        if (state.silentPolls > 0) state.silentPolls--;
        throw new Error(`Query timeout after ${timeoutMs ?? 5000}ms for command: ${cmd}`);
      }
      if (cmd === "*OPC?") return "1";
      return state.errors.shift() ?? '0,"No error"';
    }
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") return;
    calls.push(cmd);
  });
  return { state, calls, reset, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const ctx = await createTestServer(registerEmiRunTools);
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
  it("registers emi_run and emi_stop, both state-changing", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["emi_run", "emi_stop"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.emi_run.annotations?.readOnlyHint).toBe(false);
    expect(byName.emi_stop.annotations?.readOnlyHint).toBe(false);
  });
});

describe("emi_run", () => {
  it("starts the sequence, turns continuous sweep off first, and reports finished once the instrument answers again", async () => {
    fake.state.silentPolls = 2; // simulates a short scan that stays silent for two poll attempts
    const res = await callTool(client, "emi_run", { timeout_s: 5 });
    expect(res.isError).toBeUndefined();
    const out = json(res);
    expect(out.started).toBe(true);
    expect(out.finished).toBe(true);
    expect(out.error_queue).toBe('0,"No error"');
    expect(fake.calls).toEqual([":INITiate2:CONTinuous OFF", ":INITiate:IMMediate"]);
    expect(out.warnings.some((w: string) => /could not be read before changing it/.test(w))).toBe(true);
  });

  it("clears the signal list first when clear_list is true", async () => {
    const res = await callTool(client, "emi_run", { clear_list: true, timeout_s: 5 });
    expect(res.isError).toBeUndefined();
    expect(fake.calls).toEqual([":INITiate2:CONTinuous OFF", ":INITiate:FSCan:CLEar:IMMediate"]);
  });

  it("reports finished: false, not an error, when nothing answers within timeout_s", async () => {
    fake.state.alwaysSilent = true; // never finishes within the short timeout below
    const res = await callTool(client, "emi_run", { timeout_s: 0.3 });
    expect(res.isError).toBeUndefined();
    const out = json(res);
    expect(out.started).toBe(true);
    expect(out.finished).toBe(false);
    expect(out.warnings.some((w: string) => /may still be running/.test(w))).toBe(true);
  });

  it("surfaces an instrument error seen after the scan completes", async () => {
    fake.state.errors = ['-224,"Illegal parameter value"'];
    const res = await callTool(client, "emi_run", { timeout_s: 5 });
    const out = json(res);
    expect(out.finished).toBe(true);
    expect(out.error_queue).toBe('-224,"Illegal parameter value"');
  });

  it("rejects an out-of-range timeout before sending anything", async () => {
    const res = await callTool(client, "emi_run", { timeout_s: 0 });
    expect(res.isError).toBe(true);
    expect(fake.calls).toEqual([]);
    const res2 = await callTool(client, "emi_run", { timeout_s: 700 });
    expect(res2.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

describe("emi_stop", () => {
  it("sends :INITiate:STOP and reports no read-back exists", async () => {
    const res = await callTool(client, "emi_stop", {});
    expect(res.isError).toBeUndefined();
    const out = json(res);
    expect(out.stopped).toBe(true);
    expect(out.note).toMatch(/No read-back/);
    expect(fake.calls).toEqual([":INITiate:STOP"]);
  });

  it("reports an instrument error if the stop is rejected", async () => {
    fake.state.errors = ['-113,"Undefined header"'];
    const res = await callTool(client, "emi_stop", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/Undefined header/);
  });
});

describe("wrong module", () => {
  it("emi_run refuses before sending anything when the instrument is not in EMI", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "emi_run", { timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("emi_stop refuses before sending anything when the instrument is not in EMI", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "emi_stop", {});
    expect(res.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});
