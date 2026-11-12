import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerInstrumentModuleTools } from "../../src/tools/instrumentModule.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const mockConnection = vi.hoisted(() => ({
  module: "SA" as string,
  refuseSwitch: false,
  readbackFails: false,
  query: vi.fn(async (cmd: string, _timeout?: number): Promise<string> => {
    if (cmd === ":INSTrument:SELect?") {
      if (mockConnection.readbackFails) throw new Error("Query timeout after 5000ms for command: :INSTrument:SELect?");
      return mockConnection.module;
    }
    if (cmd === ":SYSTem:ERRor?") return '0,"No error"';
    return "1";
  }),
  msSinceQueryTimeout: () => Infinity,
  runExclusive: (fn: () => unknown) => fn(),
  sendCommand: vi.fn(async (cmd: string) => {
    const m = /^:INSTrument:SELect (\w+)$/.exec(cmd);
    if (m && !mockConnection.refuseSwitch) mockConnection.module = m[1]!;
  }),
}));

vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerInstrumentModuleTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  vi.clearAllMocks();
  mockConnection.module = "SA";
  mockConnection.refuseSwitch = false;
  mockConnection.readbackFails = false;
});

describe("tool listing", () => {
  it("has the right hints", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_instrument_module", "select_instrument_module"]);
    expect(byName.get_instrument_module.annotations?.readOnlyHint).toBe(true);
    expect(byName.select_instrument_module.annotations?.readOnlyHint).toBeFalsy();
  });
});

describe("get_instrument_module", () => {
  it("reports the current module", async () => {
    mockConnection.module = "EMI";
    const res = await callTool(client, "get_instrument_module", {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(getText(res))).toEqual({ module: "emi" });
  });

  it("errors on an unexpected reply rather than guessing", async () => {
    mockConnection.query.mockResolvedValueOnce("VNA");
    const res = await callTool(client, "get_instrument_module", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("VNA");
  });
});

describe("select_instrument_module", () => {
  it("switches module and reads it back", async () => {
    const res = await callTool(client, "select_instrument_module", { module: "ad" });
    expect(res.isError).toBeFalsy();
    expect(mockConnection.sendCommand).toHaveBeenCalledWith(":INSTrument:SELect AD");
    expect(JSON.parse(getText(res))).toEqual({ requested: "AD", module: "AD" });
  });

  it("rejects an invalid module before sending anything", async () => {
    const res = await callTool(client, "select_instrument_module", { module: "iq" });
    expect(res.isError).toBe(true);
    expect(mockConnection.sendCommand).not.toHaveBeenCalled();
  });

  it("warns, not errors, when the module did not take (e.g. unlicensed, refused silently)", async () => {
    mockConnection.refuseSwitch = true; // setter accepted (no instrument error) but module stays SA
    const res = await callTool(client, "select_instrument_module", { module: "emi" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res));
    expect(parsed.requested).toBe("EMI");
    expect(parsed.module).toBe("SA");
    expect(parsed.warnings[0]).toMatch(/refused|unlicensed/);
  });

  it("reports a readback timeout with the connection-quirk hint", async () => {
    mockConnection.readbackFails = true;
    const res = await callTool(client, "select_instrument_module", { module: "emi" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("same connection");
  });
});

