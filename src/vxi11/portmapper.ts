/** ONC RPC portmapper (program 100000 version 2, RFC 1833) lookups, dependency-free. */
import { RpcClient, RpcProtocolError } from "./rpc.js";
import { XdrError, XdrReader, XdrWriter } from "./xdr.js";

export const PMAP_PROGRAM = 100000;
export const PMAP_VERSION = 2;
export const PMAPPROC_GETPORT = 3;
export const PMAP_PORT = 111;
export const IPPROTO_TCP = 6;

export interface GetPortOptions {
  /** Portmapper port (default 111). */
  portmapperPort?: number;
  timeoutMs?: number;
}

/**
 * Ask the portmapper on `host` for the TCP port of `program`/`version`.
 * Returns 0 when the program is not registered. Always closes its connection.
 * Rejects with an RpcError subclass on connect failure, timeout or a malformed reply.
 */
export async function getPort(host: string, program: number, version: number, options: GetPortOptions = {}): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const client = await RpcClient.connect(host, options.portmapperPort ?? PMAP_PORT, { connectTimeoutMs: timeoutMs });
  try {
    // struct mapping { prog; vers; prot; port }
    const args = new XdrWriter().u32(program).u32(version).u32(IPPROTO_TCP).u32(0).toBuffer();
    const reply: XdrReader = await client.call(PMAP_PROGRAM, PMAP_VERSION, PMAPPROC_GETPORT, args, { timeoutMs });
    try {
      const port = reply.u32();
      reply.expectEnd();
      if (port > 65535) throw new XdrError(`port ${port} is out of range`);
      return port;
    } catch (err) {
      if (err instanceof XdrError) throw new RpcProtocolError(`portmapper GETPORT: malformed reply: ${err.message}`);
      throw err;
    }
  } finally {
    client.close();
  }
}
