import * as net from "node:net";
import { RecordDecoder, encodeRecord } from "../src/vxi11/rpc.js";
import { XdrError, XdrReader, XdrWriter } from "../src/vxi11/xdr.js";

/** What a handler is told about the call it serves. */
export interface FakeRpcCall {
  xid: number;
  program: number;
  version: number;
  procedure: number;
  socket: net.Socket;
}

/**
 * A handler returns the XDR-encoded results (Buffer or XdrWriter), `undefined` to send no reply
 * (to test timeouts), or an object describing a failure reply. Throwing an XdrError answers
 * GARBAGE_ARGS; any other throw answers SYSTEM_ERR.
 */
export type FakeRpcResult =
  | Buffer
  | XdrWriter
  | undefined
  | { acceptStat: 1 | 3 | 4 | 5 }
  | { denied: "rpc_mismatch"; low: number; high: number }
  | { denied: "auth_error"; authStat: number }
  | { raw: Buffer }; // a complete reply record body, sent as-is (garbage tests)
export type FakeRpcHandler = (args: XdrReader, call: FakeRpcCall) => FakeRpcResult | Promise<FakeRpcResult>;

export interface FakeRpcServerOptions {
  /** Split every reply into fragments of at most this many bytes (multi-fragment records). */
  fragmentSize?: number;
  /** Write replies in chunks of at most this many bytes, one event-loop turn apart. */
  chunkSize?: number;
  /** Delay every reply by this many ms. */
  replyDelayMs?: number;
}

export interface FakeRpcServer {
  port: number;
  /** Every call received, in order. */
  calls: FakeRpcCall[];
  sockets: Set<net.Socket>;
  /** Register a handler for program/version/procedure. */
  register(program: number, version: number, procedure: number, handler: FakeRpcHandler): void;
  /** Make the built-in portmapper (program 100000 v2) answer GETPORT using `ports`; returns the live map. */
  registerPortmapper(ports?: Map<string, number>): Map<string, number>;
  /** Send raw bytes to every connected client (for malformed-input tests). */
  broadcastRaw(data: Buffer): void;
  /** Drop every client connection. */
  dropClients(): void;
  options: FakeRpcServerOptions;
  close(): Promise<void>;
}

export const portKey = (program: number, version: number): string => `${program}:${version}`;

const MSG_ACCEPTED_HEADER = (xid: number): XdrWriter => new XdrWriter().u32(xid).u32(1).u32(0).u32(0).u32(0); // REPLY, accepted, AUTH_NONE verf

/**
 * In-process ONC RPC TCP server on 127.0.0.1 (record marking, AUTH_NONE) with per
 * program/version/procedure handlers and a fake portmapper, reusable by the VXI-11 fake instrument.
 */
export async function startFakeRpcServer(options: FakeRpcServerOptions = {}, listenPort = 0): Promise<FakeRpcServer> {
  const handlers = new Map<string, FakeRpcHandler>();
  const versions = new Map<number, Set<number>>();
  const calls: FakeRpcCall[] = [];
  const sockets = new Set<net.Socket>();

  const send = (socket: net.Socket, body: Buffer): void => {
    const write = (): void => {
      if (socket.destroyed) return;
      const framed = encodeRecord(body, options.fragmentSize);
      if (!options.chunkSize) {
        socket.write(framed);
        return;
      }
      let offset = 0;
      const next = (): void => {
        if (socket.destroyed || offset >= framed.length) return;
        socket.write(framed.subarray(offset, offset + options.chunkSize!));
        offset += options.chunkSize!;
        setImmediate(next);
      };
      next();
    };
    if (options.replyDelayMs) setTimeout(write, options.replyDelayMs);
    else write();
  };

  const serve = async (socket: net.Socket, record: Buffer): Promise<void> => {
    const r = new XdrReader(record);
    let xid: number;
    let call: FakeRpcCall;
    try {
      xid = r.u32();
      if (r.u32() !== 0) return; // not a CALL
      const rpcVers = r.u32();
      const program = r.u32();
      const version = r.u32();
      const procedure = r.u32();
      for (let i = 0; i < 2; i++) {
        r.u32(); // flavor
        r.opaque(400); // body
      }
      call = { xid, program, version, procedure, socket };
      calls.push(call);
      if (rpcVers !== 2) {
        send(socket, new XdrWriter().u32(xid).u32(1).u32(1).u32(0).u32(2).u32(2).toBuffer());
        return;
      }
    } catch {
      return; // unparseable call: ignore
    }
    const known = versions.get(call.program);
    const accepted = MSG_ACCEPTED_HEADER(xid);
    if (!known) return void send(socket, accepted.u32(1).toBuffer()); // PROG_UNAVAIL
    if (!known.has(call.version)) {
      const vs = [...known];
      return void send(socket, accepted.u32(2).u32(Math.min(...vs)).u32(Math.max(...vs)).toBuffer()); // PROG_MISMATCH
    }
    const handler = handlers.get(`${call.program}:${call.version}:${call.procedure}`);
    if (!handler) return void send(socket, accepted.u32(3).toBuffer()); // PROC_UNAVAIL
    let result: FakeRpcResult;
    try {
      result = await handler(r, call);
    } catch (err) {
      return void send(socket, accepted.u32(err instanceof XdrError ? 4 : 5).toBuffer());
    }
    if (result === undefined) return;
    if (Buffer.isBuffer(result)) return void send(socket, Buffer.concat([accepted.u32(0).toBuffer(), result]));
    if (result instanceof XdrWriter) return void send(socket, Buffer.concat([accepted.u32(0).toBuffer(), result.toBuffer()]));
    if ("raw" in result) return void send(socket, result.raw);
    if ("acceptStat" in result) return void send(socket, accepted.u32(result.acceptStat).toBuffer());
    if (result.denied === "rpc_mismatch") {
      return void send(socket, new XdrWriter().u32(xid).u32(1).u32(1).u32(0).u32(result.low).u32(result.high).toBuffer());
    }
    send(socket, new XdrWriter().u32(xid).u32(1).u32(1).u32(1).u32(result.authStat).toBuffer());
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const decoder = new RecordDecoder(16 * 1024 * 1024);
    socket.on("data", (chunk) => {
      try {
        for (const rec of decoder.push(chunk)) void serve(socket, rec);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  const fake: FakeRpcServer = {
    port,
    calls,
    sockets,
    options,
    register(program, version, procedure, handler) {
      handlers.set(`${program}:${version}:${procedure}`, handler);
      if (!versions.has(program)) versions.set(program, new Set());
      versions.get(program)!.add(version);
    },
    registerPortmapper(ports = new Map<string, number>()) {
      fake.register(100000, 2, 0, () => Buffer.alloc(0)); // NULL
      fake.register(100000, 2, 3, (args) => {
        const prog = args.u32();
        const vers = args.u32();
        const prot = args.u32();
        args.u32(); // port, ignored
        return new XdrWriter().u32(prot === 6 ? (ports.get(portKey(prog, vers)) ?? 0) : 0);
      });
      return ports;
    },
    broadcastRaw(data) {
      for (const s of sockets) s.write(data);
    },
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}
