import * as dgram from "node:dgram";
import { XdrReader, XdrWriter } from "../src/vxi11/xdr.js";

/** A GETPORT request as the fake saw it. */
export interface FakeUdpRequest {
  xid: number;
  program: number;
  version: number;
  procedure: number;
  mapping: { program: number; version: number; protocol: number; port: number };
}

export interface FakeUdpPortmapper {
  /** Port the fake listens on (127.0.0.1, UDP). */
  port: number;
  requests: FakeUdpRequest[];
  close(): Promise<void>;
}

/** An accepted RPC reply to `xid` carrying one XDR u32 (the portmapper GETPORT result). */
export function getPortReply(xid: number, port: number): Buffer {
  return new XdrWriter().u32(xid).u32(1).u32(0).u32(0).u32(0).u32(0).u32(port).toBuffer() as Buffer;
}

/**
 * In-process UDP portmapper on 127.0.0.1. `respond` gets each parsed request and returns the datagrams to send back
 * (none to stay silent, several for duplicates, arbitrary bytes for malformed replies).
 */
export async function startFakeUdpPortmapper(respond: (req: FakeUdpRequest) => Buffer[] | undefined): Promise<FakeUdpPortmapper> {
  const socket = dgram.createSocket("udp4");
  const requests: FakeUdpRequest[] = [];
  socket.on("message", (msg, rinfo) => {
    try {
      const r = new XdrReader(msg);
      const xid = r.u32();
      r.u32(); // CALL
      r.u32(); // rpc version
      const program = r.u32();
      const version = r.u32();
      const procedure = r.u32();
      r.u32(); r.opaque(400); // cred
      r.u32(); r.opaque(400); // verf
      const mapping = { program: r.u32(), version: r.u32(), protocol: r.u32(), port: r.u32() };
      const req = { xid, program, version, procedure, mapping };
      requests.push(req);
      for (const out of respond(req) ?? []) socket.send(out, rinfo.port, rinfo.address);
    } catch {
      /* not a call we understand */
    }
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    port: socket.address().port,
    requests,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
