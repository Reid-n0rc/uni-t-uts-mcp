import { getPort, PMAP_PORT } from "../vxi11/portmapper.js";
import { VXI11_CORE_PROGRAM, VXI11_CORE_VERSION } from "../vxi11/client.js";

/**
 * Choosing the transport: `UTS_TRANSPORT=raw|vxi11|auto` (default auto), the VXI-11 device name
 * (`UTS_VXI11_DEVICE`, default inst0) and the probe behind `auto`. Everything here comes from
 * environment variables or tool parameters, so it is validated strictly before any connection.
 */

export type TransportChoice = "raw" | "vxi11" | "auto";
export const TRANSPORT_CHOICES: readonly TransportChoice[] = ["raw", "vxi11", "auto"];
/**
 * Decision of issue #75: every tool works over VXI-11 on the UTS3036B with the same values as over raw, and VXI-11
 * is better where they differ (commands are queued during a sweep instead of dropped, no stall after an
 * unsupported query, the full screenshot arrives). `auto` uses it when the instrument offers it and falls back to
 * raw otherwise, so the default stays safe on instruments or networks without VXI-11.
 */
export const DEFAULT_TRANSPORT: TransportChoice = "auto";
export const DEFAULT_VXI11_DEVICE = "inst0";
const MAX_DEVICE_NAME = 64;

/** Show untrusted input in an error message: short, printable only. */
function shown(value: string): string {
  return value.slice(0, 40).replace(/[^\x20-\x7e]/g, "?");
}

/** Parse a transport name; `source` (an env var or parameter name) is named in the error. */
export function parseTransportChoice(value: string, source = "transport"): TransportChoice {
  const v = value.trim().toLowerCase();
  if ((TRANSPORT_CHOICES as readonly string[]).includes(v)) return v as TransportChoice;
  throw new Error(`Invalid ${source} "${shown(value)}": expected raw, vxi11 or auto`);
}

/** `UTS_TRANSPORT`: unset or empty means raw. */
export function transportFromEnv(value: string | undefined): TransportChoice {
  if (value === undefined || value === "") return DEFAULT_TRANSPORT;
  return parseTransportChoice(value, "UTS_TRANSPORT");
}

export interface ResolveTransportInput {
  /** The `transport` tool parameter. */
  param?: string;
  /** The `UTS_TRANSPORT` environment variable. */
  env?: string;
  /** A TCP port was given (tool parameter or `UTS_PORT`): it only means something to the raw transport. */
  portGiven?: boolean;
}

/**
 * The transport to use: an explicit choice (parameter, then `UTS_TRANSPORT`) wins; with none, a port that was
 * given means raw (it is a raw-transport setting, for example a tunnel); otherwise the default (auto).
 */
export function resolveTransport(input: ResolveTransportInput): TransportChoice {
  if (input.param !== undefined) return parseTransportChoice(input.param, "transport");
  if (input.env !== undefined && input.env !== "") return parseTransportChoice(input.env, "UTS_TRANSPORT");
  return input.portGiven ? "raw" : DEFAULT_TRANSPORT;
}

/** Letters, digits and `. _ , -`, 1 to 64 characters (VXI-11 logical names such as inst0 or gpib0,5). */
export function isValidDeviceName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_DEVICE_NAME && /^[A-Za-z0-9._,-]+$/.test(name);
}

/** `UTS_VXI11_DEVICE`: unset or empty means inst0. */
export function vxi11DeviceFromEnv(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_VXI11_DEVICE;
  if (!isValidDeviceName(value)) {
    throw new Error(
      `Invalid UTS_VXI11_DEVICE "${shown(value)}": expected 1-${MAX_DEVICE_NAME} characters from letters, digits and . _ , -`
    );
  }
  return value;
}

export interface Vxi11Probe {
  available: boolean;
  /** Why VXI-11 is not available (set when `available` is false). */
  reason?: string;
}

export interface ProbeOptions {
  /** Portmapper port (default 111). */
  portmapperPort?: number;
  timeoutMs?: number;
}

/**
 * Ask the portmapper on `host` (TCP port 111) whether the VXI-11 core program is registered.
 * Never throws; bounded by `timeoutMs` (default 5000).
 */
export async function probeVxi11(host: string, options: ProbeOptions = {}): Promise<Vxi11Probe> {
  try {
    const port = await getPort(host, VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, {
      portmapperPort: options.portmapperPort ?? PMAP_PORT,
      timeoutMs: options.timeoutMs ?? 5000,
    });
    if (port === 0) {
      return { available: false, reason: `the VXI-11 core program is not registered with the portmapper on ${host}` };
    }
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `the portmapper on ${host} did not answer (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
