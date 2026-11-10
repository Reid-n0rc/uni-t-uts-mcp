import { connection } from "./connection.js";
import { queryNumber } from "./instrument.js";

// Sweep synchronisation, verified on the UTS3036B (docs/verified-hardware.md, "Acquisition"):
// while a single sweep runs the instrument IGNORES every line it receives (nothing is queued, an
// `*OPC?` sent then never gets a reply, not even after the sweep ends), and `*OPC?` does not block.
// The sweep takes about `:SENSe:SWEep:TIME?`. So: send `:INITiate:IMMediate` without the usual
// `*OPC?` sync, stay silent for the sweep time, then poll `*OPC?`; the first reply means the sweep ended.
//
// Over VXI-11 the instrument QUEUES commands during a sweep and a blocking `*OPC?` read answers `1`
// when the sweep ends (docs/verified-hardware.md, "VXI-11"). The method is chosen by the transport's
// `dropsInputDuringSweep` capability flag, never by the transport name: a transport that drops input
// uses the silent-then-poll method above, one that queues input writes `*OPC?` once and reads with
// timeout = remaining sweep time + margin.

export class SweepTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    /** Set for the blocking `*OPC?` method: names the transport in the message. */
    blockingOver?: string
  ) {
    super(
      `Timed out: the sweep did not complete within ${(timeoutMs / 1000).toFixed(1)} s ` +
        (blockingOver ? `(no reply to the blocking *OPC? read over ${blockingOver})` : "(no reply to the *OPC? polling)")
    );
    this.name = "SweepTimeoutError";
  }
}

export type StartMethod = "immediate" | "restart";
const START_COMMANDS: Record<StartMethod, string> = { immediate: ":INITiate:IMMediate", restart: ":INITiate:RESTart" };

export interface WaitOptions {
  /** Expected sweep time in s; defaults to the sweep started by `startSweep`, else polling only. */
  sweepTimeS?: number;
  /** Give up this long after the call (default: remaining sweep time + 10 s). */
  timeoutMs?: number;
  /** Timeout of each `*OPC?` poll (default 300 ms). */
  pollTimeoutMs?: number;
  /** Quiet time after the reply so a late duplicate reply cannot be mistaken for another (default 100 ms). */
  settleMs?: number;
}

interface Pending { startedAt: number; expectedMs: number }
let pending: Pending | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read the sweep time (s) via `:SENSe:SWEep:TIME?` (reply has a trailing space). */
export async function readSweepTimeS(): Promise<number> {
  return queryNumber(":SENSe:SWEep:TIME?");
}

/** True while a sweep started by `startSweep` has not been waited for. */
export function hasPendingSweep(): boolean {
  return pending !== null;
}

/**
 * Clear the error queue, read the sweep time, and start a sweep without `*OPC?` sync (the instrument
 * would ignore it). Follow with `waitForSweepComplete` before sending anything else.
 */
export async function startSweep(method: StartMethod): Promise<{ sweepTimeS: number }> {
  await connection.sendCommand("*CLS");
  const sweepTimeS = await readSweepTimeS();
  pending = { startedAt: Date.now(), expectedMs: sweepTimeS * 1000 };
  try {
    await connection.sendCommand(START_COMMANDS[method], { sync: false });
  } catch (err) {
    pending = null;
    throw err;
  }
  pending.startedAt = Date.now();
  return { sweepTimeS };
}

/** Wait until the instrument answers again, i.e. the single sweep has ended. Throws SweepTimeoutError. */
export async function waitForSweepComplete(options: WaitOptions = {}): Promise<{ waitedMs: number }> {
  const called = Date.now();
  const p = pending;
  const startedAt = p?.startedAt ?? called;
  const expectedMs = options.sweepTimeS !== undefined ? options.sweepTimeS * 1000 : p?.expectedMs ?? 0;
  const remaining = Math.max(0, startedAt + expectedMs - called);
  const timeoutMs = options.timeoutMs ?? remaining + 10_000;
  const deadline = called + timeoutMs;
  const blocking = !connection.capabilities.dropsInputDuringSweep;
  const pollTimeoutMs = options.pollTimeoutMs ?? 300;
  const settleMs = options.settleMs ?? 100;

  try {
    if (blocking) return await waitBlocking(called, timeoutMs);
    // Stay silent: anything sent during the sweep is lost.
    await sleep(Math.max(0, Math.min(remaining - 50, timeoutMs)));
    for (;;) {
      try {
        const reply = await connection.query("*OPC?", pollTimeoutMs, { expectSilence: true });
        if (reply.trim() === "1") break;
      } catch (err) {
        if (!(err instanceof Error && /timeout/i.test(err.message))) throw err;
      }
      if (Date.now() >= deadline) throw new SweepTimeoutError(timeoutMs);
      await sleep(50);
    }
    await sleep(settleMs);
    return { waitedMs: Date.now() - called };
  } finally {
    pending = null;
  }
}

/**
 * Blocking `*OPC?` sweep wait for transports that queue input during a sweep (VXI-11): one query with
 * a timeout of the whole wait; the instrument answers `1` when the sweep ends. No silent period, no
 * polling, no settle time (nothing late can arrive).
 */
async function waitBlocking(called: number, timeoutMs: number): Promise<{ waitedMs: number }> {
  let reply: string;
  try {
    reply = await connection.query("*OPC?", Math.max(1, Math.ceil(timeoutMs)), { expectSilence: true });
  } catch (err) {
    if (err instanceof Error && /timeout/i.test(err.message)) throw new SweepTimeoutError(timeoutMs, "VXI-11");
    throw err;
  }
  if (reply.trim() !== "1") {
    throw new Error(`Unexpected reply to *OPC? while waiting for the sweep: ${JSON.stringify(reply)} (expected 1)`);
  }
  return { waitedMs: Date.now() - called };
}
