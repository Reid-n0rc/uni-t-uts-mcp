import { connection } from "./connection.js";

const ERROR_QUERY_TIMEOUT = 1500;

/**
 * Read the instrument's error queue (`:SYSTem:ERRor?`, verified on the UTS3036B) until it
 * reports `0,"No error"`. Setters give no reply, so this is how rejected values (for example
 * `-131,"Invalid suffix"`) are detected. A timeout means the queue is unsupported and is
 * treated as "no information" rather than a failure.
 */
export async function drainErrorQueue(maxReads = 10): Promise<string[]> {
  const errors: string[] = [];
  for (let i = 0; i < maxReads; i++) {
    let reply: string;
    try {
      reply = await connection.query(":SYSTem:ERRor?", ERROR_QUERY_TIMEOUT);
    } catch (err) {
      if (err instanceof Error && /timeout/i.test(err.message)) break;
      throw err;
    }
    if (/^\s*0\s*(,|$)/.test(reply)) break;
    errors.push(reply);
  }
  return errors;
}
