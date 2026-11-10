import { connection } from "./connection.js";
import { drainErrorQueue } from "./errors.js";

export class InstrumentError extends Error {
  constructor(public readonly errors: string[]) {
    super(`The instrument reported errors: ${errors.join("; ")}`);
    this.name = "InstrumentError";
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
  await connection.sendCommand("*CLS");
  for (const command of commands) await connection.sendCommand(command);
  let errors = await drainErrorQueue();
  if (connection.msSinceQueryTimeout() < STALE_ERROR_WINDOW_MS) {
    errors = errors.filter((error) => !isUndefinedHeader(error));
  }
  if (errors.length > 0) throw new InstrumentError(errors);
}
