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
const DEFAULT_BINARY_TIMEOUT = 30000;
const LF = 0x0a;

const NOT_CONNECTED =
  "Not connected to the spectrum analyzer. Use the 'connect' tool first.";

export interface ConnectOptions {
  connectTimeoutMs?: number;
  identTimeoutMs?: number;
}

type JobKind = "command" | "text" | "binary";

interface Job {
  kind: JobKind;
  cmd: string;
  timeoutMs: number;
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
  /** A binary block's trailing LF may arrive after the payload was resolved; drop it. */
  private dropLeadingLF = false;

  async connect(
    host: string,
    port: number = DEFAULT_PORT,
    options: ConnectOptions = {}
  ): Promise<string> {
    if (this.socket) this.disconnect();
    this.host = host;
    this.port = port;

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
    this.buffer = Buffer.alloc(0);
    this.dropLeadingLF = false;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => this.failActive(new Error(`Socket error: ${err.message}`)));
    socket.on("close", () => {
      if (this.socket === socket) this.closeAll("Connection closed unexpectedly");
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
    this.closeAll("Connection closed");
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  getConnectionInfo(): string {
    return this.isConnected() ? `${this.host}:${this.port}` : "Not connected";
  }

  async sendCommand(cmd: string): Promise<void> {
    await this.enqueue("command", cmd, 0);
  }

  async query(cmd: string, timeoutMs: number = DEFAULT_QUERY_TIMEOUT): Promise<string> {
    return (await this.enqueue("text", cmd, timeoutMs)) as string;
  }

  async queryBinary(cmd: string, timeoutMs: number = DEFAULT_BINARY_TIMEOUT): Promise<Buffer> {
    return (await this.enqueue("binary", cmd, timeoutMs)) as Buffer;
  }

  // ---------- queue ----------

  private enqueue(kind: JobKind, cmd: string, timeoutMs: number): Promise<Buffer | string | void> {
    if (!this.isConnected()) return Promise.reject(new Error(NOT_CONNECTED));
    try {
      validateCommand(cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.jobs.push({ kind, cmd, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.jobs.length === 0 || !this.socket) return;
    const job = this.jobs.shift()!;
    this.active = job;
    this.buffer = Buffer.alloc(0);

    if (job.kind !== "command") {
      this.timer = setTimeout(() => {
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
        this.finishActive(undefined);
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

  private closeAll(message: string): void {
    const pending = this.jobs.splice(0);
    const job = this.active;
    this.active = null;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    }
    job?.reject(new Error(message));
    for (const j of pending) j.reject(new Error(message));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- replies ----------

  private onData(chunk: Buffer): void {
    let data = chunk;
    if (this.dropLeadingLF && data.length > 0) {
      this.dropLeadingLF = false;
      if (data[0] === LF) data = data.subarray(1);
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    const job = this.active;
    if (!job || job.kind === "command") return;

    if (job.kind === "text") {
      const end = this.buffer.indexOf(LF);
      if (end >= 0) this.finishActive(this.buffer.subarray(0, end).toString("utf-8").trim());
      return;
    }

    const result = parseBlock(this.buffer);
    if (result.status === "ok") {
      // If the terminating LF has not arrived yet, remember to drop it when it does.
      const headerLength = 2 + (this.buffer[1] - 0x30);
      const lfConsumed = result.consumed > headerLength + result.data.length;
      this.dropLeadingLF = !lfConsumed;
      this.finishActive(result.data);
    } else if (result.status === "invalid") {
      this.failActive(new Error(`Expected a binary block reply: ${result.reason}`));
    }
  }
}

// Singleton used by the tool modules.
export const connection = new UtsConnection();
