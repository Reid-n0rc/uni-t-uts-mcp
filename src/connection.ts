import { instruments } from "./registry.js";
import { SessionLock, busyTimeoutFromEnv, type RunOptions } from "./sessionLock.js";
import { RawTransport } from "./transports/raw.js";
import {
  DEFAULT_VXI11_DEVICE,
  isValidDeviceName,
  parseTransportChoice,
  probeVxi11,
  type TransportChoice,
} from "./transports/select.js";
import { Vxi11Transport } from "./transports/vxi11.js";
import {
  TransportTimeout,
  type Transport,
  type TransportCapabilities,
  type TransportFactory,
  type TransportName,
} from "./transports/transport.js";

/**
 * SCPI connection to the analyzer. The wire (raw SCPI over TCP port 5025, verified on the
 * UTS3036B, see docs/verified-hardware.md) lives behind a `Transport` (src/transports/); this
 * class adds what is common to every transport: one serialized queue so a command is never
 * written in the middle of a pending query, query timeouts (unsupported queries get no reply at
 * all), the hold-off after a timed-out query, `*OPC?` command pacing (when the transport's
 * `syncsCommands` capability asks for it) and the user facing error messages.
 *
 * Individual commands and queries are serialized by the queue, but a tool's whole sequence
 * (`*CLS`, setters, error drain, readback...) must also not interleave with another tool's, so
 * tools run inside `runExclusive()`: a FIFO exclusive-session lock per connection, independent of
 * the transport (see src/sessionLock.ts and `defineTool` in src/tools/util.ts).
 *
 * Which transport `connect()` uses (raw SCPI, VXI-11, or `auto`) comes from `ConnectOptions.transport`;
 * error messages name the transport whenever it is not raw.
 */

export const DEFAULT_PORT = 5025;
const DEFAULT_CONNECT_TIMEOUT = 5000;
const DEFAULT_IDENT_TIMEOUT = 5000;
const DEFAULT_QUERY_TIMEOUT = 5000;
const DEFAULT_OPC_TIMEOUT = 3000;
/**
 * After an unsupported query the UTS3036B stalls for about 2.15 s and drops the lines it
 * receives in that window, so the next job waits until this long after the failed query.
 */
const DEFAULT_RECOVERY_MS = 2500;
const DEFAULT_BINARY_TIMEOUT = 30000;

const NOT_CONNECTED =
  "Not connected to the spectrum analyzer. Use the 'connect' tool first.";

export interface ConnectOptions {
  connectTimeoutMs?: number;
  identTimeoutMs?: number;
  /** How long to wait for the `*OPC?` reply that syncs each command (default 3000). */
  opcTimeoutMs?: number;
  /** Quiet period after a timed-out query, measured from when it was sent (default 2500). */
  recoveryMs?: number;
  /** raw (default), vxi11, or auto: VXI-11 when the portmapper registers it, else raw. Ignored when the connection was built with a transport factory. */
  transport?: TransportChoice;
  /** VXI-11 logical device name (default inst0). */
  vxi11Device?: string;
  /** Portmapper port used for VXI-11 and the auto probe (default 111; tests use a fake). */
  vxi11PortmapperPort?: number;
  /** Total time for reaching VXI-11 (portmapper probe or open, retries included); default three times the connect timeout. From `UTS_VXI11_PROBE_TIMEOUT_S`. */
  vxi11ProbeBudgetMs?: number;
  /** Receives a message when `auto` falls back to raw. */
  log?: (message: string) => void;
}

/** How a transport is named in error messages (raw is the unmarked default). */
const TRANSPORT_DISPLAY: Record<TransportName, string> = { raw: "raw TCP", vxi11: "VXI-11" };

export interface QueryOptions {
  /**
   * The caller expects silence (polling an instrument that ignores input while it sweeps): a timeout
   * neither holds off the next job nor counts as a failed query for `msSinceQueryTimeout()`.
   */
  expectSilence?: boolean;
}

export interface CommandOptions {
  /** Wait for `*OPC?` after the command so lines are never written back-to-back (default true). */
  sync?: boolean;
}

type JobKind = "command" | "text" | "binary";

interface Job {
  kind: JobKind;
  cmd: string;
  timeoutMs: number;
  /** Commands only: follow with `*OPC?` and wait for its reply. */
  sync: boolean;
  expectSilence: boolean;
  resolve: (value: Buffer | string | void) => void;
  reject: (reason: Error) => void;
}

/** Refuse anything that could end the message early or smuggle a second command. */
function validateCommand(cmd: string): void {
  if (/[^\x20-\x7e\t]/.test(cmd)) {
    throw new Error(
      "Command contains a control character, line terminator (CR/LF) or non-ASCII character; refusing to send"
    );
  }
}

export class UtsConnection {
  private transport: Transport | null = null;
  private host = "";
  private port = DEFAULT_PORT;
  private jobs: Job[] = [];
  private active: Job | null = null;
  private opcTimeoutMs = DEFAULT_OPC_TIMEOUT;
  private recoveryMs = DEFAULT_RECOVERY_MS;
  private holdUntil = 0;
  private lastQueryTimeoutAt = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the link went away unexpectedly (null after connect() or an explicit disconnect()). */
  private lostReason: string | null = null;
  /** How the transport was chosen, when that was not explicit (`auto`); shown by `transportLabel`. */
  private selectionNote = "";
  /** The exclusive-session lock; its wait limit follows UTS_BUSY_TIMEOUT_S (default 120 s). */
  private readonly lock = new SessionLock(() => this.busyTimeoutMs);

  /**
   * `createTransport`, when given, makes the transport for every `connect()` and the `transport`
   * option is ignored (tests and embedders); otherwise `connect()` picks raw, VXI-11 or auto.
   */
  constructor(private readonly createTransport?: TransportFactory) {}

  /** Name of the transport in use (null when not connected). */
  get transportName(): TransportName | null {
    return this.transport?.name ?? null;
  }

  /** Description of the transport in use for `connect`/`identify` output, e.g. "VXI-11 (device inst0)". */
  get transportLabel(): string {
    return this.transport ? this.transport.label + this.selectionNote : "not connected";
  }

  /** " (over VXI-11)" for a non-raw transport, "" for raw (raw messages stay as they always were). */
  private get via(): string {
    const t = this.transport;
    return t && t.name !== "raw" ? ` (over ${TRANSPORT_DISPLAY[t.name]})` : "";
  }

  /**
   * Capability flags of the current transport (of a fresh one when not connected), so callers can
   * adapt to the wire instead of checking which transport is in use.
   */
  get capabilities(): TransportCapabilities {
    return (this.transport ?? this.createTransport?.() ?? new RawTransport()).capabilities;
  }

  async connect(
    host: string,
    port: number = DEFAULT_PORT,
    options: ConnectOptions = {}
  ): Promise<string> {
    const choice = parseTransportChoice(options.transport ?? "raw", "transport");
    const device = options.vxi11Device ?? DEFAULT_VXI11_DEVICE;
    if (!isValidDeviceName(device)) {
      throw new Error("Invalid VXI-11 device name: expected 1-64 characters from letters, digits and . _ , -");
    }
    if (this.transport) this.disconnect();
    this.host = host;
    this.port = port;
    this.opcTimeoutMs = options.opcTimeoutMs ?? DEFAULT_OPC_TIMEOUT;
    this.recoveryMs = options.recoveryMs ?? DEFAULT_RECOVERY_MS;
    this.lastQueryTimeoutAt = 0;
    this.selectionNote = "";
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    const vxi11 = () => new Vxi11Transport({ device, portmapperPort: options.vxi11PortmapperPort, connectBudgetMs: budgetMs });
    const identTimeoutMs = options.identTimeoutMs ?? DEFAULT_IDENT_TIMEOUT;
    const budgetMs = options.vxi11ProbeBudgetMs ?? connectTimeoutMs * 3;

    if (this.createTransport) return this.attach(this.createTransport(), connectTimeoutMs, identTimeoutMs);
    if (choice === "raw") return this.attach(new RawTransport(), connectTimeoutMs, identTimeoutMs);
    if (choice === "vxi11") return this.attach(vxi11(), connectTimeoutMs, identTimeoutMs);

    // auto: VXI-11 when the portmapper registers its core program and it opens, else raw.
    let reason: string;
    const probe = await probeVxi11(host, { portmapperPort: options.vxi11PortmapperPort, budgetMs });
    if (probe.available) {
      try {
        const idn = await this.attach(vxi11(), connectTimeoutMs, identTimeoutMs);
        this.selectionNote = ", selected by auto";
        return idn;
      } catch (err) {
        reason = `VXI-11 is registered but could not be used: ${errorMessage(err)}`;
      }
    } else {
      reason = `VXI-11 is not available: ${probe.reason}`;
    }
    options.log?.(`UTS_TRANSPORT=auto: ${reason}; using the raw transport`);
    try {
      const idn = await this.attach(new RawTransport(), connectTimeoutMs, identTimeoutMs);
      this.selectionNote = `, selected by auto because ${reason}`;
      return idn;
    } catch (err) {
      throw new Error(`Auto transport selection failed. VXI-11: ${reason}. raw: ${errorMessage(err)}`);
    }
  }

  /** Open `transport`, make it the current one and read `*IDN?`. */
  private async attach(transport: Transport, connectTimeoutMs: number, identTimeoutMs: number): Promise<string> {
    await transport.open({ host: this.host, port: this.port, connectTimeoutMs });

    this.transport = transport;
    this.lostReason = null;
    transport.onLost((reason) => {
      if (this.transport === transport) this.lose(reason);
    });

    try {
      return await this.query("*IDN?", identTimeoutMs);
    } catch (err) {
      const via = this.via;
      this.disconnect();
      throw new Error(`Connected${via} but failed to initialize: ${errorMessage(err)}`);
    }
  }

  /** How long a tool call waits for another one before failing with "instrument busy" (ms). */
  get busyTimeoutMs(): number {
    return busyTimeoutFromEnv();
  }

  /**
   * Run `fn` as an exclusive session: no other session runs until it finishes, whether it
   * succeeds, throws, times out or the connection goes away. Sessions start in FIFO order. Calls
   * made from inside `fn` (helpers) join the running session instead of waiting for it. A caller
   * kept waiting longer than `busyTimeoutMs` gets an `InstrumentBusyError`; closing or losing the
   * connection rejects every waiter.
   */
  runExclusive<T>(fn: () => Promise<T> | T, options?: RunOptions): Promise<T> {
    return this.lock.run(fn, options);
  }

  disconnect(): void {
    this.lostReason = null;
    this.closeAll("Connection closed");
  }

  /**
   * Close the connection and wait until the transport has released its link (for VXI-11 the destroy_link
   * call), so a process that exits right after leaves no stale link on the instrument. Idempotent.
   */
  async shutdown(): Promise<void> {
    const transport = this.transport;
    this.disconnect();
    await transport?.drain?.();
  }

  isConnected(): boolean {
    return this.transport !== null && this.transport.isOpen();
  }

  /**
   * Milliseconds since a query last timed out (Infinity if none). An unsupported query makes
   * the instrument post a `-113` error to its error queue about 4 s later, so callers use this
   * to tell such stale errors from ones their own commands caused.
   */
  msSinceQueryTimeout(): number {
    return this.lastQueryTimeoutAt === 0 ? Infinity : Date.now() - this.lastQueryTimeoutAt;
  }

  getConnectionInfo(): string {
    if (!this.isConnected()) return "Not connected";
    return this.transport!.name === "raw" ? `${this.host}:${this.port}` : `${this.host} (${this.transport!.label})`;
  }

  async sendCommand(cmd: string, options: CommandOptions = {}): Promise<void> {
    await this.enqueue("command", cmd, 0, options.sync ?? true);
  }

  async query(
    cmd: string,
    timeoutMs: number = DEFAULT_QUERY_TIMEOUT,
    options: QueryOptions = {}
  ): Promise<string> {
    return (await this.enqueue("text", cmd, timeoutMs, false, options.expectSilence ?? false)) as string;
  }

  async queryBinary(cmd: string, timeoutMs: number = DEFAULT_BINARY_TIMEOUT): Promise<Buffer> {
    return (await this.enqueue("binary", cmd, timeoutMs)) as Buffer;
  }

  // ---------- queue ----------

  private enqueue(
    kind: JobKind,
    cmd: string,
    timeoutMs: number,
    sync = false,
    expectSilence = false
  ): Promise<Buffer | string | void> {
    if (!this.isConnected()) {
      return Promise.reject(
        new Error(
          this.lostReason !== null
            ? `Connection to the spectrum analyzer was lost (${this.lostReason}). Use the 'connect' tool to reconnect.`
            : NOT_CONNECTED
        )
      );
    }
    try {
      validateCommand(cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.jobs.push({ kind, cmd, timeoutMs, sync, expectSilence, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    const transport = this.transport;
    if (this.active || this.jobs.length === 0 || !transport) return;

    const hold = this.holdUntil - Date.now();
    if (hold > 0) {
      if (!this.holdTimer) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this.pump();
        }, hold);
      }
      return;
    }

    const job = this.jobs.shift()!;
    this.active = job;
    transport.discardInput();
    void this.execute(transport, job);
  }

  /** Run one job on the transport and settle it, unless the connection was closed meanwhile. */
  private async execute(transport: Transport, job: Job): Promise<void> {
    try {
      try {
        await transport.write(job.cmd);
      } catch (err) {
        throw new Error(`Write failed${this.via}: ${errorMessage(err)}`);
      }

      if (job.kind === "command") {
        if (job.sync && transport.capabilities.syncsCommands) {
          // Wait until the instrument has dealt with the command before writing anything else.
          try {
            await transport.write("*OPC?");
          } catch (err) {
            throw new Error(`Write failed${this.via}: ${errorMessage(err)}`);
          }
          try {
            await transport.readLine(this.opcTimeoutMs);
          } catch (err) {
            if (err instanceof TransportTimeout) {
              throw new Error(`Timeout waiting for the instrument to finish command (*OPC?)${this.via}: ${job.cmd}`);
            }
            throw err;
          }
        }
        this.finishActive(job, undefined);
        return;
      }

      try {
        this.finishActive(
          job,
          job.kind === "text"
            ? await transport.readLine(job.timeoutMs)
            : await transport.readBlock(job.timeoutMs)
        );
      } catch (err) {
        if (!(err instanceof TransportTimeout)) throw err;
        if (this.active === job) {
          if (!job.expectSilence) {
            // The instrument is probably stalled by an unsupported query; keep clear of it.
            if (transport.capabilities.holdOffAfterTimeout) {
              this.holdUntil = Date.now() + Math.max(0, this.recoveryMs - job.timeoutMs);
            }
            this.lastQueryTimeoutAt = Date.now();
          }
        }
        throw new Error(
          `${job.kind === "binary" ? "Binary query" : "Query"} timeout after ${job.timeoutMs}ms for command: ${job.cmd}${this.via}`
        );
      }
    } catch (err) {
      this.failActive(job, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private finishActive(job: Job, value: Buffer | string | void): void {
    if (this.active !== job) return;
    this.active = null;
    job.resolve(value);
    this.pump();
  }

  private failActive(job: Job, err: Error): void {
    if (this.active !== job) return;
    this.active = null;
    job.reject(err);
    this.pump();
  }

  /** The link failed or was closed by the other side: fail everything, naming the command in flight. */
  private lose(reason: string): void {
    const job = this.active;
    const message = `Connection to the spectrum analyzer was lost (${reason})`;
    this.lostReason = reason;
    this.closeAll(
      message,
      job ? `${message} while ${job.kind === "command" ? "sending" : "querying"} ${job.cmd}` : undefined
    );
  }

  private closeAll(message: string, activeMessage?: string): void {
    const pending = this.jobs;
    const job = this.active;
    this.jobs = [];
    this.active = null;
    this.holdUntil = 0;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.lock.rejectWaiters(new Error(message));
    job?.reject(new Error(activeMessage ?? message));
    for (const j of pending) j.reject(new Error(message));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

instruments.useFactory(() => new UtsConnection());

/**
 * What the tool modules import. It forwards every property to the instrument selected for the running
 * tool call (`instruments.runWith`, set by `defineTool`), else to the default one, so with a single
 * instrument it behaves exactly like the former singleton.
 */
export const connection: UtsConnection = new Proxy({} as UtsConnection, {
  get(_target, prop) {
    const current = instruments.current();
    const value = Reflect.get(current, prop, current);
    return typeof value === "function" ? value.bind(current) : value;
  },
});
