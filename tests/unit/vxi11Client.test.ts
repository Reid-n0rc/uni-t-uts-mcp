import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  Vxi11Client,
  Vxi11ClosedError,
  Vxi11ConnectError,
  Vxi11DeviceError,
  Vxi11IoTimeoutError,
  Vxi11LockedError,
  Vxi11ProtocolError,
  Vxi11TransportError,
  VXI11_ERROR_NAMES,
} from "../../src/vxi11/client.js";
import { XdrWriter } from "../../src/vxi11/xdr.js";
import { startFakeRpcServer } from "../fakeRpcServer.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument, type FakeVxi11Options } from "../fakeVxi11Instrument.js";

const CORE = 395183;
let fake: FakeVxi11Instrument | undefined;
let client: Vxi11Client | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await fake?.close();
  fake = undefined;
});

async function setup(options: FakeVxi11Options = {}, connect: { port?: number } = {}): Promise<{ fake: FakeVxi11Instrument; client: Vxi11Client }> {
  fake = await startFakeVxi11Instrument(options);
  client = await Vxi11Client.connect("127.0.0.1", { portmapperPort: fake.port, rpcMarginMs: 100, ...connect });
  return { fake, client };
}
const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
const text = (b: Buffer): string => b.toString("latin1");

describe("connect", () => {
  it("finds the core port through the portmapper and creates the link", async () => {
    const { fake, client } = await setup({ maxRecvSize: 4096 });
    expect(client.maxRecvSize).toBe(4096);
    expect(typeof client.linkId).toBe("number");
    expect(fake.links.size).toBe(1);
    const programs = fake.rpc.calls.map((c) => c.program);
    expect(programs).toContain(100000);
    expect(fake.createLinkDevices).toEqual(["inst0"]);
  });

  it("uses an explicit port without asking the portmapper", async () => {
    fake = await startFakeVxi11Instrument({ device: "inst1" });
    client = await Vxi11Client.connect("127.0.0.1", { port: fake.port, device: "inst1", portmapperPort: 1 });
    expect(fake.rpc.calls.filter((c) => c.program === 100000)).toHaveLength(0);
    expect(fake.createLinkDevices).toEqual(["inst1"]);
  });

  it("rejects with Vxi11ConnectError when the core program is not registered", async () => {
    const bare = await startFakeRpcServer();
    bare.registerPortmapper();
    try {
      await expect(Vxi11Client.connect("127.0.0.1", { portmapperPort: bare.port })).rejects.toBeInstanceOf(Vxi11ConnectError);
    } finally {
      await bare.close();
    }
  });

  it("rejects with Vxi11ConnectError when nothing listens", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(Vxi11Client.connect("127.0.0.1", { port })).rejects.toBeInstanceOf(Vxi11ConnectError);
    await expect(Vxi11Client.connect("127.0.0.1", { portmapperPort: port })).rejects.toBeInstanceOf(Vxi11ConnectError);
  });

  it("maps a create_link error to a typed device error and closes the socket", async () => {
    fake = await startFakeVxi11Instrument({ device: "inst0" });
    const err = await Vxi11Client.connect("127.0.0.1", { port: fake.port, device: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11DeviceError);
    expect(err.code).toBe(3);
    expect(err.codeName).toBe("DEVICE_NOT_ACCESSIBLE");
    await settle();
    expect(fake.rpc.sockets.size).toBe(0);
  });

  it("rejects a create_link reply with maxRecvSize 0 or a bad abort port", async () => {
    for (const reply of [new XdrWriter().u32(0).u32(1).u32(111).u32(0), new XdrWriter().u32(0).u32(1).u32(70000).u32(1024)]) {
      fake = await startFakeVxi11Instrument();
      fake.rpc.register(CORE, 1, 10, () => reply);
      await expect(Vxi11Client.connect("127.0.0.1", { port: fake.port })).rejects.toBeInstanceOf(Vxi11ProtocolError);
      await settle();
      expect(fake.rpc.sockets.size).toBe(0);
      await fake.close();
    }
  });

  it("rejects invalid options", async () => {
    await expect(Vxi11Client.connect("127.0.0.1", { port: 0 })).rejects.toThrow(/port/);
    await expect(Vxi11Client.connect("127.0.0.1", { port: 70000 })).rejects.toThrow(/port/);
    await expect(Vxi11Client.connect("127.0.0.1", { device: "" })).rejects.toThrow(/device/);
  });
});

describe("write and read", () => {
  it("round-trips a query and sends the END flag by default", async () => {
    const { fake, client } = await setup();
    expect(await client.write("*IDN?")).toBe(5);
    const r = await client.read({ timeoutMs: 1000 });
    expect(r.end).toBe(true);
    expect(text(r.data)).toBe("UNI-T,UTS3036B,FAKE,1.0\n");
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].flags & 8).toBe(8);
    expect(fake.received).toEqual(["*IDN?"]);
  });

  it("accepts a Buffer and an empty write", async () => {
    const { fake, client } = await setup();
    expect(await client.write(Buffer.from("*OPC?\n"))).toBe(6);
    expect(text((await client.read()).data)).toBe("1\n");
    expect(await client.write("")).toBe(0);
    expect(fake.writes).toHaveLength(2);
  });

  it("does not set END when end is false; the instrument executes only after the END write", async () => {
    const { fake, client } = await setup();
    await client.write("*ID", { end: false });
    expect(fake.writes[0].flags & 8).toBe(0);
    expect(fake.received).toEqual([]);
    await client.write("N?");
    expect(fake.received).toEqual(["*IDN?"]);
  });

  it("splits writes larger than maxRecvSize and sets END only on the last chunk", async () => {
    const { fake, client } = await setup({ maxRecvSize: 16 });
    const cmd = ":SENSe:FREQuency:CENTer 1000000000 Hz " + "X".repeat(5);
    expect(await client.write(cmd)).toBe(cmd.length);
    expect(fake.writes.length).toBe(Math.ceil(cmd.length / 16));
    for (const w of fake.writes) expect(w.data.length).toBeLessThanOrEqual(16);
    expect(fake.writes.map((w) => w.flags & 8)).toEqual(fake.writes.map((_, i) => (i === fake.writes.length - 1 ? 8 : 0)));
    expect(fake.received.join("")).toBe(cmd);
  });

  it("continues when the instrument accepts fewer bytes than sent", async () => {
    const { fake, client } = await setup({ maxRecvSize: 1024, writeAcceptLimit: 3 });
    expect(await client.write("*IDN?")).toBe(5);
    expect(fake.received).toEqual(["*IDN?"]);
  });

  it("fails when the instrument reports a write size larger than sent or zero", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 11, () => new XdrWriter().u32(0).u32(999));
    await expect(client.write("*IDN?")).rejects.toBeInstanceOf(Vxi11ProtocolError);
    fake.rpc.register(CORE, 1, 11, () => new XdrWriter().u32(0).u32(0));
    await expect(client.write("*IDN?")).rejects.toBeInstanceOf(Vxi11ProtocolError);
  });

  it("joins chunked reads until END", async () => {
    const { fake, client } = await setup({ maxReadChunk: 4 });
    fake.setScpiHandler(() => "0123456789");
    await client.write("X?");
    const r = await client.read({ timeoutMs: 1000 });
    expect(text(r.data)).toBe("0123456789\n");
    expect(r.end).toBe(true);
    expect(fake.readRequests.length).toBeGreaterThanOrEqual(3);
  });

  it("stops at maxBytes without END and leaves the rest for the next read", async () => {
    const { fake, client } = await setup();
    fake.setScpiHandler(() => "0123456789");
    await client.write("X?");
    const first = await client.read({ maxBytes: 5 });
    expect(text(first.data)).toBe("01234");
    expect(first.end).toBe(false);
    const rest = await client.read();
    expect(text(rest.data)).toBe("56789\n");
    expect(rest.end).toBe(true);
  });

  it("reads a large binary reply intact", async () => {
    const { fake, client } = await setup({ maxReadChunk: 65536 });
    const payload = Buffer.alloc(300_000, 0xab);
    fake.setScpiHandler(() => payload);
    await client.write("DATA?");
    const r = await client.read({ timeoutMs: 5000, maxBytes: 1_000_000 });
    expect(r.data.length).toBe(300_001);
    expect(r.data.subarray(0, 300_000).equals(payload)).toBe(true);
    expect(r.end).toBe(true);
  });

  it("maps no answer within the I/O timeout to Vxi11IoTimeoutError (code 15) and stays usable", async () => {
    const { fake, client } = await setup();
    fake.setScpiHandler((c) => (c === "BAD?" ? undefined : "ok"));
    await client.write("BAD?");
    const err = (await client.read({ timeoutMs: 80 }).catch((e) => e)) as Vxi11IoTimeoutError;
    expect(err).toBeInstanceOf(Vxi11IoTimeoutError);
    expect(err.code).toBe(15);
    expect(err.codeName).toBe("IO_TIMEOUT");
    await client.write("GOOD?");
    expect(text((await client.read()).data)).toBe("ok\n");
  });

  it("rejects invalid arguments", async () => {
    const { client } = await setup();
    await expect(client.write("x", { timeoutMs: -1 })).rejects.toThrow(/timeout/i);
    await expect(client.read({ maxBytes: 0 })).rejects.toThrow(/maxBytes/);
    await expect(client.read({ timeoutMs: Number.NaN })).rejects.toThrow(/timeout/i);
  });
});

describe("readStb and clear", () => {
  it("returns the status byte", async () => {
    const { fake, client } = await setup();
    fake.stb = 0x50;
    expect(await client.readStb()).toBe(0x50);
    fake.stb = 0;
    expect(await client.readStb()).toBe(0);
  });

  it("rejects a status byte above 255", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 13, () => new XdrWriter().u32(0).u32(300));
    await expect(client.readStb()).rejects.toBeInstanceOf(Vxi11ProtocolError);
  });

  it("clear sends device_clear and discards pending output", async () => {
    const { fake, client } = await setup();
    await client.write("*IDN?");
    await client.clear();
    expect(fake.clears).toBe(1);
    await expect(client.read({ timeoutMs: 50 })).rejects.toBeInstanceOf(Vxi11IoTimeoutError);
  });
});

describe("error mapping", () => {
  it("names every VXI-11 error code", () => {
    expect(VXI11_ERROR_NAMES).toEqual({
      1: "SYNTAX_ERROR",
      3: "DEVICE_NOT_ACCESSIBLE",
      4: "INVALID_LINK_IDENTIFIER",
      5: "PARAMETER_ERROR",
      6: "CHANNEL_NOT_ESTABLISHED",
      8: "OPERATION_NOT_SUPPORTED",
      9: "OUT_OF_RESOURCES",
      11: "DEVICE_LOCKED_BY_ANOTHER_LINK",
      12: "NO_LOCK_HELD_BY_THIS_LINK",
      15: "IO_TIMEOUT",
      17: "IO_ERROR",
      21: "INVALID_ADDRESS",
      23: "ABORT",
    });
  });

  it.each(Object.entries(VXI11_ERROR_NAMES))("maps injected error %s (%s) on write, read, readStb and clear", async (codeText, name) => {
    const code = Number(codeText);
    const { fake, client } = await setup();
    const calls: [number, () => Promise<unknown>][] = [
      [11, () => client.write("x")],
      [12, () => client.read({ timeoutMs: 50 })],
      [13, () => client.readStb()],
      [15, () => client.clear()],
    ];
    for (const [proc, run] of calls) {
      fake.injectError(proc, code);
      const err = (await run().catch((e) => e)) as Vxi11DeviceError;
      expect(err).toBeInstanceOf(Vxi11DeviceError);
      expect(err.code).toBe(code);
      expect(err.codeName).toBe(name);
      expect(err.message).toContain(name);
    }
  });

  it("names an unknown code", async () => {
    const { fake, client } = await setup();
    fake.injectError(13, 99);
    const err = await client.readStb().catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11DeviceError);
    expect(err.codeName).toBe("UNKNOWN_ERROR_99");
  });

  it("reports a locked device as Vxi11LockedError and an invalid link as code 4", async () => {
    const { fake, client } = await setup();
    fake.injectError(11, 11);
    expect(await client.write("x").catch((e) => e)).toBeInstanceOf(Vxi11LockedError);
    fake.links.clear(); // the instrument forgot the link
    const err = (await client.write("x").catch((e) => e)) as Vxi11DeviceError;
    expect(err).toBeInstanceOf(Vxi11DeviceError);
    expect(err.code).toBe(4);
  });
});

describe("close", () => {
  it("destroys the link, closes the socket, and is idempotent", async () => {
    const { fake, client } = await setup();
    await client.close();
    await client.close();
    expect(fake.destroyedLinks).toBe(1);
    expect(fake.links.size).toBe(0);
    await settle();
    expect(fake.rpc.sockets.size).toBe(0);
    await expect(client.write("x")).rejects.toBeInstanceOf(Vxi11ClosedError);
    await expect(client.read()).rejects.toBeInstanceOf(Vxi11ClosedError);
    await expect(client.readStb()).rejects.toBeInstanceOf(Vxi11ClosedError);
    await expect(client.clear()).rejects.toBeInstanceOf(Vxi11ClosedError);
  });

  it("still closes when destroy_link fails or gets no answer", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 23, () => undefined); // never answers
    const t0 = Date.now();
    await client.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    await settle();
    expect(fake.rpc.sockets.size).toBe(0);
  });

  it("returns promptly when the server is already gone", async () => {
    const { fake, client } = await setup();
    fake.rpc.dropClients();
    await settle();
    await client.close();
    expect(client.closed).toBe(true);
  });

  it("rejects a pending blocking read with Vxi11ClosedError when closed", async () => {
    const { fake, client } = await setup();
    fake.setScpiHandler(() => undefined);
    await client.write("Q?");
    const pending = client.read({ timeoutMs: 10_000 }).catch((e) => e);
    await settle();
    await client.close();
    expect(await pending).toBeInstanceOf(Vxi11ClosedError);
  });
});

describe("robustness against a misbehaving server", () => {
  it("fails a call in flight with Vxi11TransportError when the server drops the connection", async () => {
    const { fake, client } = await setup();
    fake.dropConnectionOnNext(12);
    await client.write("*IDN?");
    const err = await client.read({ timeoutMs: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11TransportError);
    expect(client.closed).toBe(true);
    await expect(client.write("x")).rejects.toBeInstanceOf(Vxi11ClosedError);
    await client.close();
  });

  it("does not leave a call pending when the RPC reply never comes", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 13, () => undefined);
    const t0 = Date.now();
    const err = await client.readStb({ timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11TransportError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("rejects malformed read replies", async () => {
    const { fake, client } = await setup();
    const cases: [string, () => XdrWriter | Buffer][] = [
      ["truncated", () => Buffer.from([0, 0, 0, 0, 0, 0])],
      ["unknown reason bits", () => new XdrWriter().u32(0).u32(8).opaque(Buffer.from("x"))],
      ["more data than requested", () => new XdrWriter().u32(0).u32(4).opaque(Buffer.alloc(100000))],
      ["empty without END", () => new XdrWriter().u32(0).u32(0).opaque(Buffer.alloc(0))],
      ["trailing bytes", () => new XdrWriter().u32(0).u32(4).opaque(Buffer.from("x")).u32(1)],
    ];
    for (const [label, make] of cases) {
      fake.rpc.register(CORE, 1, 12, () => make());
      const err = await client.read({ timeoutMs: 200, maxBytes: 1000 }).catch((e) => e);
      expect(err, label).toBeInstanceOf(Vxi11ProtocolError);
      expect(client.closed, label).toBe(false);
    }
  });

  it("stops at maxBytes when the instrument never signals END", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 12, () => new XdrWriter().u32(0).u32(1).opaque(Buffer.alloc(50)));
    const r = await client.read({ maxBytes: 100 });
    expect(r.data.length).toBe(100);
    expect(r.end).toBe(false);
  });

  it("maps RPC-level failures (program unavailable) to Vxi11TransportError", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 13, () => ({ acceptStat: 3 }));
    expect(await client.readStb().catch((e) => e)).toBeInstanceOf(Vxi11TransportError);
  });
});

describe("overall deadlines and iteration caps", () => {
  const oneByte = (): XdrWriter => new XdrWriter().u32(0).u32(1).opaque(Buffer.from("x")); // reason REQCNT, never END
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("a read that gets 1 byte per call without END times out within the requested timeout", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 12, oneByte);
    const t0 = Date.now();
    const err = await client.read({ timeoutMs: 200, maxBytes: 10_000_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11IoTimeoutError);
    expect(Date.now() - t0).toBeLessThan(200 + 100 + 150);
  });

  it("never sends a zero I/O timeout after the first read call", async () => {
    const { fake, client } = await setup();
    const timeouts: number[] = [];
    fake.rpc.register(CORE, 1, 12, (args) => {
      args.u32();
      args.u32();
      timeouts.push(args.u32());
      return oneByte();
    });
    await client.read({ timeoutMs: 100, maxBytes: 10_000_000 }).catch(() => undefined);
    expect(timeouts.length).toBeGreaterThan(1);
    expect(timeouts.slice(1).every((t) => t >= 1 && t <= 100)).toBe(true);
  });

  it("a read whose replies are slow passes the deadline mid-loop and times out in time", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 12, async () => {
      await delay(120);
      return oneByte();
    });
    const t0 = Date.now();
    const err = await client.read({ timeoutMs: 200, maxBytes: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11IoTimeoutError);
    expect(Date.now() - t0).toBeLessThan(200 + 100 + 150);
  });

  it("caps the number of device_read calls with a protocol error when the timeout is long", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 12, oneByte);
    const err = await client.read({ timeoutMs: 60_000, maxBytes: 10_000_000, maxCalls: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11ProtocolError);
    expect(fake.rpc.calls.filter((c) => c.procedure === 12)).toHaveLength(50);
  });

  it("a chunked write with 1-byte acceptance and slow replies times out in time", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 11, async () => {
      await delay(120);
      return new XdrWriter().u32(0).u32(1);
    });
    const t0 = Date.now();
    const err = await client.write("0123456789", { timeoutMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11IoTimeoutError);
    expect(Date.now() - t0).toBeLessThan(200 + 100 + 150);
  });

  it("caps the number of device_write calls with a protocol error", async () => {
    const { fake, client } = await setup();
    fake.rpc.register(CORE, 1, 11, () => new XdrWriter().u32(0).u32(1));
    const err = await client.write("x".repeat(500), { timeoutMs: 60_000, maxCalls: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(Vxi11ProtocolError);
    expect(fake.rpc.calls.filter((c) => c.procedure === 11)).toHaveLength(20);
  });
});

describe("simulated sweep (queued commands, blocking *OPC?)", () => {
  it("answers a blocking *OPC? only when the sweep ends and does not drop queued commands", async () => {
    const { fake, client } = await setup({ sweepMs: 300 });
    const seen: string[] = [];
    fake.setScpiHandler((c) => {
      seen.push(c);
      if (c === ":SENSe:SWEep:TIME?") return "0.3";
      return undefined;
    });
    const t0 = Date.now();
    await client.write(":INITiate:IMMediate");
    await client.write(":SENSe:SWEep:TIME?");
    await client.write("*OPC?");
    expect(Date.now() - t0).toBeLessThan(150); // writes are accepted at once
    expect(fake.sweeping).toBe(true);
    expect(fake.received).toEqual([":INITiate:IMMediate"]); // queued, not executed yet
    const early = await client.read({ timeoutMs: 60 }).catch((e) => e);
    expect(early).toBeInstanceOf(Vxi11IoTimeoutError);
    const opc = await client.read({ timeoutMs: 3000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1500);
    expect(fake.sweeping).toBe(false);
    expect(fake.sweepsCompleted).toBe(1);
    expect(text(opc.data)).toBe("0.3\n"); // answers come in order after the sweep
    expect(text((await client.read({ timeoutMs: 500 })).data)).toBe("1\n");
    expect(fake.received).toEqual([":INITiate:IMMediate", ":SENSe:SWEep:TIME?", "*OPC?"]);
  });

  it("handles the compound :INITiate:IMMediate;*OPC? line", async () => {
    const { fake, client } = await setup({ sweepMs: 200 });
    const t0 = Date.now();
    await client.write(":INITiate:IMMediate;*OPC?");
    expect(text((await client.read({ timeoutMs: 3000 })).data)).toBe("1\n");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });

  it("answers *OPC? immediately when no sweep runs", async () => {
    const { client } = await setup({ sweepMs: 300 });
    const t0 = Date.now();
    await client.write("*OPC?");
    expect(text((await client.read({ timeoutMs: 1000 })).data)).toBe("1\n");
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it("serial poll answers during a sweep with status byte 0", async () => {
    const { client } = await setup({ sweepMs: 200 });
    await client.write(":INITiate:IMMediate");
    expect(await client.readStb()).toBe(0);
  });
});
