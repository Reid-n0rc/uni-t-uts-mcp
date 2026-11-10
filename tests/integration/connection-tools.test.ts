import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerConnectionTools } from "../../src/tools/connection.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.100:5025"),
  connect: vi.fn(async () => "UNI-TREND,UTS0000X,<serial>,V0.0.0"),
  disconnect: vi.fn(),
  runExclusive: (fn: () => unknown) => fn(),
  query: vi.fn(async () => "UNI-TREND,UTS0000X,<serial>,V0.0.0"),
}));

vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

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
  mockConnection.isConnected.mockReturnValue(true);
});

describe("tool listing", () => {
  it("registers connect, disconnect and identify with sensible hints", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["connect", "disconnect", "identify"]);
    expect(byName.identify.annotations?.readOnlyHint).toBe(true);
    expect(byName.connect.annotations?.openWorldHint).toBe(true);
  });
});

describe("connect", () => {
  it("uses UTS_IP and the default port when host and port are omitted", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    const res = await callTool(client, "connect", {});
    expect(res.isError).toBeFalsy();
    expect(mockConnection.connect).toHaveBeenCalledWith("192.168.1.100", 5025);
    expect(getText(res)).toContain("192.168.1.100:5025");
    expect(getText(res)).toContain("UNI-TREND,UTS0000X");
  });

  it("uses UTS_PORT from the environment", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    vi.stubEnv("UTS_PORT", "5555");
    await callTool(client, "connect", {});
    expect(mockConnection.connect).toHaveBeenCalledWith("192.168.1.100", 5555);
  });

  it("explicit host and port override the environment", async () => {
    vi.stubEnv("UTS_IP", "192.168.1.100");
    await callTool(client, "connect", { host: "analyzer.lab.example", port: 5026 });
    expect(mockConnection.connect).toHaveBeenCalledWith("analyzer.lab.example", 5026);
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
    expect(getText(res)).toBe("UNI-TREND,UTS0000X,<serial>,V0.0.0");
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
