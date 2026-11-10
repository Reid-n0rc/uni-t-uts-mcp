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
 * Time allowed on top of an I/O timeout before a device_read or device_write counts as unanswered.
 * The UTS3036B does not honor the I/O timeout of a read that has nothing to deliver: it never answers
 * (no error 15) and drops the request silently about a second after the I/O timeout, so the RPC
 * deadline is what ends a timed-out query. Kept short so a timeout is reported close to the one asked
 * for; the instrument is still occupied by the abandoned read for up to a second, which only delays
 * the next device_write (it is not lost).
 */
const RPC_MARGIN_MS = 500;
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
      await client.write(line, { timeoutMs: WRITE_TIMEOUT_MS, end: true });
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
    try {
      const result = await client.read({ timeoutMs: io, maxBytes: MAX_REPLY_BYTES });
      if (!result.end) throw new Error(`VXI-11 reply longer than ${MAX_REPLY_BYTES} bytes without an end marker`);
      return result.data;
    } catch (err) {
      throw this.mapError(client, err, "read", timeoutMs);
    }
  }

  /** Translate a client error: timeouts, a closed client, a lost link, or a plain error naming VXI-11. */
  private mapError(client: Vxi11Client, err: unknown, op: "read" | "write", timeoutMs = 0): Error {
    if (this.client !== client || err instanceof Vxi11ClosedError) return new Error("Connection closed");
    if (err instanceof Vxi11IoTimeoutError && op === "read") return new TransportTimeout(timeoutMs);
    // The usual timeout on this instrument: no reply at all, the link itself is fine.
    if (err instanceof Vxi11RpcTimeoutError && op === "read") return new TransportTimeout(timeoutMs);
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
