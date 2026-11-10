import { describe, it, expect, afterEach } from "vitest";
import { Vxi11Transport, VXI11_CAPABILITIES } from "../../../src/transports/vxi11.js";
import { TransportTimeout } from "../../../src/transports/transport.js";
import { UtsConnection } from "../../../src/connection.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../../fakeVxi11Instrument.js";
import { runTransportContract, type FakeHandler } from "../../transportContract.js";

/** The fake answers through a scriptable handler; adapt the wire-independent contract handler to it. */
let contractPort = 0;

runTransportContract({
  name: "VXI-11",
  createTransport: () => new Vxi11Transport({ portmapperPort: contractPort }),
  expectedCapabilities: {
    syncsCommands: false,
    dropsInputDuringSweep: false,
    holdOffAfterTimeout: false,
  },
  async startFake(handler: FakeHandler) {
    const fake = await startFakeVxi11Instrument({
      scpi: async (line) => {
        const replies: Array<string | Buffer> = [];
        await handler(line, {
          reply: (text) => void replies.push(text),
          replyBlock: (data) =>
            void replies.push(
              Buffer.concat([Buffer.from(`#${String(data.length).length}${data.length}`), data])
            ),
        });
        return replies[0];
      },
    });
    contractPort = fake.port;
    return {
      host: "127.0.0.1",
      port: fake.port,
      received: fake.received,
      dropLink: () => fake.rpc.dropClients(),
      close: () => fake.close(),
    };
  },
});

describe("VXI-11 transport specifics", () => {
  let fake: FakeVxi11Instrument | undefined;
  let transport: Vxi11Transport | undefined;
  afterEach(async () => {
    transport?.close();
    await fake?.close();
    fake = transport = undefined;
  });

  const open = async (options: ConstructorParameters<typeof Vxi11Transport>[0] = {}, fakeOptions = {}) => {
    fake = await startFakeVxi11Instrument(fakeOptions);
    transport = new Vxi11Transport({ portmapperPort: fake.port, ...options });
    await transport.open({ host: "127.0.0.1", port: 5025, connectTimeoutMs: 2000 });
    return transport;
  };

  it("exports the capability flags as explicit constants and names itself", () => {
    expect(VXI11_CAPABILITIES).toEqual({
      syncsCommands: false,
      dropsInputDuringSweep: false,
      holdOffAfterTimeout: false,
    });
    const t = new Vxi11Transport();
    expect(t.capabilities).toBe(VXI11_CAPABILITIES);
    expect(t.name).toBe("vxi11");
    expect(new UtsConnection(() => new Vxi11Transport()).capabilities).toEqual(VXI11_CAPABILITIES);
  });

  it("uses the device name given (default inst0) and ignores the raw TCP port in the open options", async () => {
    await open();
    expect(fake!.createLinkDevices).toEqual(["inst0"]);
    transport!.close();
    await open({ device: "inst7" }).catch(() => {});
    expect(fake!.createLinkDevices).toEqual(["inst7"]);
  });

  it("rejects an invalid device name before touching the network", () => {
    for (const bad of ["", "a b", "inst0;rm", "x".repeat(65), "inst0\n", "é"]) {
      expect(() => new Vxi11Transport({ device: bad })).toThrow(/device/i);
    }
    expect(() => new Vxi11Transport({ device: "gpib0,5" })).not.toThrow();
  });

  it("sends each line as one device_write with END and no terminator", async () => {
    const t = await open();
    await t.write(":FREQuency:CENTer 1e9");
    expect(fake!.writes.at(-1)!.data.toString()).toBe(":FREQuency:CENTer 1e9");
    expect(fake!.writes.at(-1)!.flags & 8).toBe(8);
  });

  it("open failure names VXI-11 and starts with 'Connection failed'", async () => {
    fake = await startFakeVxi11Instrument({ device: "other" });
    const t = new Vxi11Transport({ portmapperPort: fake.port });
    await expect(t.open({ host: "127.0.0.1", port: 5025, connectTimeoutMs: 1000 })).rejects.toThrow(
      /^Connection failed:.*VXI-11.*DEVICE_NOT_ACCESSIBLE/s
    );
  });

  it("maps an instrument I/O timeout (error 15) to TransportTimeout and stays usable", async () => {
    const t = await open({}, { scpi: (c: string) => (c === "A?" ? "ok" : undefined) });
    await t.write("NOPE?");
    await expect(t.readLine(80)).rejects.toBeInstanceOf(TransportTimeout);
    expect(t.isOpen()).toBe(true);
    t.discardInput();
    await t.write("A?");
    expect(await t.readLine(2000)).toBe("ok");
  });

  it("drains an abandoned reply of a timed-out query before the next write", async () => {
    const t = await open({}, { scpi: (c: string) => (c === "A?" ? "late" : c === "B?" ? "fresh" : undefined) });
    await t.write("A?");
    await new Promise((r) => setTimeout(r, 30));
    t.discardInput();
    await t.write("B?");
    expect(await t.readLine(2000)).toBe("fresh");
  });

  it("does not issue extra device_read calls when nothing is outstanding", async () => {
    const t = await open({}, { scpi: (c: string) => (c === "A?" ? "x" : undefined) });
    await t.write("A?");
    await t.readLine(2000);
    const reads = fake!.readRequests.length;
    t.discardInput();
    await t.write("*CLS");
    expect(fake!.readRequests.length).toBe(reads);
  });

  it("a blocking read waits for the sweep to end", async () => {
    const t = await open({}, { sweepMs: 300 });
    const t0 = Date.now();
    await t.write(":INITiate:IMMediate");
    await t.write("*OPC?");
    expect(await t.readLine(5000)).toBe("1");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("rejects a reply to readBlock that is cut short", async () => {
    const t = await open({}, { scpi: (c: string) => (c === "B?" ? "#210ab" : undefined) });
    await t.write("B?");
    await expect(t.readBlock(2000)).rejects.toThrow(/block/i);
  });

  it("a protocol or device error other than a timeout is a plain error naming VXI-11", async () => {
    const t = await open();
    fake!.injectError(11, 17, 1);
    await expect(t.write("*CLS")).rejects.toThrow(/VXI-11.*IO_ERROR/);
    expect(t.isOpen()).toBe(true);
  });

  it("calls after close fail with 'Connection closed'", async () => {
    const t = await open();
    t.close();
    await expect(t.write("*CLS")).rejects.toThrow(/Connection closed/);
    await expect(t.readLine(100)).rejects.toThrow(/Connection closed/);
  });
});
