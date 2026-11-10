import type { ConnectOptions } from "./connection.js";
import { isValidHost, portFromEnv } from "./target.js";
import { AUTO_HOST, autoSelectedNote, resolveAutoHost } from "./autoHost.js";
import type { DiscoveryResult } from "./discovery.js";
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
