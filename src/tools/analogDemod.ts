import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryParsed, readBack } from "../instrument.js";
import { parseModuleReply, type ModuleName } from "../moduleGuard.js";
import { restoreSa, type SaState, readSa } from "./measurement.js";

import { defineTool, setterFailure, textResult } from "./util.js";

// Command: `:INSTrument[:SELect] {SA|EMI|AD}` (docs/research/analog-demodulation.md section 1, #192). Entering AD is
// saved/restored the same way exit_measurement saves/restores a measurement's settings (src/tools/measurement.ts):
// read the SA state before switching, send the switch, and put the settings back by read-back when leaving.
//
// Not covered by this tool pair (deferred, not asked for by #192's scope): the AD demodulation type (AM/FM, via the
// destructive `:CONFigure:AM`/`:CONFigure:FM`), AD settings themselves (#193+), and the tracking generator (unlike a
// measurement, nothing confirms `:INSTrument:SELect AD` touches it; restoring something nobody has seen it change
// would be guessing, docs/research/analog-demodulation.md section 4 risk 5 - "trust no example without a live
// probe"). get_instrument_module/select_instrument_module (#177) remain the general-purpose module tools; these two
// add only the SA-state round trip.
//
// Like select_instrument_module, these switch INTO and OUT OF the SA module themselves, so they cannot use
// defineTool's default `requireModule: "sa"` guard (src/tools/util.ts, src/moduleGuard.ts) - they do their own
// module bookkeeping instead.

async function readModule(): Promise<ModuleName> {
  return queryParsed(":INSTrument:SELect?", parseModuleReply);
}

/** Same caveat and wording as instrumentModule.ts: the first command right after a mode switch can get no reply. */
const READBACK_TIMEOUT_HINT =
  "reading the module back after the switch got no reply. The analyzer's own documented quirk (docs/verified-hardware.md) is that " +
  "the first command right after a mode switch can be silently dropped on the same connection; the switch itself most likely took. " +
  "Call get_instrument_module again (ideally after reconnecting) to check.";

async function readModuleAfterSwitch(): Promise<ModuleName> {
  try {
    return await readModule();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|timed out/i.test(message)) throw new Error(`${message}. ${READBACK_TIMEOUT_HINT}`);
    throw err;
  }
}

/** Settings saved by enter_analog_demod when it switched from spectrum analyzer mode, for exit_analog_demod to put back. */
let savedSa: SaState | undefined;
/** True from enter_analog_demod until exit_analog_demod leaves again; just distinguishes the two "nothing saved" warnings below. */
let analogDemodEntered = false;

/** For tests: forget the saved state (the tool table runs every tool from a clean state). */
export function forgetAnalogDemodState(): void {
  savedSa = undefined;
  analogDemodEntered = false;
}

export function registerAnalogDemodTools(server: McpServer): void {
  defineTool(
    server,
    "enter_analog_demod",
    "Switch to the analog demodulation (AD) module and read it back. From spectrum analyzer mode, saves the frequency, bandwidth, " +
      "sweep time and continuous-sweep settings first, for exit_analog_demod to restore; re-entering AD while already there keeps " +
      "whatever was saved the first time. Warns (not an error) if the module did not change: on this firmware an unlicensed module " +
      "is refused silently with no SCPI error, which this tool cannot distinguish from a link glitch. Leaves the instrument in AD " +
      "on purpose; call exit_analog_demod when done. Does not select or preset an AM/FM demodulation type.",
    {},
    { readOnlyHint: false },
    async () => {
      try {
        const before = await readModule();
        const saved = before === "sa" ? await readSa() : before === "ad" && analogDemodEntered ? savedSa : undefined;
        if (before !== "ad") await applyCommands([":INSTrument:SELect AD"]);
        const actual = await readBack(readModuleAfterSwitch);
        const warnings: string[] = [];
        if (actual !== "ad") {
          warnings.push(
            "Requested AD but the module reads back " +
              { sa: "SA", emi: "EMI", ad: "AD" }[actual] +
              ". The switch may have been refused (an unlicensed module is refused silently, with no SCPI error) or not taken effect yet."
          );
        } else {
          analogDemodEntered = true;
          if (before === "sa") savedSa = saved;
        }
        return textResult(
          JSON.stringify(
            {
              module: { sa: "spectrum_analyzer", emi: "emi", ad: "analog_demod" }[actual],
              saved_settings: actual === "ad" && savedSa !== undefined,
              warnings,
            },
            null,
            2
          )
        );
      } catch (err) {
        return setterFailure(err, "get_instrument_module");
      }
    },
    { requireModule: false }
  );

  defineTool(
    server,
    "exit_analog_demod",
    "Leave the AD module and return to spectrum analyzer mode (:INSTrument:SELect SA). Unless restore_settings=false, the frequency, " +
      "bandwidth, sweep time and continuous-sweep settings saved by enter_analog_demod are put back and verified by read-back (the " +
      "same resend-once-then-fail pattern exit_measurement uses). Always sends the switch, even if this server never called " +
      "enter_analog_demod (e.g. after select_instrument_module); a clear warning says so when there is nothing saved to restore, " +
      "rather than guessing at settings this server never saw.",
    { restore_settings: z.boolean().optional().describe("Restore the settings saved when AD was entered (default true)") },
    { readOnlyHint: false, idempotentHint: false },
    async (args) => {
      const hadEntered = analogDemodEntered;
      try {
        await applyCommands([":INSTrument:SELect SA"]);
        const actual = await readBack(readModuleAfterSwitch);
        if (actual !== "sa") {
          throw new Error(
            `Switching back to spectrum analyzer did not take: the module reads back ${
              { sa: "SA", emi: "EMI", ad: "AD" }[actual]
            }. Check the instrument.`
          );
        }
        const wantRestore = args.restore_settings !== false;
        const saved = savedSa;
        const warnings: string[] = [];
        let restored = false;
        if (wantRestore) {
          if (saved) {
            warnings.push(...(await restoreSa(saved)));
            restored = true;
          } else if (hadEntered) {
            warnings.push(
              "No saved settings (analog demodulation was entered while not in spectrum analyzer mode, or its state was lost): " +
                "nothing to restore."
            );
          } else {
            warnings.push(
              "This server did not call enter_analog_demod, so nothing was saved here: nothing to restore. If AD was entered another " +
                "way (e.g. select_instrument_module), the settings it had before switching are unknown to this server."
            );
          }
        }
        savedSa = undefined;
        analogDemodEntered = false;
        return textResult(JSON.stringify({ module: "spectrum_analyzer", restored, warnings }, null, 2));
      } catch (err) {
        savedSa = undefined;
        analogDemodEntered = false;
        return setterFailure(err, "get_instrument_module");
      }
    },
    { requireModule: false }
  );
}
