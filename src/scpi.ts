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
  { path: ["MMEMORY", "*", "CALIBRATION"], description: "writes a calibration file" },
  { path: ["SYSTEM", "INFO"], description: "can rewrite factory model/bandwidth configuration (confirmed by firmware disassembly)" },
  { path: ["FACTORY"], description: "factory-only command" },
  { path: ["CALIBRATION"], description: "calibration command" },
  { path: ["SERVICE", "LATCH", "VALUE"], description: "service latch value" },
  { path: ["MOUSE"], description: "simulates mouse/touch input" },
];

function nodeMatches(node: string, longForm: string): boolean {
  if (longForm === "*") return true;
  const name = node.toUpperCase().replace(/\d+$/, "");
  return name === longForm || (name.length >= 3 && longForm.startsWith(name));
}

interface Statement {
  text: string;
  /** True when this statement begins a new program message (after CR/LF): the path resets. */
  newMessage: boolean;
}

type SplitResult = { statements: Statement[] } | { error: string };

const NON_ASCII = /[^\u0000-\u007f]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Split a command line into statements. `;` separates commands within a
 * program message; CR and LF (and CRLF) end a program message, because the
 * instrument accepts them as terminators. Quoted strings and `#<N><len>`
 * definite-length blocks are skipped as data. Anything ambiguous (control
 * characters, unterminated quotes, malformed blocks) is an error so callers
 * fail closed.
 */
function splitStatements(line: string): SplitResult {
  // Block lengths are counted in bytes by the instrument but in UTF-16 units here,
  // so non-ASCII text could make the two parsers disagree. Fail closed.
  if (NON_ASCII.test(line)) return { error: "command contains non-ASCII characters" };
  if (CONTROL_CHARS.test(line)) return { error: "command contains control characters" };

  const statements: Statement[] = [];
  let current = "";
  let newMessage = true;
  let seenHeaderEnd = false; // past the header (first whitespace) of the current statement
  let i = 0;

  const flush = () => {
    const text = current.trim();
    if (text.length > 0) {
      statements.push({ text, newMessage });
      newMessage = false;
    }
    current = "";
    seenHeaderEnd = false;
  };

  while (i < line.length) {
    const ch = line[i];

    if (ch === '"' || ch === "'") {
      const close = line.indexOf(ch, i + 1);
      if (close < 0) return { error: "command contains an unterminated quoted string" };
      current += line.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    if (ch === "#" && seenHeaderEnd && /[ \t,]/.test(line[i - 1] ?? "")) {
      const digitCount = Number(line[i + 1]);
      if (!(digitCount >= 1 && digitCount <= 9)) {
        return { error: "command contains a malformed # block header" };
      }
      const lengthText = line.slice(i + 2, i + 2 + digitCount);
      if (lengthText.length !== digitCount || !/^[0-9]+$/.test(lengthText)) {
        return { error: "command contains a malformed # block length" };
      }
      const end = i + 2 + digitCount + parseInt(lengthText, 10);
      if (end > line.length) return { error: "command contains a truncated # block" };
      current += line.slice(i, end);
      i = end;
      continue;
    }

    if (ch === ";") {
      flush();
    } else if (ch === "\r" || ch === "\n") {
      // Only CRLF and LF are treated as terminators; a lone CR is ambiguous, so fail closed.
      if (ch === "\r" && line[i + 1] !== "\n") {
        return { error: "command contains a lone CR (use LF or CRLF)" };
      }
      flush();
      newMessage = true;
    } else {
      if (/[ \t]/.test(ch) && current.trim().length > 0) seenHeaderEnd = true;
      current += ch;
    }
    i++;
  }
  flush();
  return { statements };
}

export type LineAnalysis =
  | { ok: true; statements: number; queries: number }
  | { ok: false; reason: string };

/**
 * Count the statements and queries (headers ending in `?`) in a command line, using
 * the same tokenizer as the denylist. Fails closed (`ok: false`) when the line is
 * ambiguous, so callers can refuse it.
 */
export function analyzeLine(line: string): LineAnalysis {
  const split = splitStatements(line);
  if ("error" in split) return { ok: false, reason: split.error };
  const queries = split.statements.filter(({ text }) => text.split(/\s/, 1)[0].endsWith("?")).length;
  return { ok: true, statements: split.statements.length, queries };
}

/** Common (`*`) commands that need confirmation. *SAV overwrites saved state like :MMEMory:STORe. */
const BLOCKED_COMMON = new Map<string, string>([
  ["*RST", "*RST resets the instrument to factory defaults"],
  ["*SAV", "*SAV writes (and may overwrite) a saved instrument state"],
]);

/** Check a command line (possibly several `;`-separated commands). */
export function checkCommand(line: string): CommandCheck {
  const split = splitStatements(line);
  if ("error" in split) return blocked(split.error);

  let previousPath: string[] = [];

  for (const { text: segment, newMessage } of split.statements) {
    if (newMessage) previousPath = [];
    const header = segment.split(/\s/, 1)[0];
    const isQuery = header.endsWith("?");

    if (header.startsWith("*")) {
      const why = BLOCKED_COMMON.get(header.toUpperCase());
      if (why) return blocked(why);
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
