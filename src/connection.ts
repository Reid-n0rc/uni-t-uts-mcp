import * as net from "node:net";
import { parseBlock } from "./blocks.js";

/**
 * Raw SCPI over TCP (port 5025 verified on the UTS3036B, see
 * docs/verified-hardware.md). Commands are LF-terminated; replies end in LF.
 * Unsupported queries get no reply at all, so every query has a timeout.
 *
 * All traffic goes through one serialized queue so a command is never written
 * in the middle of a pending query.
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
const LF = 0x0a;
const CR = 0x0d;

const NOT_CONNECTED =
  "Not connected to the spectrum analyzer. Use the 'connect' tool first.";

export interface ConnectOptions {
  connectTimeoutMs?: number;
  identTimeoutMs?: number;
  /** How long to wait for the `*OPC?` reply that syncs each command (default 3000). */
  opcTimeoutMs?: number;
  /** Quiet period after a timed-out query, measured from when it was sent (default 2500). */
  recoveryMs?: number;
}

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
  /** Commands only: the `*OPC?` has been written and its reply is awaited. */
  waitingForSync: boolean;
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
  private socket: net.Socket | null = null;
  private host = "";
  private port = DEFAULT_PORT;
  private buffer = Buffer.alloc(0);
  private jobs: Job[] = [];
  private active: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The terminator (LF or CRLF) of a binary block may arrive after the payload was
   * resolved. `any`: nothing seen yet; `lf`: a CR was seen, an LF should follow.
   */
  private pendingTerminator: "none" | "any" | "lf" = "none";
  private opcTimeoutMs = DEFAULT_OPC_TIMEOUT;
  private recoveryMs = DEFAULT_RECOVERY_MS;
  private holdUntil = 0;
  private lastQueryTimeoutAt = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the socket went away unexpectedly (null after connect() or an explicit disconnect()). */
  private lostReason: string | null = null;

  async connect(
    host: string,
    port: number = DEFAULT_PORT,
    options: ConnectOptions = {}
  ): Promise<string> {
    if (this.socket) this.disconnect();
    this.host = host;
    this.port = port;
    this.opcTimeoutMs = options.opcTimeoutMs ?? DEFAULT_OPC_TIMEOUT;
    this.recoveryMs = options.recoveryMs ?? DEFAULT_RECOVERY_MS;
    this.lastQueryTimeoutAt = 0;

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = new net.Socket();
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Connection failed: timeout connecting to ${host}:${port}`));
      }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT);
      s.once("error", (err) => {
        clearTimeout(timer);
        s.destroy();
        reject(new Error(`Connection failed: ${err.message}`));
      });
      s.connect(port, host, () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        resolve(s);
      });
    });

    this.socket = socket;
    this.lostReason = null;
    socket.setNoDelay(true);
    this.buffer = Buffer.alloc(0);
    this.pendingTerminator = "none";
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => {
      if (this.socket === socket) this.lose(err.message);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.lose("closed by the instrument or the network");
    });

    try {
      return await this.query("*IDN?", options.identTimeoutMs ?? DEFAULT_IDENT_TIMEOUT);
    } catch (err) {
      this.disconnect();
      throw new Error(
        `Connected but failed to initialize: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  disconnect(): void {
    this.lostReason = null;
    this.closeAll("Connection closed");
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
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
    return this.isConnected() ? `${this.host}:${this.port}` : "Not connected";
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
      this.jobs.push({ kind, cmd, timeoutMs, sync, expectSilence, waitingForSync: false, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.jobs.length === 0 || !this.socket) return;

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
    this.buffer = Buffer.alloc(0);

    if (job.kind !== "command") {
      this.timer = setTimeout(() => {
        // The instrument is probably stalled by an unsupported query; keep clear of it.
        if (!job.expectSilence) {
          this.holdUntil = Date.now() + Math.max(0, this.recoveryMs - job.timeoutMs);
          this.lastQueryTimeoutAt = Date.now();
        }
        this.failActive(
          new Error(
            `${job.kind === "binary" ? "Binary query" : "Query"} timeout after ${job.timeoutMs}ms for command: ${job.cmd}`
          )
        );
      }, job.timeoutMs);
    }

    this.socket.write(job.cmd + "\n", (err) => {
      if (this.active !== job) return;
      if (err) {
        this.failActive(new Error(`Write failed: ${err.message}`));
      } else if (job.kind === "command") {
        if (!job.sync) {
          this.finishActive(undefined);
        } else {
          // Wait until the instrument has dealt with the command before writing anything else.
          job.waitingForSync = true;
          this.timer = setTimeout(() => {
            this.failActive(
              new Error(`Timeout waiting for the instrument to finish command (*OPC?): ${job.cmd}`)
            );
          }, this.opcTimeoutMs);
          this.socket?.write("*OPC?\n", (opcErr) => {
            if (opcErr && this.active === job) this.failActive(new Error(`Write failed: ${opcErr.message}`));
          });
        }
      }
    });
  }

  private finishActive(value: Buffer | string | void): void {
    const job = this.active;
    if (!job) return;
    this.clearTimer();
    this.active = null;
    job.resolve(value);
    this.pump();
  }

  private failActive(err: Error): void {
    const job = this.active;
    if (!job) return;
    this.clearTimer();
    this.active = null;
    this.buffer = Buffer.alloc(0);
    job.reject(err);
    this.pump();
  }

  /** The socket failed or was closed by the other side: fail everything, naming the command in flight. */
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
    const pending = this.jobs.splice(0);
    const job = this.active;
    this.active = null;
    this.clearTimer();
    this.holdUntil = 0;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    }
    job?.reject(new Error(activeMessage ?? message));
    for (const j of pending) j.reject(new Error(message));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- replies ----------

  private stripPendingTerminator(data: Buffer): Buffer {
    let i = 0;
    if (this.pendingTerminator === "any" && data.length > 0) {
      if (data[0] === CR) {
        i = 1;
        this.pendingTerminator = "lf";
      } else {
        if (data[0] === LF) i = 1;
        this.pendingTerminator = "none";
      }
    }
    if (this.pendingTerminator === "lf" && i < data.length) {
      if (data[i] === LF) i++;
      this.pendingTerminator = "none";
    }
    return data.subarray(i);
  }

  private onData(chunk: Buffer): void {
    const data = this.stripPendingTerminator(chunk);
    this.buffer = Buffer.concat([this.buffer, data]);
    const job = this.active;
    if (!job) return;

    if (job.kind === "command") {
      if (job.waitingForSync && this.buffer.indexOf(LF) >= 0) this.finishActive(undefined);
      return;
    }

    if (job.kind === "text") {
      const end = this.buffer.indexOf(LF);
      if (end >= 0) this.finishActive(this.buffer.subarray(0, end).toString("utf-8").trim());
      return;
    }

    const result = parseBlock(this.buffer);
    if (result.status === "ok") {
      // Remember how much of the terminator still has to arrive so it is not read as a reply.
      this.pendingTerminator =
        result.terminator === "none" ? "any" : result.terminator === "cr" ? "lf" : "none";
      this.finishActive(result.data);
    } else if (result.status === "invalid") {
      this.failActive(new Error(`Expected a binary block reply: ${result.reason}`));
    }
  }
}

// Singleton used by the tool modules.
export const connection = new UtsConnection();
