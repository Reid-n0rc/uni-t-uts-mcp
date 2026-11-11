import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getPort } from "../../src/vxi11/portmapper.js";
import { RpcAcceptError, RpcConnectError, RpcProtocolError, RpcTimeoutError } from "../../src/vxi11/rpc.js";
import { XdrWriter } from "../../src/vxi11/xdr.js";
import { portKey, startFakeRpcServer, type FakeRpcServer } from "../fakeRpcServer.js";

let server: FakeRpcServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("getPort", () => {
  it("returns the registered port", async () => {
    server = await startFakeRpcServer();
    server.registerPortmapper(new Map([[portKey(395183, 1), 56569]]));
    expect(await getPort("127.0.0.1", 395183, 1, { portmapperPort: server.port })).toBe(56569);
    const call = server.calls[0];
    expect([call.program, call.version, call.procedure]).toEqual([100000, 2, 3]);
  });

  it("returns 0 for a program that is not registered", async () => {
    server = await startFakeRpcServer();
    server.registerPortmapper();
    expect(await getPort("127.0.0.1", 395184, 1, { portmapperPort: server.port })).toBe(0);
  });

  it("closes its connection after every lookup", async () => {
    server = await startFakeRpcServer();
    server.registerPortmapper();
    await getPort("127.0.0.1", 1, 1, { portmapperPort: server.port });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.sockets.size).toBe(0);
  });

  it("rejects with RpcConnectError when port 111 is unreachable", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(getPort("127.0.0.1", 395183, 1, { portmapperPort: port, timeoutMs: 2000 })).rejects.toBeInstanceOf(RpcConnectError);
  });

  it("times out and closes the connection when the portmapper does not answer", async () => {
    server = await startFakeRpcServer();
    server.register(100000, 2, 3, () => undefined);
    await expect(getPort("127.0.0.1", 1, 1, { portmapperPort: server.port, timeoutMs: 80 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.sockets.size).toBe(0);
  });

  it("rejects a reply that is truncated, has trailing data, or an out-of-range port", async () => {
    server = await startFakeRpcServer();
    const replies = [new XdrWriter(), new XdrWriter().u32(1).u32(2), new XdrWriter().u32(70000)];
    server.register(100000, 2, 3, () => replies.shift());
    for (let i = 0; i < 3; i++) {
      await expect(getPort("127.0.0.1", 1, 1, { portmapperPort: server.port, timeoutMs: 2000 })).rejects.toBeInstanceOf(RpcProtocolError);
    }
  });

  it("surfaces PROG_UNAVAIL when the server has no portmapper", async () => {
    server = await startFakeRpcServer();
    await expect(getPort("127.0.0.1", 1, 1, { portmapperPort: server.port, timeoutMs: 2000 })).rejects.toBeInstanceOf(RpcAcceptError);
  });
});

describe("getPort reply validation", () => {
  it("rejects a port above 65535 as a malformed reply", async () => {
    server = await startFakeRpcServer();
    server.registerPortmapper(new Map([[portKey(395190, 1), 70000]]));
    await expect(getPort("127.0.0.1", 395190, 1, { portmapperPort: server.port })).rejects.toThrow(RpcProtocolError);
    await expect(getPort("127.0.0.1", 395190, 1, { portmapperPort: server.port })).rejects.toThrow(/out of range/);
  });
});
