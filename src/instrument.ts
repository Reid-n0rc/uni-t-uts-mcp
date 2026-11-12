import { connection } from "./connection.js";
import { instruments } from "./registry.js";
import { drainErrorQueue } from "./errors.js";
import { parseBool, parseNumber } from "./scpi.js";
import { ensureModuleOk } from "./moduleGuard.js";

export class InstrumentError extends Error {
  constructor(
    public readonly errors: string[],
    /** The commands that were sent before the errors were read (named in the message). */
    public readonly commands: string[] = []
  ) {
    super(
      `The instrument reported errors: ${errors.join("; ")}` +
        (commands.length > 0 ? ` (after sending: ${commands.join("; ")})` : "")
    );
    this.name = "InstrumentError";
  }
}

/** A reply that could not be parsed. The message names the command and quotes the raw reply. */
export class ReplyError extends Error {
  constructor(
    public readonly command: string,
    public readonly reply: string,
    detail: string
  ) {
    super(`Invalid reply to ${command}: ${detail}`);
    this.name = "ReplyError";
  }
}

/** Query one command and parse the reply strictly; a malformed reply is a ReplyError naming the command. */
export async function queryParsed<T>(command: string, parse: (reply: string) => T): Promise<T> {
  await ensureModuleOk();
  const reply = await connection.query(command);
  try {
    return parse(reply);
  } catch (err) {
    throw new ReplyError(command, reply, err instanceof Error ? err.message : String(err));
  }
}

export const queryNumber = (command: string) => queryParsed(command, parseNumber);
export const queryBool = (command: string) => queryParsed(command, parseBool);

/**
 * Run the readback that follows a setter. The commands were already accepted at that point, so a failure
 * here must not look like a failure to set.
 */
export async function readBack<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The settings were sent and the instrument reported no error, but reading them back failed: ${message}. ` +
        "The settings may already be applied."
    );
  }
}

/** The instrument posts the `-113` for an unsupported query about 4 s after it was sent. */
const STALE_ERROR_WINDOW_MS = 10_000;

function isUndefinedHeader(error: string): boolean {
  return /^\s*-113\b/.test(error);
}

/**
 * Send setter commands and check that the instrument accepted them. Setters give no reply,
 * so rejections (for example `-131,"Invalid suffix"`) only show up in the error queue, which
 * is global to the instrument: it also holds stale errors from earlier unsupported queries.
 * `*CLS` (verified to clear the queue on the UTS3036B) runs first, but an unsupported query
 * posts its `-113 "Undefined header"` late, even after `*CLS`, so `-113` entries are ignored
 * for a short while after a query timeout. A genuinely wrong command is still caught by the
 * tools' readback comparison.
 */
export async function applyCommands(commands: string[]): Promise<void> {
  await ensureModuleOk();
  const sent: string[] = [];
  let inFlight: string | undefined;
  const first = takeFirstSetter();
  try {
    await connection.sendCommand("*CLS");
    if (first) await clearStaleQueue();
    for (const command of commands) {
      inFlight = command;
      await connection.sendCommand(command);
      sent.push(command);
      inFlight = undefined;
    }
    await checkInstrumentErrors(sent, first);
  } catch (err) {
    if (err instanceof InstrumentError) throw err;
    // Nothing was sent, or only *CLS: nothing can be applied.
    if (sent.length === 0 && inFlight === undefined) throw err;
    // Not connected at all: the first command never left.
    if (sent.length === 0 && err instanceof Error && /^Not connected/.test(err.message)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const parts = [message];
    if (sent.length > 0) {
      parts.push(`These commands were sent before the failure and may already be applied: ${sent.join("; ")}`);
    }
    // The command in flight can have been executed even though its *OPC? reply never arrived.
    if (inFlight !== undefined) {
      parts.push(`The command being sent when it failed (${inFlight}) may also have taken effect`);
    }
    throw new Error(parts.join(". "));
  }
}

/**
 * True until each instrument (connection) received its first setter from this process. A previous process (or an earlier query of this one that the
 * instrument did not answer) leaves a `-113` in the queue, or posts it up to ~4 s later, so the first setter would
 * otherwise fail on an error it did not cause (#133).
 */
let firstSetterPending = true;
/** Connections that already had their first setter: the stale error belongs to one instrument, not to the process (#166). */
let firstSetterDone = new WeakSet<object>();

/** The connection a setter of the running tool call goes to (the connection object itself when no registry entry applies, as in mocks). */
function currentConnection(): object {
  try {
    return instruments.current() as object;
  } catch {
    return connection;
  }
}

function takeFirstSetter(): boolean {
  if (!firstSetterPending) return false;
  const key = currentConnection();
  if (firstSetterDone.has(key)) return false;
  firstSetterDone.add(key);
  return true;
}

/** For tests: make the next applyCommands (not) behave as the first setter of each instrument. */
export function setFirstSetterPending(pending: boolean): void {
  firstSetterPending = pending;
  if (pending) firstSetterDone = new WeakSet<object>();
}

/** Clear the queue and re-check it until it is empty (at most 3 rounds): whatever is in it now was not caused by us. */
async function clearStaleQueue(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const stale = await drainErrorQueue();
    if (stale.length === 0) return;
    await connection.sendCommand("*CLS");
  }
}

/**
 * Drain the error queue and throw InstrumentError for real errors (stale `-113`s are ignored, see applyCommands;
 * `firstSetter` also ignores them: one from a previous process can arrive during the first setter).
 */
export async function checkInstrumentErrors(sent: string[] = [], firstSetter = false): Promise<void> {
  let errors = await drainErrorQueue();
  if (firstSetter || connection.msSinceQueryTimeout() < STALE_ERROR_WINDOW_MS) {
    errors = errors.filter((error) => !isUndefinedHeader(error));
  }
  if (errors.length > 0) throw new InstrumentError(errors, sent);
}
