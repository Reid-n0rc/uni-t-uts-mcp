import { describe, it, expect, afterEach } from "vitest";
import { connection, UtsConnection } from "../../src/connection.js";
import { instruments } from "../../src/registry.js";
import { startFakeScpi, idnHandler, type FakeScpi } from "../fakeScpiServer.js";

const servers: FakeScpi[] = [];
afterEach(async () => {
  await instruments.shutdown();
  for (const s of servers.splice(0)) await s.close();
});

describe("connection singleton and the registry", () => {
  it("resolves to the default instrument and is a real UtsConnection underneath", () => {
    expect(instruments.get("default")).toBeUndefined();
    expect(connection.isConnected()).toBe(false); // creates the default on first use
    expect(instruments.get("default")).toBeInstanceOf(UtsConnection);
  });

  it("each named connection has its own link, queue and lock", async () => {
    const a = await startFakeScpi(idnHandler((l, s) => { if (l === ":WHO?") s.write("A\r\n"); }));
    const b = await startFakeScpi(idnHandler((l, s) => { if (l === ":WHO?") s.write("B\r\n"); }));
    servers.push(a, b);
    const ca = instruments.declare("a");
    const cb = instruments.declare("b");
    await ca.connect("127.0.0.1", a.port, { recoveryMs: 50 });
    await cb.connect("127.0.0.1", b.port, { recoveryMs: 50 });
    expect(ca).not.toBe(cb);
    const [ra, rb] = await Promise.all([
      instruments.runWith(ca, () => connection.query(":WHO?")),
      instruments.runWith(cb, () => connection.query(":WHO?")),
    ]);
    expect([ra, rb]).toEqual(["A", "B"]);
    cb.disconnect();
    expect(ca.isConnected()).toBe(true);
    expect(cb.isConnected()).toBe(false);
  });

  it("a held session on one connection does not block the other", async () => {
    const ca = instruments.declare("a");
    const cb = instruments.declare("b");
    let release!: () => void;
    const held = ca.runExclusive(() => new Promise<void>((r) => { release = r; }));
    expect(await cb.runExclusive(() => "free")).toBe("free");
    expect(ca.runExclusive(() => "queued").then(() => "done")).toBeInstanceOf(Promise);
    release();
    await held;
  });
});
