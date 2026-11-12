import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAcquisitionTools } from "../../src/tools/acquisition.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake of the acquisition subsystem. A started sweep makes *OPC? time out (as on the unit) until it ends. */
const fake = vi.hoisted(() => {
  const state = { continuous: true, time: 0.05, timeAuto: false, sweepEnd: 0, errors: [] as string[] };
  const log: Array<{ cmd: string; sync?: boolean }> = [];
  function reset() { Object.assign(state, { continuous: true, time: 0.05, timeAuto: false, sweepEnd: 0, errors: [] }); log.length = 0; }
  const query = vi.fn(async (cmd: string, _t?: number, _o?: unknown): Promise<string> => {
    switch (cmd) {
      case ":INITiate:CONTinuous?": return state.continuous ? "1" : "0";
      case ":SENSe:SWEep:TIME?": return state.time.toExponential(6) + " ";
      case ":SENSe:SWEep:TIME:AUTO?": return state.timeAuto ? "1" : "0";
      case "*OPC?":
        if (Date.now() < state.sweepEnd) throw new Error("Query timeout after 100ms for command: *OPC?");
        return "1";
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
    }
    if (cmd === ":INSTrument:SELect?") return "SA";
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string, o?: { sync?: boolean }) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    log.push({ cmd, sync: o?.sync });
    if (cmd === ":INITiate:CONTinuous OFF") state.continuous = false;
    else if (cmd === ":INITiate:CONTinuous ON") state.continuous = true;
    else if (cmd === ":INITiate:IMMediate" || cmd === ":INITiate:RESTart") state.sweepEnd = Date.now() + state.time * 1000;
    else state.errors.push('-113,"Undefined header"');
  });
  return { state, log, reset, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { capabilities: { syncsCommands: true, dropsInputDuringSweep: true, holdOffAfterTimeout: true }, query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => { const c = await createTestServer(registerAcquisitionTools); client = c.client; cleanup = c.cleanup; });
afterAll(async () => { await cleanup(); });
beforeEach(() => { fake.reset(); vi.clearAllMocks(); });

const json = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(r));

describe("tool listing", () => {
  it("registers the acquisition tools; only the getter is read-only", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(["get_acquisition", "set_acquisition", "single_sweep", "start_sweep", "wait_for_sweep_complete"]);
    expect(by.get_acquisition.annotations?.readOnlyHint).toBe(true);
    for (const n of ["set_acquisition", "single_sweep", "start_sweep", "wait_for_sweep_complete"]) expect(by[n].annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_acquisition", () => {
  it("reports continuous mode and the sweep time", async () => {
    expect(json(await callTool(client, "get_acquisition"))).toEqual({ continuous: true, sweep_time_s: 0.05, sweep_time_auto: false });
    fake.state.continuous = false;
    expect(json(await callTool(client, "get_acquisition")).continuous).toBe(false);
  });
});

describe("set_acquisition", () => {
  it("switches continuous off and on with ON/OFF", async () => {
    let out = json(await callTool(client, "set_acquisition", { continuous: false }));
    expect(fake.log.map((l) => l.cmd)).toEqual([":INITiate:CONTinuous OFF"]);
    expect(out.state.continuous).toBe(false);
    expect(out.warnings).toEqual([]);
    out = json(await callTool(client, "set_acquisition", { continuous: true }));
    expect(fake.log.at(-1)!.cmd).toBe(":INITiate:CONTinuous ON");
    expect(out.state.continuous).toBe(true);
  });
  it("warns when the readback differs", async () => {
    fake.sendCommand.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {});
    const out = json(await callTool(client, "set_acquisition", { continuous: false }));
    expect(out.warnings.join()).toMatch(/continuous/);
  });
});

describe("single_sweep", () => {
  it("sets single mode, starts the sweep unsynced, waits for the end and checks errors", async () => {
    const t0 = Date.now();
    const out = json(await callTool(client, "single_sweep"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(fake.log).toEqual([
      { cmd: ":INITiate:CONTinuous OFF", sync: undefined },
      { cmd: ":INITiate:IMMediate", sync: false },
    ]);
    expect(out.completed).toBe(true);
    expect(out.sweep_time_s).toBe(0.05);
    expect(fake.state.continuous).toBe(false);
  });
  it("reports a timeout as an error result", async () => {
    fake.state.time = 0.01;
    fake.sendCommand.mockImplementation(async (cmd: string) => { if (cmd === ":INITiate:IMMediate") fake.state.sweepEnd = Date.now() + 60000; });
    const res = await callTool(client, "single_sweep", { timeout_s: 0.3 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/did not complete|timed out/i);
    fake.sendCommand.mockReset();
  });
});

describe("single_sweep failure that may have switched the mode (live finding, issue #63)", () => {
  it("says the instrument may be left in single sweep mode when the connection drops while switching to it", async () => {
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === ":INITiate:CONTinuous OFF") throw new Error("Connection to the spectrum analyzer was lost (while sending :INITiate:CONTinuous OFF)");
    });
    const res = await callTool(client, "single_sweep");
    fake.sendCommand.mockReset();
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/single sweep mode/i);
    expect(getText(res)).toMatch(/set_acquisition continuous=true/);
  });
});

describe("start_sweep / wait_for_sweep_complete", () => {
  it("start_sweep without waiting returns at once; wait_for_sweep_complete then waits for the remainder", async () => {
    fake.state.continuous = false;
    fake.state.time = 0.15;
    const t0 = Date.now();
    const started = json(await callTool(client, "start_sweep", { wait: false }));
    expect(Date.now() - t0).toBeLessThan(100);
    expect(started.completed).toBe(false);
    const waited = json(await callTool(client, "wait_for_sweep_complete"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(130);
    expect(waited.completed).toBe(true);
  });
  it("start_sweep restart uses :INITiate:RESTart", async () => {
    fake.state.continuous = false;
    await callTool(client, "start_sweep", { method: "restart" });
    expect(fake.log.at(-1)).toEqual({ cmd: ":INITiate:RESTart", sync: false });
  });
  it("in continuous mode a sweep is restarted but not awaited, with a note", async () => {
    const out = json(await callTool(client, "start_sweep"));
    expect(out.completed).toBe(false);
    expect(out.warnings.join()).toMatch(/continuous/i);
    expect(fake.log.at(-1)!.cmd).toBe(":INITiate:IMMediate");
  });
  it("rejects a non-positive timeout", async () => {
    expect((await callTool(client, "single_sweep", { timeout_s: 0 })).isError).toBe(true);
  });
});
