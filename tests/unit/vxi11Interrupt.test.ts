import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Vxi11Client, Vxi11ClosedError, Vxi11DeviceError, Vxi11Error, Vxi11SrqTimeoutError } from "../../src/vxi11/client.js";
import { IntrServer, localAddressFor } from "../../src/vxi11/interrupt.js";
import { RecordDecoder, encodeCall, encodeRecord } from "../../src/vxi11/rpc.js";
import { XdrReader, XdrWriter } from "../../src/vxi11/xdr.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";

const INTR = 395185;
let fake: FakeVxi11Instrument | undefined;
let client: Vxi11Client | undefined;
let server: IntrServer | undefined;
let sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets = [];
  await client?.close();
  client = undefined;
  await server?.close();
  server = undefined;
  await fake?.close();
  fake = undefined;
});
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function setup(): Promise<{ fake: FakeVxi11Instrument; client: Vxi11Client }> {
  fake = await startFakeVxi11Instrument();
  client = await Vxi11Client.connect("127.0.0.1", { portmapperPort: fake.port, rpcMarginMs: 100 });
  return { fake, client };
}

function connectTo(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
    s.on("error", () => {});
    sockets.push(s);
  });
}
const srqCall = (handle: Buffer, program = INTR, procedure = 30, xid = 1): Buffer =>
  encodeRecord(encodeCall(xid, program, 1, procedure, new XdrWriter().opaque(handle).toBuffer()));

describe("IntrServer", () => {
  it("delivers device_intr_srq handles from an allowed peer and answers the call", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"] });
    const got: Buffer[] = [];
    server.onSrq((h) => got.push(h));
    const s = await connectTo(server.port);
    const replies: Buffer[] = [];
    const dec = new RecordDecoder();
    s.on("data", (d) => replies.push(...dec.push(d)));
    s.write(srqCall(Buffer.from([1, 2, 3, 4]), INTR, 30, 77));
    await settle();
    expect(got.map((b) => [...b])).toEqual([[1, 2, 3, 4]]);
    expect(server.stats.accepted).toBe(1);
    expect(server.stats.srqCalls).toBe(1);
    const r = new XdrReader(replies[0]);
    expect([r.u32(), r.u32(), r.u32()]).toEqual([77, 1, 0]); // xid, REPLY, MSG_ACCEPTED
  });

  it("rejects connections from other peers without reading them", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["10.1.2.3"] });
    const got: Buffer[] = [];
    server.onSrq((h) => got.push(h));
    const s = await connectTo(server.port);
    s.write(srqCall(Buffer.from([9])));
    await settle();
    expect(got).toEqual([]);
    expect(server.stats.rejected).toBe(1);
    expect(server.stats.accepted).toBe(0);
    expect(s.destroyed).toBe(true);
  });

  it("accepts an IPv4-mapped IPv6 peer address of an allowed peer", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"] });
    expect(server.isAllowed("::ffff:127.0.0.1")).toBe(true);
    expect(server.isAllowed("::ffff:10.0.0.1")).toBe(false);
    expect(server.isAllowed(undefined)).toBe(false);
  });

  it("ignores other programs and procedures and answers them with an RPC error", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"] });
    const got: Buffer[] = [];
    server.onSrq((h) => got.push(h));
    const s = await connectTo(server.port);
    const replies: Buffer[] = [];
    const dec = new RecordDecoder();
    s.on("data", (d) => replies.push(...dec.push(d)));
    s.write(srqCall(Buffer.from([1]), 123456, 30, 1));
    s.write(srqCall(Buffer.from([1]), INTR, 31, 2));
    await settle();
    expect(got).toEqual([]);
    const stats = replies.map((r) => {
      const x = new XdrReader(r);
      x.u32();
      x.u32();
      x.u32(); // accepted
      x.u32();
      x.u32(); // verifier
      return x.u32();
    });
    expect(stats).toEqual([1, 3]); // PROG_UNAVAIL, PROC_UNAVAIL
  });

  it("drops a connection that sends an oversized or garbage record, and a handle longer than 40 bytes", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"] });
    const got: Buffer[] = [];
    server.onSrq((h) => got.push(h));
    const a = await connectTo(server.port);
    a.write(Buffer.from([0x80, 0x10, 0x00, 0x00])); // announces a 1 MiB record
    const b = await connectTo(server.port);
    b.write(srqCall(Buffer.alloc(41, 1)));
    await settle();
    expect(got).toEqual([]);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
  });

  it("caps the number of concurrent connections", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"], maxConnections: 2 });
    const socks = [await connectTo(server.port), await connectTo(server.port), await connectTo(server.port)];
    await settle();
    expect(socks.filter((s) => s.destroyed).length).toBe(1);
    expect(server.stats.rejected).toBe(1);
  });

  it("close() stops listening and drops connections", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"] });
    const port = server.port;
    const s = await connectTo(port);
    await server.close();
    await server.close(); // idempotent
    await settle();
    expect(s.destroyed).toBe(true);
    await expect(connectTo(port)).rejects.toThrow();
  });

  it("rejects an invalid bind address or port", async () => {
    await expect(IntrServer.listen({ bindAddress: "not-an-ip", allowedPeers: ["127.0.0.1"] })).rejects.toThrow();
    await expect(IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: [] })).rejects.toThrow(RangeError);
  });
});

describe("localAddressFor", () => {
  it("returns the local address the OS would use to reach a host", async () => {
    expect(await localAddressFor("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("Vxi11Client SRQ", () => {
  it("creates the interrupt channel, enables SRQ and receives an interrupt", async () => {
    const { fake, client } = await setup();
    const info = await client.enableSrq({ bindAddress: "127.0.0.1" });
    expect(info.address).toBe("127.0.0.1");
    expect(fake.intrChannels).toEqual([{ host: "127.0.0.1", port: info.port, program: INTR, version: 1, family: 0 }]);
    expect(fake.enableSrqCalls).toHaveLength(1);
    expect(fake.enableSrqCalls[0].enable).toBe(true);
    expect(client.srqEnabled).toBe(true);
    const wait = client.waitForSrq({ timeoutMs: 2000 });
    await fake.raiseSrq();
    await wait;
    expect(client.srqCount).toBe(1);
  });

  it("keeps an interrupt that arrived before waitForSrq, and clearSrq discards it", async () => {
    const { fake, client } = await setup();
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    await fake.raiseSrq();
    await settle();
    await client.waitForSrq({ timeoutMs: 500 }); // resolves at once, consumes it
    await expect(client.waitForSrq({ timeoutMs: 100 })).rejects.toThrow(Vxi11SrqTimeoutError);
    await fake.raiseSrq();
    await settle();
    client.clearSrq();
    await expect(client.waitForSrq({ timeoutMs: 100 })).rejects.toThrow(Vxi11SrqTimeoutError);
  });

  it("ignores interrupts carrying a different handle", async () => {
    const { fake, client } = await setup();
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    await fake.raiseSrq({ handle: Buffer.from("nope") });
    await settle();
    expect(client.srqCount).toBe(0);
  });

  it("calls onSrq listeners and lets them unsubscribe", async () => {
    const { fake, client } = await setup();
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    let n = 0;
    const off = client.onSrq(() => n++);
    await fake.raiseSrq();
    await settle();
    off();
    await fake.raiseSrq();
    await settle();
    expect(n).toBe(1);
    expect(client.srqCount).toBe(2);
  });

  it("disableSrq turns SRQ off, destroys the channel and stops the listener", async () => {
    const { fake, client } = await setup();
    const info = await client.enableSrq({ bindAddress: "127.0.0.1" });
    await client.disableSrq();
    expect(client.srqEnabled).toBe(false);
    expect(fake.enableSrqCalls.map((c) => c.enable)).toEqual([true, false]);
    expect(fake.destroyedIntrChannels).toBe(1);
    await expect(connectTo(info.port)).rejects.toThrow();
    await client.disableSrq(); // idempotent
    await expect(client.waitForSrq({ timeoutMs: 50 })).rejects.toThrow(Vxi11Error);
  });

  it("close() tears the interrupt channel down too", async () => {
    const { fake, client } = await setup();
    const info = await client.enableSrq({ bindAddress: "127.0.0.1" });
    await client.close();
    expect(fake.destroyedIntrChannels).toBe(1);
    await expect(connectTo(info.port)).rejects.toThrow();
  });

  it("close() rejects a pending waitForSrq with Vxi11ClosedError", async () => {
    const { client } = await setup();
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    const wait = client.waitForSrq({ timeoutMs: 5000 });
    const assertion = expect(wait).rejects.toThrow(Vxi11ClosedError);
    await client.close();
    await assertion;
  });

  it("times out in waitForSrq", async () => {
    const { client } = await setup();
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    const t = Date.now();
    await expect(client.waitForSrq({ timeoutMs: 150 })).rejects.toThrow(Vxi11SrqTimeoutError);
    expect(Date.now() - t).toBeGreaterThanOrEqual(140);
  });

  it("an instrument error from create_intr_chan is reported and nothing stays open", async () => {
    const { fake, client } = await setup();
    fake.injectError(25, 8); // OPERATION_NOT_SUPPORTED
    const err = await client.enableSrq({ bindAddress: "127.0.0.1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11DeviceError);
    expect(err.message).toMatch(/create_intr_chan.*OPERATION_NOT_SUPPORTED/);
    expect(client.srqEnabled).toBe(false);
    // a second attempt works: the listener from the failed one was released
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    expect(client.srqEnabled).toBe(true);
  });

  it("an instrument error from device_enable_srq destroys the channel again", async () => {
    const { fake, client } = await setup();
    fake.injectError(20, 5);
    await expect(client.enableSrq({ bindAddress: "127.0.0.1" })).rejects.toThrow(/device_enable_srq.*PARAMETER_ERROR/);
    expect(fake.destroyedIntrChannels).toBe(1);
    expect(client.srqEnabled).toBe(false);
  });

  it("refuses to enable twice and to wait when not enabled", async () => {
    const { client } = await setup();
    await expect(client.waitForSrq({ timeoutMs: 50 })).rejects.toThrow(/not enabled/);
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    await expect(client.enableSrq({ bindAddress: "127.0.0.1" })).rejects.toThrow(/already enabled/);
  });

  it("validates options", async () => {
    const { client } = await setup();
    await expect(client.enableSrq({ bindAddress: "::1" })).rejects.toThrow(RangeError);
    await expect(client.enableSrq({ bindAddress: "127.0.0.1", port: 70000 })).rejects.toThrow(RangeError);
    await expect(client.enableSrq({ bindAddress: "127.0.0.1", handle: Buffer.alloc(41) })).rejects.toThrow(RangeError);
    await client.enableSrq({ bindAddress: "127.0.0.1" });
    await expect(client.waitForSrq({ timeoutMs: -1 })).rejects.toThrow(RangeError);
  });

  it("enableSrq after close fails with Vxi11ClosedError", async () => {
    const { client } = await setup();
    await client.close();
    await expect(client.enableSrq({ bindAddress: "127.0.0.1" })).rejects.toThrow(Vxi11ClosedError);
  });
});

describe("IntrServer validation and protocol replies", () => {
  const rpcStatus = (r: Buffer): number[] => {
    const x = new XdrReader(r);
    for (let i = 0; i < 5; i++) x.u32(); // xid, REPLY, MSG_ACCEPTED, verifier flavor, verifier length
    const stat = x.u32();
    return stat === 2 ? [stat, x.u32(), x.u32()] : [stat];
  };
  async function call(bytes: Buffer): Promise<Buffer[]> {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"] });
    const s = await connectTo(server.port);
    const replies: Buffer[] = [];
    const dec = new RecordDecoder();
    s.on("data", (d) => replies.push(...dec.push(d)));
    s.write(bytes);
    await settle();
    return replies;
  }

  it.each([
    ["a non-IPv4 bind address", { bindAddress: "::1", allowedPeers: ["127.0.0.1"] }, /bindAddress must be an IPv4/],
    ["an empty allow list", { bindAddress: "127.0.0.1", allowedPeers: [] }, /allowedPeers/],
    ["a non-IPv4 allowed peer", { bindAddress: "127.0.0.1", allowedPeers: ["nope"] }, /allowedPeers/],
    ["a port out of range", { bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"], port: 70000 }, /invalid port/],
    ["a fractional port", { bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"], port: 1.5 }, /invalid port/],
    ["zero connections", { bindAddress: "127.0.0.1", allowedPeers: ["127.0.0.1"], maxConnections: 0 }, /maxConnections/],
  ])("refuses to listen with %s", async (_name, options, message) => {
    await expect(IntrServer.listen(options)).rejects.toThrow(message);
  });

  it("answers a wrong program version with PROG_MISMATCH and the supported version range", async () => {
    const replies = await call(encodeRecord(encodeCall(5, INTR, 9, 30, new XdrWriter().opaque(Buffer.from([1])).toBuffer())));
    expect(rpcStatus(replies[0])).toEqual([2, 1, 1]);
    expect(server!.stats.srqCalls).toBe(0);
  });

  it("answers the null procedure with success and counts it neither as SRQ nor as ignored", async () => {
    const replies = await call(encodeRecord(encodeCall(6, INTR, 1, 0, Buffer.alloc(0))));
    expect(rpcStatus(replies[0])).toEqual([0]);
    expect(server!.stats.ignored).toBe(0);
  });

  it.each([
    ["a record that is not an RPC call", new XdrWriter().u32(7).u32(1).toBuffer()],
    ["a call with a wrong RPC version", new XdrWriter().u32(8).u32(0).u32(3).toBuffer()],
  ])("silently ignores %s and drops the connection", async (_name, record) => {
    const replies = await call(encodeRecord(record));
    expect(replies).toEqual([]);
    expect(server!.stats.ignored).toBe(1);
  });

  it("ignores a truncated call without answering", async () => {
    const replies = await call(encodeRecord(new XdrWriter().u32(9).u32(0).toBuffer()));
    expect(replies).toEqual([]);
    expect(server!.stats.ignored).toBe(1);
  });

  it("remembers at most 16 rejected peers", async () => {
    server = await IntrServer.listen({ bindAddress: "127.0.0.1", allowedPeers: ["10.9.9.9"] });
    for (let i = 0; i < 18; i++) (await connectTo(server.port)).write(Buffer.from([0]));
    await settle(150);
    expect(server.stats.rejected).toBe(18);
    expect(server.stats.rejectedPeers).toHaveLength(16);
  });
});
