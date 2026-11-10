/**
 * Minimal VXI-11 (TCP/IP-IEEE 488.1) core-channel client over {@link RpcClient}: create_link,
 * device_write, device_read, device_readstb, device_clear and destroy_link, plus the interrupt
 * channel (create_intr_chan, device_enable_srq, destroy_intr_chan; see {@link IntrServer}). On the UTS3036B
 * the interrupt channel is accepted but never used (docs/verified-hardware.md, "VXI-11 SRQ").
 *
 * Replies come from the network and are untrusted: every field is validated, sizes are capped, the
 * server dropping the connection mid-call rejects the call, and every call has a deadline (the
 * instrument's I/O timeout plus a margin), so no promise is ever left pending.
 */
import * as net from "node:net";
import { IntrServer, localAddressFor, MAX_SRQ_HANDLE, VXI11_INTR_PROGRAM, VXI11_INTR_VERSION } from "./interrupt.js";
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
export const PROC_DEVICE_ENABLE_SRQ = 20;
export const PROC_DESTROY_LINK = 23;
export const PROC_CREATE_INTR_CHAN = 25;
export const PROC_DESTROY_INTR_CHAN = 26;

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
/** Default cap on RPC calls made by one read() or write() (a hostile server could answer 1 byte at a time). */
export const DEFAULT_MAX_CALLS = 10_000;
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
/**
 * No RPC reply arrived within the deadline (the I/O timeout plus the RPC margin) although the
 * connection is still open. The UTS3036B never answers a device_read that has nothing to deliver
 * (no error 15), so this is how a "query timeout" shows up on a live link.
 */
export class Vxi11RpcTimeoutError extends Vxi11TransportError {}
/** The reply violated the protocol (malformed, out of range, never terminating). */
export class Vxi11ProtocolError extends Vxi11Error {}
/** waitForSrq gave up: no device_intr_srq arrived in time. */
export class Vxi11SrqTimeoutError extends Vxi11Error {}
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
  /** Cap on device_write calls for this write, chunks plus partial-write retries (default 10000 plus the chunk count). */
  maxCalls?: number;
}

export interface Vxi11ReadOptions {
  /** Overall time allowed for the whole read, in ms (default 5000); the call also gives up after the deadline passes between chunks. */
  timeoutMs?: number;
  /** Stop after this many bytes even without END (default 16 MiB). */
  maxBytes?: number;
  /** Cap on device_read calls for this read (default 10000). */
  maxCalls?: number;
  /**
   * Send only this fraction (0 < f <= 1, default 1) of the remaining time as the io_timeout of each
   * device_read, while the RPC deadline still covers all of it plus the margin. For instruments that wait
   * a multiple of the io_timeout before giving up silently (the UTS3036B waits 5.4 times as long).
   */
  ioTimeoutFraction?: number;
}

export interface Vxi11SrqOptions {
  /** Local IPv4 address to listen on and to tell the instrument (default: the address the OS uses to reach it). */
  bindAddress?: string;
  /** Local TCP port for the listener (default: an ephemeral one). */
  port?: number;
  /** Handle (up to 40 bytes) the instrument echoes in each device_intr_srq (default: 4 random bytes). */
  handle?: Uint8Array;
  /** Timeout for create_intr_chan and device_enable_srq in ms (default 5000). */
  timeoutMs?: number;
}

export interface Vxi11SrqInfo {
  /** Address advertised to the instrument. */
  address: string;
  port: number;
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
  private intr: { server: IntrServer; handle: Buffer; info: Vxi11SrqInfo; unsubscribe: () => void } | undefined;
  private enabling = false;
  private srqTotal = 0;
  private srqPending = 0;
  private readonly srqWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly srqListeners = new Set<() => void>();

  private constructor(
    private readonly rpc: RpcClient,
    readonly linkId: number,
    /** Largest device_write the instrument accepts (from create_link). */
    readonly maxRecvSize: number,
    /** Abort channel port reported by create_link (unused). */
    readonly abortPort: number,
    private readonly rpcMarginMs: number,
    private readonly closeTimeoutMs: number,
    private readonly host: string
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
        throw new Vxi11ConnectError(`VXI-11 portmapper lookup on ${host} (port ${options.portmapperPort ?? PMAP_PORT}) failed: ${errMessage(err)}`, { cause: err });
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
      return new Vxi11Client(rpc, linkId, maxRecvSize, abortPort, rpcMarginMs, closeTimeoutMs, host);
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
    const maxCalls = checkCalls(options.maxCalls, DEFAULT_MAX_CALLS + Math.ceil(bytes.length / this.maxRecvSize));
    const deadline = Date.now() + timeoutMs;
    let offset = 0;
    for (let calls = 0; ; calls++) {
      if (calls >= maxCalls) throw new Vxi11ProtocolError(`device_write needed more than ${maxCalls} calls to send ${bytes.length} bytes`);
      const { ioMs, rpcMs } = this.budget(deadline, calls > 0, "device_write");
      const chunk = bytes.subarray(offset, offset + this.maxRecvSize);
      const last = offset + chunk.length >= bytes.length;
      const args = new XdrWriter()
        .u32(this.linkId)
        .u32(ioMs)
        .u32(0)
        .u32(last && end ? FLAG_END : 0)
        .opaque(chunk)
        .toBuffer();
      const reply = await this.call(PROC_DEVICE_WRITE, args, rpcMs, "device_write");
      const { error, size } = parse(reply, "device_write", (r) => ({ error: r.u32(), size: r.u32() }));
      if (error !== 0) throw deviceError(error, "device_write");
      if (size > chunk.length) throw new Vxi11ProtocolError(`device_write reported ${size} bytes written but only ${chunk.length} were sent`);
      if (size === 0 && chunk.length > 0) throw new Vxi11ProtocolError("device_write accepted 0 bytes");
      offset += size;
      if (offset >= bytes.length && (size === chunk.length || chunk.length === 0)) return offset;
    }
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
    const maxCalls = checkCalls(options.maxCalls, DEFAULT_MAX_CALLS);
    const fraction = options.ioTimeoutFraction ?? 1;
    if (!(fraction > 0 && fraction <= 1)) throw new RangeError(`ioTimeoutFraction must be greater than 0 and at most 1, got ${fraction}`);
    const deadline = Date.now() + timeoutMs;
    const chunks: Buffer[] = [];
    let total = 0;
    let end = false;
    for (let calls = 0; !end && total < maxBytes; calls++) {
      if (calls >= maxCalls) throw new Vxi11ProtocolError(`device_read needed more than ${maxCalls} calls without END (${total} bytes so far)`);
      const { ioMs, rpcMs } = this.budget(deadline, calls > 0, "device_read", fraction);
      const requestSize = Math.min(maxBytes - total, MAX_READ_CHUNK);
      // (link, requestSize, io_timeout, lock_timeout, flags, termChar)
      const args = new XdrWriter().u32(this.linkId).u32(requestSize).u32(ioMs).u32(0).u32(0).u32(0).toBuffer();
      const reply = await this.call(PROC_DEVICE_READ, args, rpcMs, "device_read");
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

  /**
   * Time budget for one call of a multi-call operation: the I/O timeout is the time left until
   * `deadline` (at least 1 ms after the first call; 0 on the first call only if the caller asked for
   * 0), and the RPC deadline never extends past `deadline + rpcMarginMs`. Past the deadline,
   * later calls are refused with {@link Vxi11IoTimeoutError}.
   */
  private budget(deadline: number, later: boolean, name: string, fraction = 1): { ioMs: number; rpcMs: number } {
    const now = Date.now();
    if (later && now >= deadline) throw new Vxi11IoTimeoutError(15, `${name} (overall timeout exceeded)`);
    const remaining = Math.max(later ? 1 : 0, deadline - now);
    const ioMs = fraction === 1 ? remaining : Math.max(remaining > 0 ? 1 : 0, Math.ceil(remaining * fraction));
    return { ioMs, rpcMs: remaining + this.rpcMarginMs };
  }

  /** device_readstb: the IEEE 488.1 status byte (0-255). */
  async readStb(options: { timeoutMs?: number } = {}): Promise<number> {
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "readStb");
    const args = new XdrWriter().u32(this.linkId).u32(0).u32(0).u32(timeoutMs).toBuffer();
    const reply = await this.call(PROC_DEVICE_READSTB, args, timeoutMs + this.rpcMarginMs, "device_readstb");
    const { error, stb } = parse(reply, "device_readstb", (r) => ({ error: r.u32(), stb: r.u32() }));
    if (error !== 0) throw deviceError(error, "device_readstb");
    if (stb > 255) throw new Vxi11ProtocolError(`device_readstb returned a status byte of ${stb}`);
    return stb;
  }

  /** True while the interrupt channel is established and SRQ is enabled. */
  get srqEnabled(): boolean {
    return this.intr !== undefined;
  }

  /** Total device_intr_srq interrupts received for this client's handle since enableSrq. */
  get srqCount(): number {
    return this.srqTotal;
  }

  /** Address and port of the interrupt listener (undefined unless SRQ is enabled). */
  get srqInfo(): Vxi11SrqInfo | undefined {
    return this.intr?.info;
  }

  /** Diagnostic counters of the interrupt listener (connections from the instrument, rejected peers). */
  get srqStats(): IntrServer["stats"] | undefined {
    return this.intr?.server.stats;
  }

  /**
   * Establish the interrupt channel and enable SRQ: start a local listener (one interface, only the
   * instrument allowed), create_intr_chan pointing at it, then device_enable_srq. On any failure
   * everything already done is undone. The instrument connects back to the listener when it
   * raises a service request, so the listener's address must be routable from the instrument and
   * the OS firewall must let the connection in.
   */
  async enableSrq(options: Vxi11SrqOptions = {}): Promise<Vxi11SrqInfo> {
    this.assertOpen("enableSrq");
    if (this.intr || this.enabling) throw new Vxi11Error("SRQ is already enabled on this link");
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "enableSrq");
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new RangeError(`invalid port ${options.port}`);
    if (options.handle !== undefined && options.handle.length > MAX_SRQ_HANDLE) throw new RangeError(`handle must be at most ${MAX_SRQ_HANDLE} bytes`);
    if (options.bindAddress !== undefined && !net.isIPv4(options.bindAddress)) throw new RangeError(`bindAddress must be an IPv4 address, got "${options.bindAddress}"`);
    this.enabling = true;
    let server: IntrServer | undefined;
    let channel = false;
    try {
      let address = options.bindAddress;
      if (address === undefined) {
        try {
          address = await localAddressFor(this.host);
        } catch (err) {
          throw new Vxi11ConnectError(`no local address routes to ${this.host}: ${errMessage(err)}`, { cause: err });
        }
        if (!net.isIPv4(address)) throw new Vxi11ConnectError(`the local address for ${this.host} is not IPv4 (${address}); pass bindAddress`);
      }
      const peer = net.isIPv4(this.host) ? this.host : await resolvePeer(this.host);
      server = await IntrServer.listen({ bindAddress: address, allowedPeers: [peer], port: options.port });
      const handle = options.handle ? Buffer.from(options.handle) : Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
      const hostAddr = address.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
      // (hostAddr, hostPort, progNum, progVers, progFamily TCP) -> error
      const createArgs = new XdrWriter().u32(hostAddr).u32(server.port).u32(VXI11_INTR_PROGRAM).u32(VXI11_INTR_VERSION).u32(0).toBuffer();
      const created = parse(await this.call(PROC_CREATE_INTR_CHAN, createArgs, timeoutMs + this.rpcMarginMs, "create_intr_chan"), "create_intr_chan", (r) => r.u32());
      if (created !== 0) throw deviceError(created, "create_intr_chan");
      channel = true;
      const enableArgs = new XdrWriter().u32(this.linkId).bool(true).opaque(handle, MAX_SRQ_HANDLE).toBuffer();
      const enabled = parse(await this.call(PROC_DEVICE_ENABLE_SRQ, enableArgs, timeoutMs + this.rpcMarginMs, "device_enable_srq"), "device_enable_srq", (r) => r.u32());
      if (enabled !== 0) throw deviceError(enabled, "device_enable_srq");
      if (this.closing || this.closed) throw new Vxi11ClosedError("enableSrq aborted: the VXI-11 client was closed");
      const unsubscribe = server.onSrq((h) => {
        if (h.equals(handle)) this.onInterrupt();
      });
      this.srqTotal = 0;
      this.srqPending = 0;
      this.intr = { server, handle, info: { address: server.address, port: server.port }, unsubscribe };
      return this.intr.info;
    } catch (err) {
      if (channel) await this.destroyIntrChannel(timeoutMs);
      await server?.close();
      throw err;
    } finally {
      this.enabling = false;
    }
  }

  private onInterrupt(): void {
    this.srqTotal++;
    const waiter = this.srqWaiters.values().next().value;
    if (waiter) {
      this.srqWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    } else {
      this.srqPending++;
    }
    for (const l of [...this.srqListeners]) {
      try {
        l();
      } catch {
        // listener failures are not the transport's problem
      }
    }
  }

  /** Call `listener` for every interrupt received. Returns an unsubscribe function. */
  onSrq(listener: () => void): () => void {
    this.srqListeners.add(listener);
    return () => this.srqListeners.delete(listener);
  }

  /** Forget interrupts that arrived but were not waited for. */
  clearSrq(): void {
    this.srqPending = 0;
  }

  /**
   * Wait for one interrupt (consuming a buffered one if it already arrived). Rejects with
   * {@link Vxi11SrqTimeoutError} after `timeoutMs`, or {@link Vxi11ClosedError} when the client closes.
   */
  waitForSrq(options: { timeoutMs?: number } = {}): Promise<void> {
    let timeoutMs: number;
    try {
      timeoutMs = checkTimeout(options.timeoutMs, 5000, "waitForSrq");
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.closed || this.closing) return Promise.reject(new Vxi11ClosedError("waitForSrq on a closed VXI-11 client"));
    if (!this.intr) return Promise.reject(new Vxi11Error("SRQ is not enabled on this link (call enableSrq first)"));
    if (this.srqPending > 0) {
      this.srqPending--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.srqWaiters.delete(waiter);
          reject(new Vxi11SrqTimeoutError(`no VXI-11 service request (device_intr_srq) arrived within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.srqWaiters.add(waiter);
    });
  }

  /** device_enable_srq(false), destroy_intr_chan and stop the listener. Idempotent; the first failure is thrown after cleanup. */
  async disableSrq(options: { timeoutMs?: number } = {}): Promise<void> {
    const intr = this.intr;
    if (!intr) return;
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "disableSrq");
    this.intr = undefined;
    intr.unsubscribe();
    this.rejectSrqWaiters(new Vxi11Error("SRQ was disabled while waiting"));
    let failure: unknown;
    if (!this.closed && !this.closing) {
      try {
        const args = new XdrWriter().u32(this.linkId).bool(false).opaque(intr.handle, MAX_SRQ_HANDLE).toBuffer();
        const code = parse(await this.call(PROC_DEVICE_ENABLE_SRQ, args, timeoutMs + this.rpcMarginMs, "device_enable_srq"), "device_enable_srq", (r) => r.u32());
        if (code !== 0) failure = deviceError(code, "device_enable_srq(false)");
      } catch (err) {
        failure = err;
      }
      await this.destroyIntrChannel(timeoutMs);
    }
    await intr.server.close();
    if (failure) throw failure;
  }

  /** Best effort destroy_intr_chan. */
  private async destroyIntrChannel(timeoutMs: number): Promise<void> {
    try {
      await this.call(PROC_DESTROY_INTR_CHAN, Buffer.alloc(0), timeoutMs + this.rpcMarginMs, "destroy_intr_chan");
    } catch {
      // the channel dies with the link anyway
    }
  }

  private rejectSrqWaiters(err: Error): void {
    for (const w of [...this.srqWaiters]) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.srqWaiters.clear();
  }

  private assertOpen(name: string): void {
    if (this.closed || this.closing) throw new Vxi11ClosedError(`${name} on a closed VXI-11 client`);
  }

  /** device_clear: clear the instrument's I/O buffers. */
  async clear(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = checkTimeout(options.timeoutMs, 5000, "clear");
    const args = new XdrWriter().u32(this.linkId).u32(0).u32(0).u32(timeoutMs).toBuffer();
    const reply = await this.call(PROC_DEVICE_CLEAR, args, timeoutMs + this.rpcMarginMs, "device_clear");
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
    this.rejectSrqWaiters(new Vxi11ClosedError("waitForSrq aborted: the VXI-11 client was closed"));
    const intr = this.intr;
    this.intr = undefined;
    if (intr) {
      intr.unsubscribe();
      if (!this.rpc.closed) {
        try {
          const args = new XdrWriter().u32(this.linkId).bool(false).opaque(intr.handle, MAX_SRQ_HANDLE).toBuffer();
          await this.rpc.call(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, PROC_DEVICE_ENABLE_SRQ, args, { timeoutMs: this.closeTimeoutMs });
          await this.rpc.call(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, PROC_DESTROY_INTR_CHAN, Buffer.alloc(0), { timeoutMs: this.closeTimeoutMs });
        } catch {
          // best effort
        }
      }
      await intr.server.close();
    }
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

  private async call(procedure: number, args: Buffer, rpcTimeoutMs: number, name: string): Promise<XdrReader> {
    if (this.closed || this.closing) throw new Vxi11ClosedError(`${name} on a closed VXI-11 client`);
    try {
      const reply = await this.rpc.call(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, procedure, args, { timeoutMs: rpcTimeoutMs });
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

function checkCalls(value: number | undefined, fallback: number): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`maxCalls must be a positive integer, got ${v}`);
  return v;
}

function randomClientId(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/** Resolve a host name to the IPv4 address the instrument will call back from (the one we connected to). */
async function resolvePeer(host: string): Promise<string> {
  const { lookup } = await import("node:dns/promises");
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch (err) {
    throw new Vxi11ConnectError(`cannot resolve ${host} to an IPv4 address: ${errMessage(err)}`, { cause: err });
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Map an RPC-layer failure to the VXI-11 error taxonomy. */
function rpcFailure(err: unknown, operation: string, connecting: boolean): Vxi11Error {
  if (err instanceof Vxi11Error) return err;
  const detail = `VXI-11 ${operation}: ${errMessage(err)}`;
  if (connecting && err instanceof RpcError) return new Vxi11ConnectError(detail, { cause: err });
  if (err instanceof RpcProtocolError) return new Vxi11ProtocolError(detail, { cause: err });
  if (err instanceof RpcTimeoutError) return new Vxi11RpcTimeoutError(detail, { cause: err });
  if (err instanceof RpcClosedError || err instanceof RpcError) return new Vxi11TransportError(detail, { cause: err });
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
