import { isValidHost, portFromEnv } from "./target.js";

/**
 * Connect at startup from UTS_IP / UTS_PORT. Never throws: failures are logged and
 * the user can still call the `connect` tool. Returns whether a connection was made.
 */
export async function autoConnectFromEnv(
  env: Record<string, string | undefined>,
  conn: { connect(host: string, port: number): Promise<string> },
  rawLog: (...args: unknown[]) => void
): Promise<boolean> {
  // The caller does not await this: a throwing logger (for example a closed stderr) must not become an unhandled rejection.
  const log = (...args: unknown[]) => {
    try {
      rawLog(...args);
    } catch {
      /* nothing more can be done */
    }
  };
  const host = env.UTS_IP;
  if (!host) return false;

  try {
    if (!isValidHost(host)) throw new Error("UTS_IP is not a valid hostname or IP address");
    const port = portFromEnv(env.UTS_PORT);
    const idn = await conn.connect(host, port);
    log(`Auto-connected to ${host}:${port}: ${idn}`);
    return true;
  } catch (err) {
    log(`Auto-connect failed: ${err instanceof Error ? err.message : String(err)}`);
    log("Use the 'connect' tool to connect manually.");
    return false;
  }
}
