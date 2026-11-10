import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import {
  DEFAULT_TRANSPORT,
  DEFAULT_VXI11_DEVICE,
  isValidDeviceName,
  parseTransportChoice,
  resolveTransport,
  transportFromEnv,
  vxi11DeviceFromEnv,
  probeVxi11,
} from "../../../src/transports/select.js";
import { startFakeRpcServer, type FakeRpcServer } from "../../fakeRpcServer.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../../fakeVxi11Instrument.js";

describe("transport choice parsing", () => {
  it("accepts raw, vxi11 and auto, case-insensitively and trimmed", () => {
    expect(parseTransportChoice("raw")).toBe("raw");
    expect(parseTransportChoice(" VXI11 ")).toBe("vxi11");
    expect(parseTransportChoice("Auto")).toBe("auto");
  });

  it("rejects anything else with a message naming the allowed values", () => {
    for (const bad of ["", "serial", "vxi-11", "raw;auto", "hislip"]) {
      expect(() => parseTransportChoice(bad, "UTS_TRANSPORT")).toThrow(/UTS_TRANSPORT.*raw, vxi11 or auto/s);
    }
  });

  it("defaults to auto when UTS_TRANSPORT is unset or empty (decision of issue #75)", () => {
    expect(DEFAULT_TRANSPORT).toBe("auto");
    expect(transportFromEnv(undefined)).toBe("auto");
    expect(transportFromEnv("")).toBe("auto");
    expect(transportFromEnv("auto")).toBe("auto");
    expect(() => transportFromEnv("bogus")).toThrow(/Invalid UTS_TRANSPORT "bogus"/);
  });
});

describe("resolveTransport", () => {
  it("an explicit transport always wins, then UTS_TRANSPORT, then auto", () => {
    expect(resolveTransport({ param: "vxi11", env: "raw", portGiven: true })).toBe("vxi11");
    expect(resolveTransport({ env: "vxi11", portGiven: true })).toBe("vxi11");
    expect(resolveTransport({ env: "auto", portGiven: true })).toBe("auto");
    expect(resolveTransport({})).toBe("auto");
    expect(resolveTransport({ env: "" })).toBe("auto");
  });

  it("a port given without any transport choice means raw (the port is a raw transport setting)", () => {
    expect(resolveTransport({ portGiven: true })).toBe("raw");
    expect(resolveTransport({ env: "", portGiven: true })).toBe("raw");
  });

  it("an invalid UTS_TRANSPORT is an error naming the variable", () => {
    expect(() => resolveTransport({ env: "bogus" })).toThrow(/UTS_TRANSPORT/);
  });
});

describe("VXI-11 device name", () => {
  it("defaults to inst0 and validates UTS_VXI11_DEVICE", () => {
    expect(DEFAULT_VXI11_DEVICE).toBe("inst0");
    expect(vxi11DeviceFromEnv(undefined)).toBe("inst0");
    expect(vxi11DeviceFromEnv("")).toBe("inst0");
    expect(vxi11DeviceFromEnv("inst1")).toBe("inst1");
    expect(() => vxi11DeviceFromEnv("bad name")).toThrow(/UTS_VXI11_DEVICE/);
  });

  it("allows letters, digits and . _ , - up to 64 characters", () => {
    for (const ok of ["inst0", "gpib0,5", "my-dev_1.2", "a".repeat(64)]) expect(isValidDeviceName(ok)).toBe(true);
    for (const bad of ["", "a b", "x/y", "a;b", "a\nb", "a\0b", "é", "a".repeat(65), "'x'", "x\"y"]) {
      expect(isValidDeviceName(bad)).toBe(false);
    }
  });
});

describe("probeVxi11 (the check behind UTS_TRANSPORT=auto)", () => {
  let rpc: FakeRpcServer | undefined;
  let inst: FakeVxi11Instrument | undefined;
  let tcp: net.Server | undefined;
  const held: net.Socket[] = [];
  afterEach(async () => {
    await rpc?.close();
    await inst?.close();
    for (const sock of held) sock.destroy();
    held.length = 0;
    await new Promise<void>((r) => (tcp ? tcp.close(() => r()) : r()));
    rpc = inst = tcp = undefined;
  });

  it("reports available when the portmapper registers the VXI-11 core program", async () => {
    inst = await startFakeVxi11Instrument();
    const res = await probeVxi11("127.0.0.1", { portmapperPort: inst.port, timeoutMs: 1000 });
    expect(res.available).toBe(true);
  });

  it("reports unavailable with a reason when the program is not registered", async () => {
    rpc = await startFakeRpcServer();
    rpc.registerPortmapper(new Map());
    const res = await probeVxi11("127.0.0.1", { portmapperPort: rpc.port, timeoutMs: 1000 });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not registered/i);
  });

  it("reports unavailable with a reason when nothing listens on the portmapper port", async () => {
    rpc = await startFakeRpcServer();
    const port = rpc.port;
    await rpc.close();
    rpc = undefined;
    const res = await probeVxi11("127.0.0.1", { portmapperPort: port, timeoutMs: 1000 });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/portmapper/i);
  });

  it("gives up when the portmapper port accepts but never answers (deadline enforced)", async () => {
    tcp = net.createServer((sock) => void held.push(sock));
    await new Promise<void>((r) => tcp!.listen(0, "127.0.0.1", r));
    const port = (tcp.address() as net.AddressInfo).port;
    const t0 = Date.now();
    const res = await probeVxi11("127.0.0.1", { portmapperPort: port, timeoutMs: 200 });
    expect(res.available).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
