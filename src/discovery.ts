/**
 * Find UNI-T / VXI-11 analyzers on the local network without knowing their address (issue #85).
 *
 * The analyzer answers the ONC RPC portmapper (UDP and TCP port 111) and registers the VXI-11 core program, so one
 * broadcast GETPORT(395183 v1, TCP) per local IPv4 interface makes every VXI-11 instrument on that subnet answer.
 * Each responder is then identified with `*IDN?` (the only thing ever sent to it; discovery never changes instrument
 * state) over VXI-11, falling back to raw SCPI on TCP 5025, and port 5025 is checked with a plain TCP connect.
 *
 * Safety properties, all deliberate:
 * - it never scans: it only broadcasts to the directed broadcast address of each local interface (never a range of
 *   hosts or ports) and only talks to hosts that answered the portmapper query;
 * - it is time-boxed (reply window, per-host probe timeout, at most MAX_RESPONDERS hosts) and never throws;
 * - reply datagrams are untrusted network input: size-capped, strictly parsed, matched to our xid, IPv4 sources only;
 * - the serial number in `*IDN?` is dropped (never returned, never logged).
 * Works on Windows, macOS and Linux with `node:dgram` and `node:os` only.
 */
import * as dgram from "node:dgram";
import * as net from "node:net";
import * as os from "node:os";
import { randomInt } from "node:crypto";
import { PMAP_PORT, PMAP_PROGRAM, PMAP_VERSION, PMAPPROC_GETPORT, IPPROTO_TCP } from "./vxi11/portmapper.js";
import { VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, Vxi11Client } from "./vxi11/client.js";
import { MSG_REPLY, encodeCall, parseReply } from "./vxi11/rpc.js";
import { XdrWriter } from "./vxi11/xdr.js";
import { DEFAULT_PORT } from "./target.js";

export const DEFAULT_WINDOW_MS = 1500;
export const MIN_WINDOW_MS = 100;
export const MAX_WINDOW_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
/** A GETPORT reply is 28 bytes; anything much larger is not one. */
const MAX_DATAGRAM = 512;
/** Identification work is bounded: more responders than this are reported in `notes` and not identified. */
export const MAX_RESPONDERS = 16;
const MAX_IDN_BYTES = 256;

export interface DiscoveryTarget {
  /** IPv4 address the request is sent to (a directed broadcast address in normal use). */
  address: string;
  /** Local interface address to send from (so each interface gets its own broadcast). */
  bindAddress?: string;
  /** Netmask of that interface: replies are accepted only from hosts inside this subnet (see `acceptResponder`). */
  netmask?: string;
  /** UDP port of the portmapper (default 111; tests aim at a fake). */
  port?: number;
}

export interface DiscoverOptions {
  /** How long to collect replies, in ms (default 1500; clamped to 100-10000). */
  windowMs?: number;
  /** Override the broadcast targets (default: one per external IPv4 interface). */
  targets?: DiscoveryTarget[];
  /** Raw SCPI port to check (default 5025). */
  rawPort?: number;
  /** Per host and per step (VXI-11, raw) timeout of the identification, in ms (default 3000). */
  probeTimeoutMs?: number;
  /** Hosts that are not to be identified (the one already connected: do not disturb its session). */
  skipIdentify?: ReadonlySet<string>;
}

export interface InstrumentIdentity {
  manufacturer: string;
  model: string;
  firmware: string;
}

export interface DiscoveredInstrument {
  host: string;
  /** The portmapper on this host registers the VXI-11 core channel. */
  vxi11: boolean;
  vxi11Port: number;
  /** TCP port 5025 accepts a connection (raw SCPI). */
  raw: boolean;
  /** From `*IDN?`, without the serial number; absent when the host could not be (or was not to be) identified. */
  idn?: InstrumentIdentity;
  /** A UNI-T analyzer by its identification. */
  analyzer: boolean;
  note?: string;
}

export interface DiscoveryResult {
  instruments: DiscoveredInstrument[];
  /** Things that went wrong or were skipped (a socket that could not be opened, hosts not identified, ...). */
  notes: string[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

function ipv4ToInt(ip: string): number | undefined {
  if (!net.isIPv4(ip)) return undefined;
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}
const intToIpv4 = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/**
 * Directed broadcast target of every external IPv4 interface (`ip | ~netmask`), bound to the interface address.
 * Loopback, link-local (169.254/16), IPv6 and masks without a broadcast domain (/31, /32) are skipped.
 */
export function broadcastTargets(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): DiscoveryTarget[] {
  const targets: DiscoveryTarget[] = [];
  const seen = new Set<string>();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (!info || info.internal) continue;
      if (info.family !== "IPv4" && (info.family as unknown) !== 4) continue;
      const ip = ipv4ToInt(info.address);
      const mask = ipv4ToInt(info.netmask);
      if (ip === undefined || mask === undefined) continue;
      if (mask === 0xffffffff || mask === 0xfffffffe || mask === 0) continue;
      if (info.address.startsWith("169.254.")) continue;
      const broadcast = intToIpv4(((ip | ~mask) >>> 0));
      const key = `${info.address}>${broadcast}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ address: broadcast, bindAddress: info.address, netmask: info.netmask });
    }
  }
  return targets;
}

/**
 * Trust rule for a reply source (the portmapper protocol is unauthenticated, so anything that can send a datagram
 * could answer): with a netmask, only a plain host address inside the subnet of the interface the request left from
 * (not the network or broadcast address, not this computer, never loopback or multicast); with an explicit unicast
 * target and no netmask, only that very host. Anything unparsable is refused.
 */
export function acceptResponder(source: string, target: DiscoveryTarget): boolean {
  const src = ipv4ToInt(source);
  if (src === undefined) return false;
  if (target.netmask === undefined || target.bindAddress === undefined) {
    const t = ipv4ToInt(target.address);
    return t !== undefined && t === src && (t & 0xff) !== 255;
  }
  const first = src >>> 24;
  if (first === 127 || first >= 224 || first === 0) return false; // loopback, multicast/reserved, "this network"
  const mask = ipv4ToInt(target.netmask);
  const own = ipv4ToInt(target.bindAddress);
  if (mask === undefined || own === undefined) return false;
  if (((src & mask) >>> 0) !== ((own & mask) >>> 0)) return false;
  return src !== own && ((src & ~mask) >>> 0) !== 0 && ((src | mask) >>> 0) !== 0xffffffff;
}

/** `manufacturer,model,serial,firmware` to its parts without the serial; undefined for anything else. */
export function parseIdn(reply: string): InstrumentIdentity | undefined {
  const text = reply.trim();
  if (text.length === 0 || text.length > MAX_IDN_BYTES || !/^[\x20-\x7e]+$/.test(text)) return undefined;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length < 4 || !parts[0] || !parts[1]) return undefined;
  // Untrusted text that reaches the assistant: only plain identifier characters in the fields we pass on.
  const plain = /^[A-Za-z0-9 ._+\-\/()]+$/;
  if (![parts[0], parts[1], parts[3]].every((f) => plain.test(f))) return undefined;
  return { manufacturer: parts[0].slice(0, 64), model: parts[1].slice(0, 64), firmware: parts[3].slice(0, 64) };
}

/** UNI-T / UNI-TREND maker or a UTS model number. */
export function isUniTAnalyzer(idn: InstrumentIdentity): boolean {
  return /^uni-?t/i.test(idn.manufacturer) || /^uts\d/i.test(idn.model);
}

function windowFrom(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WINDOW_MS;
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(value)));
}

/** Port from a GETPORT reply datagram for `xid`, or undefined when it is anything else. Never throws. */
function parseGetPortDatagram(msg: Buffer, xid: number): number | undefined {
  try {
    if (msg.length < 28 || msg.length > MAX_DATAGRAM) return undefined;
    if (msg.readUInt32BE(0) !== xid || msg.readUInt32BE(4) !== MSG_REPLY) return undefined;
    const r = parseReply(msg, { program: PMAP_PROGRAM, version: PMAP_VERSION, procedure: PMAPPROC_GETPORT });
    const port = r.u32();
    r.expectEnd();
    // Below 1024 is a well-known service, never the analyzer's dynamic VXI-11 port: do not follow it.
    return port >= 1024 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Broadcast the request from one socket and collect `host -> VXI-11 port` until `done` resolves. */
async function broadcastOnce(
  target: DiscoveryTarget,
  request: Buffer,
  xid: number,
  windowMs: number,
  found: Map<string, number>,
  notes: string[]
): Promise<void> {
  if (!net.isIPv4(target.address) || (target.bindAddress !== undefined && !net.isIPv4(target.bindAddress))) {
    notes.push(`Skipped broadcast target ${JSON.stringify(target.address).slice(0, 40)}: not an IPv4 address`);
    return;
  }
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
  let failed = false;
  socket.on("error", (err) => {
    failed = true;
    notes.push(`Broadcast on ${target.bindAddress ?? "the default interface"} failed: ${errText(err)}`);
  });
  socket.on("message", (msg, rinfo) => {
    if (rinfo.family !== "IPv4" || !acceptResponder(rinfo.address, target)) return;
    const port = parseGetPortDatagram(msg, xid);
    if (port !== undefined && !found.has(rinfo.address)) found.set(rinfo.address, port);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, target.bindAddress, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.setBroadcast(true);
    const send = () =>
      socket.send(request, target.port ?? PMAP_PORT, target.address, (err) => {
        if (err && !failed) {
          failed = true;
          notes.push(`Broadcast to ${target.address} failed: ${errText(err)}`);
        }
      });
    send();
    // UDP loses datagrams: ask once more in the middle of the window (duplicates are merged by host).
    const again = setTimeout(() => {
      if (!failed) send();
    }, Math.floor(windowMs / 3));
    await new Promise<void>((resolve) => setTimeout(resolve, windowMs));
    clearTimeout(again);
  } catch (err) {
    if (!failed) notes.push(`Broadcast on ${target.bindAddress ?? "the default interface"} failed: ${errText(err)}`);
  } finally {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** Race `work` against `ms`; `cleanup` runs when the timer wins so a stuck probe releases its socket. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string, cleanup?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cleanup?.();
          reject(new Error(`${what} timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function identifyVxi11(host: string, port: number, timeoutMs: number): Promise<string> {
  const client = await Vxi11Client.connect(host, { port, connectTimeoutMs: timeoutMs });
  try {
    await client.write("*IDN?\n", { timeoutMs });
    const { data } = await client.read({ timeoutMs, maxBytes: MAX_IDN_BYTES, ioTimeoutFraction: 0.2 });
    return data.toString("latin1");
  } finally {
    await client.close().catch(() => {});
  }
}

/** Connect to the raw port; with `query`, also ask `*IDN?`. Resolves { connected, reply? }, never rejects. */
function probeRaw(host: string, port: number, timeoutMs: number, query: boolean): Promise<{ connected: boolean; reply?: string }> {
  return new Promise((resolve) => {
    let connected = false;
    let buffer = "";
    let finished = false;
    const socket = net.createConnection({ host, port });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ connected, reply: query && buffer.includes("\n") ? buffer.split("\n")[0] : undefined });
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("connect", () => {
      connected = true;
      if (!query) return finish();
      socket.write("*IDN?\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\n") || buffer.length > MAX_IDN_BYTES) finish();
    });
  });
}

async function describeHost(host: string, vxi11Port: number, options: Required<Pick<DiscoverOptions, "rawPort" | "probeTimeoutMs">> & DiscoverOptions): Promise<DiscoveredInstrument> {
  const entry: DiscoveredInstrument = { host, vxi11: true, vxi11Port, raw: false, analyzer: false };
  if (options.skipIdentify?.has(host)) {
    entry.note = "currently connected: not identified again";
    entry.analyzer = false;
    return entry;
  }
  const { rawPort, probeTimeoutMs } = options;
  let idn: InstrumentIdentity | undefined;
  const problems: string[] = [];
  try {
    idn = parseIdn(await withTimeout(identifyVxi11(host, vxi11Port, probeTimeoutMs), probeTimeoutMs * 3, "VXI-11 identification"));
    if (!idn) problems.push("VXI-11 *IDN? reply was not manufacturer,model,serial,firmware");
  } catch (err) {
    problems.push(`VXI-11 identification failed: ${errText(err)}`);
  }
  const raw = await probeRaw(host, rawPort, probeTimeoutMs, idn === undefined);
  entry.raw = raw.connected;
  if (idn === undefined && raw.reply !== undefined) {
    idn = parseIdn(raw.reply);
    if (!idn) problems.push("raw *IDN? reply was not manufacturer,model,serial,firmware");
  }
  if (idn) {
    entry.idn = idn;
    entry.analyzer = isUniTAnalyzer(idn);
    if (!entry.analyzer) entry.note = "not a UNI-T analyzer";
  } else {
    entry.note = `could not identify: ${problems.join("; ")}`;
  }
  return entry;
}

/**
 * Discover VXI-11 instruments on the local network. Never throws; problems are returned in `notes`.
 * Results are sorted by address.
 */
export async function discoverInstruments(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const notes: string[] = [];
  try {
    const windowMs = windowFrom(options.windowMs);
    const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) && options.probeTimeoutMs! > 0 ? Math.min(options.probeTimeoutMs!, 10_000) : DEFAULT_PROBE_TIMEOUT_MS;
    const rawPort = options.rawPort ?? DEFAULT_PORT;
    let targets = options.targets;
    if (!targets) {
      try {
        targets = broadcastTargets();
      } catch (err) {
        notes.push(`Could not list the network interfaces: ${errText(err)}`);
        targets = [];
      }
      if (targets.length === 0) notes.push("No usable IPv4 network interface found (is the computer connected to a network?)");
    }

    const xid = randomInt(1, 0x7fffffff);
    // mapping { prog; vers; prot; port }: where is the TCP service of the VXI-11 core channel?
    const args = new XdrWriter().u32(VXI11_CORE_PROGRAM).u32(VXI11_CORE_VERSION).u32(IPPROTO_TCP).u32(0).toBuffer();
    const request = encodeCall(xid, PMAP_PROGRAM, PMAP_VERSION, PMAPPROC_GETPORT, args);
    const found = new Map<string, number>();
    await Promise.all(targets.map((t) => broadcastOnce(t, request, xid, windowMs, found, notes)));

    let hosts = [...found.entries()].sort(([a], [b]) => (ipv4ToInt(a)! - ipv4ToInt(b)!));
    if (hosts.length > MAX_RESPONDERS) {
      notes.push(`${hosts.length} hosts answered; only the first ${MAX_RESPONDERS} were identified`);
      hosts = hosts.slice(0, MAX_RESPONDERS);
    }
    const instruments = await Promise.all(
      hosts.map(([host, port]) =>
        describeHost(host, port, { ...options, rawPort, probeTimeoutMs }).catch(
          (err): DiscoveredInstrument => ({ host, vxi11: true, vxi11Port: port, raw: false, analyzer: false, note: `could not identify: ${errText(err)}` })
        )
      )
    );
    return { instruments, notes };
  } catch (err) {
    notes.push(`Discovery failed: ${errText(err)}`);
    return { instruments: [], notes };
  }
}
