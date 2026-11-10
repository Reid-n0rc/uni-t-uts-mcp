import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  broadcastTargets,
  discoverInstruments,
  isUniTAnalyzer,
  parseIdn,
  type DiscoverOptions,
} from "../../src/discovery.js";
import { startFakeScpi, idnHandler, type FakeScpi } from "../fakeScpiServer.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";
import { getPortReply, startFakeUdpPortmapper, type FakeUdpPortmapper } from "../fakeUdpPortmapper.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function pmap(respond: Parameters<typeof startFakeUdpPortmapper>[0]): Promise<FakeUdpPortmapper> {
  const p = await startFakeUdpPortmapper(respond);
  cleanups.push(() => p.close());
  return p;
}
async function vxi11(serial = "FAKE12345"): Promise<FakeVxi11Instrument> {
  const i = await startFakeVxi11Instrument({ scpi: (c) => (c === "*IDN?" ? `UNI-T,UTS3036B,${serial},V1.04.0040` : undefined) });
  cleanups.push(() => i.close());
  return i;
}
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
/** Options that aim discovery at one fake portmapper on loopback and keep the test fast. */
function opts(p: FakeUdpPortmapper, extra: DiscoverOptions = {}): DiscoverOptions {
  return { targets: [{ address: "127.0.0.1", port: p.port }], windowMs: 300, probeTimeoutMs: 1000, rawPort: 1, ...extra };
}

describe("discoverInstruments", () => {
  it("finds nothing when nobody answers, within the window, without throwing", async () => {
    const p = await pmap(() => undefined);
    const t = Date.now();
    const res = await discoverInstruments(opts(p));
    expect(res.instruments).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("asks the portmapper for the VXI-11 core program (395183 v1, TCP) with a standard GETPORT call", async () => {
    const p = await pmap(() => undefined);
    await discoverInstruments(opts(p));
    expect(p.requests.length).toBeGreaterThan(0);
    expect(p.requests[0]).toMatchObject({
      program: 100000,
      version: 2,
      procedure: 3,
      mapping: { program: 395183, version: 1, protocol: 6, port: 0 },
    });
  });

  it("identifies a responder over VXI-11 with *IDN? only and redacts the serial number", async () => {
    const inst = await vxi11("SN-SECRET-0001");
    const p = await pmap((r) => [getPortReply(r.xid, inst.port)]);
    const res = await discoverInstruments(opts(p));
    expect(res.instruments).toHaveLength(1);
    const found = res.instruments[0];
    expect(found).toMatchObject({ host: "127.0.0.1", vxi11: true, vxi11Port: inst.port, analyzer: true });
    expect(found.idn).toEqual({ manufacturer: "UNI-T", model: "UTS3036B", firmware: "V1.04.0040" });
    expect(JSON.stringify(res)).not.toContain("SN-SECRET-0001");
    expect(inst.received).toEqual(["*IDN?"]); // identify only: no setter, no other query
  });

  it("reports whether raw port 5025 answers and falls back to it for the identification", async () => {
    const raw: FakeScpi = await startFakeScpi(idnHandler());
    cleanups.push(() => raw.close());
    const dead = await closedPort(); // portmapper names a VXI-11 port nothing listens on
    const p = await pmap((r) => [getPortReply(r.xid, dead)]);
    const res = await discoverInstruments(opts(p, { rawPort: raw.port }));
    expect(res.instruments).toHaveLength(1);
    expect(res.instruments[0]).toMatchObject({ raw: true, analyzer: true });
    expect(res.instruments[0].idn?.model).toBe("UTS0000X");
    expect(raw.received).toEqual(["*IDN?"]);
  });

  it("lists a responder that cannot be identified, with a note, and does not count it as an analyzer", async () => {
    const dead = await closedPort();
    const p = await pmap((r) => [getPortReply(r.xid, dead)]);
    const res = await discoverInstruments(opts(p, { rawPort: await closedPort() }));
    expect(res.instruments).toHaveLength(1);
    expect(res.instruments[0]).toMatchObject({ raw: false, analyzer: false });
    expect(res.instruments[0].idn).toBeUndefined();
    expect(res.instruments[0].note).toMatch(/identif/i);
  });

  it("does not count a VXI-11 device from another maker as an analyzer", async () => {
    const i = await startFakeVxi11Instrument({ scpi: (c) => (c === "*IDN?" ? "ACME,SCOPE-1,0001,1.0" : undefined) });
    cleanups.push(() => i.close());
    const p = await pmap((r) => [getPortReply(r.xid, i.port)]);
    const res = await discoverInstruments(opts(p));
    expect(res.instruments[0]).toMatchObject({ analyzer: false });
    expect(res.instruments[0].idn?.manufacturer).toBe("ACME");
  });

  it("ignores programs the portmapper does not know (port 0)", async () => {
    const p = await pmap((r) => [getPortReply(r.xid, 0)]);
    expect((await discoverInstruments(opts(p))).instruments).toEqual([]);
  });

  it("merges duplicate replies from one host into one entry", async () => {
    const inst = await vxi11();
    const p = await pmap((r) => [getPortReply(r.xid, inst.port), getPortReply(r.xid, inst.port), getPortReply(r.xid, inst.port)]);
    expect((await discoverInstruments(opts(p))).instruments).toHaveLength(1);
  });

  it("ignores malformed, truncated, foreign-xid, denied and oversized replies", async () => {
    const p = await pmap((r) => [
      Buffer.from("garbage"),
      Buffer.alloc(0),
      getPortReply(r.xid, 5025).subarray(0, 10),
      getPortReply(r.xid + 1, 5025), // not our call
      Buffer.concat([getPortReply(r.xid, 5025), Buffer.from([0, 0, 0, 0])]), // trailing bytes
      Buffer.alloc(9000, 1),
      Buffer.from([...getPortReply(r.xid, 5025)].map((b, i) => (i === 7 ? 0 : b))), // message type CALL, not REPLY
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]), // MSG_DENIED
      getPortReply(r.xid, 70000), // port out of range
    ]);
    const res = await discoverInstruments(opts(p));
    expect(res.instruments).toEqual([]);
  });

  it("skips the identification of hosts in skipIdentify (for the instrument already connected)", async () => {
    const inst = await vxi11();
    const p = await pmap((r) => [getPortReply(r.xid, inst.port)]);
    const res = await discoverInstruments(opts(p, { skipIdentify: new Set(["127.0.0.1"]) }));
    expect(inst.received).toEqual([]);
    expect(res.instruments[0].idn).toBeUndefined();
    expect(res.instruments[0].note).toMatch(/connected/i);
  });

  it("never throws: an address it cannot use becomes a note", async () => {
    const res = await discoverInstruments({ targets: [{ address: "not-an-address" }, { address: "127.0.0.1", bindAddress: "203.0.113.77" }], windowMs: 100 });
    expect(res.instruments).toEqual([]);
    expect(res.notes.length).toBeGreaterThan(0);
  });

  it("bounds the window: nonsense values fall back to limits", async () => {
    const p = await pmap(() => undefined);
    const t = Date.now();
    await discoverInstruments(opts(p, { windowMs: Number.NaN }));
    expect(Date.now() - t).toBeLessThan(5000);
    const t2 = Date.now();
    await discoverInstruments(opts(p, { windowMs: -5 }));
    expect(Date.now() - t2).toBeLessThan(5000);
  });
});

describe("broadcastTargets", () => {
  const nic = (address: string, netmask: string, internal = false, family: string | number = "IPv4") => ({ address, netmask, internal, family, mac: "", cidr: null });
  it("gives the directed broadcast address of each external IPv4 interface, bound to its address", () => {
    const t = broadcastTargets({
      en0: [nic("192.168.1.20", "255.255.255.0"), nic("fe80::1", "ffff:ffff:ffff:ffff::", false, "IPv6")],
      eth1: [nic("10.4.7.9", "255.255.0.0")],
      lo0: [nic("127.0.0.1", "255.0.0.0", true)],
    } as never);
    expect(t).toEqual([
      { address: "192.168.1.255", bindAddress: "192.168.1.20" },
      { address: "10.4.255.255", bindAddress: "10.4.7.9" },
    ]);
  });
  it("accepts the numeric family some Node versions report and skips /32, /31 and link-local interfaces", () => {
    const t = broadcastTargets({
      a: [nic("192.168.5.5", "255.255.255.0", false, 4)],
      b: [nic("10.0.0.1", "255.255.255.255")],
      c: [nic("10.0.0.2", "255.255.255.254")],
      d: [nic("169.254.3.4", "255.255.0.0")],
    } as never);
    expect(t).toEqual([{ address: "192.168.5.255", bindAddress: "192.168.5.5" }]);
  });
  it("deduplicates and tolerates missing or malformed entries", () => {
    const t = broadcastTargets({
      a: [nic("192.168.1.20", "255.255.255.0")],
      b: [nic("192.168.1.20", "255.255.255.0")],
      c: undefined,
      d: [nic("bogus", "255.255.255.0"), nic("192.168.9.9", "nonsense")],
    } as never);
    expect(t).toEqual([{ address: "192.168.1.255", bindAddress: "192.168.1.20" }]);
  });
});

describe("parseIdn and isUniTAnalyzer", () => {
  it("splits manufacturer, model, firmware and drops the serial number", () => {
    expect(parseIdn("UNI-T,UTS3036B,SN123,V1.04.0040\r\n")).toEqual({ manufacturer: "UNI-T", model: "UTS3036B", firmware: "V1.04.0040" });
  });
  it("rejects short, empty, oversized and non-printable replies", () => {
    expect(parseIdn("")).toBeUndefined();
    expect(parseIdn("a,b,c")).toBeUndefined();
    expect(parseIdn("a,b,c,d\u0000")).toBeUndefined();
    expect(parseIdn(`a,b,c,${"d".repeat(500)}`)).toBeUndefined();
  });
  it("recognises UNI-T analyzers by manufacturer or UTS model", () => {
    expect(isUniTAnalyzer({ manufacturer: "UNI-T", model: "UTS3036B", firmware: "1" })).toBe(true);
    expect(isUniTAnalyzer({ manufacturer: "UNI-TREND", model: "UTS0000X", firmware: "1" })).toBe(true);
    expect(isUniTAnalyzer({ manufacturer: "OTHER", model: "UTS1000B", firmware: "1" })).toBe(true);
    expect(isUniTAnalyzer({ manufacturer: "ACME", model: "SCOPE", firmware: "1" })).toBe(false);
  });
});
