import type { ConnectOptions } from "./connection.js";
import { isValidHost, portFromEnv } from "./target.js";
import { AUTO_HOST, autoSelectedNote, resolveAutoHost } from "./autoHost.js";
import type { DiscoveryResult } from "./discovery.js";
import { DEFAULT_INSTRUMENT, instrumentTargetsFromEnv } from "./registry.js";
import { resolveTransport, vxi11DeviceFromEnv, vxi11ProbeBudgetFromEnv } from "./transports/select.js";

/**
 * Connect at startup from UTS_IP / UTS_PORT / UTS_TRANSPORT / UTS_VXI11_DEVICE / UTS_VXI11_PROBE_TIMEOUT_S. Never throws: failures are logged and
 * the user can still call the `connect` tool. Returns whether a connection was made.
 */
export async function autoConnectFromEnv(
  env: Record<string, string | undefined>,
  conn: {
    connect(host: string, port: number, options: ConnectOptions): Promise<string>;
    /** Description of the transport in use, logged after connecting (optional for fakes). */
    transportLabel?: string;
  },
  rawLog: (...args: unknown[]) => void,
  /** Network discovery for UTS_IP=auto (a fake in tests). */
  discover?: () => Promise<DiscoveryResult>
): Promise<boolean> {
  // The caller does not await this: a throwing logger (for example a closed stderr) must not become an unhandled rejection.
  const log = (...args: unknown[]) => {
    try {
      rawLog(...args);
    } catch {
      /* nothing more can be done */
    }
  };
  let host = env.UTS_IP;
  if (!host) return false;

  try {
    if (host.toLowerCase() === AUTO_HOST) {
      const found = await resolveAutoHost(discover);
      if ("error" in found) throw new Error(found.error);
      host = found.host;
      log(autoSelectedNote(found.host, found.model, found.firmware));
    }
    if (!isValidHost(host)) throw new Error("UTS_IP is not a valid hostname or IP address");
    const port = portFromEnv(env.UTS_PORT);
    const transport = resolveTransport({ env: env.UTS_TRANSPORT, portGiven: env.UTS_PORT !== undefined && env.UTS_PORT !== "" });
    const vxi11Device = vxi11DeviceFromEnv(env.UTS_VXI11_DEVICE);
    const vxi11ProbeBudgetMs = vxi11ProbeBudgetFromEnv(env.UTS_VXI11_PROBE_TIMEOUT_S);
    const idn = await conn.connect(host, port, { transport, vxi11Device, vxi11ProbeBudgetMs, log });
    log(`Auto-connected to ${host} via ${conn.transportLabel ?? transport}: ${idn}`);
    return true;
  } catch (err) {
    log(`Auto-connect failed: ${err instanceof Error ? err.message : String(err)}`);
    log("Use the 'connect' tool to connect manually.");
    return false;
  }
}

type AutoConn = Parameters<typeof autoConnectFromEnv>[1];

/**
 * Startup connections for every configured instrument (issue #163): `default` from UTS_IP, plus each
 * UTS_INSTRUMENTS entry, all in parallel on their own connections. A failure (or an invalid
 * UTS_INSTRUMENTS) is logged and never stops the others. Returns whether each name connected.
 */
export async function autoConnectAll(
  env: Record<string, string | undefined>,
  registry: { declare(name: string, target?: { host: string; port?: number }): AutoConn },
  rawLog: (...args: unknown[]) => void,
  discover?: () => Promise<DiscoveryResult>
): Promise<Record<string, boolean>> {
  const log = (...args: unknown[]) => {
    try {
      rawLog(...args);
    } catch {
      /* nothing more can be done */
    }
  };
  const jobs: Array<Promise<[string, boolean]>> = [];
  if (env.UTS_IP) {
    jobs.push(autoConnectFromEnv(env, registry.declare(DEFAULT_INSTRUMENT), log, discover).then((ok) => [DEFAULT_INSTRUMENT, ok]));
  }
  try {
    for (const [name, target] of instrumentTargetsFromEnv(env)) {
      const conn = registry.declare(name, target);
      // A port given in the entry means raw unless UTS_TRANSPORT says otherwise (same rule as UTS_PORT).
      const own: Record<string, string | undefined> = { ...env, UTS_IP: target.host, UTS_PORT: target.port === undefined ? undefined : String(target.port) };
      jobs.push(autoConnectFromEnv(own, conn, (...a) => log(`[${name}]`, ...a), discover).then((ok) => [name, ok]));
    }
  } catch (err) {
    log(`${err instanceof Error ? err.message : String(err)}; ignoring UTS_INSTRUMENTS.`);
  }
  return Object.fromEntries(await Promise.all(jobs));
}
