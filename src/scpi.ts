/**
 * Shared SCPI helpers: number/boolean formatting and parsing, and a denylist
 * of commands that need explicit confirmation (see docs/programming-guide.md,
 * section 10 "Safety notes").
 */

// ---------- formatting ----------

/** Format a finite number for a SCPI setter (plain decimal, exponent for extremes). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Value must be a finite number, got ${value}`);
  }
  return String(value).replace("e+", "E").replace("e-", "E-");
}

/** `formatNumber` followed by a space and a unit suffix, e.g. `100 MHz`. */
export function formatWithUnit(value: number, unit: string): string {
  return `${formatNumber(value)} ${unit}`;
}

export function onOff(value: boolean): "ON" | "OFF" {
  return value ? "ON" : "OFF";
}

// ---------- parsing ----------

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseNumber(reply: string): number {
  const text = reply.trim();
  if (!NUMBER_RE.test(text)) {
    throw new Error(`Expected a number, got ${JSON.stringify(reply)}`);
  }
  return Number(text);
}

export function parseNumberList(reply: string): number[] {
  const text = reply.trim();
  if (text === "") return [];
  return text.split(",").map((part) => parseNumber(part));
}

/** The manuals contain boolean typos; treat 1/ON/TRUE as true and 0/OFF/FALSE as false. */
export function parseBool(reply: string): boolean {
  const text = reply.trim().toUpperCase();
  if (text === "1" || text === "ON" || text === "TRUE") return true;
  if (text === "0" || text === "OFF" || text === "FALSE") return false;
  throw new Error(`Expected a boolean, got ${JSON.stringify(reply)}`);
}

// ---------- denylist ----------

export type CommandCheck = { allowed: true } | { allowed: false; reason: string };

export class DangerousCommandError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "DangerousCommandError";
  }
}

interface Rule {
  /** Long-form keywords from the root; `*` matches any single node. Prefix match. */
  path: string[];
  description: string;
}

/** Only commands that change state are blocked; the matching queries are allowed. */
const RULES: Rule[] = [
  { path: ["SYSTEM", "DEFAULT"], description: "resets the instrument to factory defaults" },
  { path: ["SYSTEM", "LOCK"], description: "locks the instrument front panel" },
  { path: ["KEY", "*", "LOCK"], description: "locks front-panel keys" },
  { path: ["SYSTEM", "COMMUNICATE", "LAN"], description: "changes network settings" },
  { path: ["SYSTEM", "CONFIGURE"], description: "changes system configuration" },
  { path: ["MMEMORY", "STORE"], description: "writes (and may overwrite) files on the instrument" },
];

function nodeMatches(node: string, longForm: string): boolean {
  if (longForm === "*") return true;
  const name = node.toUpperCase().replace(/\d+$/, "");
  return name === longForm || (name.length >= 3 && longForm.startsWith(name));
}

/** Split on ';' outside double or single quotes. */
function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ";") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Check a command line (possibly several `;`-separated commands). */
export function checkCommand(line: string): CommandCheck {
  let previousPath: string[] = [];

  for (const segment of splitCommands(line)) {
    const header = segment.split(/\s/, 1)[0];
    const isQuery = header.endsWith("?");

    if (header.startsWith("*")) {
      if (header.toUpperCase() === "*RST") {
        return blocked("*RST resets the instrument to factory defaults");
      }
      continue;
    }

    const body = header.replace(/\?$/, "");
    const absolute = body.startsWith(":");
    const nodes = body.replace(/^:/, "").split(":").filter((n) => n.length > 0);
    const path = absolute || previousPath.length === 0
      ? nodes
      : previousPath.slice(0, -1).concat(nodes);
    previousPath = path;

    if (isQuery) continue;
    for (const rule of RULES) {
      if (rule.path.length <= path.length && rule.path.every((kw, i) => nodeMatches(path[i], kw))) {
        return blocked(`${header} ${rule.description}`);
      }
    }
  }
  return { allowed: true };
}

function blocked(what: string): CommandCheck {
  return { allowed: false, reason: `${what}; this requires confirm=true.` };
}

/** Throw `DangerousCommandError` for a blocked command unless `confirm` is true. */
export function assertAllowed(line: string, confirm = false): void {
  if (confirm) return;
  const result = checkCommand(line);
  if (!result.allowed) throw new DangerousCommandError(result.reason);
}
