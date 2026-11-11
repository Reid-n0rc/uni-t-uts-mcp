import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setFirstSetterPending } from "../../src/instrument.js";
import type * as net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { connection } from "../../src/connection.js";
import { callTool, getText } from "../helpers.js";
import { defaultReply } from "../toolContract.js";
import { startFakeScpi, IDN, type FakeScpi } from "../fakeScpiServer.js";

/**
 * Parallel tool calls (issue #66) against the REAL connection and a stateful fake instrument that
 * records the exact byte stream. The fake mimics the real analyzer's two relevant behaviours: its
 * error queue is global (`*CLS` clears it) and it ignores every line while a single sweep runs.
 */

const SWEEP_S = 0.12;
let server: FakeScpi;
let client: Client;
let cleanup: () => Promise<void>;
const state = new Map<string, number>();
let errors: string[] = [];
let deafUntil = 0;
/** Lines that arrived while the fake was ignoring input (these would be lost on the real instrument). */
let lost: string[] = [];

const UNITS: Record<string, number> = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9 };

function handler(line: string, socket: net.Socket): void {
  if (Date.now() < deafUntil) {
    // The sweep owner's own *OPC? polls are meant to go unanswered until the sweep ends.
    if (line !== "*OPC?") lost.push(line);
    return;
  }
  const reply = (text: string): void => { socket.write(text + "\r\n"); };
  if (line === "*IDN?") return reply(IDN);
  if (line === "*OPC?") return reply("1");
  if (line === "*CLS") { errors = []; return; }
  if (line === ":SYSTem:ERRor?") return reply(errors.shift() ?? '0,"No error"');
  if (line === ":INITiate:IMMediate") { deafUntil = Date.now() + SWEEP_S * 1000; return; }
  if (line.startsWith(":REJECT")) { errors.push('-131,"Invalid suffix"'); return; }
  if (line === ":SENSe:SWEep:TIME?") return reply(SWEEP_S.toExponential(6));
  if (line.endsWith("?")) {
    const stored = state.get(line.slice(0, -1));
    return reply(stored !== undefined ? stored.toExponential(9) : defaultReply(line));
  }
  const m = /^(\S+)\s+(-?[\d.eE+-]+)\s*([A-Za-z]*)$/.exec(line);
  if (m) state.set(m[1], Number(m[2]) * (UNITS[m[3].toUpperCase()] ?? 1));
}

beforeAll(async () => {
  server = await startFakeScpi(handler);
  const mcp = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "concurrency", version: "0.0.0" });
  await Promise.all([client.connect(ct), mcp.connect(st)]);
  cleanup = async () => { await client.close(); await mcp.close(); };
});
afterAll(async () => {
  connection.disconnect();
  await cleanup();
  await server.close();
});
beforeEach(async () => {
  state.clear(); errors = []; deafUntil = 0; lost = [];
  // The first setter of a process also clears the stale error queue first (an extra wire line); the baselines are for later setters.
  setFirstSetterPending(false);
  const res = await callTool(client, "connect", { host: "127.0.0.1", port: server.port });
  expect(res.isError, getText(res)).toBeFalsy();
});
afterEach(() => {
  delete process.env.UTS_BUSY_TIMEOUT_S;
  connection.disconnect();
});

const json = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(r));

/** Lines the instrument received since `from`, with runs of *OPC? polls collapsed (poll counts vary with timing). */
function wire(from: number): string[] {
  const out: string[] = [];
  for (const line of server.received.slice(from)) {
    if (line === "*OPC?" && out[out.length - 1] === "*OPC?") continue;
    out.push(line);
  }
  return out;
}

const CALLS: Array<[string, string, Record<string, unknown>]> = [
  ["set_frequency", "set_frequency", { center_hz: 100e6, span_hz: 10e6 }],
  ["set_amplitude", "set_amplitude", { reference_level: -20 }],
  ["get_frequency", "get_frequency", {}],
  ["get_amplitude", "get_amplitude", {}],
  ["scpi_query", "scpi_query", { command: ":SWEep:POINts?" }],
  ["scpi_command", "scpi_command", { command: ":FREQuency:CENTer:STEP 1 MHz" }],
  ["single_sweep", "single_sweep", {}],
  ["get_bandwidth", "get_bandwidth", {}],
  ["get_sweep", "get_sweep", {}],
];

/** Can `stream` be split into one segment per remaining baseline (in any order)? */
function splits(stream: string[], baselines: Map<string, string[]>): boolean {
  if (stream.length === 0) return baselines.size === 0;
  for (const [name, seq] of baselines) {
    if (seq.every((l, i) => stream[i] === l)) {
      const rest = new Map(baselines);
      rest.delete(name);
      if (splits(stream.slice(seq.length), rest)) return true;
    }
  }
  return false;
}

describe("parallel tool calls against the real connection", () => {
  it("keeps every tool's command sequence contiguous and every result correct", async () => {
    // Baselines: each call alone.
    const baselines = new Map<string, string[]>();
    for (const [label, tool, args] of CALLS) {
      const from = server.received.length;
      const res = await callTool(client, tool, args);
      expect(res.isError, `${label}: ${getText(res)}`).toBeFalsy();
      baselines.set(label, wire(from));
    }
    state.clear();
    lost = [];

    const from = server.received.length;
    const results = await Promise.all(CALLS.map(([, tool, args]) => callTool(client, tool, args)));
    CALLS.forEach(([label], i) => expect(results[i].isError, `${label}: ${getText(results[i])}`).toBeFalsy());

    expect(lost, "lines sent while the instrument was sweeping would be dropped").toEqual([]);
    expect(splits(wire(from), baselines), `wire stream was interleaved:\n${wire(from).join("\n")}`).toBe(true);

    // Results: set_frequency read back exactly what it set; no warnings.
    expect(json(results[0]).warnings).toEqual([]);
    expect(json(results[0]).state.center_hz).toBe(100e6);
    expect(json(results[1]).warnings).toEqual([]);
    // The getters ran after the setters (FIFO), so they report the new values.
    expect(json(results[2]).center_hz).toBe(100e6);
    expect(json(results[3]).reference_level).toBe(-20);
    expect(getText(results[4])).toBe("1000");
    expect(json(results[6]).completed).toBe(true);
    expect(errors).toEqual([]);
  });

  it("many copies of the same tools in parallel give identical, uncorrupted results", async () => {
    const from = server.received.length;
    const calls = Array.from({ length: 6 }, (_, i) => [
      callTool(client, "set_frequency", { center_hz: (i + 1) * 100e6 }),
      callTool(client, "get_frequency", {}),
    ]).flat();
    const results = await Promise.all(calls);
    for (const r of results) expect(r.isError, getText(r)).toBeFalsy();
    for (let i = 0; i < 6; i++) {
      expect(json(results[2 * i]).warnings, `set #${i}`).toEqual([]);
      // Each getter sees a complete state written by exactly one setter: center follows the preceding setter.
      expect(json(results[2 * i + 1]).center_hz).toBe((i + 1) * 100e6);
    }
    // The stream is 6 x (set sequence, get sequence): no interleaving anywhere.
    const lines = wire(from);
    const centers = lines.filter((l) => /^:FREQuency:CENTer /.test(l));
    expect(centers).toHaveLength(6);
    const clsAt = lines.map((l, i) => (l === "*CLS" ? i : -1)).filter((i) => i >= 0);
    expect(clsAt).toHaveLength(6);
    for (const i of clsAt) {
      const next = lines.slice(i + 1).find((l) => l !== "*OPC?");
      expect(next).toMatch(/^:FREQuency:(SPAN|CENTer) /);
    }
  });

  it("attributes an instrument error to the failing call only", async () => {
    const results = await Promise.all([
      callTool(client, "set_frequency", { center_hz: 50e6 }),
      callTool(client, "scpi_command", { command: ":REJECT 1" }),
      callTool(client, "set_amplitude", { reference_level: -30 }),
      callTool(client, "scpi_command", { command: ":FREQuency:CENTer:STEP 2 MHz" }),
      callTool(client, "get_frequency", {}),
    ]);
    expect(results[1].isError).toBe(true);
    expect(getText(results[1])).toContain("-131");
    for (const i of [0, 2, 3, 4]) expect(results[i].isError, `call ${i}: ${getText(results[i])}`).toBeFalsy();
    expect(errors).toEqual([]);
  });

  it("returns an 'instrument busy' error to a call that waits longer than the limit, while the sweep completes", async () => {
    process.env.UTS_BUSY_TIMEOUT_S = "0.03";
    const sweep = callTool(client, "single_sweep", {});
    const waiting = await callTool(client, "get_frequency", {});
    expect(waiting.isError).toBe(true);
    expect(getText(waiting)).toMatch(/instrument busy/i);
    expect(getText(waiting)).toMatch(/single_sweep/);
    expect(getText(waiting)).toMatch(/UTS_BUSY_TIMEOUT_S/);
    const done = await sweep;
    expect(done.isError, getText(done)).toBeFalsy();
    expect(lost).toEqual([]);
    // Lock was released: the next call works.
    expect((await callTool(client, "get_frequency", {})).isError).toBeFalsy();
  });

  it("disconnect is not blocked by a running call and rejects the waiters", async () => {
    const sweep = callTool(client, "single_sweep", {});
    const waiter = callTool(client, "get_frequency", {});
    await new Promise((r) => setTimeout(r, 20));
    const dis = await callTool(client, "disconnect", {});
    expect(dis.isError).toBeFalsy();
    const w = await waiter;
    expect(w.isError).toBe(true);
    expect(getText(w)).toMatch(/closed|not connected|lost/i);
    const s = await sweep;
    expect(s.isError).toBe(true);
    // Everything is released: reconnect (once the fake's sweep is over) and carry on.
    await new Promise((r) => setTimeout(r, SWEEP_S * 1000 + 50));
    const again = await callTool(client, "connect", { host: "127.0.0.1", port: server.port });
    expect(again.isError, getText(again)).toBeFalsy();
    expect((await callTool(client, "get_frequency", {})).isError).toBeFalsy();
  });
});
