import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Exclusive instrument sessions. The analyzer has ONE command stream, a global error queue and
 * (while a single sweep runs) ignores every line it receives, so a tool's whole sequence of
 * commands and queries must not interleave with another tool's. Node runs concurrent MCP tool
 * calls concurrently, so every tool runs inside `run()`: a FIFO mutex.
 *
 * Calls made from inside a session (helpers such as `applyCommands`, or a tool calling another
 * helper that itself asks for a session) must not wait for the session they are part of. The
 * current session is tracked with AsyncLocalStorage, which follows awaits, timers and callbacks,
 * so no handle needs to be passed around.
 */

/** Default wait for the lock; generous because `single_sweep` can hold it for the whole sweep. */
export const DEFAULT_BUSY_TIMEOUT_MS = 120_000;
export const BUSY_TIMEOUT_ENV = "UTS_BUSY_TIMEOUT_S";

/** Wait limit from `UTS_BUSY_TIMEOUT_S` (seconds, > 0); anything else gives the default. */
export function busyTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BUSY_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUSY_TIMEOUT_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_BUSY_TIMEOUT_MS;
}

export class InstrumentBusyError extends Error {
  constructor(
    public readonly waitedMs: number,
    public readonly holder: string | undefined
  ) {
    super(
      `Instrument busy: waited ${waitedMs / 1000} s for another tool call${holder ? ` (${holder})` : ""} to finish and gave up. ` +
        "Tool calls are run one at a time per instrument, and a long operation such as single_sweep blocks the others while it runs. " +
        `Retry in a moment, or raise the wait limit with the ${BUSY_TIMEOUT_ENV} environment variable (seconds).`
    );
    this.name = "InstrumentBusyError";
  }
}

export interface RunOptions {
  /** Longest wait for the lock in ms (default: the lock's `defaultTimeoutMs`). */
  timeoutMs?: number;
  /** Who is asking (a tool name), used in the busy message of the callers that are kept waiting. */
  label?: string;
}

interface Waiter {
  start: () => void;
  fail: (err: Error) => void;
  label: string | undefined;
}

const sessions = new AsyncLocalStorage<ReadonlySet<SessionLock>>();

export class SessionLock {
  private holder: { label: string | undefined } | null = null;
  private queue: Waiter[] = [];

  /** `defaultTimeoutMs` is read at each call so the limit can follow the environment. */
  constructor(private readonly defaultTimeoutMs: () => number = () => DEFAULT_BUSY_TIMEOUT_MS) {}

  get held(): boolean {
    return this.holder !== null;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** True inside `run()` of this lock (including nested async work started from it). */
  inSession(): boolean {
    return sessions.getStore()?.has(this) === true;
  }

  async run<T>(fn: () => Promise<T> | T, options: RunOptions = {}): Promise<T> {
    // Nested call from inside the session that already holds the lock: just run.
    if (this.inSession()) return fn();
    await this.acquire(options);
    try {
      const outer = sessions.getStore();
      const inner = new Set(outer ?? []);
      inner.add(this);
      return await sessions.run(inner, fn);
    } finally {
      this.release();
    }
  }

  /** Fail every queued session (the running one is not touched); used when the connection goes away. */
  rejectWaiters(err: Error): void {
    const queued = this.queue;
    this.queue = [];
    for (const w of queued) w.fail(err);
  }

  private acquire(options: RunOptions): Promise<void> {
    if (!this.holder && this.queue.length === 0) {
      this.holder = { label: options.label };
      return Promise.resolve();
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        label: options.label,
        start: () => {
          clearTimeout(timer);
          this.holder = { label: options.label };
          resolve();
        },
        fail: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        reject(new InstrumentBusyError(timeoutMs, this.holder?.label));
      }, timeoutMs);
      timer.unref?.();
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.holder = null;
    this.queue.shift()?.start();
  }
}
