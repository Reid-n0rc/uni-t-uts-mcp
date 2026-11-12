import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { connection } from "../connection.js";
import { instruments, isValidInstrumentName } from "../registry.js";
import { InstrumentError } from "../instrument.js";
import { withModuleGuard, type ModuleName } from "../moduleGuard.js";

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
  /**
   * The tool names an instrument in this argument (`name` for connect/disconnect/identify): when it is given, the handler
   * runs with that instrument selected (`connection` resolves to it) and in its own session. `create` registers an unknown
   * name (only `connect`; a first connect that fails does not leave the name registered). An unknown or invalid name is
   * an error result before anything is sent. Without the argument the default instrument is used. Default: the optional
   * `instrument` argument, added to the tool's schema here for every tool; `false` for tools that take none (the listing tools).
   */
  instrumentArg?: { name: string; create?: boolean } | false;
  /**
   * The module this tool requires (same-named commands mean something different per module, #178/#191).
   * Checked first thing inside the exclusive session, before the handler sends anything, against a
   * per-instrument cache invalidated by select_instrument_module. Defaults to "sa": every tool that talks
   * to the instrument is SA-only unless it says otherwise. Pass `false` to opt out (connection/scpi tools,
   * and get_instrument_module/select_instrument_module themselves, which must work in any module).
   */
  requireModule?: ModuleName | false;
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

const INSTRUMENT_ARG = "instrument";
const instrumentSchema = z
  .string()
  .refine(isValidInstrumentName, "instrument must be 1-32 characters: letters, digits, '_' or '-'")
  .optional()
  .describe("Which instrument to use (a name from list_instruments). Default: the `default` instrument, or the only one configured");

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
  // Every tool takes the optional `instrument` argument unless it names its own (`name`) or opts out.
  const selector = options.instrumentArg === undefined ? { name: INSTRUMENT_ARG } : options.instrumentArg;
  const fullShape = (selector && selector.name === INSTRUMENT_ARG
    ? { ...shape, [INSTRUMENT_ARG]: instrumentSchema }
    : shape) as Args;
  const run = async (args: Parameters<ToolCallback<Args>>[0]): Promise<CallToolResult> => {
    try {
      const named = selector ? (args as Record<string, unknown>)[selector.name] : undefined;
      // An unknown instrument is refused first: it needs no instrument access and says what the choices are.
      if (typeof named === "string" && !(selector && selector.create)) instruments.resolve(named);
      const problem = options.validate?.(args);
      if (problem) return errorResult(problem);
      if (typeof named === "string") return await runOnInstrument(named, args);
      if (options.exclusive === false) return await handler(args);
      return await connection.runExclusive(() => runGuarded(args), { label: name });
    } catch (err) {
      return errorResult(err);
    }
  };
  const requiredModule = options.requireModule === undefined ? "sa" : options.requireModule;
  const runGuarded = (args: Parameters<ToolCallback<Args>>[0]): Promise<CallToolResult> =>
    withModuleGuard(requiredModule, async () => handler(args));
  const runOnInstrument = async (named: string, args: Parameters<ToolCallback<Args>>[0]): Promise<CallToolResult> => {
    const existed = instruments.has(named);
    const conn = selector && selector.create ? instruments.declare(named) : instruments.resolve(named);
    try {
      return await instruments.runWith(conn, () =>
        options.exclusive === false ? handler(args) : conn.runExclusive(() => runGuarded(args), { label: name })
      );
    } finally {
      if (selector && selector.create && !existed && !conn.isConnected()) instruments.remove(named);
    }
  };
  // Call the real registration directly: createServer() guards the instance's own tool().
  const register = McpServer.prototype.tool as (this: McpServer, ...a: unknown[]) => unknown;
  register.call(server, name, description, fullShape, annotations, ((args: Parameters<ToolCallback<Args>>[0]) =>
    run(args)) as unknown);
}
