import { AsyncLocalStorage } from "node:async_hooks";
import { queryParsed } from "./instrument.js";

// Command: `:INSTrument[:SELect] {SA|EMI|AD}` / `:INSTrument[:SELect]?`, programming manual p.6
// (docs/research/emi-function.md, docs/research/analog-demodulation.md). Same-named commands (for example
// `:SENSe:FREQuency:CENTer`) mean something different per module, so every SA-only tool refuses before
// sending anything when the analyzer is not in the SA module (#178, #191).
//
// Checked lazily, at most once per tool call, by the first real instrument access (instrument.ts's
// queryParsed/applyCommands, and the handful of tools that call connection.query/queryBinary directly -
// see the `ensureModuleOk()` call sites), not eagerly at the start of defineTool's exclusive session. A
// tool that rejects its own arguments before touching the instrument (many do, deep in the handler rather
// than in defineTool's `validate` option) must still send nothing at all (AGENTS.md, error handling
// standard); checking eagerly would add one query even to those calls. Deliberately uncached across calls,
// unlike the two issues' suggested design: the parallel-call contract test (AGENTS.md, Concurrency) asserts
// every one of several concurrent calls to the same tool sends the exact same command sequence as a solo
// call, which a cross-call cache (the obvious approach, mirroring instrument.ts's first-setter flag) would
// break on the 2nd/3rd call. One extra read-only query on the first real instrument access of a call is a
// small, constant cost next to that invariant, and it also means a module switch made outside this process
// is never read stale.

export const MODULES = { sa: "SA", emi: "EMI", ad: "AD" } as const;
export type ModuleName = keyof typeof MODULES;
export const MODULE_NAMES = Object.keys(MODULES) as [ModuleName, ...ModuleName[]];
const REVERSE: Partial<Record<string, ModuleName>> = Object.fromEntries(
  Object.entries(MODULES).map(([k, v]) => [v, k as ModuleName])
);

export function parseModuleReply(reply: string): ModuleName {
  const name = REVERSE[reply.trim().toUpperCase()];
  if (!name) throw new Error(`expected SA, EMI or AD, got ${JSON.stringify(reply)}`);
  return name;
}

async function readModule(): Promise<ModuleName> {
  return queryParsed(":INSTrument:SELect?", parseModuleReply);
}

const LABELS: Record<ModuleName, string> = {
  sa: "spectrum analyzer (SA)",
  emi: "EMI",
  ad: "analog demodulation (AD)",
};

interface GuardContext {
  expected: ModuleName;
  checked: boolean;
}

const guardContext = new AsyncLocalStorage<GuardContext | undefined>();

/**
 * Run `fn` (a tool's handler) with a pending module requirement: the first call to `ensureModuleOk()`
 * made from inside it checks the module and throws if it does not match; later calls in the same `fn`
 * are no-ops. `expected: false` runs `fn` with no requirement at all (defineTool's `requireModule: false`).
 */
export function withModuleGuard<T>(expected: ModuleName | false, fn: () => Promise<T>): Promise<T> {
  if (expected === false) return fn();
  return guardContext.run({ expected, checked: false }, fn);
}

/**
 * Check the module once per `withModuleGuard` session, right before the first real instrument access.
 * A no-op outside a guarded session (get_instrument_module, select_instrument_module, connection/scpi
 * tools: all opt out with `requireModule: false`) or after the first call in one already checked it.
 */
export async function ensureModuleOk(): Promise<void> {
  const ctx = guardContext.getStore();
  if (!ctx || ctx.checked) return;
  ctx.checked = true;
  const actual = await readModule();
  if (actual === ctx.expected) return;
  throw new Error(
    `This tool only works in the ${LABELS[ctx.expected]} module, but the analyzer is currently in the ${LABELS[actual]} module. ` +
      "Call select_instrument_module to switch, then retry."
  );
}
