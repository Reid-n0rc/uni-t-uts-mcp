/**
 * Internal transport abstraction under `UtsConnection`.
 *
 * A transport moves SCPI text to and from the instrument and owns everything wire specific:
 * connecting, message framing, terminators and binary block assembly. `UtsConnection` owns what
 * is the same on every wire: the serialized job queue, query timeouts, the hold-off after a
 * timed-out query, `msSinceQueryTimeout`, `expectSilence`, and the user facing error messages.
 *
 * Contract (exercised for every transport by tests/transportContract.ts):
 * - `write` sends one SCPI line (no terminator in `line`; the transport adds its own).
 * - `readLine` / `readBlock` wait for the next reply and reject with `TransportTimeout` after
 *   `timeoutMs`. Only one read is pending at a time.
 * - `discardInput` drops unread input (stale replies) before a new job starts.
 * - If the link fails or is closed by the other side, the callback given to `onLost` is called
 *   once with a short reason, and any pending read rejects. `close()` never calls it.
 */

export interface TransportCapabilities {
  /**
   * Commands must be followed by `*OPC?` and its reply before the next line is written: the
   * instrument does not queue or pace input for us. A transport whose protocol already blocks
   * until the instrument accepted the command (e.g. VXI-11 device_write) sets this to false.
   */
  syncsCommands: boolean;
  /**
   * While a single sweep runs the instrument ignores (drops) input instead of queueing it, so
   * commands and queries sent then are lost and callers must stay silent until the sweep ends.
   * When false, commands are queued by the instrument and a blocking `*OPC?` read can serve as
   * the sweep-complete signal.
   */
  dropsInputDuringSweep: boolean;
  /**
   * After a query times out the instrument may stall and drop what it receives, so the connection
   * keeps quiet for a while before the next job.
   */
  holdOffAfterTimeout: boolean;
  /**
   * Replies of several hundred kilobytes (a screenshot) arrive complete. False on raw TCP, where the
   * instrument stops sending after exactly 144,800 bytes (issue #42); true on VXI-11.
   */
  completeLargeBlocks: boolean;
}

export interface OpenOptions {
  host: string;
  port: number;
  connectTimeoutMs: number;
  /** Total time for opening, retries included (VXI-11: `UTS_VXI11_PROBE_TIMEOUT_S`); default three times `connectTimeoutMs`. */
  connectBudgetMs?: number;
}

/** A read did not complete in time. */
export class TransportTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`No reply within ${timeoutMs}ms`);
    this.name = "TransportTimeout";
  }
}

export type TransportName = "raw" | "vxi11";

export interface Transport {
  /** Which wire this is; error messages name it for every transport except raw. */
  readonly name: TransportName;
  /** Human readable description for `connect`/`identify` output, e.g. "VXI-11 (device inst0)". */
  readonly label: string;
  readonly capabilities: TransportCapabilities;
  /** Rejects with a message starting `Connection failed:`. */
  open(options: OpenOptions): Promise<void>;
  /** Idempotent; releases the link without reporting it as lost. */
  close(): void;
  /** Resolves once everything `close()` started (for VXI-11 the destroy_link calls) has finished; used at process exit. */
  drain?(): Promise<void>;
  isOpen(): boolean;
  /** Register the callback for an unexpected loss of the link (replaces any previous one). */
  onLost(callback: (reason: string) => void): void;
  write(line: string): Promise<void>;
  /** The next reply as one trimmed line of text. */
  readLine(timeoutMs: number): Promise<string>;
  /** The next reply as the payload of one IEEE 488.2 `#` block. */
  readBlock(timeoutMs: number): Promise<Buffer>;
  /** Drop any input received but not yet read. */
  discardInput(): void;
}

export type TransportFactory = () => Transport;
