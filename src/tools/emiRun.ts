import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { applyCommands } from "../instrument.js";
import { ensureModuleOk } from "../moduleGuard.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// `:INITiate:IMMediate`/`:INITiate:FSCan:CLEar:IMMediate`/`:INITiate:STOP` (programming manual
// pp.114-115; docs/research/emi-function.md section 3.9/5.4). Live-verified 2026-11-12 with the
// owner present (docs/verified-hardware.md): a scan-only sequence can leave the instrument silent
// to EVERY command, including `:SYSTem:ERRor?`, for 25 s or more while it runs, then answers again
// on its own once the sequence finishes (matching the manual's "single mode stops by itself when
// the measurement is done"). There is no documented "finished" query, so completion is inferred
// the same way `waitForSweepComplete` infers an SA sweep's end: stay silent, then poll a cheap
// query (`*OPC?`) until something answers again or the deadline passes.
//
// `:INITiate2:CONTinuous?` got NO REPLY AT ALL in EMI mode (same silent-timeout pattern, tried
// with retries) - unlike SA, where it answers. This tool therefore cannot read the continuous-sweep
// state before changing it (the research doc's plan assumed it could); it unconditionally sends
// `:INITiate2:CONTinuous OFF` first and says so, rather than silently skipping a check it cannot do.
//
// `:INITiate:STOP`, `:INITiate:PAUSe` and `:INITiate:RESume` were all live-verified to be accepted
// WITHOUT an instrument error in EMI mode (`:SYSTem:ERRor?` stayed `0,"No error"` after each),
// unlike SA where these three give `-113` ("Undefined header"). This is evidence they are real EMI
// commands, not that the instrument silently ignored them: no independent confirmation (e.g. a
// screenshot) was taken that PAUSe actually paused anything. Only `:INITiate:STOP` is exposed here,
// matching the issue's scope (`emi_run`/`emi_stop`); PAUSe/RESume are not implemented as tools.

const DEFAULT_TIMEOUT_S = 45;
const TIMEOUT = z
  .number()
  .finite()
  .optional()
  .describe(
    `Give up waiting after this many seconds (default ${DEFAULT_TIMEOUT_S}, 0-600). A cold EMI scan was seen to leave the ` +
      "instrument silent to everything, including the error queue, for 25 s or more; reaching this limit does not " +
      "necessarily mean the scan failed, only that nothing answered in time."
  );

function validTimeout(t: number | undefined): string | undefined {
  return t !== undefined && !(t > 0 && t <= 600) ? "timeout_s must be greater than 0 and at most 600." : undefined;
}

export class EmiRunTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(
      `No reply within ${(timeoutMs / 1000).toFixed(1)} s. The EMI scan may still be running: the instrument ` +
        "ignores every command, including the error queue, for the whole scan and only answers again once it stops."
    );
    this.name = "EmiRunTimeoutError";
  }
}

/** `sent`: a command was already sent before the failure, so the message says it may be applied. */
function failure(err: unknown, sent: boolean) {
  const message = err instanceof Error ? err.message : String(err);
  if (sent) return errorResult(`${message}. A command was already sent and may be applied; use get_emi_settings to check the state.`);
  return errorResult(err);
}

/** Poll `*OPC?` until anything answers (not a timeout) or the deadline passes. Throws EmiRunTimeoutError. */
async function waitUntilResponsive(timeoutMs: number, pollTimeoutMs = 500): Promise<{ waitedMs: number }> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  for (;;) {
    try {
      await connection.query("*OPC?", pollTimeoutMs, { expectSilence: true });
      return { waitedMs: Date.now() - start };
    } catch (err) {
      if (!(err instanceof Error && /timeout/i.test(err.message))) throw err;
    }
    if (Date.now() >= deadline) throw new EmiRunTimeoutError(timeoutMs);
  }
}

export function registerEmiRunTools(server: McpServer): void {
  defineTool(
    server,
    "emi_run",
    "Start an EMI scan sequence and wait for it, with a time limit. Sends `:INITiate2:CONTinuous OFF` first " +
      "(cannot read its prior state first: `:INITiate2:CONTinuous?` gets no reply in EMI, live-verified), then " +
      "either `:INITiate:FSCan:CLEar:IMMediate` (clear_list true: clears the signal list and starts) or " +
      "`:INITiate:IMMediate`. There is no documented 'finished' query; completion is inferred from the instrument " +
      "answering again, since a scan-only sequence was live-verified to leave it silent to everything (including the " +
      "error queue) for 25 s or more while running, then stop by itself. Reading the resulting signal list is not " +
      "possible through documented commands (use emi_signal_list actions or the screenshot tool over VXI-11).",
    {
      clear_list: z.boolean().optional().describe("Clear the signal list before starting (:INITiate:FSCan:CLEar:IMMediate instead of :INITiate:IMMediate)"),
      timeout_s: TIMEOUT,
    },
    { readOnlyHint: false },
    async ({ clear_list, timeout_s }) => {
      const warnings: string[] = [
        "Continuous-sweep state could not be read before changing it (:INITiate2:CONTinuous? gets no reply in EMI, live-verified 2026-11-12); :INITiate2:CONTinuous OFF was sent unconditionally.",
      ];
      let sent = false;
      try {
        await ensureModuleOk();
        await connection.sendCommand("*CLS");
        await connection.sendCommand(":INITiate2:CONTinuous OFF", { sync: false });
        sent = true;
        await connection.sendCommand(clear_list ? ":INITiate:FSCan:CLEar:IMMediate" : ":INITiate:IMMediate", { sync: false });
      } catch (err) {
        return failure(err, sent);
      }

      const timeoutMs = (timeout_s ?? DEFAULT_TIMEOUT_S) * 1000;
      try {
        const { waitedMs } = await waitUntilResponsive(timeoutMs);
        const errorText = await connection.query(":SYSTem:ERRor?");
        return textResult(
          JSON.stringify({ started: true, finished: true, waited_s: Math.round(waitedMs / 100) / 10, error_queue: errorText.trim(), warnings }, null, 2)
        );
      } catch (err) {
        if (err instanceof EmiRunTimeoutError) {
          warnings.push(err.message);
          return textResult(
            JSON.stringify({ started: true, finished: false, waited_s: Math.round(timeoutMs / 100) / 10, warnings }, null, 2)
          );
        }
        return failure(err, true);
      }
    },
    { requireModule: "emi", validate: (a) => validTimeout(a.timeout_s) }
  );

  defineTool(
    server,
    "emi_stop",
    "Stop a running EMI scan sequence (`:INITiate:STOP`). Live-verified 2026-11-12: accepted without an instrument " +
      "error in EMI mode (unlike SA, where this command gives -113). No independent confirmation that it actually " +
      "halted anything was taken (no documented read-back); the result only reports whether the instrument raised " +
      "an error.",
    {},
    { readOnlyHint: false },
    async () => {
      try {
        await applyCommands([":INITiate:STOP"]);
        return textResult(JSON.stringify({ stopped: true, note: "No read-back exists to confirm the scan actually halted." }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_settings");
      }
    },
    { requireModule: "emi" }
  );
}
