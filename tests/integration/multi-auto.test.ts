import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerConnectionTools } from "../../src/tools/connection.js";
import { instruments } from "../../src/registry.js";
import { startFakeScpi, type FakeScpi } from "../fakeScpiServer.js";
import type { DiscoveredInstrument } from "../../src/discovery.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** `connect host=auto` and `discover_instruments` with several instruments (issue #166): real connections, mocked discovery. */
const mockDiscover = vi.hoisted(() => vi.fn());
vi.mock("../../src/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/discovery.js")>()),
  discoverInstruments: mockDiscover,
}));

const inst = (host: string): DiscoveredInstrument => ({
  host, vxi11: true, vxi11Port: 4321, raw: true, analyzer: true,
  idn: { manufacturer: "UNI-T", model: "UTS3036B", firmware: "V1.04.0040" },
});
const idn = (line: string, socket: { write(s: string): void }) => { if (line === "*IDN?") socket.write("UNI-TREND,UTS0000X,<serial>,V0.0.0\r\n"); };

let client: Client;
let cleanup: () => Promise<void>;
let a: FakeScpi;
let b: FakeScpi;
beforeAll(async () => ({ client, cleanup } = await createTestServer(registerConnectionTools)));
afterAll(async () => cleanup());
beforeEach(async () => {
  vi.clearAllMocks();
  a = await startFakeScpi(idn);
  b = await startFakeScpi(idn);
  const r = await callTool(client, "connect", { name: "a", host: "127.0.0.1", port: a.port, transport: "raw" });
  expect(r.isError, getText(r)).toBeFalsy();
});
afterEach(async () => {
  await instruments.shutdown();
  for (const n of instruments.names()) instruments.remove(n);
  await a.close();
  await b.close();
});

describe("connect host=auto with several instruments", () => {
  it("leaves out analyzers that are already connected under another name", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("127.0.0.1"), inst("localhost")], notes: [] });
    const r = await callTool(client, "connect", { name: "b", host: "auto", port: b.port, transport: "raw" });
    expect(r.isError, getText(r)).toBeFalsy();
    expect(getText(r)).toContain("localhost");
    expect(getText(r)).toContain("Instrument: b");
    expect([...mockDiscover.mock.calls[0][0].skipIdentify]).toEqual(["127.0.0.1"]);
  });

  it("reports that the only analyzer found is already connected, and registers nothing", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("127.0.0.1")], notes: [] });
    const r = await callTool(client, "connect", { name: "b", host: "auto", port: b.port, transport: "raw" });
    expect(r.isError).toBe(true);
    expect(getText(r)).toMatch(/already connected/i);
    expect(instruments.names()).toEqual(["a"]);
  });

  it("reconnecting a name with auto does not exclude its own host", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("127.0.0.1")], notes: [] });
    const r = await callTool(client, "connect", { name: "a", host: "auto", port: a.port, transport: "raw" });
    expect(r.isError, getText(r)).toBeFalsy();
  });

  it("still refuses to guess when two new analyzers answer", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("localhost"), inst("127.0.0.2")], notes: [] });
    const r = await callTool(client, "connect", { name: "b", host: "auto", port: b.port, transport: "raw" });
    expect(r.isError).toBe(true);
    expect(getText(r)).toMatch(/2 UNI-T analyzers/);
  });
});

describe("discover_instruments with several connections", () => {
  it("does not probe any host that is connected under any name", async () => {
    const r = await callTool(client, "connect", { name: "b", host: "localhost", port: b.port, transport: "raw" });
    expect(r.isError, getText(r)).toBeFalsy();
    mockDiscover.mockResolvedValue({ instruments: [], notes: [] });
    await callTool(client, "discover_instruments", {});
    expect([...mockDiscover.mock.calls[0][0].skipIdentify].sort()).toEqual(["127.0.0.1", "localhost"]);
  });
});
