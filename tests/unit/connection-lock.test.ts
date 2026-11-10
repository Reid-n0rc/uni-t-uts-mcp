import { describe, it, expect, afterEach } from "vitest";
import { UtsConnection } from "../../src/connection.js";
import { InstrumentBusyError } from "../../src/sessionLock.js";
import { startFakeScpi, idnHandler, type FakeScpi } from "../fakeScpiServer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: FakeScpi | undefined;
let conn: UtsConnection;

async function setup(extra?: Parameters<typeof idnHandler>[0]) {
  server = await startFakeScpi(idnHandler(extra));
  conn = new UtsConnection();
  await conn.connect("127.0.0.1", server.port, { recoveryMs: 100 });
}
afterEach(async () => {
  conn?.disconnect();
  delete process.env.UTS_BUSY_TIMEOUT_S;
  await server?.close();
  server = undefined;
});

describe("UtsConnection.runExclusive", () => {
  it("keeps a whole sequence contiguous on the wire while other sessions wait", async () => {
    await setup((line, socket) => { if (line.endsWith("?")) socket.write("1\r\n"); });
    const seq = (tag: string) =>
      conn.runExclusive(async () => {
        await conn.sendCommand(`:A ${tag}`);
        await conn.query(`:Q1 ${tag}?`);
        await conn.sendCommand(`:B ${tag}`);
        await conn.query(`:Q2 ${tag}?`);
      });
    await Promise.all(["x", "y", "z"].map(seq));
    const lines = server!.received.filter((l) => l !== "*OPC?" && l !== "*IDN?");
    expect(lines).toEqual(
      ["x", "y", "z"].flatMap((t) => [`:A ${t}`, `:Q1 ${t}?`, `:B ${t}`, `:Q2 ${t}?`])
    );
  });

  it("lets helpers called inside a session use the connection without deadlocking", async () => {
    await setup((line, socket) => { if (line.endsWith("?")) socket.write("1\r\n"); });
    const helper = () => conn.runExclusive(async () => conn.query(":H?"));
    const out = await conn.runExclusive(async () => `${await helper()}${await helper()}`);
    expect(out).toBe("11");
  });

  it("releases after an error thrown inside the session and after a query timeout", async () => {
    await setup((line, socket) => { if (line === ":OK?") socket.write("1\r\n"); });
    await expect(conn.runExclusive(async () => { throw new Error("tool failed"); })).rejects.toThrow("tool failed");
    await expect(conn.runExclusive(() => conn.query(":SILENT?", 80))).rejects.toThrow(/timeout/i);
    expect(await conn.runExclusive(() => conn.query(":OK?"))).toBe("1");
  });

  it("rejects waiters with a clear message when the connection is closed, and the holder fails too", async () => {
    await setup((line, socket) => { if (line === ":OK?") socket.write("1\r\n"); });
    const holder = conn.runExclusive(async () => { await sleep(50); return conn.query(":OK?"); }, { label: "single_sweep" });
    const waiter = conn.runExclusive(async () => "ran", { label: "get_frequency" });
    await sleep(10);
    conn.disconnect();
    await expect(waiter).rejects.toThrow(/Connection closed/);
    await expect(holder).rejects.toThrow(/not connected|closed|lost/i);
  });

  it("rejects waiters when the instrument drops the link", async () => {
    await setup();
    const holder = conn.runExclusive(async () => { await sleep(100); return "late"; });
    const waiter = conn.runExclusive(async () => "ran");
    await sleep(10);
    for (const s of server!.sockets) s.destroy();
    await expect(waiter).rejects.toThrow(/lost/i);
    await holder.catch(() => {});
    conn.disconnect();
  });

  it("gives an 'instrument busy' error after the configured wait (UTS_BUSY_TIMEOUT_S), then recovers", async () => {
    process.env.UTS_BUSY_TIMEOUT_S = "0.05";
    await setup();
    const long = conn.runExclusive(async () => { await sleep(200); return "long"; }, { label: "single_sweep" });
    const err = await conn.runExclusive(async () => "x", { label: "get_frequency" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstrumentBusyError);
    expect(err.message).toMatch(/instrument busy/i);
    expect(err.message).toMatch(/0\.05/);
    expect(await long).toBe("long");
    expect(await conn.runExclusive(async () => "free")).toBe("free");
  });

  it("falls back to a generous default for an invalid UTS_BUSY_TIMEOUT_S", async () => {
    process.env.UTS_BUSY_TIMEOUT_S = "banana";
    await setup();
    expect(conn.busyTimeoutMs).toBe(120_000);
    process.env.UTS_BUSY_TIMEOUT_S = "30";
    expect(conn.busyTimeoutMs).toBe(30_000);
  });
});
