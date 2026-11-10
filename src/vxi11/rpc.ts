/**
 * ONC RPC v2 (RFC 5531) client over TCP with record marking (RFC 5531 section 11), AUTH_NONE only.
 *
 * Replies are parsed from untrusted network input: record and fragment sizes are capped, every field
 * is bounds-checked, replies are matched to calls by xid, and every failure path (timeout, denied,
 * garbage, connection loss, close) rejects the affected promises and releases the socket.
 */
import * as net from "node:net";
import { randomInt } from "node:crypto";
import { MAX_OPAQUE_BYTES, XdrError, XdrReader, XdrWriter } from "./xdr.js";

export const RPC_VERSION = 2;
export const MSG_CALL = 0;
export const MSG_REPLY = 1;
export const AUTH_NONE = 0;
/** Cap for one reassembled record, request or reply (4 MiB; VXI-11 transfers are at most ~1 MiB). */
export const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** Cap for the number of fragments in one record. */
export const MAX_FRAGMENTS = 4096;
/** RFC 5531 limits an authentication body to 400 bytes. */
const MAX_AUTH_BODY = 400;
const LAST_FRAGMENT_BIT = 0x80000000;

export const ACCEPT_STAT_NAMES: Record<number, string> = {
  0: "SUCCESS",
  1: "PROG_UNAVAIL",
  2: "PROG_MISMATCH",
  3: "PROC_UNAVAIL",
  4: "GARBAGE_ARGS",
  5: "SYSTEM_ERR",
};
export const AUTH_STAT_NAMES: Record<number, string> = {
  0: "AUTH_OK",
  1: "AUTH_BADCRED",
  2: "AUTH_REJECTEDCRED",
  3: "AUTH_BADVERF",
  4: "AUTH_REJECTEDVERF",
  5: "AUTH_TOOWEAK",
};

/** Base class of every error raised by this module. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** TCP connect failed or timed out. */
export class RpcConnectError extends RpcError {}
/** The connection was closed (by the peer, by a socket error, or by `close()`). */
export class RpcClosedError extends RpcError {}
/** A call received no reply within its timeout. */
export class RpcTimeoutError extends RpcError {}
/** Malformed reply or framing violation (garbage, oversize, truncated, wrong message type). */
export class RpcProtocolError extends RpcError {}
/** MSG_DENIED: RPC version mismatch or authentication failure. */
export class RpcDeniedError extends RpcError {
  constructor(
    message: string,
    readonly rejectStat: number,
    readonly authStat?: number,
    readonly low?: number,
    readonly high?: number
  ) {
    super(message);
  }
}
/** MSG_ACCEPTED with a non-SUCCESS accept_stat. */
export class RpcAcceptError extends RpcError {
  constructor(
    message: string,
    readonly acceptStat: number,
    readonly low?: number,
    readonly high?: number
  ) {
    super(message);
  }
}

/** Wrap a message body in a single last-fragment record-marking frame (or several if it exceeds 2^31-1). */
export function encodeRecord(body: Uint8Array, fragmentSize = 0x7fffffff): Buffer {
  if (!Number.isInteger(fragmentSize) || fragmentSize < 1 || fragmentSize > 0x7fffffff) {
    throw new RpcProtocolError(`invalid fragment size ${fragmentSize}`);
  }
  const frames: Buffer[] = [];
  let offset = 0;
  do {
    const len = Math.min(fragmentSize, body.length - offset);
    const last = offset + len >= body.length;
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(((last ? LAST_FRAGMENT_BIT : 0) | len) >>> 0, 0);
    frames.push(header, Buffer.from(body.subarray(offset, offset + len)));
    offset += len;
  } while (offset < body.length);
  return Buffer.concat(frames);
}

/**
 * Incremental record-marking decoder. Feed it arbitrary chunks; it returns complete records.
 * Throws {@link RpcProtocolError} (after which it must not be used again) when a fragment or the
 * reassembled record would exceed the limits.
 */
export class RecordDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private fragmentLeft = -1; // -1: reading a header
  private fragmentIsLast = false;
  private fragments: Buffer[] = [];
  private recordBytes = 0;
  private fragmentCount = 0;

  constructor(private readonly maxRecordBytes = DEFAULT_MAX_RECORD_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    const records: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.fragmentLeft < 0) {
        const take = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + take);
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < 4) break;
        this.headerBytes = 0;
        const word = this.header.readUInt32BE(0);
        const len = (word & 0x7fffffff) >>> 0;
        this.fragmentIsLast = (word & LAST_FRAGMENT_BIT) !== 0;
        if (this.recordBytes + len > this.maxRecordBytes) {
          throw new RpcProtocolError(
            `record exceeds the limit of ${this.maxRecordBytes} bytes (fragment of ${len} bytes announced)`
          );
        }
        if (++this.fragmentCount > MAX_FRAGMENTS) {
          throw new RpcProtocolError(`record has more than ${MAX_FRAGMENTS} fragments`);
        }
        this.fragmentLeft = len;
        if (len === 0) this.finishFragment(records);
        continue;
      }
      const take = Math.min(this.fragmentLeft, chunk.length - offset);
      this.fragments.push(Buffer.from(chunk.subarray(offset, offset + take)));
      this.recordBytes += take;
      this.fragmentLeft -= take;
      offset += take;
      if (this.fragmentLeft === 0) this.finishFragment(records);
    }
    return records;
  }

  private finishFragment(records: Buffer[]): void {
    this.fragmentLeft = -1;
    if (this.fragmentIsLast) {
      records.push(Buffer.concat(this.fragments, this.recordBytes));
      this.fragments = [];
      this.recordBytes = 0;
      this.fragmentCount = 0;
    }
  }

  /** True when bytes of an unfinished record are buffered (used to detect truncation on close). */
  get midRecord(): boolean {
    return this.fragmentLeft >= 0 || this.headerBytes > 0 || this.recordBytes > 0 || this.fragmentCount > 0;
  }
}

/** Encode an RPC CALL message (AUTH_NONE credentials and verifier). */
export function encodeCall(xid: number, program: number, version: number, procedure: number, args: Uint8Array): Buffer {
  const w = new XdrWriter();
  w.u32(xid).u32(MSG_CALL).u32(RPC_VERSION).u32(program).u32(version).u32(procedure);
  w.u32(AUTH_NONE).u32(0); // cred
  w.u32(AUTH_NONE).u32(0); // verf
  return Buffer.concat([w.toBuffer(), args]);
}

export interface RpcCallOptions {
  /** Time to wait for the reply, in ms (default 15000). */
  timeoutMs?: number;
}

export interface RpcConnectOptions {
  /** TCP connect timeout in ms (default 5000). */
  connectTimeoutMs?: number;
  /** Cap for one request or reply record (default 4 MiB). */
  maxRecordBytes?: number;
}

interface PendingCall {
  program: number;
  version: number;
  procedure: number;
  resolve: (r: XdrReader) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const describe = (c: { program: number; version: number; procedure: number }): string =>
  `RPC call ${c.program}v${c.version} proc ${c.procedure}`;

export class RpcClient {
  private readonly pending = new Map<number, PendingCall>();
  private readonly decoder: RecordDecoder;
  private nextXid: number;
  private closedReason: Error | undefined;

  private constructor(
    private readonly socket: net.Socket,
    private readonly maxRecordBytes: number
  ) {
    this.decoder = new RecordDecoder(maxRecordBytes);
    this.nextXid = randomInt(1, 0xffffffff);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => this.fail(new RpcClosedError(`connection error: ${err.message}`)));
    socket.on("close", () => {
      const truncated = this.decoder.midRecord;
      this.fail(new RpcClosedError(truncated ? "connection closed in the middle of a reply" : "connection closed"));
    });
    socket.on("end", () => socket.destroy());
  }

  /** Open a TCP connection to an RPC server. Rejects with {@link RpcConnectError}. */
  static connect(host: string, port: number, options: RpcConnectOptions = {}): Promise<RpcClient> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    return new Promise((resolve, reject) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        reject(new RpcConnectError(`invalid port ${port}`));
        return;
      }
      const socket = new net.Socket();
      socket.setNoDelay(true);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new RpcConnectError(`connect to ${host}:${port} timed out after ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new RpcConnectError(`connect to ${host}:${port} failed: ${err.message}`));
      };
      socket.once("error", onError);
      socket.connect(port, host, () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(new RpcClient(socket, maxRecordBytes));
      });
    });
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /**
   * Call a procedure. Resolves with a reader positioned at the procedure results (after the
   * accepted-reply header); the caller must parse them (and may call `expectEnd()`).
   */
  call(program: number, version: number, procedure: number, args: Uint8Array = new Uint8Array(0), options: RpcCallOptions = {}): Promise<XdrReader> {
    const timeoutMs = options.timeoutMs ?? 15000;
    if (this.closedReason) return Promise.reject(new RpcClosedError(`${describe({ program, version, procedure })} on a closed connection: ${this.closedReason.message}`));
    let xid = this.nextXid;
    do {
      xid = (xid + 1) >>> 0;
    } while (xid === 0 || this.pending.has(xid));
    this.nextXid = xid;

    let record: Buffer;
    try {
      record = encodeRecord(encodeCall(xid, program, version, procedure, args));
      if (record.length - 4 > this.maxRecordBytes) {
        throw new RpcProtocolError(`request of ${record.length - 4} bytes exceeds the limit of ${this.maxRecordBytes}`);
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise<XdrReader>((resolve, reject) => {
      const call = { program, version, procedure };
      const timer = setTimeout(() => {
        this.pending.delete(xid);
        reject(new RpcTimeoutError(`${describe(call)} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(xid, { ...call, resolve, reject, timer });
      this.socket.write(record, (err) => {
        if (err) this.fail(new RpcClosedError(`write failed: ${err.message}`));
      });
    });
  }

  /** Close the connection; pending calls reject with {@link RpcClosedError}. Idempotent. */
  close(): void {
    this.fail(new RpcClosedError("connection closed by the client"));
  }

  private fail(reason: Error): void {
    if (!this.closedReason) this.closedReason = reason;
    this.socket.destroy();
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) {
      clearTimeout(c.timer);
      c.reject(
        this.closedReason instanceof RpcProtocolError
          ? this.closedReason
          : new RpcClosedError(`${describe(c)} aborted: ${this.closedReason.message}`)
      );
    }
  }

  private onData(chunk: Buffer): void {
    let records: Buffer[];
    try {
      records = this.decoder.push(chunk);
    } catch (err) {
      this.fail(err instanceof Error ? err : new RpcProtocolError(String(err)));
      return;
    }
    for (const record of records) {
      if (this.closed) return;
      this.onRecord(record);
    }
  }

  private onRecord(record: Buffer): void {
    let xid: number;
    try {
      xid = new XdrReader(record).u32();
    } catch {
      this.fail(new RpcProtocolError("reply record too short to contain an xid"));
      return;
    }
    const call = this.pending.get(xid);
    if (!call) return; // late reply to a timed-out call, or unsolicited: ignore
    this.pending.delete(xid);
    clearTimeout(call.timer);
    try {
      call.resolve(parseReply(record, call));
    } catch (err) {
      call.reject(err instanceof Error ? err : new RpcProtocolError(String(err)));
    }
  }
}

/** Parse a reply record up to the procedure results. Throws a typed error for anything but success. */
export function parseReply(record: Uint8Array, call: { program: number; version: number; procedure: number }): XdrReader {
  const what = describe(call);
  const r = new XdrReader(record);
  try {
    r.u32(); // xid, already matched
    const mtype = r.u32();
    if (mtype !== MSG_REPLY) throw new RpcProtocolError(`${what}: message type ${mtype} is not a REPLY`);
    const replyStat = r.u32();
    if (replyStat === 1) {
      const rejectStat = r.u32();
      if (rejectStat === 0) {
        const low = r.u32();
        const high = r.u32();
        throw new RpcDeniedError(`${what} denied: RPC version mismatch (server supports ${low}-${high})`, 0, undefined, low, high);
      }
      if (rejectStat === 1) {
        const authStat = r.u32();
        throw new RpcDeniedError(`${what} denied: authentication error ${AUTH_STAT_NAMES[authStat] ?? authStat}`, 1, authStat);
      }
      throw new RpcProtocolError(`${what}: unknown reject_stat ${rejectStat}`);
    }
    if (replyStat !== 0) throw new RpcProtocolError(`${what}: unknown reply_stat ${replyStat}`);
    r.u32(); // verifier flavor
    r.opaque(MAX_AUTH_BODY); // verifier body
    const acceptStat = r.u32();
    if (acceptStat === 2) {
      const low = r.u32();
      const high = r.u32();
      throw new RpcAcceptError(`${what} failed: PROG_MISMATCH (server supports versions ${low}-${high})`, 2, low, high);
    }
    if (acceptStat !== 0) {
      const name = ACCEPT_STAT_NAMES[acceptStat];
      if (name === undefined) throw new RpcProtocolError(`${what}: unknown accept_stat ${acceptStat}`);
      throw new RpcAcceptError(`${what} failed: ${name}`, acceptStat);
    }
    return r;
  } catch (err) {
    if (err instanceof XdrError) throw new RpcProtocolError(`${what}: malformed reply: ${err.message}`);
    throw err;
  }
}
