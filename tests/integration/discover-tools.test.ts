import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerConnectionTools } from "../../src/tools/connection.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { DiscoveredInstrument } from "../../src/discovery.js";

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => false),
  getConnectionInfo: vi.fn(() => "Not connected"),
  transportName: "raw",
  transportLabel: "raw SCPI over TCP",
  connect: vi.fn(async (_h: string, _p: number, _o?: unknown) => "UNI-TREND,UTS0000X,<serial>,V0.0.0"),
  disconnect: vi.fn(),
  runExclusive: (fn: () => unknown) => fn(),
  query: vi.fn(),
}));
const mockDiscover = vi.hoisted(() => vi.fn());

vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));
vi.mock("../../src/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/discovery.js")>()),
  discoverInstruments: mockDiscover,
}));

const inst = (host: string, analyzer = true): DiscoveredInstrument => ({
  host,
  vxi11: true,
  vxi11Port: 4321,
  raw: true,
  idn: { manufacturer: analyzer ? "UNI-T" : "ACME", model: analyzer ? "UTS3036B" : "SCOPE", firmware: "V1.04.0040" },
  analyzer,
});

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ client, cleanup } = await createTestServer(registerConnectionTools));
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockConnection.isConnected.mockReturnValue(false);
  mockDiscover.mockResolvedValue({ instruments: [], notes: [] });
});

describe("discover_instruments", () => {
  it("is registered read-only and open-world", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "discover_instruments");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.annotations?.openWorldHint).toBe(true);
  });

  it("lists what was found as JSON without serial numbers", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("192.168.1.100"), inst("192.168.1.101")], notes: ["bind failed on one interface"] });
    const res = await callTool(client, "discover_instruments", {});
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res));
    expect(parsed.instruments).toHaveLength(2);
    expect(parsed.instruments[0]).toMatchObject({ host: "192.168.1.100", analyzer: true, vxi11: true, raw: true });
    expect(parsed.notes).toContain("bind failed on one interface");
  });

  it("passes the timeout and says so when nothing is found (not an error)", async () => {
    const res = await callTool(client, "discover_instruments", { timeout_ms: 800 });
    expect(res.isError).toBeFalsy();
    expect(mockDiscover).toHaveBeenCalledWith(expect.objectContaining({ windowMs: 800 }));
    expect(JSON.parse(getText(res)).hint).toMatch(/no analyzer/i);
  });

  it("rejects an out-of-range timeout without scanning", async () => {
    expect((await callTool(client, "discover_instruments", { timeout_ms: 50 })).isError).toBe(true);
    expect((await callTool(client, "discover_instruments", { timeout_ms: 60000 })).isError).toBe(true);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("does not identify the host it is already connected to", async () => {
    mockConnection.isConnected.mockReturnValue(true);
    mockConnection.getConnectionInfo.mockReturnValue("192.168.1.100:5025");
    await callTool(client, "discover_instruments", {});
    const arg = mockDiscover.mock.calls[0][0] as { skipIdentify: Set<string> };
    expect([...arg.skipIdentify]).toEqual(["192.168.1.100"]);
  });

  it("turns a failing discovery into an error result", async () => {
    mockDiscover.mockRejectedValue(new Error("boom"));
    const res = await callTool(client, "discover_instruments", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("boom");
  });
});

describe("connect host=auto", () => {
  it("connects to the only analyzer found", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("192.168.1.100")], notes: [] });
    const res = await callTool(client, "connect", { host: "auto" });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(mockConnection.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.objectContaining({ transport: "auto" }));
    expect(getText(res)).toContain("Connected to");
    expect(getText(res)).toContain("192.168.1.100");
    expect(getText(res)).toMatch(/auto-selected by network discovery/i);
    expect(getText(res)).toContain('"UTS3036B"');
    expect(getText(res)).toMatch(/unauthenticated/i);
  });

  it("works through UTS_IP=auto when no host is given", async () => {
    vi.stubEnv("UTS_IP", "auto");
    mockDiscover.mockResolvedValue({ instruments: [inst("192.168.1.100")], notes: [] });
    const res = await callTool(client, "connect", {});
    expect(res.isError, getText(res)).toBeFalsy();
    expect(mockConnection.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.anything());
  });

  it("an explicit host overrides UTS_IP=auto and never discovers", async () => {
    vi.stubEnv("UTS_IP", "auto");
    await callTool(client, "connect", { host: "192.168.1.5" });
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockConnection.connect).toHaveBeenCalledWith("192.168.1.5", 5025, expect.anything());
  });

  it("returns the list and asks the user to choose when several are found", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("192.168.1.100"), inst("192.168.1.101")], notes: [] });
    const res = await callTool(client, "connect", { host: "auto" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("192.168.1.100");
    expect(getText(res)).toContain("192.168.1.101");
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("is an error with advice when nothing is found", async () => {
    const res = await callTool(client, "connect", { host: "auto" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/no .*analyzer/i);
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("still honours the transport and port rules for the found host", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("192.168.1.100")], notes: [] });
    const res = await callTool(client, "connect", { host: "auto", transport: "vxi11", port: 5025 });
    expect(res.isError).toBe(true);
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("a failing connect after discovery is an error result", async () => {
    mockDiscover.mockResolvedValue({ instruments: [inst("192.168.1.100")], notes: [] });
    mockConnection.connect.mockRejectedValueOnce(new Error("Connection failed: ECONNREFUSED"));
    const res = await callTool(client, "connect", { host: "auto" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("ECONNREFUSED");
  });
});
