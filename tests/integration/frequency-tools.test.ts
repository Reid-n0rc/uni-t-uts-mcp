import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerFrequencyTools } from "../../src/tools/frequency.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Tiny stateful fake of the analyzer's frequency subsystem. */
const fake = vi.hoisted(() => {
  const state = {
    center: 1.805e9,
    span: 3.59e9,
    start: 1e7,
    stop: 3.6e9,
    step: 3.59e8,
    stepAuto: true,
    offset: 0,
    errors: [] as string[],
    clampStopTo: undefined as number | undefined,
  };
  const sci = (n: number) => n.toExponential(10);
  const mult: Record<string, number> = { Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9 };
  function reset() {
    Object.assign(state, {
      center: 1.805e9, span: 3.59e9, start: 1e7, stop: 3.6e9, step: 3.59e8,
      stepAuto: true, offset: 0, errors: [], clampStopTo: undefined,
    });
  }
  function fromRange() {
    state.center = (state.start + state.stop) / 2;
    state.span = state.stop - state.start;
  }
  function fromCenterSpan() {
    state.start = state.center - state.span / 2;
    state.stop = state.center + state.span / 2;
  }
  const calls: string[] = [];
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    switch (cmd) {
      case ":FREQuency:CENTer?": return sci(state.center);
      case ":FREQuency:SPAN?": return sci(state.span);
      case ":FREQuency:STARt?": return sci(state.start);
      case ":FREQuency:STOP?": return sci(state.stop);
      case ":FREQuency:CENTer:STEP?": return sci(state.step);
      case ":FREQuency:CENTer:STEP:AUTO?": return state.stepAuto ? "1" : "0";
      case ":FREQuency:OFFSet?": return sci(state.offset);
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
      case ":INSTrument:SELect?": return "SA";
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    if (cmd === ":FREQuency:SPAN:FULL") { state.start = 1e7; state.stop = 3.6e9; fromRange(); return; }
    if (cmd === ":FREQuency:SPAN:ZERO") { state.span = 0; fromCenterSpan(); return; }
    let m = /^:FREQuency:CENTer:STEP:AUTO (ON|OFF)$/.exec(cmd);
    if (m) { state.stepAuto = m[1] === "ON"; return; }
    m = /^:FREQuency:(CENTer:STEP|CENTer|SPAN|STARt|STOP|OFFSet) (\S+) (Hz|kHz|MHz|GHz)$/.exec(cmd);
    if (!m) { state.errors.push('-131,"Invalid suffix"'); return; }
    const v = Number(m[2]) * mult[m[3]];
    switch (m[1]) {
      case "CENTer": state.center = v; fromCenterSpan(); break;
      case "SPAN": state.span = v; fromCenterSpan(); break;
      case "STARt": state.start = v; fromRange(); break;
      case "STOP": state.stop = state.clampStopTo ?? v; fromRange(); break;
      case "OFFSet": state.offset = v; break;
      case "CENTer:STEP": state.step = v; state.stepAuto = false; break;
    }
  });
  return { state, reset, calls, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerFrequencyTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  fake.calls.length = 0;
  vi.clearAllMocks();
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));

describe("tool listing", () => {
  it("registers get_frequency (read-only) and set_frequency", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_frequency", "set_frequency"]);
    expect(byName.get_frequency.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_frequency.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_frequency", () => {
  it("returns the full frequency state in Hz", async () => {
    const res = await callTool(client, "get_frequency", {});
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({
      center_hz: 1.805e9,
      span_hz: 3.59e9,
      start_hz: 1e7,
      stop_hz: 3.6e9,
      center_step_hz: 3.59e8,
      center_step_auto: true,
      offset_hz: 0,
    });
  });

  it("surfaces connection errors", async () => {
    fake.query.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "get_frequency", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
});

describe("set_frequency", () => {
  it("sets center and span, then returns the re-read state", async () => {
    const res = await callTool(client, "set_frequency", { center_hz: 1e9, span_hz: 1e8 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":FREQuency:SPAN 100000000 Hz", ":FREQuency:CENTer 1000000000 Hz"]);
    const out = json(res);
    expect(out.state.center_hz).toBe(1e9);
    expect(out.state.span_hz).toBe(1e8);
    expect(out.state.start_hz).toBe(9.5e8);
    expect(out.warnings).toEqual([]);
  });

  it("sets only the center when span is omitted", async () => {
    await callTool(client, "set_frequency", { center_hz: 2e9 });
    expect(fake.calls).toEqual([":FREQuency:CENTer 2000000000 Hz"]);
  });

  it("sets start and stop (start first when moving down/overlapping)", async () => {
    fake.state.start = 1e9; fake.state.stop = 2e9;
    await callTool(client, "set_frequency", { start_hz: 5e8, stop_hz: 1.5e9 });
    expect(fake.calls).toEqual([":FREQuency:STARt 500000000 Hz", ":FREQuency:STOP 1500000000 Hz"]);
  });

  it("sets stop first when the new range lies entirely above the current stop", async () => {
    fake.state.start = 1e9; fake.state.stop = 2e9;
    await callTool(client, "set_frequency", { start_hz: 3e9, stop_hz: 3.5e9 });
    expect(fake.calls).toEqual([":FREQuency:STOP 3500000000 Hz", ":FREQuency:STARt 3000000000 Hz"]);
  });

  it("allows setting only start or only stop", async () => {
    await callTool(client, "set_frequency", { start_hz: 5e8 });
    expect(fake.calls).toEqual([":FREQuency:STARt 500000000 Hz"]);
    fake.calls.length = 0;
    await callTool(client, "set_frequency", { stop_hz: 2e9 });
    expect(fake.calls).toEqual([":FREQuency:STOP 2000000000 Hz"]);
  });

  it("full_span and zero_span", async () => {
    await callTool(client, "set_frequency", { full_span: true });
    expect(fake.calls).toEqual([":FREQuency:SPAN:FULL"]);
    fake.calls.length = 0;
    await callTool(client, "set_frequency", { zero_span: true });
    expect(fake.calls).toEqual([":FREQuency:SPAN:ZERO"]);
  });

  it("center step, auto step and offset", async () => {
    await callTool(client, "set_frequency", { center_step_hz: 1e6, offset_hz: 0 });
    expect(fake.calls).toEqual([":FREQuency:CENTer:STEP 1000000 Hz", ":FREQuency:OFFSet 0 Hz"]);
    fake.calls.length = 0;
    await callTool(client, "set_frequency", { center_step_auto: true });
    expect(fake.calls).toEqual([":FREQuency:CENTer:STEP:AUTO ON"]);
    expect(fake.state.stepAuto).toBe(true);
  });

  it("allows combining a range with step/offset settings", async () => {
    const res = await callTool(client, "set_frequency", { center_hz: 1e9, span_hz: 1e6, offset_hz: 10 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toContain(":FREQuency:OFFSet 10 Hz");
  });

  it("warns when the instrument adjusts a requested value", async () => {
    fake.state.clampStopTo = 3.6e9;
    const res = await callTool(client, "set_frequency", { start_hz: 1e9, stop_hz: 9e9 });
    const out = json(res);
    expect(out.warnings.join(" ")).toMatch(/stop_hz/);
    expect(out.warnings.join(" ")).toMatch(/adjusted/i);
  });

  it("reports instrument errors from the error queue", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await original(cmd);
      if (cmd.startsWith(":FREQuency:CENTer ")) fake.state.errors.push('-131,"Invalid suffix"');
    });
    try {
      const res = await callTool(client, "set_frequency", { center_hz: 1e9 });
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("Invalid suffix");
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });

  it("clears stale errors with *CLS first, so old errors are not blamed on this call", async () => {
    fake.state.errors.push('-113,"Undefined header"', '-113,"Undefined header"');
    const res = await callTool(client, "set_frequency", { center_hz: 1e9 });
    expect(res.isError).toBeFalsy();
    expect(fake.sendCommand.mock.calls[0][0]).toBe("*CLS");
  });

  describe("validation (nothing is sent)", () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["no parameters", {}],
      ["negative span", { span_hz: -1 }],
      ["zero span via span_hz", { span_hz: 0 }],
      ["zero center", { center_hz: 0 }],
      ["negative start", { start_hz: -5 }],
      ["start >= stop", { start_hz: 2e9, stop_hz: 1e9 }],
      ["zero step", { center_step_hz: 0 }],
      ["non-finite value", { center_hz: Infinity }],
      ["center/span mixed with start/stop", { center_hz: 1e9, start_hz: 5e8 }],
      ["span mixed with stop", { span_hz: 1e6, stop_hz: 5e8 }],
      ["full_span with center", { full_span: true, center_hz: 1e9 }],
      ["zero_span with span", { zero_span: true, span_hz: 1e6 }],
      ["full_span with zero_span", { full_span: true, zero_span: true }],
      ["center_step_hz with center_step_auto=true", { center_step_hz: 1e6, center_step_auto: true }],
    ];
    it.each(invalid)("rejects %s", async (_name, args) => {
      const res = await callTool(client, "set_frequency", args);
      expect(res.isError).toBe(true);
      expect(fake.sendCommand).not.toHaveBeenCalled();
    });
  });
});
