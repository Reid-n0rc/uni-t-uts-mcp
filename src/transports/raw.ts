import * as net from "node:net";
import { parseBlock } from "../blocks.js";
import {
  TransportTimeout,
  type OpenOptions,
  type Transport,
  type TransportCapabilities,
} from "./transport.js";

/**
 * Raw SCPI over TCP (port 5025 verified on the UTS3036B, see docs/verified-hardware.md).
 * Lines are LF-terminated; replies end in LF or CRLF. Unsupported queries get no reply at all.
 */

const LF = 0x0a;
const CR = 0x0d;

export const RAW_CAPABILITIES: TransportCapabilities = {
  syncsCommands: true,
  dropsInputDuringSweep: true,
  holdOffAfterTimeout: true,
  /** The instrument stops after 144,800 bytes of a large reply (issue #42). */
  completeLargeBlocks: false,
};

export class RawTransport implements Transport {
  readonly name = "raw" as const;
  readonly label = "raw SCPI over TCP";
  readonly capabilities: TransportCapabilities = RAW_CAPABILITIES;
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  /**
   * The terminator (LF or CRLF) of a binary block may arrive after the payload was
   * returned. `any`: nothing seen yet; `lf`: a CR was seen, an LF should follow.
   */
  private pendingTerminator: "none" | "any" | "lf" = "none";
  private lostCallback: ((reason: string) => void) | null = null;
  private poll: (() => void) | null = null;
  private abort: ((err: Error) => void) | null = null;

  async open(options: OpenOptions): Promise<void> {
    this.close();
    const { host, port, connectTimeoutMs } = options;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = new net.Socket();
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Connection failed: timeout connecting to ${host}:${port}`));
      }, connectTimeoutMs);
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
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    }
    this.abort?.(new Error("Connection closed"));
  }

  isOpen(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  onLost(callback: (reason: string) => void): void {
    this.lostCallback = callback;
  }

  write(line: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("Connection closed"));
    return new Promise((resolve, reject) => {
      socket.write(line + "\n", (err) => (err ? reject(err) : resolve()));
    });
  }

  readLine(timeoutMs: number): Promise<string> {
    return this.read(timeoutMs, () => {
      const end = this.buffer.indexOf(LF);
      return end >= 0 ? this.buffer.subarray(0, end).toString("utf-8").trim() : undefined;
    });
  }

  readBlock(timeoutMs: number): Promise<Buffer> {
    return this.read(timeoutMs, () => {
      const result = parseBlock(this.buffer);
      if (result.status === "ok") {
        // Remember how much of the terminator still has to arrive so it is not read as a reply.
        this.pendingTerminator =
          result.terminator === "none" ? "any" : result.terminator === "cr" ? "lf" : "none";
        return result.data;
      }
      if (result.status === "invalid") {
        throw new Error(`Expected a binary block reply: ${result.reason}`);
      }
      return undefined;
    });
  }

  discardInput(): void {
    this.buffer = Buffer.alloc(0);
  }

  // ---------- internals ----------

  /** Wait until `extract` returns a value (it is retried whenever data arrives) or throws. */
  private read<T>(timeoutMs: number, extract: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.poll = null;
        this.abort = null;
      };
      const timer = setTimeout(() => {
        done();
        reject(new TransportTimeout(timeoutMs));
      }, timeoutMs);
      const attempt = () => {
        try {
          const value = extract();
          if (value !== undefined) {
            done();
            resolve(value);
          }
        } catch (err) {
          done();
          reject(err);
        }
      };
      this.poll = attempt;
      this.abort = (err) => {
        done();
        reject(err);
      };
      attempt();
    });
  }

  private lose(reason: string): void {
    this.close();
    this.lostCallback?.(reason);
  }

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
    this.buffer = Buffer.concat([this.buffer, this.stripPendingTerminator(chunk)]);
    this.poll?.();
  }
}
