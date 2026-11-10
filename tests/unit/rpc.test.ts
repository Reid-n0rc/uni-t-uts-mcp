import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecordDecoder,
  RpcAcceptError,
  RpcClient,
  RpcClosedError,
  RpcConnectError,
  RpcDeniedError,
  RpcProtocolError,
  RpcTimeoutError,
  encodeRecord,
} from "../../src/vxi11/rpc.js";
import { XdrWriter } from "../../src/vxi11/xdr.js";
import { startFakeRpcServer, type FakeRpcServer } from "../fakeRpcServer.js";

const PROG = 0x20000001;
const echoU32 = (args: import("../../src/vxi11/xdr.js").XdrReader) => new XdrWriter().u32(args.u32() + 1);
const arg = (n: number): Buffer => new XdrWriter().u32(n).toBuffer();

let server: FakeRpcServer | undefined;
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await server?.close();
  server = undefined;
});
async function setup(opts = {}): Promise<{ s: FakeRpcServer; c: RpcClient }> {
  const s = await startFakeRpcServer(opts);
  server = s;
  s.register(PROG, 1, 1, echoU32);
  const c = await RpcClient.connect("127.0.0.1", s.port);
  clients.push(c);
  return { s, c };
}
const frameWord = (len: number, last: boolean): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(((last ? 0x80000000 : 0) | len) >>> 0);
  return b;
};

describe("RecordDecoder / encodeRecord", () => {
  it("sets the last-fragment bit as an unsigned value", () => {
    const framed = encodeRecord(Buffer.from([1, 2, 3, 4]));
    expect(framed.readUInt32BE(0)).toBe(0x80000004);
    expect(new RecordDecoder().push(framed).map((r) => [...r])).toEqual([[1, 2, 3, 4]]);
  });

  it("reassembles multi-fragment records and handles byte-by-byte delivery", () => {
    const body = Buffer.from("0123456789abcdef");
    const framed = encodeRecord(body, 5);
    expect(framed.length).toBe(16 + 4 * 4);
    const d = new RecordDecoder();
    const out: Buffer[] = [];
    for (const byte of framed) out.push(...d.push(Buffer.from([byte])));
    expect(out.map((b) => b.toString())).toEqual(["0123456789abcdef"]);
    expect(d.midRecord).toBe(false);
  });

  it("returns several records from one chunk and handles empty records", () => {
    const framed = Buffer.concat([encodeRecord(Buffer.from("ab")), encodeRecord(Buffer.alloc(0)), encodeRecord(Buffer.from("c"))]);
    expect(new RecordDecoder().push(framed).map((b) => b.toString())).toEqual(["ab", "", "c"]);
  });

  it("rejects a fragment announcing more than the cap, before any data arrives", () => {
    expect(() => new RecordDecoder(100).push(frameWord(101, true))).toThrow(RpcProtocolError);
    expect(() => new RecordDecoder().push(frameWord(0x7fffffff, true))).toThrow(/exceeds the limit/);
  });

  it("applies the cap to the accumulated record across fragments", () => {
    const d = new RecordDecoder(10);
    d.push(Buffer.concat([frameWord(6, false), Buffer.alloc(6)]));
    expect(() => d.push(frameWord(5, true))).toThrow(RpcProtocolError);
  });

  it("limits the number of fragments (zero-length fragment flood)", () => {
    const d = new RecordDecoder();
    const flood = Buffer.concat(Array.from({ length: 5000 }, () => frameWord(0, false)));
    expect(() => d.push(flood)).toThrow(/fragments/);
  });

  it("reports an unfinished record", () => {
    const d = new RecordDecoder();
    d.push(Buffer.concat([frameWord(8, true), Buffer.alloc(3)]));
    expect(d.midRecord).toBe(true);
  });
});

describe("RpcClient.call", () => {
  it("round trips a call", async () => {
    const { c } = await setup();
    const r = await c.call(PROG, 1, 1, arg(41));
    expect(r.u32()).toBe(42);
    r.expectEnd();
  });

  it("matches replies to calls by xid for concurrent calls answered out of order", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 2, async (args) => {
      const n = args.u32();
      await new Promise((res) => setTimeout(res, (5 - n) * 20)); // later calls answer first
      return new XdrWriter().u32(n * 10);
    });
    const results = await Promise.all([1, 2, 3, 4].map(async (n) => (await c.call(PROG, 1, 2, arg(n))).u32()));
    expect(results).toEqual([10, 20, 30, 40]);
    expect(new Set(s.calls.map((x) => x.xid)).size).toBe(4);
  });

  it("handles multi-fragment replies", async () => {
    const { s, c } = await setup({ fragmentSize: 3 });
    s.register(PROG, 1, 3, () => new XdrWriter().opaque(Buffer.alloc(100, 7)));
    expect((await c.call(PROG, 1, 3)).opaque().length).toBe(100);
  });

  it("handles a reply split across many chunks", async () => {
    const { s, c } = await setup({ chunkSize: 2 });
    s.register(PROG, 1, 3, () => new XdrWriter().string("hello world"));
    expect((await c.call(PROG, 1, 3)).string()).toBe("hello world");
  });

  it("times out when no reply arrives and ignores the late reply", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 4, () => undefined);
    await expect(c.call(PROG, 1, 4, undefined, { timeoutMs: 50 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect((await c.call(PROG, 1, 1, arg(1))).u32()).toBe(2); // connection still usable
  });

  it("ignores a reply with an unknown xid", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 5, (_a, call) => {
      const bogus = new XdrWriter().u32((call.xid + 1000) >>> 0).u32(1).u32(0).u32(0).u32(0).u32(0).toBuffer();
      call.socket.write(encodeRecord(bogus));
      return new XdrWriter().u32(9);
    });
    expect((await c.call(PROG, 1, 5)).u32()).toBe(9);
  });

  it("maps PROG_UNAVAIL, PROG_MISMATCH, PROC_UNAVAIL, GARBAGE_ARGS and SYSTEM_ERR", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 6, (args) => {
      args.u32();
      return new XdrWriter();
    });
    s.register(PROG, 1, 7, () => {
      throw new Error("boom");
    });
    const stat = async (p: Promise<unknown>): Promise<RpcAcceptError> => (await p.then(() => undefined, (e) => e)) as RpcAcceptError;
    const e1 = await stat(c.call(PROG + 1, 1, 1));
    expect([e1 instanceof RpcAcceptError, e1.acceptStat]).toEqual([true, 1]);
    const e2 = await stat(c.call(PROG, 5, 1));
    expect([e2.acceptStat, e2.low, e2.high]).toEqual([2, 1, 1]);
    expect((await stat(c.call(PROG, 1, 99))).acceptStat).toBe(3);
    expect((await stat(c.call(PROG, 1, 6))).acceptStat).toBe(4); // handler wanted a u32, got none
    expect((await stat(c.call(PROG, 1, 7))).acceptStat).toBe(5);
    expect(e1.message).toMatch(/PROG_UNAVAIL/);
  });

  it("maps MSG_DENIED (auth error and RPC mismatch)", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 8, () => ({ denied: "auth_error", authStat: 1 }));
    s.register(PROG, 1, 9, () => ({ denied: "rpc_mismatch", low: 2, high: 2 }));
    const a = await c.call(PROG, 1, 8).catch((e) => e);
    expect(a).toBeInstanceOf(RpcDeniedError);
    expect([a.rejectStat, a.authStat]).toEqual([1, 1]);
    expect(a.message).toMatch(/AUTH_BADCRED/);
    const m = await c.call(PROG, 1, 9).catch((e) => e);
    expect([m.rejectStat, m.low, m.high]).toEqual([0, 2, 2]);
  });

  const garbage: Array<[string, (xid: number) => Buffer]> = [
    ["a CALL instead of a REPLY", (x) => new XdrWriter().u32(x).u32(0).toBuffer()],
    ["a truncated reply", (x) => new XdrWriter().u32(x).u32(1).u32(0).toBuffer()],
    ["an unknown reply_stat", (x) => new XdrWriter().u32(x).u32(1).u32(7).toBuffer()],
    ["an unknown accept_stat", (x) => new XdrWriter().u32(x).u32(1).u32(0).u32(0).u32(0).u32(99).toBuffer()],
    ["an oversized verifier", (x) => new XdrWriter().u32(x).u32(1).u32(0).u32(0).u32(0xffffffff).toBuffer()],
    ["a truncated verifier", (x) => new XdrWriter().u32(x).u32(1).u32(0).u32(0).u32(8).toBuffer()],
    ["an unknown reject_stat", (x) => new XdrWriter().u32(x).u32(1).u32(1).u32(9).toBuffer()],
  ];
  it.each(garbage)("rejects only that call for %s and keeps the connection", async (_n, make) => {
    const { s, c } = await setup();
    s.register(PROG, 1, 10, (_a, call) => ({ raw: make(call.xid) }));
    await expect(c.call(PROG, 1, 10)).rejects.toBeInstanceOf(RpcProtocolError);
    expect((await c.call(PROG, 1, 1, arg(1))).u32()).toBe(2);
  });

  it("fails the connection on a record too short for an xid", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 11, (_a, call) => {
      call.socket.write(encodeRecord(Buffer.from([1, 2])));
      return undefined;
    });
    await expect(c.call(PROG, 1, 11, undefined, { timeoutMs: 2000 })).rejects.toBeInstanceOf(RpcProtocolError);
    expect(c.closed).toBe(true);
  });

  it("fails every pending call and closes when the server announces an oversized record", async () => {
    const s = await startFakeRpcServer();
    server = s;
    s.register(PROG, 1, 1, () => undefined);
    const c = await RpcClient.connect("127.0.0.1", s.port, { maxRecordBytes: 1024 });
    clients.push(c);
    const p1 = c.call(PROG, 1, 1, undefined, { timeoutMs: 5000 });
    const p2 = c.call(PROG, 1, 1, undefined, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    s.broadcastRaw(frameWord(2000, true));
    await expect(p1).rejects.toBeInstanceOf(RpcProtocolError);
    await expect(p2).rejects.toBeInstanceOf(RpcProtocolError);
    expect(c.closed).toBe(true);
    await expect(c.call(PROG, 1, 1)).rejects.toBeInstanceOf(RpcClosedError);
  });

  it("rejects an oversized request without sending it", async () => {
    const s = await startFakeRpcServer();
    server = s;
    const c = await RpcClient.connect("127.0.0.1", s.port, { maxRecordBytes: 64 });
    clients.push(c);
    await expect(c.call(PROG, 1, 1, Buffer.alloc(100))).rejects.toBeInstanceOf(RpcProtocolError);
    expect(s.calls.length).toBe(0);
  });

  it("rejects pending calls when the connection is closed mid-call", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 12, (_a, call) => {
      call.socket.destroy();
      return undefined;
    });
    const p = c.call(PROG, 1, 12, undefined, { timeoutMs: 5000 });
    await expect(p).rejects.toBeInstanceOf(RpcClosedError);
    await expect(c.call(PROG, 1, 1, arg(1))).rejects.toBeInstanceOf(RpcClosedError);
  });

  it("reports a connection closed in the middle of a reply", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 13, (_a, call) => {
      call.socket.end(Buffer.concat([frameWord(40, true), Buffer.alloc(5)]));
      return undefined;
    });
    await expect(c.call(PROG, 1, 13, undefined, { timeoutMs: 5000 })).rejects.toThrow(/middle of a reply/);
  });

  it("close() rejects pending calls immediately and is idempotent", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 14, () => undefined);
    const p = c.call(PROG, 1, 14, undefined, { timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 20));
    c.close();
    c.close();
    await expect(p).rejects.toBeInstanceOf(RpcClosedError);
  });

  it("leaves no pending timers after a failure (process can exit)", async () => {
    const { s, c } = await setup();
    s.register(PROG, 1, 14, () => undefined);
    const p = c.call(PROG, 1, 14, undefined, { timeoutMs: 60000 });
    c.close();
    await p.catch(() => undefined);
    expect(c.closed).toBe(true);
  });
});

describe("RpcClient.connect", () => {
  it("rejects with RpcConnectError when nothing listens", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(RpcClient.connect("127.0.0.1", port, { connectTimeoutMs: 2000 })).rejects.toBeInstanceOf(RpcConnectError);
  });

  it.each([0, -1, 65536, 1.5, NaN])("rejects invalid port %s", async (port) => {
    await expect(RpcClient.connect("127.0.0.1", port)).rejects.toBeInstanceOf(RpcConnectError);
  });
});
