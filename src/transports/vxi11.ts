import { parseBlock } from "../blocks.js";
import {
  Vxi11Client,
  Vxi11ClosedError,
  Vxi11DeviceError,
  Vxi11IoTimeoutError,
  Vxi11RpcTimeoutError,
  Vxi11TransportError,
} from "../vxi11/client.js";
import { DEFAULT_VXI11_DEVICE, isValidDeviceName } from "./select.js";
import {
  TransportTimeout,
  type OpenOptions,
  type Transport,
  type TransportCapabilities,
} from "./transport.js";

/**
 * SCPI over VXI-11 (TCP/IP-IEEE 488.1), core channel only, on top of {@link Vxi11Client}.
 *
 * Capability flags. They follow the prototype findings on the UTS3036B (see
 * docs/verified-hardware.md): over VXI-11 the instrument QUEUES commands that arrive during a sweep
 * instead of dropping them, and a blocking `*OPC?` read is the sweep-complete signal. These are
 * explicit constants on purpose: hardware verification (issue #75) may show that a VXI-11 session
 * still needs `*OPC?` pacing after commands (`syncsCommands: true`) or a quiet period after a timed
 * out query (`holdOffAfterTimeout: true`). Change them HERE (nothing else needs to change: the
 * connection layer and src/acquisition.ts read the flags, not the transport name).
 */
export const VXI11_CAPABILITIES: TransportCapabilities = {
  /** device_write returns once the instrument accepted the line, so no `*OPC?` after each command. */
  syncsCommands: false,
  /** Commands issued during a single sweep are queued and answered when it ends. */
  dropsInputDuringSweep: false,
  /** No stall after unsupported queries has been seen over VXI-11 (an I/O timeout error 15 is returned). */
  holdOffAfterTimeout: false,
};

/** I/O timeout of a device_write, in ms (the instrument accepts writes in 1 to 2 ms). */
const WRITE_TIMEOUT_MS = 5000;
/** Upper bound for what one reply may be (the largest real reply is a 144,800 byte screenshot). */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/**
 * Time allowed on top of the requested timeout before a device_read or device_write counts as unanswered.
 *
 * Measured on the UTS3036B: a device_read that has nothing to deliver is NEVER answered with error 15.
 * The instrument keeps waiting for 5.4 times the io_timeout it was given, then drops the request without
 * a reply, and it serves no other call on that link (a device_write is delayed, not lost) until it has
 * given up. A zero io_timeout never returns data (error 15 at once). So the transport sends a fifth of the
 * requested timeout as io_timeout (the instrument then waits about 1.08 times the timeout, long enough to
 * deliver anything that arrives in time and short enough to be free again about when we give up) and ends
 * a timed-out query with the RPC deadline: the requested timeout plus this margin.
 */
const RPC_MARGIN_MS = 500;
const READ_IO_FRACTION = 0.2;
/** The instrument is busy with an abandoned read for about this many times its io_timeout. */
const READ_BUSY_FACTOR = 5.5;
const MAX_IO_TIMEOUT_MS = 0xffffffff;

export interface Vxi11TransportOptions {
  /** VXI-11 logical device name (default inst0). */
  device?: string;
  /** Portmapper port (default 111); tests point it at a fake. */
  portmapperPort?: number;
  /** Extra time past an I/O timeout before an unanswered call fails (default 500 ms, see RPC_MARGIN_MS). */
  rpcMarginMs?: number;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Vxi11Transport implements Transport {
  readonly name = "vxi11" as const;
  readonly label: string;
  readonly capabilities: TransportCapabilities = VXI11_CAPABILITIES;
  private readonly device: string;
  private client: Vxi11Client | null = null;
  private lostCallback: ((reason: string) => void) | null = null;
  /** The instrument is busy with a read nobody waits for until this time (ms since the epoch). */
  private busyUntil = 0;

  constructor(private readonly options: Vxi11TransportOptions = {}) {
    this.device = options.device ?? DEFAULT_VXI11_DEVICE;
    if (!isValidDeviceName(this.device)) {
      throw new Error("Invalid VXI-11 device name: expected 1-64 characters from letters, digits and . _ , -");
    }
    this.label = `VXI-11 (device ${this.device})`;
  }

  /** Opens the core channel (portmapper lookup, create_link); the TCP port of `options` is not used. */
  async open(options: OpenOptions): Promise<void> {
    this.close();
    try {
      this.client = await Vxi11Client.connect(options.host, {
        device: this.device,
        portmapperPort: this.options.portmapperPort,
        connectTimeoutMs: options.connectTimeoutMs,
        rpcMarginMs: this.options.rpcMarginMs ?? RPC_MARGIN_MS,
      });
    } catch (err) {
      throw new Error(`Connection failed: ${errMessage(err)}`);
    }
  }

  close(): void {
    const client = this.client;
    this.client = null;
    this.busyUntil = 0;
    // Best effort destroy_link; close() never rejects. Pending calls reject with "Connection closed".
    void client?.close();
  }

  isOpen(): boolean {
    const client = this.client;
    if (!client) return false;
    if (client.closed) {
      // The instrument or the network ended the connection while idle: report it as a loss.
      this.lose("VXI-11: the connection was closed by the instrument or the network");
      return false;
    }
    return true;
  }

  onLost(callback: (reason: string) => void): void {
    this.lostCallback = callback;
  }

  async write(line: string): Promise<void> {
    const client = this.requireClient();
    try {
      // A write queues behind an abandoned read: allow for the time the instrument is still busy with it.
      const busyMs = Math.max(0, this.busyUntil - Date.now());
      await client.write(line, { timeoutMs: WRITE_TIMEOUT_MS + busyMs, end: true });
    } catch (err) {
      throw this.mapError(client, err, "write");
    }
  }

  async readLine(timeoutMs: number): Promise<string> {
    const data = await this.readReply(timeoutMs);
    return data.toString("utf-8").trim();
  }

  async readBlock(timeoutMs: number): Promise<Buffer> {
    const data = await this.readReply(timeoutMs);
    const result = parseBlock(data);
    if (result.status === "ok") return result.data;
    throw new Error(
      `Expected a binary block reply: ${result.status === "invalid" ? result.reason : "the reply ended before the block was complete"}`
    );
  }

  /**
   * Nothing to do over VXI-11. Measured on the UTS3036B: the output buffer has ONE slot (a newer reply
   * replaces an unread older one, also one that is still queued behind a sweep) and the instrument
   * drops the reply of a read that gave up, so a stale reply can never be mistaken for the answer to
   * the next query. A zero-timeout device_read cannot be used to flush anyway: the instrument answers
   * it with error 15 without delivering waiting data, and it blocks behind an abandoned read.
   */
  discardInput(): void {}

  // ---------- internals ----------

  private requireClient(): Vxi11Client {
    if (!this.client) throw new Error("Connection closed");
    return this.client;
  }

  private async readReply(timeoutMs: number): Promise<Buffer> {
    const client = this.requireClient();
    const io = Math.min(Math.max(0, Math.ceil(timeoutMs)), MAX_IO_TIMEOUT_MS);
    const started = Date.now();
    try {
      const result = await client.read({ timeoutMs: io, maxBytes: MAX_REPLY_BYTES, ioTimeoutFraction: READ_IO_FRACTION });
      if (!result.end) throw new Error(`VXI-11 reply longer than ${MAX_REPLY_BYTES} bytes without an end marker`);
      return result.data;
    } catch (err) {
      throw this.mapError(client, err, "read", timeoutMs, started);
    }
  }

  /** Translate a client error: timeouts, a closed client, a lost link, or a plain error naming VXI-11. */
  private mapError(client: Vxi11Client, err: unknown, op: "read" | "write", timeoutMs = 0, started = 0): Error {
    if (this.client !== client || err instanceof Vxi11ClosedError) return new Error("Connection closed");
    if (err instanceof Vxi11IoTimeoutError && op === "read") return new TransportTimeout(timeoutMs);
    // The usual timeout on this instrument: no reply at all, the link itself is fine.
    if (err instanceof Vxi11RpcTimeoutError && op === "read") {
      this.busyUntil = Math.max(this.busyUntil, started + Math.ceil(timeoutMs * READ_IO_FRACTION) * READ_BUSY_FACTOR);
      return new TransportTimeout(timeoutMs);
    }
    if (err instanceof Vxi11TransportError || (err instanceof Vxi11DeviceError && (err.code === 4 || err.code === 6))) {
      const reason = `VXI-11: ${errMessage(err)}`;
      this.lose(reason);
      return new Error(reason);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private lose(reason: string): void {
    const client = this.client;
    if (!client) return;
    this.close();
    this.lostCallback?.(reason);
  }
}
