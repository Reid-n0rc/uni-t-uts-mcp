import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerConnectionTools } from "../../src/tools/connection.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.100:5025"),
  transportName: "raw",
  transportLabel: "raw SCPI over TCP",
  connect: vi.fn(async () => "UNI-TREND,UTS0000X,<serial>,V0.0.0"),
  disconnect: vi.fn(),
  runExclusive: (fn: () => unknown) => fn(),
  query: vi.fn(async () => "UNI-TREND,UTS0000X,<serial>,V0.0.0"),
}));

vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

const RAW_OPTIONS = expect.objectContaining({ transport: "raw", vxi11Device: "inst0" });

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerConnectionTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockConnection.transportName = "raw";
  mockConnection.transportLabel = "raw SCPI over TCP";
  mockConnection.isConnected.mockReturnValue(true);
});

describe("tool listing", () => {
  it("registers connect, disconnect and identify with sensible hints", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["connect", "disconnect", "discover_instruments", "identify", "list_instruments"]);
    expect(byName.identify.annotations?.readOnlyHint).toBe(true);
    expect(byName.connect.annotations?.openWorldHint).toBe(true);
  });
});

describe("connect", () => {
  it("uses UTS_IP and the default port when host and port are omitted", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    const res = await callTool(client, "connect", {});
    expect(res.isError).toBeFalsy();
    expect(mockConnection.connect).toHaveBeenCalledWith(
      "192.168.1.100",
      5025,
      expect.objectContaining({ transport: "auto", vxi11Device: "inst0" })
    );
    expect(getText(res)).toContain("192.168.1.100:5025");
    expect(getText(res)).toContain("UNI-TREND,UTS0000X");
  });

  it("uses UTS_PORT from the environment", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    vi.stubEnv("UTS_PORT", "5555");
    await callTool(client, "connect", {});
    expect(mockConnection.connect).toHaveBeenCalledWith("192.168.1.100", 5555, RAW_OPTIONS);
  });

  it("explicit host and port override the environment", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    await callTool(client, "connect", { host: "analyzer.lab.example", port: 5026 });
    expect(mockConnection.connect).toHaveBeenCalledWith("analyzer.lab.example", 5026, RAW_OPTIONS);
  });

  it("errors and mentions UTS_IP when no host is available", async () => {
    vi.stubEnv("UTS_IP", "");
    const res = await callTool(client, "connect", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("UTS_IP");
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("returns the failure as an error result", async () => {
    mockConnection.connect.mockRejectedValueOnce(new Error("Connection failed: ECONNREFUSED"));
    const res = await callTool(client, "connect", { host: "192.168.1.100" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("ECONNREFUSED");
  });

  it.each(["", "bad host", "a/b", "host;rm", "http://x", "x".repeat(300)])(
    "rejects invalid host %j without connecting",
    async (host) => {
      const res = await callTool(client, "connect", { host });
      expect(res.isError).toBe(true);
      expect(mockConnection.connect).not.toHaveBeenCalled();
    }
  );

  it.each([0, 70000, 1.5, -1])("rejects invalid port %j", async (port) => {
    const res = await callTool(client, "connect", { host: "192.168.1.100", port });
    expect(res.isError).toBe(true);
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("rejects an invalid UTS_PORT in the environment", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    vi.stubEnv("UTS_PORT", "notaport");
    const res = await callTool(client, "connect", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("UTS_PORT");
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });
});

describe("identify", () => {
  it("returns the *IDN? reply", async () => {
    const res = await callTool(client, "identify", {});
    expect(mockConnection.query).toHaveBeenCalledWith("*IDN?");
    expect(getText(res)).toContain("UNI-TREND,UTS0000X,<serial>,V0.0.0");
  });

  it("states which transport is in use", async () => {
    expect(getText(await callTool(client, "identify", {}))).toContain("Transport: raw SCPI over TCP");
    mockConnection.transportLabel = "VXI-11 (device inst0)";
    expect(getText(await callTool(client, "identify", {}))).toContain("Transport: VXI-11 (device inst0)");
  });

  it("surfaces the not-connected error", async () => {
    mockConnection.query.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "identify", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
});

describe("identify and disconnect failure modes (#58)", () => {
  it("rejects an empty or non-IDN reply, naming the command", async () => {
    for (const reply of ["", "garbage"]) {
      mockConnection.query.mockResolvedValueOnce(reply);
      const res = await callTool(client, "identify", {});
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("*IDN?");
    }
  });

  it("returns an error result if disconnecting throws", async () => {
    mockConnection.disconnect.mockImplementationOnce(() => {
      throw new Error("socket exploded");
    });
    const res = await callTool(client, "disconnect", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("socket exploded");
  });
});

describe("disconnect", () => {
  it("disconnects when connected", async () => {
    const res = await callTool(client, "disconnect", {});
    expect(mockConnection.disconnect).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toMatch(/disconnected/i);
  });

  it("is safe when not connected", async () => {
    mockConnection.isConnected.mockReturnValue(false);
    const res = await callTool(client, "disconnect", {});
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toMatch(/not connected/i);
  });
});

describe("front-panel lock notice (#155)", () => {
  it("connect says the panel is locked while remote and Esc returns to local", async () => {
    const text = getText(await callTool(client, "connect", { host: "192.168.1.100" }));
    expect(text).toMatch(/front panel/i);
    expect(text).toMatch(/locked/i);
    expect(text).toMatch(/Esc/);
  });

  it("disconnect says the user must press Esc on the analyzer", async () => {
    const text = getText(await callTool(client, "disconnect", {}));
    expect(text).toMatch(/Esc/);
    expect(text).toMatch(/front panel|local mode/i);
  });

  it("disconnect when not connected stays a plain notice", async () => {
    mockConnection.isConnected.mockReturnValue(false);
    expect(getText(await callTool(client, "disconnect", {}))).toMatch(/not connected/i);
  });
});

describe("transport selection (#74)", () => {
  it("states the transport in the connect output", async () => {
    const res = await callTool(client, "connect", { host: "192.168.1.100" });
    expect(getText(res)).toContain("Transport: raw SCPI over TCP");
  });

  it("defaults to raw, honors UTS_TRANSPORT and UTS_VXI11_DEVICE, and the parameter wins", async () => {
    vi.stubEnv("UTS_TRANSPORT", "vxi11");
    vi.stubEnv("UTS_VXI11_DEVICE", "inst2");
    await callTool(client, "connect", { host: "192.168.1.100" });
    expect(mockConnection.connect).toHaveBeenLastCalledWith(
      "192.168.1.100",
      5025,
      expect.objectContaining({ transport: "vxi11", vxi11Device: "inst2" })
    );
    await callTool(client, "connect", { host: "192.168.1.100", transport: "auto" });
    expect(mockConnection.connect).toHaveBeenLastCalledWith(
      "192.168.1.100",
      5025,
      expect.objectContaining({ transport: "auto", vxi11Device: "inst2" })
    );
  });

  it("shows the VXI-11 transport in the connect output", async () => {
    mockConnection.transportName = "vxi11";
    mockConnection.transportLabel = "VXI-11 (device inst0)";
    mockConnection.getConnectionInfo.mockReturnValueOnce("192.168.1.100 (VXI-11 inst0)");
    const res = await callTool(client, "connect", { host: "192.168.1.100", transport: "vxi11" });
    expect(getText(res)).toContain("Transport: VXI-11 (device inst0)");
  });

  it("rejects an invalid transport parameter without connecting", async () => {
    const res = await callTool(client, "connect", { host: "192.168.1.100", transport: "serial" });
    expect(res.isError).toBe(true);
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("rejects an invalid UTS_TRANSPORT or UTS_VXI11_DEVICE with a message naming the variable", async () => {
    vi.stubEnv("UTS_TRANSPORT", "hislip");
    let res = await callTool(client, "connect", { host: "192.168.1.100" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("UTS_TRANSPORT");
    vi.stubEnv("UTS_TRANSPORT", "");
    vi.stubEnv("UTS_VXI11_DEVICE", "bad name;");
    res = await callTool(client, "connect", { host: "192.168.1.100" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("UTS_VXI11_DEVICE");
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });

  it("rejects an explicit port together with transport vxi11 (the port is for the raw transport only)", async () => {
    const res = await callTool(client, "connect", { host: "192.168.1.100", transport: "vxi11", port: 5025 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/port.*raw/i);
    expect(mockConnection.connect).not.toHaveBeenCalled();
  });
});
