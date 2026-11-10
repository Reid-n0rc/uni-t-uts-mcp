/** Connection target (host/port) parsing and validation shared by the connect tool and auto-connect. */

export const DEFAULT_PORT = 5025;

/** Hostnames, IPv4 and IPv6 literals only: no whitespace, slashes, quotes or separators. */
export function isValidHost(host: string): boolean {
  return host.length >= 1 && host.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9.\-_:%[\]]*$/.test(host);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Parse a port from an environment variable; throws a message naming `UTS_PORT`. */
export function portFromEnv(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!isValidPort(port)) throw new Error(`Invalid UTS_PORT "${value}": expected an integer 1-65535`);
  return port;
}
