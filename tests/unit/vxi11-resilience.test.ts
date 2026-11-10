import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import { probeVxi11, vxi11ProbeBudgetFromEnv, DEFAULT_VXI11_PROBE_BUDGET_MS } from "../../src/transports/select.js";
import { Vxi11Transport } from "../../src/transports/vxi11.js";
import { UtsConnection } from "../../src/connection.js";
import { installShutdownHandlers } from "../../src/shutdown.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";

/**
 * Issue #127: a cold TCP connect to the portmapper over a routed path sometimes timed out (auto then fell back to
 * raw), and the first write after a previous VXI-11 process sometimes timed out and dropped the link.
 */

describe("UTS_VXI11_PROBE_TIMEOUT_S", () => {
  it("defaults to 15 s, accepts seconds from 1 to 120 and names the variable in errors", () => {
    expect(DEFAULT_VXI11_PROBE_BUDGET_MS).toBe(15000);
    expect(vxi11ProbeBudgetFromEnv(undefined)).toBeUndefined();
    expect(vxi11ProbeBudgetFromEnv("")).toBeUndefined();
    expect(vxi11ProbeBudgetFromEnv("30")).toBe(30000);
    expect(vxi11ProbeBudgetFromEnv("1.5")).toBe(1500);
    for (const bad of ["0", "121", "abc", "-1", "NaN", "1e3", "5 s"]) {
      expect(() => vxi11ProbeBudgetFromEnv(bad)).toThrow(/UTS_VXI11_PROBE_TIMEOUT_S/);
    }
  });
});

/** A TCP front for the fake instrument whose first connections misbehave (a slow or flaky routed path). */
async function flakyFront(target: number, firstMode: "silent" | "drop", firstCount: number) {
  let seen = 0;
  const held: net.Socket[] = [];
  const server = net.createServer((sock) => {
    seen++;
    if (seen <= firstCount) {
      if (firstMode === "drop") sock.destroy();
      else held.push(sock);
      return;
    }
    const up = net.connect(target, "127.0.0.1");
    sock.pipe(up);
    up.pipe(sock);
    sock.on("error", () => up.destroy());
    up.on("error", () => sock.destroy());
    sock.on("close", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    get connections() {
      return seen;
    },
    close: async () => {
      for (const s of held) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("probeVxi11 retries", () => {
  let fake: FakeVxi11Instrument | undefined;
  let front: Awaited<ReturnType<typeof flakyFront>> | undefined;
  afterEach(async () => {
    await front?.close();
    await fake?.close();
    fake = undefined;
    front = undefined;
  });

  it("succeeds when the first portmapper connection is closed and the next one works", async () => {
    fake = await startFakeVxi11Instrument();
    front = await flakyFront(fake.port, "drop", 1);
    const res = await probeVxi11("127.0.0.1", { portmapperPort: front.port, timeoutMs: 500, backoffMs: 20 });
    expect(res.available).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it("succeeds when the first connection hangs silently past the per-attempt timeout", async () => {
    fake = await startFakeVxi11Instrument();
    front = await flakyFront(fake.port, "silent", 1);
    const t0 = Date.now();
    const res = await probeVxi11("127.0.0.1", { portmapperPort: front.port, timeoutMs: 300, backoffMs: 20 });
    expect(res.available).toBe(true);
    expect(res.attempts).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it("derives the per-attempt timeout from a total budget and stays within it", async () => {
    fake = await startFakeVxi11Instrument();
    front = await flakyFront(fake.port, "silent", 99);
    const t0 = Date.now();
    const res = await probeVxi11("127.0.0.1", { portmapperPort: front.port, budgetMs: 1200, backoffMs: 50 });
    expect(res.available).toBe(false);
    expect(res.attempts).toBe(3);
    expect(Date.now() - t0).toBeLessThan(1200 + 400);
    expect(res.reason).toMatch(new RegExp(`port ${front.port}`));
    expect(res.reason).toMatch(/3 attempts/);
    expect(res.reason).toMatch(/UTS_VXI11_PROBE_TIMEOUT_S/);
  });

  it("does not retry when the core program is simply not registered", async () => {
    const { startFakeRpcServer } = await import("../fakeRpcServer.js");
    const rpc = await startFakeRpcServer();
    rpc.registerPortmapper(new Map());
    const res = await probeVxi11("127.0.0.1", { portmapperPort: rpc.port, timeoutMs: 500, backoffMs: 20 });
    await rpc.close();
    expect(res.available).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.reason).toMatch(/not registered/);
  });
});

describe("Vxi11Transport open: portmapper retries and stale links", () => {
  let fake: FakeVxi11Instrument | undefined;
  let front: Awaited<ReturnType<typeof flakyFront>> | undefined;
  let transport: Vxi11Transport | undefined;
  afterEach(async () => {
    transport?.close();
    await transport?.drain();
    await front?.close();
    await fake?.close();
    fake = front = undefined;
    transport = undefined;
  });
  const openOpts = { host: "127.0.0.1", port: 5025, connectTimeoutMs: 400 };

  it("explicit vxi11 retries a slow portmapper connect instead of failing at the first timeout", async () => {
    fake = await startFakeVxi11Instrument();
    front = await flakyFront(fake.port, "silent", 1);
    transport = new Vxi11Transport({ portmapperPort: front.port, connectBackoffMs: 20 });
    await transport.open(openOpts);
    expect(transport.isOpen()).toBe(true);
    expect(front.connections).toBeGreaterThanOrEqual(2);
  });

  it("names port 111 and the setting when the portmapper never answers", async () => {
    fake = await startFakeVxi11Instrument();
    front = await flakyFront(fake.port, "silent", 99);
    transport = new Vxi11Transport({ portmapperPort: front.port, connectBackoffMs: 20, connectBudgetMs: 900 });
    const t0 = Date.now();
    await expect(transport.open(openOpts)).rejects.toThrow(
      new RegExp(`^Connection failed:.*portmapper.*port ${front.port}.*3 attempts.*UTS_VXI11_PROBE_TIMEOUT_S`, "s")
    );
    expect(Date.now() - t0).toBeLessThan(900 + 500);
  });

  it("retries create_link after a transient refusal (out of resources)", async () => {
    fake = await startFakeVxi11Instrument();
    fake.injectError(10, 9, 1);
    transport = new Vxi11Transport({ portmapperPort: fake.port, connectBackoffMs: 20 });
    await transport.open(openOpts);
    expect(fake.createLinkDevices).toHaveLength(2);
    expect(transport.isOpen()).toBe(true);
  });

  it("does not retry a wrong device name", async () => {
    fake = await startFakeVxi11Instrument({ device: "other" });
    transport = new Vxi11Transport({ portmapperPort: fake.port, connectBackoffMs: 20 });
    await expect(transport.open(openOpts)).rejects.toThrow(/DEVICE_NOT_ACCESSIBLE/);
    expect(fake.createLinkDevices).toHaveLength(1);
  });

  it("replaces a stale link that stops answering: destroys it, creates a new one, loses nothing", async () => {
    fake = await startFakeVxi11Instrument({ staleFirstLinks: 1 });
    transport = new Vxi11Transport({ portmapperPort: fake.port, connectBackoffMs: 20, linkCheckTimeoutMs: 150 });
    await transport.open(openOpts);
    expect(fake.createLinkDevices).toHaveLength(2);
    // the health check is a status poll only: no command was sent on the stale link
    expect(fake.writes).toHaveLength(0);
    await transport.write("*IDN?");
    expect(await transport.readLine(1000)).toMatch(/UTS3036B/);
    expect(fake.writes).toHaveLength(1);
    transport.close();
    await transport.drain();
    expect(fake.links.size).toBe(0);
  });

  it("reports a clear error when every link is stale (bounded)", async () => {
    fake = await startFakeVxi11Instrument({ staleFirstLinks: 99 });
    transport = new Vxi11Transport({ portmapperPort: fake.port, connectBackoffMs: 20, linkCheckTimeoutMs: 100, connectBudgetMs: 1500 });
    const t0 = Date.now();
    await expect(transport.open(openOpts)).rejects.toThrow(/^Connection failed:.*did not answer.*3 attempts/s);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(fake.writes).toHaveLength(0);
  });

  it("never resends a write that timed out: the loss is reported and the command stays unsent", async () => {
    fake = await startFakeVxi11Instrument();
    transport = new Vxi11Transport({ portmapperPort: fake.port, writeTimeoutMs: 150, rpcMarginMs: 50 });
    await transport.open(openOpts);
    let lost = "";
    transport.onLost((r) => (lost = r));
    for (const id of fake.links) fake.staleLinks.add(id);
    await expect(transport.write(":FREQuency:CENTer 1e9")).rejects.toThrow(/may or may not.*not resent|not resent/s);
    expect(lost).toMatch(/VXI-11/);
    expect(transport.isOpen()).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });
});

describe("clean teardown", () => {
  let fake: FakeVxi11Instrument | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("shutdown() sends destroy_link and waits for it before resolving", async () => {
    fake = await startFakeVxi11Instrument();
    const conn = new UtsConnection(() => new Vxi11Transport({ portmapperPort: fake!.port }));
    await conn.connect("127.0.0.1", 5025, { connectTimeoutMs: 1000 });
    expect(fake.links.size).toBe(1);
    await conn.shutdown();
    expect(fake.destroyedLinks).toBe(1);
    expect(fake.links.size).toBe(0);
    expect(conn.isConnected()).toBe(false);
    await conn.shutdown(); // idempotent
  });

  it("shutdown() on a connection that never connected resolves", async () => {
    await new UtsConnection().shutdown();
  });

  it("installShutdownHandlers closes the connection on SIGINT, SIGTERM and stdin end, once, then exits", async () => {
    for (const trigger of ["SIGINT", "SIGTERM", "stdin-end", "stdin-close"] as const) {
      const proc = new EventEmitter() as EventEmitter & { stdin: EventEmitter };
      proc.stdin = new EventEmitter();
      let shutdowns = 0;
      const exits: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      installShutdownHandlers(
        proc as never,
        { shutdown: async () => { shutdowns++; await gate; } },
        (code) => void exits.push(code),
        { graceMs: 2000 }
      );
      if (trigger === "SIGINT" || trigger === "SIGTERM") proc.emit(trigger);
      else proc.stdin.emit(trigger === "stdin-end" ? "end" : "close");
      proc.emit("SIGTERM"); // a second trigger must not shut down twice
      expect(shutdowns).toBe(1);
      expect(exits).toEqual([]); // exits only after the link was torn down
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(exits).toEqual([0]);
    }
  });

  it("installShutdownHandlers exits after the grace period if teardown hangs", async () => {
    const proc = new EventEmitter() as EventEmitter & { stdin: EventEmitter };
    proc.stdin = new EventEmitter();
    const exits: number[] = [];
    installShutdownHandlers(proc as never, { shutdown: () => new Promise<void>(() => {}) }, (c) => void exits.push(c), { graceMs: 50 });
    proc.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 150));
    expect(exits).toEqual([0]);
  });
});
