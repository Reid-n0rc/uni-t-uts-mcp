import { connection } from "./connection.js";
import { drainErrorQueue } from "./errors.js";
import { parseBool, parseNumber } from "./scpi.js";

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
  const sent: string[] = [];
  try {
    await connection.sendCommand("*CLS");
    for (const command of commands) {
      await connection.sendCommand(command);
      sent.push(command);
    }
    await checkInstrumentErrors(sent);
  } catch (err) {
    if (sent.length === 0 || err instanceof InstrumentError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message}. These commands were sent before the failure and may already be applied: ${sent.join("; ")}`
    );
  }
}

/** Drain the error queue and throw InstrumentError for real errors (stale `-113`s are ignored, see applyCommands). */
export async function checkInstrumentErrors(sent: string[] = []): Promise<void> {
  let errors = await drainErrorQueue();
  if (connection.msSinceQueryTimeout() < STALE_ERROR_WINDOW_MS) {
    errors = errors.filter((error) => !isUndefinedHeader(error));
  }
  if (errors.length > 0) throw new InstrumentError(errors, sent);
}
