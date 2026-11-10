import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { connection } from "../connection.js";
import { InstrumentError } from "../instrument.js";

/** Shared helpers for building MCP tool results. */

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

/** Error result for a setter: instrument-reported errors say the settings may be partially applied. */
export function setterFailure(err: unknown, getter: string) {
  if (err instanceof InstrumentError) {
    return errorResult(`${err.message}. Settings may be partially applied; use ${getter} to check.`);
  }
  return errorResult(err);
}

// ---------- tool registration: every tool is an exclusive instrument session ----------

export interface DefineToolOptions<Args> {
  /**
   * Pure input checks that need no instrument: return an error message to reject the call BEFORE it
   * waits for the instrument (an invalid call must not queue behind a long sweep just to be refused).
   */
  validate?: (args: Args) => string | undefined;
  /**
   * Run the handler without taking the instrument lock. Only for tools that must not wait for a
   * running operation (`disconnect`, which also fails everything queued). Default true.
   */
  exclusive?: boolean;
}

const REFUSED =
  "Register tools with defineTool() from src/tools/util.ts, not server.tool()/registerTool(): defineTool runs the whole " +
  "handler as an exclusive instrument session so parallel tool calls cannot interleave their commands (AGENTS.md, Concurrency).";

/**
 * Make `server.tool` / `server.registerTool` throw, so a tool that bypasses `defineTool` (and with it
 * the exclusive-session lock) fails at startup and in every test instead of corrupting a parallel call.
 */
export function guardToolRegistration(server: McpServer): void {
  const refuse = () => {
    throw new Error(REFUSED);
  };
  const guarded = server as unknown as Record<string, unknown>;
  guarded.tool = refuse;
  guarded.registerTool = refuse;
}

/**
 * Register a tool. The ONLY way tools are registered: the handler runs inside
 * `connection.runExclusive`, so its whole command sequence is atomic with respect to every other
 * tool call (FIFO; helpers called from the handler join the session). Errors never escape: a busy
 * timeout, a closed connection or an unexpected throw all become an isError result.
 */
export function defineTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  description: string,
  shape: Args,
  annotations: ToolAnnotations,
  handler: (args: Parameters<ToolCallback<Args>>[0]) => CallToolResult | Promise<CallToolResult>,
  options: DefineToolOptions<Parameters<ToolCallback<Args>>[0]> = {}
): void {
  const run = async (args: Parameters<ToolCallback<Args>>[0]): Promise<CallToolResult> => {
    try {
      const problem = options.validate?.(args);
      if (problem) return errorResult(problem);
      if (options.exclusive === false) return await handler(args);
      return await connection.runExclusive(() => handler(args), { label: name });
    } catch (err) {
      return errorResult(err);
    }
  };
  // Call the real registration directly: createServer() guards the instance's own tool().
  const register = McpServer.prototype.tool as (this: McpServer, ...a: unknown[]) => unknown;
  register.call(server, name, description, shape, annotations, ((args: Parameters<ToolCallback<Args>>[0]) =>
    run(args)) as unknown);
}
