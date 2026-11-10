import { describe, it, expect, afterEach, vi } from "vitest";
import * as net from "node:net";
import { UtsConnection } from "../../src/connection.js";
import { startFakeScpi, idnHandler, IDN, type FakeScpi } from "../fakeScpiServer.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";

/** Transport selection inside UtsConnection.connect: raw, vxi11 and auto (with fallback). */
let conn: UtsConnection | undefined;
let raw: FakeScpi | undefined;
let vxi: FakeVxi11Instrument | undefined;
let tcp: net.Server | undefined;

afterEach(async () => {
  conn?.disconnect();
  await raw?.close();
  await vxi?.close();
  await new Promise<void>((r) => (tcp ? tcp.close(() => r()) : r()));
  conn = undefined;
  raw = vxi = tcp = undefined;
});

const deadPort = async (): Promise<number> => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

describe("UtsConnection transport selection", () => {
  it("defaults to the raw transport", async () => {
    raw = await startFakeScpi(idnHandler());
    conn = new UtsConnection();
    expect(await conn.connect("127.0.0.1", raw.port)).toBe(IDN);
    expect(conn.transportName).toBe("raw");
    expect(conn.transportLabel).toMatch(/raw/i);
    expect(conn.capabilities.dropsInputDuringSweep).toBe(true);
  });

  it("uses VXI-11 when asked, with the portmapper port and device from the options", async () => {
    vxi = await startFakeVxi11Instrument({ device: "inst3" });
    conn = new UtsConnection();
    const idn = await conn.connect("127.0.0.1", 5025, {
      transport: "vxi11",
      vxi11Device: "inst3",
      vxi11PortmapperPort: vxi.port,
    });
    expect(idn).toMatch(/UTS3036B/);
    expect(conn.transportName).toBe("vxi11");
    expect(conn.transportLabel).toMatch(/VXI-11/);
    expect(conn.transportLabel).toContain("inst3");
    expect(conn.capabilities.dropsInputDuringSweep).toBe(false);
    expect(conn.getConnectionInfo()).toMatch(/127\.0\.0\.1.*VXI-11/);
    expect(vxi.createLinkDevices).toEqual(["inst3"]);
    // commands are not paced with *OPC? on VXI-11
    await conn.sendCommand(":FREQuency:CENTer 1e9");
    expect(vxi.received).not.toContain("*OPC?");
  });

  it("vxi11: a failure to open is an error naming VXI-11 (no silent fallback)", async () => {
    const port = await deadPort();
    conn = new UtsConnection();
    await expect(
      conn.connect("127.0.0.1", 5025, { transport: "vxi11", vxi11PortmapperPort: port, connectTimeoutMs: 500 })
    ).rejects.toThrow(/Connection failed.*VXI-11/s);
    expect(conn.isConnected()).toBe(false);
  });

  it("auto: uses VXI-11 when the portmapper registers the core program", async () => {
    vxi = await startFakeVxi11Instrument();
    conn = new UtsConnection();
    await conn.connect("127.0.0.1", 5025, { transport: "auto", vxi11PortmapperPort: vxi.port });
    expect(conn.transportName).toBe("vxi11");
  });

  it("auto: falls back to raw and logs the reason when the portmapper is unreachable", async () => {
    raw = await startFakeScpi(idnHandler());
    const log = vi.fn();
    conn = new UtsConnection();
    const idn = await conn.connect("127.0.0.1", raw.port, {
      transport: "auto",
      vxi11PortmapperPort: await deadPort(),
      connectTimeoutMs: 500,
      log,
    });
    expect(idn).toBe(IDN);
    expect(conn.transportName).toBe("raw");
    expect(conn.transportLabel).toMatch(/auto/i);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/auto.*VXI-11.*raw/is);
  });

  it("auto: falls back to raw when the core program is not registered", async () => {
    raw = await startFakeScpi(idnHandler());
    vxi = await startFakeVxi11Instrument();
    vxi.rpc.registerPortmapper(new Map()); // replaces the lookup table: nothing registered
    const log = vi.fn();
    conn = new UtsConnection();
    await conn.connect("127.0.0.1", raw.port, { transport: "auto", vxi11PortmapperPort: vxi.port, log });
    expect(conn.transportName).toBe("raw");
    expect(String(log.mock.calls[0][0])).toMatch(/not registered/i);
  });

  it("auto: falls back to raw when VXI-11 is registered but create_link fails", async () => {
    raw = await startFakeScpi(idnHandler());
    vxi = await startFakeVxi11Instrument({ device: "other" });
    const log = vi.fn();
    conn = new UtsConnection();
    await conn.connect("127.0.0.1", raw.port, { transport: "auto", vxi11PortmapperPort: vxi.port, log });
    expect(conn.transportName).toBe("raw");
    expect(String(log.mock.calls[0][0])).toMatch(/DEVICE_NOT_ACCESSIBLE/);
  });

  it("auto: when raw also fails the error mentions both attempts", async () => {
    const rawPort = await deadPort();
    conn = new UtsConnection();
    await expect(
      conn.connect("127.0.0.1", rawPort, {
        transport: "auto",
        vxi11PortmapperPort: await deadPort(),
        connectTimeoutMs: 500,
      })
    ).rejects.toThrow(/VXI-11.*raw/is);
  });

  it("rejects an unknown transport or an invalid device name before connecting", async () => {
    conn = new UtsConnection();
    await expect(conn.connect("127.0.0.1", 5025, { transport: "serial" as never })).rejects.toThrow(/transport/i);
    await expect(
      conn.connect("127.0.0.1", 5025, { transport: "vxi11", vxi11Device: "bad name" })
    ).rejects.toThrow(/device/i);
  });

  it("names the transport in a query timeout over VXI-11 but not over raw", async () => {
    vxi = await startFakeVxi11Instrument();
    conn = new UtsConnection();
    await conn.connect("127.0.0.1", 5025, { transport: "vxi11", vxi11PortmapperPort: vxi.port });
    await expect(conn.query(":NOPE?", 60)).rejects.toThrow(/Query timeout after 60ms.*:NOPE\?.*VXI-11/);
    raw = await startFakeScpi(idnHandler());
    await conn.connect("127.0.0.1", raw.port, { recoveryMs: 50 });
    await expect(conn.query(":NOPE?", 60)).rejects.toThrow(/^Query timeout after 60ms for command: :NOPE\?$/);
  });

  it("reports a lost VXI-11 link naming the transport and the command in flight", async () => {
    vxi = await startFakeVxi11Instrument();
    conn = new UtsConnection();
    await conn.connect("127.0.0.1", 5025, { transport: "vxi11", vxi11PortmapperPort: vxi.port });
    const pending = conn.query(":SILENT?", 5000).then(
      () => "reply",
      (e: Error) => e.message
    );
    await new Promise((r) => setTimeout(r, 50));
    vxi.rpc.dropClients();
    expect(await pending).toMatch(/was lost.*VXI-11.*:SILENT\?|was lost.*:SILENT\?.*VXI-11/s);
  });
});
