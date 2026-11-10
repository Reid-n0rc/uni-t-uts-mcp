import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { applyCommands } from "../instrument.js";
import { DangerousCommandError, analyzeLine, assertAllowed } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

/** Largest block payload (bytes) returned inline, as base64. */
const MAX_BLOCK_BYTES = 65536;

/** Input checks for scpi_query that need no instrument (run before waiting for the instrument). */
function queryProblem({ command }: { command: string }): string | undefined {
  const analysis = analyzeLine(command);
  if (!analysis.ok) return `Refusing to send: ${analysis.reason}`;
  if (analysis.statements === 0 || analysis.queries !== analysis.statements) {
    return "scpi_query only accepts queries (every statement must end in '?'). Use scpi_command for commands.";
  }
  if (analysis.statements > 1) {
    // On the UTS3036B a ';'-joined query line is answered with only one reply, which
    // would leave the other to be misread as the answer to the next query.
    return "scpi_query accepts one query per call; send each query separately.";
  }
  return undefined;
}

export function registerScpiTools(server: McpServer): void {
  defineTool(
    server,
    "scpi_query",
    "Send one raw SCPI query (it must end in '?') to the analyzer and return the reply. " +
      "Escape hatch for commands without a dedicated tool. Use reply='block' for IEEE 488.2 '#' binary block replies " +
      "(returned as base64). Unsupported queries get no reply from the instrument and time out.",
    {
      command: z.string().describe("SCPI query, e.g. '*IDN?' or ':SWEep:POINts?'"),
      timeout_ms: z
        .number()
        .int()
        .min(1)
        .max(120000)
        .optional()
        .describe("Timeout in milliseconds (default 5000 for text, 30000 for blocks)"),
      reply: z
        .enum(["text", "block"])
        .optional()
        .describe("Reply type: 'text' (default) or 'block' for a binary block"),
    },
    { readOnlyHint: true },
    async ({ command, timeout_ms, reply }) => {
      try {
        if (reply === "block") {
          const data = await connection.queryBinary(command, timeout_ms).catch((err) => {
            throw new Error(`${err instanceof Error ? err.message : String(err)} (command: ${command})`);
          });
          const shown = data.subarray(0, MAX_BLOCK_BYTES);
          const note =
            data.length > shown.length ? ` (truncated: showing the first ${shown.length} bytes)` : "";
          return textResult(`Block of ${data.length} bytes${note} (base64):\n${shown.toString("base64")}`);
        }
        return textResult(await connection.query(command, timeout_ms));
      } catch (err) {
        return errorResult(err);
      }
    },
    { validate: queryProblem }
  );

  defineTool(
    server,
    "scpi_command",
    "Send a raw SCPI command (no reply expected) to the analyzer. Escape hatch for commands without a dedicated tool. " +
      "Commands that reset the instrument, change network settings, lock the panel or write files are refused " +
      "unless confirm=true. Queries are refused; use scpi_query.",
    {
      command: z.string().describe("SCPI command, e.g. ':FREQuency:CENTer 1 GHz'"),
      confirm: z
        .boolean()
        .optional()
        .describe("Set true to allow a command on the safety denylist (e.g. *RST). Only with the user's approval."),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ command, confirm }) => {
      try {
        assertAllowed(command, confirm === true);
        const analysis = analyzeLine(command);
        if (analysis.ok && analysis.queries > 0) {
          return errorResult("scpi_command does not read replies; use scpi_query for queries.");
        }
        // Like every setter: *CLS, synced send, then check the error queue (a rejected command only shows up there).
        await applyCommands([command]);
        return textResult(`Command sent: ${command} (the instrument reported no error)`);
      } catch (err) {
        if (err instanceof DangerousCommandError) return errorResult(err.reason);
        return setterFailure(err, "scpi_query");
      }
    }
  );
}
