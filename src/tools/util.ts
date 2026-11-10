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
