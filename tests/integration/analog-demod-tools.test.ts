import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAnalogDemodTools, forgetAnalogDemodState } from "../../src/tools/analogDemod.js";
import { probeTuning } from "../../src/tools/measurement.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Small stateful fake: module (SA/EMI/AD, docs/verified-hardware.md "Installed options") plus the SA state
 * `enter_analog_demod`/`exit_analog_demod` save and restore (the same fields `exit_measurement` restores,
 * docs/research/analog-demodulation.md section 1). `loseNextSet` silently drops the next SA setter, to
 * exercise the resend-once-then-fail restore path (#133's precedent).
 */
const fake = vi.hoisted(() => {
  const initial = () => ({
    module: "SA" as "SA" | "EMI" | "AD",
    refuseSwitch: false,
    readbackFails: false,
    center: 1.805e9, span: 3.59e9, rbw: 3e6, rbwAuto: true, vbw: 3e6, vbwAuto: true,
    sweepTime: 2.6475e-3, sweepAuto: true, continuous: true,
    loseNextSet: 0,
  });
  const state = initial();
  const calls: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const flag = (b: boolean) => (b ? "1" : "0");
  function reset() { Object.assign(state, initial()); calls.length = 0; }
  const query = vi.fn(async (cmd: string): Promise<string> => {
    switch (cmd) {
      case ":SYSTem:ERRor?": return '0,"No error"';
      case ":INSTrument:SELect?":
        if (state.readbackFails) throw new Error("Query timeout after 5000ms for command: :INSTrument:SELect?");
        return state.module;
      case ":FREQuency:CENTer?": return sci(state.center);
      case ":FREQuency:SPAN?": return sci(state.span);
      case ":SENSe:BANDwidth:RESolution?": return sci(state.rbw);
      case ":SENSe:BANDwidth:RESolution:AUTO?": return flag(state.rbwAuto);
      case ":SENSe:BANDwidth:VIDeo?": return sci(state.vbw);
      case ":SENSe:BANDwidth:VIDeo:AUTO?": return flag(state.vbwAuto);
      case ":SENSe:SWEep:TIME?": return sci(state.sweepTime);
      case ":SENSe:SWEep:TIME:AUTO?": return flag(state.sweepAuto);
      case ":INITiate:CONTinuous?": return flag(state.continuous);
    }
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    const m = /^:INSTrument:SELect (\w+)$/.exec(cmd);
    if (m) {
      if (!state.refuseSwitch) state.module = m[1] as "SA" | "EMI" | "AD";
      return;
    }
    if (state.loseNextSet > 0) { state.loseNextSet--; return; } // setter accepted, instrument drops it
    const parts = /^(\S+) (\S+)$/.exec(cmd);
    if (!parts) return;
    const [, head, arg] = parts;
    const on = arg === "ON" || arg === "1";
    switch (head) {
      case ":FREQuency:CENTer": state.center = Number(arg); return;
      case ":FREQuency:SPAN": state.span = Number(arg); return;
      case ":SENSe:BANDwidth:RESolution": state.rbw = Number(arg); state.rbwAuto = false; return;
      case ":SENSe:BANDwidth:RESolution:AUTO": state.rbwAuto = on; return;
      case ":SENSe:BANDwidth:VIDeo": state.vbw = Number(arg); state.vbwAuto = false; return;
      case ":SENSe:BANDwidth:VIDeo:AUTO": state.vbwAuto = on; return;
      case ":SENSe:SWEep:TIME": state.sweepTime = Number(arg); state.sweepAuto = false; return;
      case ":SENSe:SWEep:TIME:AUTO": state.sweepAuto = on; return;
      case ":INITiate:CONTinuous": state.continuous = on; return;
    }
  });
  const impls = { query: query.getMockImplementation()!, sendCommand: sendCommand.getMockImplementation()! };
  return { state, reset, calls, query, sendCommand, impls };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  probeTuning.recoveryMs = 0;
  probeTuning.settleMs = 0;
  const ctx = await createTestServer(registerAnalogDemodTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => { await cleanup(); });
beforeEach(() => {
  fake.query.mockImplementation(fake.impls.query);
  fake.sendCommand.mockImplementation(fake.impls.sendCommand);
  fake.reset();
  vi.clearAllMocks();
  forgetAnalogDemodState();
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));

describe("tool listing", () => {
  it("registers both tools; entering is not read-only", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(["enter_analog_demod", "exit_analog_demod"]);
    expect(by.enter_analog_demod.annotations?.readOnlyHint).toBeFalsy();
    expect(by.exit_analog_demod.annotations?.readOnlyHint).toBeFalsy();
  });
});

describe("enter_analog_demod", () => {
  it("switches to AD, reads it back, and saves the SA state", async () => {
    const res = await callTool(client, "enter_analog_demod", {});
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toContain(":INSTrument:SELect AD");
    const parsed = json(res);
    expect(parsed.module).toBe("analog_demod");
    expect(parsed.saved_settings).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });

  it("warns, not errors, when the switch did not take (unlicensed/refused silently)", async () => {
    fake.state.refuseSwitch = true;
    const res = await callTool(client, "enter_analog_demod", {});
    expect(res.isError).toBeFalsy();
    const parsed = json(res);
    expect(parsed.module).toBe("spectrum_analyzer");
    expect(parsed.warnings[0]).toMatch(/refused|unlicensed/);
  });

  it("reports a readback timeout with the connection-quirk hint", async () => {
    fake.state.readbackFails = true;
    const res = await callTool(client, "enter_analog_demod", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("same connection");
  });

  it("re-entering AD keeps the originally saved SA state rather than overwriting it", async () => {
    await callTool(client, "enter_analog_demod", {});
    fake.state.center = 2.4e9; // instrument moved around while already in AD
    const res = await callTool(client, "enter_analog_demod", {});
    expect(res.isError).toBeFalsy();
    expect(json(res).saved_settings).toBe(true);
    // Exiting restores the ORIGINAL center, not the one set while already in AD.
    await callTool(client, "exit_analog_demod", {});
    expect(fake.state.center).toBe(1.805e9);
  });
});

describe("exit_analog_demod", () => {
  it("fails clearly when this server did not enter AD", async () => {
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/enter_analog_demod/);
    expect(fake.calls).not.toContain(":INSTrument:SELect SA");
  });

  it("switches back to SA and restores the saved settings, verified by read-back", async () => {
    await callTool(client, "enter_analog_demod", {});
    fake.state.center = 2.4e9;
    fake.state.span = 1e6;
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBeFalsy();
    const parsed = json(res);
    expect(parsed.module).toBe("spectrum_analyzer");
    expect(parsed.restored).toBe(true);
    expect(parsed.warnings).toEqual([]);
    expect(fake.state.center).toBe(1.805e9);
    expect(fake.state.span).toBe(3.59e9);
  });

  it("does nothing more once exited: a second exit fails clearly again", async () => {
    await callTool(client, "enter_analog_demod", {});
    await callTool(client, "exit_analog_demod", {});
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBe(true);
  });

  it("resends once when a setter is silently lost, and warns about it", async () => {
    await callTool(client, "enter_analog_demod", {});
    fake.state.center = 2.4e9;
    fake.state.loseNextSet = 1; // the first :FREQuency:CENTer in the restore is dropped
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBeFalsy();
    const parsed = json(res);
    expect(parsed.warnings[0]).toMatch(/second attempt restored/);
    expect(fake.state.center).toBe(1.805e9);
  });

  it("errors if a setting still will not restore after the resend", async () => {
    await callTool(client, "enter_analog_demod", {});
    fake.state.center = 2.4e9;
    fake.state.loseNextSet = 100; // every setter keeps getting dropped
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("could not be restored");
  });

  it("restore_settings: false skips restoring and says so", async () => {
    await callTool(client, "enter_analog_demod", {});
    fake.state.center = 2.4e9;
    const res = await callTool(client, "exit_analog_demod", { restore_settings: false });
    expect(res.isError).toBeFalsy();
    const parsed = json(res);
    expect(parsed.restored).toBe(false);
    expect(fake.state.center).toBe(2.4e9); // left as AD left it
  });

  it("has no saved settings when AD was entered without being in SA first", async () => {
    fake.state.module = "EMI";
    await callTool(client, "enter_analog_demod", {}); // from EMI, no SA state to capture
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBeFalsy();
    const parsed = json(res);
    expect(parsed.restored).toBe(false);
    expect(parsed.warnings[0]).toMatch(/no saved/i);
  });

  it("reports a readback timeout with the connection-quirk hint", async () => {
    await callTool(client, "enter_analog_demod", {});
    fake.state.readbackFails = true;
    const res = await callTool(client, "exit_analog_demod", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("same connection");
  });
});
