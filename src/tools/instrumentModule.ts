import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryParsed, readBack } from "../instrument.js";
import { MODULES, MODULE_NAMES, type ModuleName, parseModuleReply } from "../moduleGuard.js";

import { defineTool, errorResult, setterFailure, textResult } from "./util.js";

// Command: `:INSTrument[:SELect] {SA|EMI|AD}` / `:INSTrument[:SELect]?`, programming manual p.6 (docs/research/emi-function.md,
// docs/research/analog-demodulation.md). Confirmed live (docs/verified-hardware.md, "Installed options and AD results readback"):
// the setter is safe to probe with even when a module is not licensed - the firmware refuses it silently (no SCPI error,
// module unchanged), it does not change what `*OPT?` or any other query reports, and it does not touch the front-panel lock
// any differently than an ordinary command (docs/verified-hardware.md, "Front-panel lock"). Modules beyond the three the public
// manual documents (IQ, VSA, RTSA, VNA, PNA, FDD, TDD, NR) are known to exist internally but are out of scope here.
//
// These two tools must not get defineTool's default `requireModule: "sa"` guard (src/tools/util.ts, src/moduleGuard.ts):
// get_instrument_module is read-only in any module, and select_instrument_module is how a caller leaves SA in the first place.

async function readModule(): Promise<ModuleName> {
  return queryParsed(":INSTrument:SELect?", parseModuleReply);
}

/**
 * Caveat found live (docs/verified-hardware.md): right after an `:INSTrument <mode>` round trip on one TCP
 * connection, the next command on that same connection can get no reply at all, even though the instrument
 * applied the change. The readback here is the first command after the setter and so is exactly where that
 * would show up; a timeout at this specific point is reported with that context rather than as a bare timeout.
 */
const READBACK_TIMEOUT_HINT =
  "reading the module back after the switch got no reply. The analyzer's own documented quirk (docs/verified-hardware.md) is that " +
  "the first command right after a mode switch can be silently dropped on the same connection; the switch itself most likely took. " +
  "Call get_instrument_module again (ideally after reconnecting) to check.";

export function registerInstrumentModuleTools(server: McpServer): void {
  defineTool(
    server,
    "get_instrument_module",
    "Get the active measurement function module: spectrum_analyzer, emi or analog_demod. Read-only, safe in any module. " +
      "An unexpected reply (not SA/EMI/AD) is an error quoting it rather than a guess.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const module = await readModule();
        return textResult(JSON.stringify({ module: { sa: "spectrum_analyzer", emi: "emi", ad: "analog_demod" }[module] }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: false }
  );

  defineTool(
    server,
    "select_instrument_module",
    "Switch the active measurement function module (SA/EMI/AD) and read it back. Does not restore the previous module afterwards - " +
      "the caller chose this switch; call it again with the module you want back when done. Warns (not an error) if the module did not " +
      "change: on this firmware an unlicensed module is refused silently with no SCPI error, which this tool cannot distinguish from a " +
      "link glitch. The front-panel lock is unaffected by this call beyond the usual: see docs/verified-hardware.md, 'Front-panel lock'.",
    { module: z.enum(MODULE_NAMES).describe("Module to select: sa (spectrum analyzer), emi, or ad (analog demodulation)") },
    { readOnlyHint: false },
    async ({ module }) => {
      const wanted = MODULES[module];
      try {
        await applyCommands([`:INSTrument:SELect ${wanted}`]);
        const actual = await readBack(async () => {
          try {
            return await readModule();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/timeout|timed out/i.test(message)) throw new Error(`${message}. ${READBACK_TIMEOUT_HINT}`);
            throw err;
          }
        });
        const warnings: string[] = [];
        if (actual !== module) {
          warnings.push(
            `Requested ${wanted} but the module reads back ${MODULES[actual]}. The switch may have been refused (an unlicensed ` +
              "module is refused silently, with no SCPI error) or not taken effect yet."
          );
        }
        return textResult(
          JSON.stringify({ requested: wanted, module: MODULES[actual], ...(warnings.length > 0 ? { warnings } : {}) }, null, 2)
        );
      } catch (err) {
        return setterFailure(err, "get_instrument_module");
      }
    },
    { requireModule: false }
  );
}
