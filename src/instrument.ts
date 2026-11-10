import { connection } from "./connection.js";
import { drainErrorQueue } from "./errors.js";

export class InstrumentError extends Error {
  constructor(public readonly errors: string[]) {
    super(`The instrument reported errors: ${errors.join("; ")}`);
    this.name = "InstrumentError";
  }
}

/**
 * Send setter commands and check that the instrument accepted them. Setters give no reply,
 * so rejections (for example `-131,"Invalid suffix"`) only show up in the error queue, which
 * is global to the instrument: it also holds stale errors from earlier unsupported queries.
 * `*CLS` (verified to clear the queue on the UTS3036B) runs first so only errors caused by
 * these commands are reported.
 */
export async function applyCommands(commands: string[]): Promise<void> {
  await connection.sendCommand("*CLS");
  for (const command of commands) await connection.sendCommand(command);
  const errors = await drainErrorQueue();
  if (errors.length > 0) throw new InstrumentError(errors);
}
