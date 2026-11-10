import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerScpiTools } from "../../src/tools/scpi.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const mockConnection = vi.hoisted(() => ({
  query: vi.fn(async (cmd: string, _timeout?: number): Promise<string> =>
    cmd === "*IDN?" ? "UNI-TREND,UTS0000X,<serial>,V0.0.0" : cmd === ":SYSTem:ERRor?" ? '0,"No error"' : "1"
  ),
  msSinceQueryTimeout: () => Infinity,
  runExclusive: (fn: () => unknown) => fn(),
  queryBinary: vi.fn(async (_cmd: string, _timeout?: number) => Buffer.from([0, 1, 2, 255])),
  sendCommand: vi.fn(async (_cmd: string) => {}),
}));

vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerScpiTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe("tool listing", () => {
  it("has the right hints", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["scpi_command", "scpi_query"]);
    expect(byName.scpi_query.annotations?.readOnlyHint).toBe(true);
    expect(byName.scpi_command.annotations?.readOnlyHint).toBe(false);
  });
});

describe("scpi_query", () => {
  it("returns the reply text", async () => {
    const res = await callTool(client, "scpi_query", { command: "*IDN?" });
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toBe("UNI-TREND,UTS0000X,<serial>,V0.0.0");
    expect(mockConnection.query).toHaveBeenCalledWith("*IDN?", undefined);
  });

  it("passes timeout_ms through and rejects out-of-range values", async () => {
    await callTool(client, "scpi_query", { command: ":FREQ:CENT?", timeout_ms: 1234 });
    expect(mockConnection.query).toHaveBeenCalledWith(":FREQ:CENT?", 1234);
    for (const timeout_ms of [0, -5, 600000, 1.5]) {
      const res = await callTool(client, "scpi_query", { command: ":FREQ:CENT?", timeout_ms });
      expect(res.isError).toBe(true);
    }
  });

  it("returns a binary block reply as base64 with its length", async () => {
    const res = await callTool(client, "scpi_query", { command: ":DISP:ZBmp?", reply: "block" });
    expect(mockConnection.queryBinary).toHaveBeenCalledWith(":DISP:ZBmp?", undefined);
    const text = getText(res);
    expect(text).toContain("4 bytes");
    expect(text).toContain(Buffer.from([0, 1, 2, 255]).toString("base64"));
  });

  it("truncates very large block replies and says so", async () => {
    mockConnection.queryBinary.mockResolvedValueOnce(Buffer.alloc(200_000, 7));
    const text = getText(await callTool(client, "scpi_query", { command: "X?", reply: "block" }));
    expect(text).toContain("200000 bytes");
    expect(text).toMatch(/truncated/i);
    expect(text.length).toBeLessThan(120_000);
  });

  it.each([":FREQ:CENT 1 GHz", "*IDN?;*RST", "*RST", ":FREQ:CENT?;:SYST:DEF", ":FOO \"x"])(
    "refuses non-query %j so the read-only hint holds",
    async (command) => {
      const res = await callTool(client, "scpi_query", { command });
      expect(res.isError).toBe(true);
      expect(getText(res)).toMatch(/scpi_command|query|refusing/i);
      expect(mockConnection.query).not.toHaveBeenCalled();
      expect(mockConnection.queryBinary).not.toHaveBeenCalled();
    }
  );

  it("accepts only one query per call (the UTS3036B answers just one of several joined queries)", async () => {
    const res = await callTool(client, "scpi_query", { command: ":FREQ:CENT?;:FREQ:SPAN?" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/one query/i);
    expect(mockConnection.query).not.toHaveBeenCalled();
  });

  it("returns connection errors as error results", async () => {
    mockConnection.query.mockRejectedValueOnce(new Error("Query timeout after 5000ms for command: X?"));
    const res = await callTool(client, "scpi_query", { command: "X?" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("timeout");
  });
});

describe("scpi_command", () => {
  it("sends the command and confirms", async () => {
    const res = await callTool(client, "scpi_command", { command: ":FREQ:CENT 1 GHz" });
    expect(res.isError).toBeFalsy();
    expect(mockConnection.sendCommand).toHaveBeenCalledWith(":FREQ:CENT 1 GHz");
    expect(getText(res)).toContain(":FREQ:CENT 1 GHz");
  });

  it.each(["*RST", ":SYST:DEF", "*SAV 1", ":SYST:COMM:LAN:IPAD 192.168.1.100", ":FREQ:CENT 1 GHz\n*RST"])(
    "refuses denylisted %j without confirm",
    async (command) => {
      const res = await callTool(client, "scpi_command", { command });
      expect(res.isError).toBe(true);
      expect(getText(res)).toMatch(/confirm/i);
      expect(mockConnection.sendCommand).not.toHaveBeenCalled();
    }
  );

  it("allows a denylisted command with confirm=true", async () => {
    const res = await callTool(client, "scpi_command", { command: "*RST", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("*RST");
  });

  it("refuses commands that contain queries (use scpi_query)", async () => {
    for (const command of ["*IDN?", ":FREQ:CENT 1 GHz;:FREQ:CENT?"]) {
      const res = await callTool(client, "scpi_command", { command });
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("scpi_query");
    }
    expect(mockConnection.sendCommand).not.toHaveBeenCalled();
  });

  it("returns connection errors as error results", async () => {
    mockConnection.sendCommand.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "scpi_command", { command: ":FREQ:CENT 1 GHz" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });
});

describe("scpi_command error checking (#58)", () => {
  it("uses applyCommands: *CLS first, then checks the error queue and reports instrument errors", async () => {
    mockConnection.query.mockResolvedValueOnce('-131,"Invalid suffix"');
    const res = await callTool(client, "scpi_command", { command: ":FREQ:CENT 1 XX" });
    expect(mockConnection.sendCommand.mock.calls.map((c) => c[0])).toEqual(["*CLS", ":FREQ:CENT 1 XX"]);
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("Invalid suffix");
    expect(getText(res)).toContain(":FREQ:CENT 1 XX");
  });

  it("names the command when a block query fails", async () => {
    mockConnection.queryBinary.mockRejectedValueOnce(new Error("Expected a binary block reply: bad header"));
    const res = await callTool(client, "scpi_query", { command: ":DISP:ZBmp?", reply: "block" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":DISP:ZBmp?");
  });
});
