import { AsyncLocalStorage } from "node:async_hooks";
import type { UtsConnection } from "./connection.js";
import { isValidHost, isValidPort } from "./target.js";

/**
 * Registry of named instruments (issue #163). Each name owns one connection object, and with it
 * its own queue, hold-off state and exclusive-session lock, so calls to different instruments never
 * wait for each other. The registry is generic over the connection type: src/connection.ts
 * instantiates it with `UtsConnection` and exports the `connection` facade that resolves to the
 * instrument selected for the running tool call.
 */

/** The instrument that `UTS_IP`/`UTS_PORT` configure and that a call without a name uses. */
export const DEFAULT_INSTRUMENT = "default";

export interface InstrumentTarget {
  host: string;
  /** Absent when the configuration did not give one (the connection default applies). */
  port?: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const isValidInstrumentName = (name: string): boolean => NAME_RE.test(name);
const NAME_RULE = "1-32 characters from letters, digits, '_' and '-', starting with a letter or digit";

/** A bad instrument name or selection; the message says what to do. */
export class InstrumentSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstrumentSelectionError";
  }
}

// ---------- UTS_INSTRUMENTS ----------

const ENV = "UTS_INSTRUMENTS";
const bad = (detail: string) => new Error(`Invalid ${ENV}: ${detail}`);

function parsePort(text: string, where: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!isValidPort(port)) throw bad(`${where}: port "${text}" is not an integer 1-65535`);
  return port;
}

/** `host`, `host:port`, `[ipv6]` or `[ipv6]:port` to a target. */
function parseHostPort(text: string, where: string): InstrumentTarget {
  let host: string;
  let portText: string | undefined;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) throw bad(`${where}: missing ']' in "${text}"`);
    host = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) throw bad(`${where}: unexpected text after ']' in "${text}"`);
      portText = rest.slice(1);
    }
  } else {
    const colons = text.split(":").length - 1;
    if (colons > 1) throw bad(`${where}: an IPv6 address must be written in brackets, e.g. [fd00::1]:5025`);
    const at = text.indexOf(":");
    host = at < 0 ? text : text.slice(0, at);
    if (at >= 0) portText = text.slice(at + 1);
  }
  if (!isValidHost(host)) throw bad(`${where}: "${host}" is not a valid hostname or IP address`);
  return { host, port: portText === undefined ? undefined : parsePort(portText, where) };
}

function checkName(name: unknown, where: string): string {
  if (typeof name !== "string" || !isValidInstrumentName(name)) {
    throw bad(`${where}: name ${JSON.stringify(name)} is invalid, expected ${NAME_RULE}`);
  }
  return name;
}

function fromJsonValue(value: unknown, where: string): InstrumentTarget {
  if (typeof value === "string") return parseHostPort(value, where);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bad(`${where}: expected "host:port" or an object with host and optional port`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "host" && key !== "port" && key !== "name") throw bad(`${where}: unknown key "${key}" (allowed: name, host, port)`);
  }
  if (typeof obj.host !== "string" || !isValidHost(obj.host)) throw bad(`${where}: host is missing or not a valid hostname or IP address`);
  if (obj.port !== undefined && (typeof obj.port !== "number" || !isValidPort(obj.port))) {
    throw bad(`${where}: port must be an integer 1-65535`);
  }
  return { host: obj.host, port: obj.port as number | undefined };
}

/**
 * Parse `UTS_INSTRUMENTS`: `name=host[:port],name2=host2[:port2]` or JSON (an object `{name: "host:port" |
 * {host, port}}` or an array of `{name, host, port}`). Strict: any problem throws an Error naming the variable.
 */
export function parseInstrumentsEnv(value: string | undefined): Map<string, InstrumentTarget> {
  const out = new Map<string, InstrumentTarget>();
  const add = (name: string, target: InstrumentTarget) => {
    if (out.has(name)) throw bad(`duplicate instrument name "${name}"`);
    out.set(name, target);
  };
  const text = value?.trim() ?? "";
  if (text === "") return out;

  if (text.startsWith("{") || text.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw bad(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (Array.isArray(json)) {
      json.forEach((item, i) => {
        const where = `entry ${i + 1}`;
        if (item === null || typeof item !== "object" || Array.isArray(item)) throw bad(`${where}: expected an object with name and host`);
        add(checkName((item as Record<string, unknown>).name, where), fromJsonValue(item, where));
      });
    } else {
      for (const [name, v] of Object.entries(json as Record<string, unknown>)) {
        if (typeof v === "object" && v !== null && "name" in v) throw bad(`"${name}": unknown key "name" (the key is the name)`);
        add(checkName(name, `"${name}"`), fromJsonValue(v, `"${name}"`));
      }
    }
    return out;
  }

  for (const raw of text.split(",")) {
    const entry = raw.trim();
    if (entry === "") throw bad("empty entry (stray comma)");
    const eq = entry.indexOf("=");
    if (eq < 0) throw bad(`"${entry}" is not name=host[:port]`);
    const name = checkName(entry.slice(0, eq).trim(), `"${entry}"`);
    const hostPart = entry.slice(eq + 1).trim();
    if (hostPart === "") throw bad(`"${entry}": missing host`);
    add(name, parseHostPort(hostPart, `"${entry}"`));
  }
  return out;
}

/** The extra instruments from the environment; `UTS_IP` defines `default`, so a `default` entry as well is a conflict. */
export function instrumentTargetsFromEnv(env: Record<string, string | undefined>): Map<string, InstrumentTarget> {
  const targets = parseInstrumentsEnv(env[ENV]);
  if (targets.has(DEFAULT_INSTRUMENT) && env.UTS_IP) {
    throw bad(`"${DEFAULT_INSTRUMENT}" is defined by UTS_IP already; remove one of the two (or rename the ${ENV} entry)`);
  }
  return targets;
}

// ---------- registry ----------

export class InstrumentRegistry<C> {
  private readonly connections = new Map<string, C>();
  private readonly targets = new Map<string, InstrumentTarget | undefined>();
  private readonly selected = new AsyncLocalStorage<C>();

  private factory: ((name: string) => C) | undefined;

  constructor(factory?: (name: string) => C) {
    this.factory = factory;
  }

  /** Set how connections are made (src/connection.ts does this at load, which keeps this module free of a runtime import cycle). */
  useFactory(factory: (name: string) => C): void {
    this.factory = factory;
  }

  /** Add the instrument (or return the existing one), remembering its configured target. */
  declare(name: string, target?: InstrumentTarget): C {
    if (!isValidInstrumentName(name)) {
      throw new InstrumentSelectionError(`Invalid instrument name ${JSON.stringify(name)}: expected ${NAME_RULE}.`);
    }
    let conn = this.connections.get(name);
    if (!conn) {
      if (!this.factory) throw new Error("No connection factory configured for the instrument registry");
      conn = this.factory(name);
      this.connections.set(name, conn);
    }
    if (target) this.targets.set(name, target);
    return conn;
  }

  names(): string[] {
    return [...this.connections.keys()];
  }

  has(name: string): boolean {
    return this.connections.has(name);
  }

  get(name: string): C | undefined {
    return this.connections.get(name);
  }

  target(name: string): InstrumentTarget | undefined {
    return this.targets.get(name);
  }

  list(): Array<{ name: string; target: InstrumentTarget | undefined }> {
    return this.names().map((name) => ({ name, target: this.targets.get(name) }));
  }

  /**
   * The connection for a tool call. With a name it must exist. Without one: `default` if declared, else the only
   * instrument, else an error asking for the name; with nothing declared yet, `default` is created (it reports "not connected").
   */
  resolve(name?: string): C {
    if (name !== undefined) {
      const conn = this.connections.get(name);
      if (conn) return conn;
      throw new InstrumentSelectionError(
        isValidInstrumentName(name)
          ? `Unknown instrument "${name}". ${this.known()} Use list_instruments to see them.`
          : `Invalid instrument name ${JSON.stringify(name)}: expected ${NAME_RULE}. ${this.known()}`
      );
    }
    const def = this.connections.get(DEFAULT_INSTRUMENT);
    if (def) return def;
    if (this.connections.size === 0) return this.declare(DEFAULT_INSTRUMENT);
    if (this.connections.size === 1) return [...this.connections.values()][0]!;
    throw new InstrumentSelectionError(
      `Several instruments are configured (${this.names().join(", ")}) and none is named "${DEFAULT_INSTRUMENT}": ` +
        "pass the 'instrument' argument naming one of them."
    );
  }

  private known(): string {
    return this.connections.size === 0 ? "No instruments are configured." : `Configured instruments: ${this.names().join(", ")}.`;
  }

  /** Run `fn` with `conn` as the instrument `current()` returns (follows awaits, timers and callbacks). */
  runWith<T>(conn: C, fn: () => T): T {
    return this.selected.run(conn, fn);
  }

  /** The instrument of the running tool call, else the default one. */
  current(): C {
    return this.selected.getStore() ?? this.resolve();
  }

  /** Shut every connection down; a failure on one does not stop the others. */
  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((c) => (c as { shutdown?: () => Promise<void> }).shutdown?.())
    );
  }
}

/** The process-wide registry of `UtsConnection`s (its factory is installed by src/connection.ts). */
export const instruments = new InstrumentRegistry<UtsConnection>();
