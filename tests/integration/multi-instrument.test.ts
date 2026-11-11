import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { instruments } from "../../src/registry.js";
import { setFirstSetterPending } from "../../src/instrument.js";
import { callTool, getText } from "../helpers.js";
import { startFakeScpi, type FakeScpi } from "../fakeScpiServer.js";

/**
 * Several instruments at once (issue #166) against the REAL registry and connections and two fake instruments:
 * calls to different instruments proceed independently, calls to the same instrument stay serialized and
 * contiguous, a failure on one does not touch the other, and disconnecting one leaves the other alive.
 */

interface Opts {
  /** Delay of the reply to `:SLOW?` (ms). */
  slowMs?: number;
  /** The error queue always holds -113 (every scpi_command on this instrument fails). */
  failErrors?: boolean;
  /** A stale `-113` (left by an earlier process) sits in the queue and survives the first `*CLS`, like a late-posted one. */
  stale?: boolean;
}
const start = (model: string, o: Opts = {}): Promise<FakeScpi> => {
  let stale = o.stale === true;
  return startFakeScpi((line, socket) => {
    const reply = (text: string, delay = 0) => {
      if (delay > 0) setTimeout(() => socket.writable && socket.write(text + "\r\n"), delay);
      else socket.write(text + "\r\n");
    };
    if (line === "*IDN?") return reply(`UNI-TREND,${model},<serial>,V0.0.0`);
    if (line === "*OPC?") return reply("1");
    if (line === "*CLS") return;
    if (line === ":SYSTem:ERRor?") {
      if (stale) { stale = false; return reply('-113,"Undefined header"'); }
      return reply(o.failErrors ? '-113,"Undefined header"' : '0,"No error"');
    }
    if (line === ":SLOW?") return reply(model, o.slowMs ?? 0);
    if (line === ":SILENT?") return;
    if (line.endsWith("?")) return reply(`${model}${line}`);
  });
};

let client: Client;
let servers: FakeScpi[] = [];
let closeAll: () => Promise<void>;

async function setup(a: Opts = {}, b: Opts = {}): Promise<void> {
  servers = [await start("UTSA", a), await start("UTSB", b)];
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  closeAll = async () => {
    await client.close();
    await server.close();
  };
  for (const [name, s] of [["a", servers[0]], ["b", servers[1]]] as const) {
    const r = await callTool(client, "connect", { name, host: "127.0.0.1", port: s.port, transport: "raw" });
    expect(r.isError, getText(r)).toBeFalsy();
  }
}
afterEach(async () => {
  delete process.env.UTS_BUSY_TIMEOUT_S;
  await instruments.shutdown();
  for (const n of instruments.names()) instruments.remove(n);
  await closeAll?.();
  for (const s of servers) await s.close();
  servers = [];
});
beforeEach(() => {
  delete process.env.UTS_BUSY_TIMEOUT_S;
  setFirstSetterPending(false);
});

const query = (instrument: string, command = ":SLOW?", extra: Record<string, unknown> = {}) =>
  callTool(client, "scpi_query", { command, instrument, ...extra });
const timed = async <T>(fn: () => Promise<T>) => {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
};

describe("parallel calls to different instruments", () => {
  it("proceed independently: two slow queries overlap instead of queueing", async () => {
    await setup({ slowMs: 250 }, { slowMs: 250 });
    const { value, ms } = await timed(() => Promise.all([query("a"), query("b")]));
    expect(value.map(getText)).toEqual(["UTSA", "UTSB"]);
    expect(ms).toBeLessThan(430); // serialized it would be >= 500
  });

  it("a fast instrument is not held up by a slow one", async () => {
    await setup({ slowMs: 300 }, { slowMs: 0 });
    const done: string[] = [];
    const slow = query("a").then((r) => { done.push("a"); return r; });
    await new Promise((r) => setTimeout(r, 30));
    const fast = await timed(() => query("b").then((r) => { done.push("b"); return r; }));
    await slow;
    expect(done).toEqual(["b", "a"]);
    expect(fast.ms).toBeLessThan(150);
  });

  it("calls to the same instrument are still serialized", async () => {
    await setup({ slowMs: 200 });
    const { ms } = await timed(() => Promise.all([query("a"), query("a")]));
    expect(ms).toBeGreaterThanOrEqual(390);
  });

  it("sequences on each instrument stay contiguous on the wire", async () => {
    await setup();
    const call = (instrument: string, mhz: number) => callTool(client, "scpi_command", { command: `:FREQuency:CENTer ${mhz} MHz`, instrument });
    const results = await Promise.all([call("a", 1), call("b", 4), call("a", 2), call("b", 5), call("a", 3), call("b", 6)]);
    results.forEach((r) => expect(r.isError, getText(r)).toBeFalsy());
    for (const [server, base] of [[servers[0], 1], [servers[1], 4]] as const) {
      const lines = server.received.filter((l) => l !== "*IDN?" && l !== "*OPC?");
      expect(lines).toHaveLength(9);
      const seen = new Set<number>();
      for (let i = 0; i < 9; i += 3) {
        const m = /^:FREQuency:CENTer (\d+) MHz$/.exec(lines[i + 1]);
        expect(lines[i]).toBe("*CLS");
        expect(m, `group ${i / 3}: ${lines.slice(i, i + 3)}`).not.toBeNull();
        expect(lines[i + 2]).toBe(":SYSTem:ERRor?");
        seen.add(Number(m![1]));
      }
      expect([...seen].sort()).toEqual([base, base + 1, base + 2]);
    }
  });
});

describe("failures stay on their own instrument", () => {
  it("the first setter on EACH instrument clears that instrument's stale error (not only the first of the process)", async () => {
    setFirstSetterPending(true);
    await setup({ stale: true }, { stale: true });
    for (const [instrument, mhz] of [["a", 1], ["b", 2]] as const) {
      const r = await callTool(client, "scpi_command", { command: `:FREQuency:CENTer ${mhz} MHz`, instrument });
      expect(r.isError, `${instrument}: ${getText(r)}`).toBeFalsy();
    }
  });

  it("an instrument error on one does not fail the other, in the same batch", async () => {
    await setup({}, { failErrors: true });
    const [ra, rb] = await Promise.all([
      callTool(client, "scpi_command", { command: ":FREQuency:CENTer 1 MHz", instrument: "a" }),
      callTool(client, "scpi_command", { command: ":FREQuency:CENTer 2 MHz", instrument: "b" }),
    ]);
    expect(ra.isError, getText(ra)).toBeFalsy();
    expect(rb.isError).toBe(true);
    expect(getText(rb)).toMatch(/-113/);
    expect((await query("a", "*IDN?")).isError).toBeFalsy();
  });

  it("a timeout on one (and its hold-off) does not delay or fail the other", async () => {
    await setup();
    const timedOut = query("b", ":SILENT?", { timeout_ms: 100 });
    const other = await timed(() => query("a", "*IDN?"));
    expect(getText(await timedOut)).toMatch(/timeout/i);
    expect(other.value.isError).toBeFalsy();
    expect(other.ms).toBeLessThan(500); // b is held off for ~2.4 s after the timeout; a must not be
    const again = await timed(() => query("a", "*IDN?"));
    expect(again.value.isError).toBeFalsy();
    expect(again.ms).toBeLessThan(500);
  });

  it("a busy wait applies per instrument: a queued call on a held instrument gives up, the other instrument is free", async () => {
    process.env.UTS_BUSY_TIMEOUT_S = "0.2";
    await setup({}, { slowMs: 700 });
    const holder = query("b");
    await new Promise((r) => setTimeout(r, 30));
    const [queued, free] = await Promise.all([query("b", "*IDN?"), query("a", "*IDN?")]);
    expect(queued.isError).toBe(true);
    expect(getText(queued)).toMatch(/Instrument busy/);
    expect(free.isError, getText(free)).toBeFalsy();
    expect((await holder).isError).toBeFalsy();
  });
});

describe("disconnecting or losing one instrument", () => {
  it("disconnect of one leaves the other alive and usable", async () => {
    await setup();
    expect((await callTool(client, "disconnect", { name: "b" })).isError).toBeFalsy();
    expect(getText(await query("a", "*IDN?"))).toContain("UTSA");
    const gone = await query("b", "*IDN?");
    expect(gone.isError).toBe(true);
    expect(getText(gone)).toMatch(/not connected/i);
  });

  it("disconnecting one fails only its own queued calls", async () => {
    await setup({ slowMs: 200 }, { slowMs: 400 });
    const inFlightB = query("b");
    const queuedB = query("b", "*IDN?");
    const onA = query("a");
    await new Promise((r) => setTimeout(r, 40));
    await callTool(client, "disconnect", { name: "b" });
    const [rb1, rb2, ra] = await Promise.all([inFlightB, queuedB, onA]);
    expect(rb1.isError).toBe(true);
    expect(rb2.isError).toBe(true);
    expect(ra.isError, getText(ra)).toBeFalsy();
    expect(getText(ra)).toBe("UTSA");
  });

  it("losing the link of one (the instrument drops it) does not affect the other", async () => {
    await setup();
    for (const s of servers[1].sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const lost = await query("b", "*IDN?");
    expect(lost.isError).toBe(true);
    expect(getText(lost)).toMatch(/lost|not connected/i);
    expect(getText(await query("a", "*IDN?"))).toContain("UTSA");
    const list = JSON.parse(getText(await callTool(client, "list_instruments", {}))).instruments;
    expect(list.map((i: { name: string; connected: boolean }) => [i.name, i.connected])).toEqual([["a", true], ["b", false]]);
  });
});
