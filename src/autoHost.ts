import { discoverInstruments, type DiscoveredInstrument, type DiscoveryResult } from "./discovery.js";

export const AUTO_HOST = "auto";

export type AutoHost = { host: string; model?: string; firmware?: string } | { error: string };

/** Identification text comes from the network: always shown quoted (JSON string), never interpolated raw. */
export const quoted = (text: string): string => JSON.stringify(text.slice(0, 80));

const describe = (i: DiscoveredInstrument): string =>
  `${i.host}${i.idn ? ` (model ${quoted(i.idn.model)}, firmware ${quoted(i.idn.firmware)})` : i.note ? ` (${quoted(i.note)})` : ""}`;

/** One line for the user (tool result / log) saying which host was picked automatically and why it must be checked. */
export function autoSelectedNote(host: string, model: string | undefined, firmware: string | undefined): string {
  return (
    `Host ${host} was auto-selected by network discovery (model ${quoted(model ?? "unknown")}, firmware ${quoted(firmware ?? "unknown")}). ` +
    "Discovery is unauthenticated and limited to the local subnet: check that this is your analyzer, or give its address as 'host'."
  );
}

/**
 * Resolve `host=auto` / `UTS_IP=auto`: discover analyzers on the local network and return the host when exactly one
 * UNI-T analyzer answered; otherwise an error message that says what was found and what to do. Never throws.
 */
export async function resolveAutoHost(discover: () => Promise<DiscoveryResult> = discoverInstruments): Promise<AutoHost> {
  try {
    const { instruments, notes } = await discover();
    const analyzers = instruments.filter((i) => i.analyzer);
    if (analyzers.length === 1) return { host: analyzers[0].host, model: analyzers[0].idn?.model, firmware: analyzers[0].idn?.firmware };
    if (analyzers.length > 1) {
      return {
        error:
          `Found ${analyzers.length} UNI-T analyzers on the local network: ${analyzers.map(describe).join("; ")}. ` +
          "Connect to one of them by giving its address as the 'host' parameter (or UTS_IP).",
      };
    }
    const others = instruments.length ? ` Other VXI-11 devices answered but are not UNI-T analyzers or could not be identified: ${instruments.map(describe).join("; ")}.` : "";
    const why = notes.length ? ` (${notes.map(quoted).join("; ")})` : "";
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
