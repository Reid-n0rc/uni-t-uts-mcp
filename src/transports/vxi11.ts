import { parseBlock } from "../blocks.js";
import {
  Vxi11Client,
  Vxi11ClosedError,
  Vxi11ConnectError,
  Vxi11DeviceError,
  Vxi11Error,
  Vxi11IoTimeoutError,
  Vxi11RpcTimeoutError,
  Vxi11TransportError,
} from "../vxi11/client.js";
import { DEFAULT_VXI11_DEVICE, VXI11_PROBE_ENV, isValidDeviceName } from "./select.js";
import { DEFAULT_ATTEMPTS, DEFAULT_BACKOFF_MS, planAttempts, sleep } from "../vxi11/retry.js";
import {
  TransportTimeout,
  type OpenOptions,
  type Transport,
  type TransportCapabilities,
} from "./transport.js";

/**
 * SCPI over VXI-11 (TCP/IP-IEEE 488.1), core channel only, on top of {@link Vxi11Client}.
 *
 * Capability flags, all confirmed on the UTS3036B (docs/verified-hardware.md, "VXI-11 transport", issue #75):
 * the instrument QUEUES commands that arrive during a sweep instead of dropping them, a blocking `*OPC?` read
 * is the sweep-complete signal, bursts of commands need no `*OPC?` pacing, and no line is lost after a
 * timed-out query. They are explicit constants on purpose: change them HERE if another firmware differs
 * (nothing else needs to change: the connection layer and src/acquisition.ts read the flags, not the
 * transport name).
 */
export const VXI11_CAPABILITIES: TransportCapabilities = {
  /** device_write returns once the instrument accepted the line, so no `*OPC?` after each command. */
  syncsCommands: false,
  /** Commands issued during a single sweep are queued and answered when it ends. */
  dropsInputDuringSweep: false,
  /** After an unsupported query nothing sent later is lost: the instrument itself delays the next write while it is busy. */
  holdOffAfterTimeout: false,
  /** Screenshots of 200 KB and 4 MB arrive complete (issues #42, #20). */
  completeLargeBlocks: true,
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
  /** I/O timeout of a device_write in ms (default 5000). */
  writeTimeoutMs?: number;
  /** Total time for open() including retries (default three times the connect timeout). */
  connectBudgetMs?: number;
  /** Pause after the first failed open attempt, doubling afterwards (default 500 ms). */
  connectBackoffMs?: number;
  /** Time allowed for the status poll that proves a new link answers (default 3000 ms, at most the per-attempt time). */
  linkCheckTimeoutMs?: number;
}

/** Errors of an open attempt that another attempt may cure: unreachable, slow, dropped, out of resources, locked, stale. */
function retryableOpenError(err: unknown): boolean {
  if (err instanceof Vxi11ClosedError) return false;
  if (err instanceof Vxi11ConnectError || err instanceof Vxi11TransportError || err instanceof Vxi11IoTimeoutError) return true;
  return err instanceof Vxi11DeviceError && (err.code === 9 || err.code === 11);
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
  /** destroy_link calls started by close() and not finished yet. */
  private readonly closing = new Set<Promise<void>>();

  constructor(private readonly options: Vxi11TransportOptions = {}) {
    this.device = options.device ?? DEFAULT_VXI11_DEVICE;
    if (!isValidDeviceName(this.device)) {
      throw new Error("Invalid VXI-11 device name: expected 1-64 characters from letters, digits and . _ , -");
    }
    this.label = `VXI-11 (device ${this.device})`;
  }

  /**
   * Opens the core channel (portmapper lookup, create_link); the TCP port of `options` is not used.
   *
   * Issue #127: a cold connect to the portmapper over a routed path can need seconds, and a link left over from
   * a previous process can stop answering. So an attempt is retried (bounded: three attempts within the total
   * budget, doubling pauses) and each new link must answer a status poll (device_readstb: no side effects, no
   * command is sent) before it is used; a link that does not is destroyed and replaced. Nothing the user sent
   * is ever replayed: open() runs before any command, and write() never retries.
   */
  async open(options: OpenOptions): Promise<void> {
    this.close();
    const budget = options.connectBudgetMs ?? this.options.connectBudgetMs ?? options.connectTimeoutMs * DEFAULT_ATTEMPTS;
    const plan = planAttempts(budget, DEFAULT_ATTEMPTS, this.options.connectBackoffMs ?? DEFAULT_BACKOFF_MS);
    const checkMs = Math.min(this.options.linkCheckTimeoutMs ?? 3000, plan.perAttemptMs);
    let lastError: unknown;
    for (let n = 1; n <= plan.attempts; n++) {
      let client: Vxi11Client | undefined;
      try {
        client = await Vxi11Client.connect(options.host, {
          device: this.device,
          portmapperPort: this.options.portmapperPort,
          connectTimeoutMs: plan.perAttemptMs,
          rpcMarginMs: this.options.rpcMarginMs ?? RPC_MARGIN_MS,
        });
        try {
          await client.readStb({ timeoutMs: checkMs });
        } catch (err) {
          if (err instanceof Vxi11ClosedError || !(err instanceof Vxi11Error)) throw err;
          throw new Vxi11TransportError(`the instrument did not answer a status poll on the new VXI-11 link (${errMessage(err)})`, { cause: err });
        }
        this.client = client;
        return;
      } catch (err) {
        lastError = err;
        if (client) this.track(client.close());
        if (!retryableOpenError(err) || n === plan.attempts) {
          const retried =
            n > 1 || retryableOpenError(err)
              ? ` (after ${n} attempt${n === 1 ? "" : "s"} of ${plan.perAttemptMs} ms; a slow routed path may need a longer ${VXI11_PROBE_ENV})`
              : "";
          throw new Error(`Connection failed: ${errMessage(err)}${retried}`);
        }
        await sleep(plan.backoffsMs[n - 1]);
      }
    }
    throw new Error(`Connection failed: ${errMessage(lastError)}`);
  }

  close(): void {
    const client = this.client;
    this.client = null;
    this.busyUntil = 0;
    // Best effort destroy_link; close() never rejects. Pending calls reject with "Connection closed".
    if (client) this.track(client.close());
  }

  async drain(): Promise<void> {
    await Promise.all([...this.closing]);
  }

  private track(closing: Promise<void>): void {
    const done = closing.then(
      () => void this.closing.delete(done),
      () => void this.closing.delete(done)
    );
    this.closing.add(done);
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
      await client.write(line, { timeoutMs: (this.options.writeTimeoutMs ?? WRITE_TIMEOUT_MS) + busyMs, end: true });
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
    if (op === "write" && err instanceof Vxi11TransportError) {
      // The line may or may not have reached the instrument: report it as lost, never resend it.
      const reason = `VXI-11: ${errMessage(err)}; the command may or may not have reached the instrument and was not resent`;
      this.lose(reason);
      return new Error(reason);
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
