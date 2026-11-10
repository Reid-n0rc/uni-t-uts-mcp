import { discoverInstruments, type DiscoveredInstrument, type DiscoveryResult } from "./discovery.js";

export const AUTO_HOST = "auto";

export type AutoHost = { host: string; model?: string } | { error: string };

const describe = (i: DiscoveredInstrument): string =>
  `${i.host}${i.idn ? ` (${i.idn.model}, firmware ${i.idn.firmware})` : i.note ? ` (${i.note})` : ""}`;

/**
 * Resolve `host=auto` / `UTS_IP=auto`: discover analyzers on the local network and return the host when exactly one
 * UNI-T analyzer answered; otherwise an error message that says what was found and what to do. Never throws.
 */
export async function resolveAutoHost(discover: () => Promise<DiscoveryResult> = discoverInstruments): Promise<AutoHost> {
  try {
    const { instruments, notes } = await discover();
    const analyzers = instruments.filter((i) => i.analyzer);
    if (analyzers.length === 1) return { host: analyzers[0].host, model: analyzers[0].idn?.model };
    if (analyzers.length > 1) {
      return {
        error:
          `Found ${analyzers.length} UNI-T analyzers on the local network: ${analyzers.map(describe).join("; ")}. ` +
          "Connect to one of them by giving its address as the 'host' parameter (or UTS_IP).",
      };
    }
    const others = instruments.length ? ` Other VXI-11 devices answered but are not UNI-T analyzers or could not be identified: ${instruments.map(describe).join("; ")}.` : "";
    const why = notes.length ? ` (${notes.join("; ")})` : "";
    return {
      error:
        `No UNI-T analyzer found on the local network${why}.${others} ` +
        "Check that the analyzer is powered, on the same subnet as this computer and that LAN is enabled, " +
        "or give its address as the 'host' parameter (or UTS_IP).",
    };
  } catch (err) {
    return { error: `Discovery failed: ${err instanceof Error ? err.message : String(err)}. Give the analyzer's address as the 'host' parameter (or UTS_IP).` };
  }
}
