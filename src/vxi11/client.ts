/**
 * Minimal VXI-11 (TCP/IP-IEEE 488.1) core-channel client over {@link RpcClient}: create_link,
 * device_write, device_read, device_readstb, device_clear and destroy_link. The interrupt channel
 * (SRQ) is out of scope: the UTS firmware never uses it.
 *
 * Replies come from the network and are untrusted: every field is validated, sizes are capped, the
 * server dropping the connection mid-call rejects the call, and every call has a deadline (the
 * instrument's I/O timeout plus a margin), so no promise is ever left pending.
 */
import { getPort, PMAP_PORT } from "./portmapper.js";
import { RpcClient, RpcError, RpcClosedError, RpcProtocolError, RpcTimeoutError } from "./rpc.js";
import { XdrError, XdrReader, XdrWriter } from "./xdr.js";

export const VXI11_CORE_PROGRAM = 395183;
export const VXI11_CORE_VERSION = 1;
export const PROC_CREATE_LINK = 10;
export const PROC_DEVICE_WRITE = 11;
export const PROC_DEVICE_READ = 12;
export const PROC_DEVICE_READSTB = 13;
export const PROC_DEVICE_CLEAR = 15;
export const PROC_DESTROY_LINK = 23;

export const FLAG_WAITLOCK = 1;
export const FLAG_END = 8;
export const FLAG_TERMCHRSET = 128;
export const REASON_REQCNT = 1;
export const REASON_CHR = 2;
export const REASON_END = 4;

/** VXI-11 `Device_ErrorCode` names (VXI-11 spec table B.2.1). */
export const VXI11_ERROR_NAMES: Readonly<Record<number, string>> = {
  1: "SYNTAX_ERROR",
  3: "DEVICE_NOT_ACCESSIBLE",
  4: "INVALID_LINK_IDENTIFIER",
  5: "PARAMETER_ERROR",
  6: "CHANNEL_NOT_ESTABLISHED",
  8: "OPERATION_NOT_SUPPORTED",
  9: "OUT_OF_RESOURCES",
  11: "DEVICE_LOCKED_BY_ANOTHER_LINK",
  12: "NO_LOCK_HELD_BY_THIS_LINK",
  15: "IO_TIMEOUT",
  17: "IO_ERROR",
  21: "INVALID_ADDRESS",
  23: "ABORT",
};
export const vxi11ErrorName = (code: number): string => VXI11_ERROR_NAMES[code] ?? `UNKNOWN_ERROR_${code}`;

/** Largest single device_read the client asks for, and the cap on maxBytes. */
export const MAX_READ_CHUNK = 1024 * 1024;
export const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_DEVICE_NAME = 256;
const MAX_TIMEOUT_MS = 0xffffffff;

/** Base class of every error raised by the VXI-11 client. */
export class Vxi11Error extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
/** The instrument answered with a non-zero VXI-11 error code. */
export class Vxi11DeviceError extends Vxi11Error {
  readonly codeName: string;
  constructor(
    readonly code: number,
    operation: string
  ) {
    const codeName = vxi11ErrorName(code);
    super(`VXI-11 ${operation} failed: ${codeName} (error ${code})`);
    this.codeName = codeName;
  }
}
/** Error 15: the instrument had nothing to deliver / could not accept data within the I/O timeout. */
export class Vxi11IoTimeoutError extends Vxi11DeviceError {}
/** Error 11: the device is locked by another link. */
export class Vxi11LockedError extends Vxi11DeviceError {}
/** Could not reach the instrument (portmapper unreachable, program not registered, TCP refused, create_link failed at RPC level). */
export class Vxi11ConnectError extends Vxi11Error {}
/** The RPC connection failed during a call (dropped, no RPC reply in time, RPC-level rejection). */
export class Vxi11TransportError extends Vxi11Error {}
/** The reply violated the protocol (malformed, out of range, never terminating). */
export class Vxi11ProtocolError extends Vxi11Error {}
/** The client was closed (or its connection is gone) before or during the call. */
export class Vxi11ClosedError extends Vxi11Error {}

function deviceError(code: number, operation: string): Vxi11DeviceError {
  if (code === 15) return new Vxi11IoTimeoutError(code, operation);
  if (code === 11) return new Vxi11LockedError(code, operation);
  return new Vxi11DeviceError(code, operation);
}

export interface Vxi11ConnectOptions {
  /** Logical device name (default "inst0"). */
  device?: string;
  /** Core channel TCP port; when omitted it is looked up through the portmapper. */
  port?: number;
  /** Portmapper port (default 111). */
  portmapperPort?: number;
  /** Timeout for TCP connect, portmapper lookup and create_link, in ms (default 5000). */
  connectTimeoutMs?: number;
  /** Extra time allowed on top of an I/O timeout before the RPC reply is considered lost (default 5000). */
  rpcMarginMs?: number;
  /** Timeout for destroy_link during close, in ms (default 2000). */
  closeTimeoutMs?: number;
}

export interface Vxi11WriteOptions {
  /** I/O timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Set the END flag on the last chunk (default true). */
  end?: boolean;
}

export interface Vxi11ReadOptions {
  /** Overall time allowed for the whole read, in ms (default 5000). */
  timeoutMs?: number;
  /** Stop after this many bytes even without END (default 16 MiB). */
  maxBytes?: number;
}

export interface Vxi11ReadResult {
  data: Buffer;
  /** True when the instrument signalled the end of the message (END or termchar), false when maxBytes was reached first. */
  end: boolean;
}

function checkTimeout(value: number | undefined, fallback: number, what: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 0 || v > MAX_TIMEOUT_MS) throw new RangeError(`${what} timeout must be an integer from 0 to ${MAX_TIMEOUT_MS} ms, got ${v}`);
  return v;
}

export class Vxi11Client {
  private closedReason: string | undefined;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly rpc: RpcClient,
    readonly linkId: number,
    /** Largest device_write the instrument accepts (from create_link). */
    readonly maxRecvSize: number,
    /** Abort channel port reported by create_link (unused). */
    readonly abortPort: number,
    private readonly rpcMarginMs: number,
    private readonly closeTimeoutMs: number
  ) {}

  /**
   * Connect: portmapper lookup (unless `port` is given), TCP connection to the core channel,
   * create_link. Rejects with {@link Vxi11ConnectError}, {@link Vxi11DeviceError} or
   * {@link Vxi11ProtocolError}; the socket is closed on every failure.
   */
  static async connect(host: string, options: Vxi11ConnectOptions = {}): Promise<Vxi11Client> {
    const device = options.device ?? "inst0";
    if (device.length === 0 || device.length > MAX_DEVICE_NAME) throw new RangeError("device name must be 1-256 characters");
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
      throw new RangeError(`invalid port ${options.port}`);
    }
    const connectTimeoutMs = checkTimeout(options.connectTimeoutMs, 5000, "connect");
    const rpcMarginMs = checkTimeout(options.rpcMarginMs, 5000, "RPC margin");
    const closeTimeoutMs = checkTimeout(options.closeTimeoutMs, 2000, "close");

    let port = options.port;
    if (port === undefined) {
      try {
        port = await getPort(host, VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, {
          portmapperPort: options.portmapperPort ?? PMAP_PORT,
          timeoutMs: connectTimeoutMs,
        });
      } catch (err) {
        throw new Vxi11ConnectError(`VXI-11 portmapper lookup on ${host} failed: ${errMessage(err)}`, { cause: err });
      }
      if (port === 0) throw new Vxi11ConnectError(`VXI-11 core channel (program ${VXI11_CORE_PROGRAM}) is not registered with the portmapper on ${host}`);
    }
    let rpc: RpcClient;
    try {
      rpc = await RpcClient.connect(host, port, { connectTimeoutMs });
    } catch (err) {
      throw new Vxi11ConnectError(`VXI-11 core channel connect to ${host}:${port} failed: ${errMessage(err)}`, { cause: err });
    }
    try {
      // (clientId, lockDevice, lock_timeout, device) -> (error, linkId, abortPort, maxRecvSize)
      const args = new XdrWriter().u32(randomClientId()).bool(false).u32(0).string(device, MAX_DEVICE_NAME).toBuffer();
      let reply: XdrReader;
      try {
        reply = await rpc.call(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, PROC_CREATE_LINK, args, { timeoutMs: connectTimeoutMs });
      } catch (err) {
        throw rpcFailure(err, "create_link", true);
      }
      const { error, linkId, abortPort, maxRecvSize } = parse(reply, "create_link", (r) => ({
        error: r.u32(),
        linkId: r.u32(),
        abortPort: r.u32(),
        maxRecvSize: r.u32(),
      }));
      if (error !== 0) throw deviceError(error, "create_link");
      if (abortPort > 65535) throw new Vxi11ProtocolError(`create_link returned an invalid abort port ${abortPort}`);
      if (maxRecvSize === 0) throw new Vxi11ProtocolError("create_link returned maxRecvSize 0");
      return new Vxi11Client(rpc, linkId, maxRecvSize, abortPort, rpcMarginMs, closeTimeoutMs);
    } catch (err) {
      rpc.close();
      throw err;
    }
  }

  get closed(): boolean {
    return this.closedReason !== undefined || this.rpc.closed;
  }

  /**
   * device_write. Data larger than maxRecvSize is sent in chunks; END is set only on the last one
   * (unless `end` is false). Resolves with the number of bytes the instrument accepted.
   */
  async write(data: string | Uint8Array, options: Vxi11WriteOptions = {}): Promise<number> {
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "write");
    const end = options.end ?? true;
    const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    let offset = 0;
    do {
      const chunk = bytes.subarray(offset, offset + this.maxRecvSize);
      const last = offset + chunk.length >= bytes.length;
      const args = new XdrWriter()
        .u32(this.linkId)
        .u32(timeoutMs)
        .u32(0)
        .u32(last && end ? FLAG_END : 0)
        .opaque(chunk)
        .toBuffer();
      const reply = await this.call(PROC_DEVICE_WRITE, args, timeoutMs, "device_write");
      const { error, size } = parse(reply, "device_write", (r) => ({ error: r.u32(), size: r.u32() }));
      if (error !== 0) throw deviceError(error, "device_write");
      if (size > chunk.length) throw new Vxi11ProtocolError(`device_write reported ${size} bytes written but only ${chunk.length} were sent`);
      if (size === 0 && chunk.length > 0) throw new Vxi11ProtocolError("device_write accepted 0 bytes");
      offset += size;
      if (size < chunk.length || !last) continue;
      break;
    } while (offset < bytes.length);
    return offset;
  }

  /**
   * device_read, repeated until the instrument signals END (or the termination character) or
   * `maxBytes` is reached; the chunks are joined. `timeoutMs` bounds the whole read. A blocking
   * read (e.g. the answer to `*OPC?` during a sweep) simply waits up to that long.
   */
  async read(options: Vxi11ReadOptions = {}): Promise<Vxi11ReadResult> {
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "read");
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_READ_BYTES) {
      throw new RangeError(`maxBytes must be an integer from 1 to ${DEFAULT_MAX_READ_BYTES}, got ${maxBytes}`);
    }
    const deadline = Date.now() + timeoutMs;
    const chunks: Buffer[] = [];
    let total = 0;
    let end = false;
    while (!end && total < maxBytes) {
      const remainingMs = Math.max(0, deadline - Date.now());
      const requestSize = Math.min(maxBytes - total, MAX_READ_CHUNK);
      // (link, requestSize, io_timeout, lock_timeout, flags, termChar)
      const args = new XdrWriter().u32(this.linkId).u32(requestSize).u32(remainingMs).u32(0).u32(0).u32(0).toBuffer();
      const reply = await this.call(PROC_DEVICE_READ, args, remainingMs, "device_read");
      const { error, reason, data } = parse(reply, "device_read", (r) => {
        const v = { error: r.u32(), reason: r.u32(), data: r.opaque(MAX_READ_CHUNK) };
        r.expectEnd();
        return v;
      });
      if (error !== 0) throw deviceError(error, "device_read");
      if ((reason & ~(REASON_REQCNT | REASON_CHR | REASON_END)) !== 0) throw new Vxi11ProtocolError(`device_read returned unknown reason bits 0x${reason.toString(16)}`);
      if (data.length > requestSize) throw new Vxi11ProtocolError(`device_read returned ${data.length} bytes but only ${requestSize} were requested`);
      end = (reason & (REASON_END | REASON_CHR)) !== 0;
      if (data.length === 0 && !end) throw new Vxi11ProtocolError("device_read returned no data and no END");
      chunks.push(data);
      total += data.length;
    }
    return { data: Buffer.concat(chunks, total), end };
  }

  /** device_readstb: the IEEE 488.1 status byte (0-255). */
  async readStb(options: { timeoutMs?: number } = {}): Promise<number> {
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "readStb");
    const args = new XdrWriter().u32(this.linkId).u32(0).u32(0).u32(timeoutMs).toBuffer();
    const reply = await this.call(PROC_DEVICE_READSTB, args, timeoutMs, "device_readstb");
    const { error, stb } = parse(reply, "device_readstb", (r) => ({ error: r.u32(), stb: r.u32() }));
    if (error !== 0) throw deviceError(error, "device_readstb");
    if (stb > 255) throw new Vxi11ProtocolError(`device_readstb returned a status byte of ${stb}`);
    return stb;
  }

  /** device_clear: clear the instrument's I/O buffers. */
  async clear(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "clear");
    const args = new XdrWriter().u32(this.linkId).u32(0).u32(0).u32(timeoutMs).toBuffer();
    const reply = await this.call(PROC_DEVICE_CLEAR, args, timeoutMs, "device_clear");
    const { error } = parse(reply, "device_clear", (r) => ({ error: r.u32() }));
    if (error !== 0) throw deviceError(error, "device_clear");
  }

  /**
   * destroy_link (best effort, bounded by closeTimeoutMs) and close the connection. Idempotent,
   * never rejects; calls pending on this client reject with {@link Vxi11ClosedError}.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    if (!this.rpc.closed) {
      try {
        await this.rpc.call(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, PROC_DESTROY_LINK, new XdrWriter().u32(this.linkId).toBuffer(), {
          timeoutMs: this.closeTimeoutMs,
        });
      } catch {
        // best effort: the link dies with the connection anyway
      }
    }
    this.closedReason = "the client was closed";
    this.rpc.close();
  }

  private async call(procedure: number, args: Buffer, ioTimeoutMs: number, name: string): Promise<XdrReader> {
    if (this.closed || this.closing) throw new Vxi11ClosedError(`${name} on a closed VXI-11 client`);
    try {
      const reply = await this.rpc.call(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, procedure, args, { timeoutMs: ioTimeoutMs + this.rpcMarginMs });
      // A close() issued while this call was in flight wins, whatever the instrument answered.
      if (this.closing) throw new Vxi11ClosedError(`${name} aborted: the VXI-11 client was closed`);
      return reply;
    } catch (err) {
      if (err instanceof Vxi11ClosedError) throw err;
      if (this.closedReason !== undefined || this.closing) throw new Vxi11ClosedError(`${name} aborted: the VXI-11 client was closed`, { cause: err });
      throw rpcFailure(err, name, false);
    }
  }
}

function randomClientId(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Map an RPC-layer failure to the VXI-11 error taxonomy. */
function rpcFailure(err: unknown, operation: string, connecting: boolean): Vxi11Error {
  if (err instanceof Vxi11Error) return err;
  const detail = `VXI-11 ${operation}: ${errMessage(err)}`;
  if (connecting && err instanceof RpcError) return new Vxi11ConnectError(detail, { cause: err });
  if (err instanceof RpcProtocolError) return new Vxi11ProtocolError(detail, { cause: err });
  if (err instanceof RpcClosedError || err instanceof RpcTimeoutError || err instanceof RpcError) return new Vxi11TransportError(detail, { cause: err });
  return new Vxi11TransportError(detail, { cause: err });
}

/** Parse a reply with a strict XDR reader; malformed or truncated replies become Vxi11ProtocolError. */
function parse<T>(reply: XdrReader, operation: string, fn: (r: XdrReader) => T): T {
  try {
    const value = fn(reply);
    if (reply.remaining !== 0) throw new XdrError(`${reply.remaining} unexpected trailing bytes`);
    return value;
  } catch (err) {
    if (err instanceof XdrError) throw new Vxi11ProtocolError(`VXI-11 ${operation}: malformed reply: ${err.message}`, { cause: err });
    throw err;
  }
}
