import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstrumentError, applyCommands, checkInstrumentErrors, queryBool, queryNumber, readBack } from "../instrument.js";
import { onOff } from "../scpi.js";
import { SweepTimeoutError, hasPendingSweep, startSweep, waitForSweepComplete, type StartMethod } from "../acquisition.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md sections 2 and 9 (ambiguities 6-8). Verified on the UTS3036B:
// :INITiate:CONTinuous accepts ON/OFF/1/0; :INITiate:IMMediate and :RESTart work in spectrum-analyzer mode;
// :INITiate:STOP/PAUSe/RESume are rejected (-113) so they are not offered. While a single sweep runs
// the instrument ignores all input, see src/acquisition.ts.

async function readAcquisition() {
  return {
    continuous: await queryBool(":INITiate:CONTinuous?"),
    sweep_time_s: await queryNumber(":SENSe:SWEep:TIME?"),
    sweep_time_auto: await queryBool(":SENSe:SWEep:TIME:AUTO?"),
  };
}

const TIMEOUT = z.number().finite().optional().describe("Give up after this many seconds (default: sweep time + 10 s)");

function timeoutMsOf(timeout_s: number | undefined): number | undefined | Error {
  if (timeout_s === undefined) return undefined;
  if (!(timeout_s > 0)) return new Error("timeout_s must be greater than 0.");
  return timeout_s * 1000;
}

/**
 * `sent`: a command that changes the instrument was already sent, so a failure afterwards means the state
 * may have changed. `note` is added to such errors (for example that the mode was left changed).
 */
function failure(err: unknown, sent = false, note = "") {
  if (err instanceof SweepTimeoutError) {
    return errorResult(
      `${err.message}. The instrument may still be sweeping (for example waiting for a video trigger); check get_sweep.${note}`
    );
  }
  if (err instanceof InstrumentError) return setterFailure(err, "get_acquisition");
  if (sent) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`${message}. The sweep command was already sent and may be applied; use get_acquisition to check the state.${note}`);
  }
  return errorResult(err);
}

async function finish(timeoutMs: number | undefined, sent: string[]) {
  const { waitedMs } = await waitForSweepComplete({ timeoutMs });
  await checkInstrumentErrors(sent);
  return waitedMs;
}

export function registerAcquisitionTools(server: McpServer): void {
  defineTool(
    server,
    "get_acquisition",
    "Get the acquisition mode: continuous (true) or single sweep (false), plus the sweep time (s) and its auto flag. Note: over the raw transport the instrument ignores all commands while a single sweep is running; over VXI-11 it queues them.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readAcquisition(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_acquisition",
    "Switch between continuous sweep (continuous=true, the instrument's normal state) and single sweep mode (continuous=false, :INITiate:CONTINUOUS OFF). In single mode the instrument sweeps only when start_sweep or single_sweep is used.",
    { continuous: z.boolean().describe("true = continuous sweep, false = single sweep") },
    { readOnlyHint: false, idempotentHint: true },
    async ({ continuous }) => {
      try {
        await applyCommands([`:INITiate:CONTinuous ${onOff(continuous)}`]);
        const state = await readBack(readAcquisition);
        const warnings: string[] = [];
        if (state.continuous !== continuous) {
          warnings.push(`continuous adjusted by the instrument: requested ${continuous}, now ${state.continuous}`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_acquisition");
      }
    }
  );

  defineTool(
    server,
    "start_sweep",
    "Start (:INITiate:IMMediate) or restart (:INITiate:RESTart) a sweep. In single mode, wait=true (default) blocks until the sweep is complete; with wait=false " +
      "call wait_for_sweep_complete next, because over the raw transport the instrument ignores every command while it sweeps (VXI-11 queues them). In continuous mode the sweep is restarted and not awaited. " +
      "There is no stop/pause/resume: the instrument rejects :INITiate:STOP/PAUSe/RESume.",
    {
      method: z.enum(["immediate", "restart"]).optional().describe("immediate (default) or restart"),
      wait: z.boolean().optional().describe("Wait for completion in single mode (default true)"),
      timeout_s: TIMEOUT,
    },
    { readOnlyHint: false },
    async ({ method, wait, timeout_s }) => {
      let sent = false;
      const sentCommands: string[] = [];
      try {
        const timeoutMs = timeoutMsOf(timeout_s);
        if (timeoutMs instanceof Error) return errorResult(timeoutMs);
        const continuous = await queryBool(":INITiate:CONTinuous?");
        const { sweepTimeS } = await startSweep((method ?? "immediate") as StartMethod);
        sent = true;
        sentCommands.push(method === "restart" ? ":INITiate:RESTart" : ":INITiate:IMMediate");
        const warnings: string[] = [];
        let completed = false;
        let waited_ms: number | undefined;
        if (continuous) {
          // Continuous sweeps never "complete"; just make sure the command was accepted.
          await waitForSweepComplete({ timeoutMs });
          await checkInstrumentErrors(sentCommands);
          warnings.push("Instrument is in continuous mode: the sweep was restarted but completion cannot be awaited; use set_acquisition continuous=false or single_sweep.");
        } else if (wait ?? true) {
          waited_ms = await finish(timeoutMs, sentCommands);
          completed = true;
        }
        return textResult(JSON.stringify({ started: true, method: method ?? "immediate", continuous, sweep_time_s: sweepTimeS, completed, waited_ms, warnings }, null, 2));
      } catch (err) {
        return failure(err, sent);
      }
    }
  );

  defineTool(
    server,
    "single_sweep",
    "Switch to single sweep mode, run exactly one sweep and wait until it is complete, so the trace is final and can be read. Leaves the instrument in single mode; use set_acquisition continuous=true to resume normal sweeping.",
    { timeout_s: TIMEOUT },
    { readOnlyHint: false },
    async ({ timeout_s }) => {
      let sent = false;
      try {
        const timeoutMs = timeoutMsOf(timeout_s);
        if (timeoutMs instanceof Error) return errorResult(timeoutMs);
        // Set before the send: a connection failure mid-send may already have switched the mode.
        sent = true;
        await applyCommands([":INITiate:CONTinuous OFF"]);
        const { sweepTimeS } = await startSweep("immediate");
        const waited_ms = await finish(timeoutMs, [":INITiate:CONTinuous OFF", ":INITiate:IMMediate"]);
        return textResult(JSON.stringify({ completed: true, continuous: false, sweep_time_s: sweepTimeS, waited_ms }, null, 2));
      } catch (err) {
        // "Not connected": the mode command never left, so there is nothing to undo.
        const neverSent = err instanceof Error && /^Not connected/.test(err.message);
        const maySwitched = sent && !neverSent;
        return failure(err, maySwitched, maySwitched ? " The instrument may have been left in single sweep mode; use set_acquisition continuous=true to resume normal sweeping." : "");
      }
    }
  );

  defineTool(
    server,
    "wait_for_sweep_complete",
    "Wait for a sweep started with start_sweep(wait=false) to finish: over the raw transport it stays silent for the remaining sweep time (the instrument ignores input while sweeping) and then polls *OPC? until it answers; over VXI-11 it makes one blocking *OPC? read that returns when the sweep ends.",
    { timeout_s: TIMEOUT },
    { readOnlyHint: false },
    async ({ timeout_s }) => {
      try {
        const timeoutMs = timeoutMsOf(timeout_s);
        if (timeoutMs instanceof Error) return errorResult(timeoutMs);
        const hadPending = hasPendingSweep();
        const waited_ms = await finish(timeoutMs, []);
        const warnings = hadPending ? [] : ["No sweep was started by this server; waited only until the instrument answered."];
        return textResult(JSON.stringify({ completed: true, waited_ms, warnings }, null, 2));
      } catch (err) {
        return failure(err, false);
      }
    }
  );
}
