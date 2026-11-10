import { parseBlock } from "../blocks.js";
import {
  Vxi11Client,
  Vxi11ClosedError,
  Vxi11DeviceError,
  Vxi11IoTimeoutError,
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
/** Most stale replies discarded before a write. */
const MAX_DRAIN_READS = 8;
const MAX_IO_TIMEOUT_MS = 0xffffffff;

export interface Vxi11TransportOptions {
  /** VXI-11 logical device name (default inst0). */
  device?: string;
  /** Portmapper port (default 111); tests point it at a fake. */
  portmapperPort?: number;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Vxi11Transport implements Transport {
  readonly name = "vxi11" as const;
  readonly label: string;
  readonly capabilities: TransportCapabilities = VXI11_CAPABILITIES;
  private readonly device: string;
  private client: Vxi11Client | null = null;
  private lostCallback: ((reason: string) => void) | null = null;
  /** A query was written and its reply not read yet: it may still be queued in the instrument. */
  private awaitingReply = false;
  /** Read away such a reply before the next write. */
  private needDrain = false;

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
      });
    } catch (err) {
      throw new Error(`Connection failed: ${errMessage(err)}`);
    }
    this.awaitingReply = false;
    this.needDrain = false;
  }

  close(): void {
    const client = this.client;
    this.client = null;
    this.awaitingReply = false;
    this.needDrain = false;
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
    if (this.needDrain) await this.drain(client);
    try {
      await client.write(line, { timeoutMs: WRITE_TIMEOUT_MS, end: true });
    } catch (err) {
      throw this.mapError(client, err, "write");
    }
    this.awaitingReply = line.includes("?");
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
   * Over VXI-11 unread replies wait in the instrument, not in a local buffer. When a query was
   * written and its reply never read (it timed out), the next write first reads the leftover away
   * with a zero timeout, so it cannot be taken for the answer to the next query.
   */
  discardInput(): void {
    if (this.awaitingReply) this.needDrain = true;
    this.awaitingReply = false;
  }

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
      this.awaitingReply = false;
      return result.data;
    } catch (err) {
      throw this.mapError(client, err, "read", timeoutMs);
    }
  }

  private async drain(client: Vxi11Client): Promise<void> {
    this.needDrain = false;
    for (let i = 0; i < MAX_DRAIN_READS; i++) {
      try {
        await client.read({ timeoutMs: 0, maxBytes: MAX_REPLY_BYTES });
      } catch (err) {
        if (err instanceof Vxi11IoTimeoutError) return; // nothing left
        throw this.mapError(client, err, "write");
      }
    }
  }

  /** Translate a client error: timeouts, a closed client, a lost link, or a plain error naming VXI-11. */
  private mapError(client: Vxi11Client, err: unknown, op: "read" | "write", timeoutMs = 0): Error {
    if (this.client !== client || err instanceof Vxi11ClosedError) return new Error("Connection closed");
    if (err instanceof Vxi11IoTimeoutError && op === "read") return new TransportTimeout(timeoutMs);
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
