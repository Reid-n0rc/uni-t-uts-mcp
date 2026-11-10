/**
 * VXI-11 interrupt channel, server side: a bounded ONC RPC server (TCP, record marking, AUTH_NONE)
 * for program DEVICE_INTR (395185, version 1) that receives `device_intr_srq` (procedure 30) calls
 * from the instrument. The instrument connects TO us after `create_intr_chan`, so this listener is
 * reachable from the network: it binds one interface only, accepts only the instrument's address,
 * caps connections, record sizes and handle sizes, and never lets a malformed call throw.
 */
import * as dgram from "node:dgram";
import * as net from "node:net";
import { RecordDecoder, encodeRecord, MSG_CALL, MSG_REPLY, RPC_VERSION } from "./rpc.js";
import { XdrError, XdrReader, XdrWriter } from "./xdr.js";

export const VXI11_INTR_PROGRAM = 395185;
export const VXI11_INTR_VERSION = 1;
export const PROC_DEVICE_INTR_SRQ = 30;
/** `device_enable_srq` handles are at most 40 bytes (VXI-11 spec). */
export const MAX_SRQ_HANDLE = 40;
/** A device_intr_srq call is tiny (about 70 bytes); anything larger is not from a VXI-11 instrument. */
const MAX_INTR_RECORD = 1024;

export interface IntrServerOptions {
  /** The one local IPv4 address to listen on (never 0.0.0.0 by default: pass it explicitly). */
  bindAddress: string;
  /** Peer addresses allowed to connect (the instrument's IPv4 address). Everyone else is dropped. */
  allowedPeers: string[];
  /** TCP port to listen on (default 0 = ephemeral). */
  port?: number;
  /** Concurrent connections accepted (default 4). */
  maxConnections?: number;
  /** Close connections idle this long, in ms (default 10 minutes). */
  idleTimeoutMs?: number;
}

export interface IntrStats {
  /** Connections accepted from an allowed peer. */
  accepted: number;
  /** Connections dropped (wrong peer or over the cap). */
  rejected: number;
  /** device_intr_srq calls delivered. */
  srqCalls: number;
  /** Other RPC calls or malformed records seen on accepted connections. */
  ignored: number;
  /** Remote addresses of rejected connections (up to 16, for diagnostics). */
  rejectedPeers: string[];
}

const stripMapped = (a: string): string => (a.startsWith("::ffff:") ? a.slice(7) : a);

export class IntrServer {
  readonly stats: IntrStats = { accepted: 0, rejected: 0, srqCalls: 0, ignored: 0, rejectedPeers: [] };
  private readonly listeners = new Set<(handle: Buffer) => void>();
  private readonly sockets = new Set<net.Socket>();
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly server: net.Server,
    readonly address: string,
    readonly port: number,
    private readonly allowed: ReadonlySet<string>,
    private readonly maxConnections: number,
    private readonly idleTimeoutMs: number
  ) {
    server.on("connection", (socket) => this.onConnection(socket));
    server.on("error", () => {});
  }

  /** Start listening. Rejects when the options are invalid or the address cannot be bound. */
  static listen(options: IntrServerOptions): Promise<IntrServer> {
    if (net.isIPv4(options.bindAddress) === false) return Promise.reject(new RangeError(`bindAddress must be an IPv4 address, got "${options.bindAddress}"`));
    if (options.allowedPeers.length === 0 || options.allowedPeers.some((p) => !net.isIPv4(p))) {
      return Promise.reject(new RangeError("allowedPeers must be a non-empty list of IPv4 addresses"));
    }
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new RangeError(`invalid port ${port}`));
    const maxConnections = options.maxConnections ?? 4;
    if (!Number.isInteger(maxConnections) || maxConnections < 1) return Promise.reject(new RangeError("maxConnections must be a positive integer"));
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen({ host: options.bindAddress, port }, () => {
        server.removeListener("error", reject);
        const bound = server.address() as net.AddressInfo;
        resolve(new IntrServer(server, bound.address, bound.port, new Set(options.allowedPeers), maxConnections, options.idleTimeoutMs ?? 600_000));
      });
    });
  }

  /** Whether a remote address (IPv4, or IPv4-mapped IPv6) may talk to this server. */
  isAllowed(remoteAddress: string | undefined): boolean {
    return remoteAddress !== undefined && this.allowed.has(stripMapped(remoteAddress));
  }

  /** Register a listener for device_intr_srq calls (it receives the handle). Returns an unsubscribe function. */
  onSrq(listener: (handle: Buffer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop listening and drop every connection. Idempotent. */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      for (const s of this.sockets) s.destroy();
      this.sockets.clear();
      this.listeners.clear();
      this.server.close(() => resolve());
    });
    return this.closing;
  }

  private onConnection(socket: net.Socket): void {
    socket.on("error", () => {});
    if (this.closing || !this.isAllowed(socket.remoteAddress) || this.sockets.size >= this.maxConnections) {
      this.stats.rejected++;
      if (this.stats.rejectedPeers.length < 16) this.stats.rejectedPeers.push(socket.remoteAddress ?? "unknown");
      socket.destroy();
      return;
    }
    this.stats.accepted++;
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
    const decoder = new RecordDecoder(MAX_INTR_RECORD);
    socket.on("data", (chunk) => {
      let records: Buffer[];
      try {
        records = decoder.push(chunk);
      } catch {
        this.stats.ignored++;
        socket.destroy();
        return;
      }
      for (const record of records) {
        if (socket.destroyed || !this.handleRecord(socket, record)) {
          socket.destroy();
          return;
        }
      }
    });
  }

  /** Returns false when the connection must be dropped. */
  private handleRecord(socket: net.Socket, record: Buffer): boolean {
    const r = new XdrReader(record);
    let xid: number;
    let program: number;
    let version: number;
    let procedure: number;
    let handle: Buffer | undefined;
    try {
      xid = r.u32();
      if (r.u32() !== MSG_CALL) return this.ignore();
      if (r.u32() !== RPC_VERSION) return this.ignore();
      program = r.u32();
      version = r.u32();
      procedure = r.u32();
      r.u32();
      r.opaque(400); // credentials
      r.u32();
      r.opaque(400); // verifier
      if (program === VXI11_INTR_PROGRAM && version === VXI11_INTR_VERSION && procedure === PROC_DEVICE_INTR_SRQ) {
        handle = r.opaque(MAX_SRQ_HANDLE);
        r.expectEnd();
      }
    } catch (err) {
      if (err instanceof XdrError) return this.ignore();
      throw err;
    }
    const reply = new XdrWriter().u32(xid).u32(MSG_REPLY).u32(0).u32(0).u32(0); // accepted, AUTH_NONE verifier
    if (program !== VXI11_INTR_PROGRAM) reply.u32(1); // PROG_UNAVAIL
    else if (version !== VXI11_INTR_VERSION) reply.u32(2).u32(VXI11_INTR_VERSION).u32(VXI11_INTR_VERSION); // PROG_MISMATCH
    else if (procedure !== PROC_DEVICE_INTR_SRQ && procedure !== 0) reply.u32(3); // PROC_UNAVAIL
    else reply.u32(0); // SUCCESS, void result
    if (handle === undefined && procedure !== 0) this.stats.ignored++;
    socket.write(encodeRecord(reply.toBuffer()));
    if (handle !== undefined) {
      this.stats.srqCalls++;
      for (const l of [...this.listeners]) {
        try {
          l(handle);
        } catch {
          // a listener's failure must not affect the instrument's connection
        }
      }
    }
    return true;
  }

  private ignore(): false {
    this.stats.ignored++;
    return false;
  }
}

/**
 * The local IPv4 address the OS would use to reach `host`: a UDP socket is "connected" (no packet is
 * sent) and its local address read back. Rejects when there is no route.
 */
export function localAddressFor(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const done = (err: Error | undefined, address?: string): void => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(address!);
    };
    socket.once("error", (err) => done(err));
    socket.connect(9, host, () => {
      try {
        done(undefined, socket.address().address);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
