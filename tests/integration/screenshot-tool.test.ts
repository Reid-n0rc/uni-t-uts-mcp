import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerScreenshotTools } from "../../src/tools/screenshot.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** A real 1 x 1 PNG (signature, IHDR, IDAT, IEND). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const fake = vi.hoisted(() => {
  const state = {
    format: "BMP",
    completeLargeBlocks: true,
    errors: [] as string[],
    binary: null as Buffer | null | Error,
    binaryFormat: "" as string,
    events: [] as string[],
  };
  const reset = () => {
    Object.assign(state, { format: "BMP", completeLargeBlocks: true, errors: [], binary: null, binaryFormat: "", events: [] });
  };
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    state.events.push(`query ${cmd}`);
    if (cmd === ":SYSTem:PICture:FORMat?") return state.format;
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    state.events.push(`command ${cmd}`);
    const m = /^:SYSTem:PICture:FORMat (\S+)$/.exec(cmd);
    if (m) state.format = m[1];
    else state.errors.push('-113,"Undefined header"');
  });
  const queryBinary = vi.fn(async (cmd: string, _t?: number): Promise<Buffer> => {
    state.events.push(`binary ${cmd}`);
    state.binaryFormat = state.format;
    if (state.binary instanceof Error) throw state.binary;
    return state.binary ?? Buffer.alloc(0);
  });
  const connection = {
    get capabilities() { return { completeLargeBlocks: state.completeLargeBlocks }; },
    query, sendCommand, queryBinary, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn(),
  };
  return { state, reset, query, sendCommand, queryBinary, connection };
});

vi.mock("../../src/connection.js", () => ({ connection: fake.connection }));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerScreenshotTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  fake.state.binary = PNG;
});

describe("screenshot", () => {
  it("is registered read-only", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "screenshot");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("returns a PNG image block captured with the picture format set to PNG", async () => {
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBeFalsy();
    const blocks = res.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const img = blocks.find((b) => b.type === "image");
    expect(img?.mimeType).toBe("image/png");
    expect(Buffer.from(img!.data!, "base64").equals(PNG)).toBe(true);
    expect(getText(res)).toContain(`${PNG.length} bytes`);
    expect(fake.state.binaryFormat).toBe("PNG");
    expect(fake.queryBinary).toHaveBeenCalledWith(":DISPlay:DATA?", expect.any(Number));
  });

  it("restores the original picture format (BMP) afterwards", async () => {
    await callTool(client, "screenshot");
    expect(fake.state.format).toBe("BMP");
    const sets = fake.state.events.filter((e) => e.startsWith("command :SYSTem:PICture"));
    expect(sets).toEqual(["command :SYSTem:PICture:FORMat PNG", "command :SYSTem:PICture:FORMat BMP"]);
  });

  it("leaves the format as it was when it already was PNG", async () => {
    fake.state.format = "PNG";
    await callTool(client, "screenshot");
    expect(fake.state.format).toBe("PNG");
  });

  it("restores the format when the transfer fails, and reports the failure", async () => {
    fake.state.binary = new Error("Binary query timeout after 30000ms for command: :DISPlay:DATA?");
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":DISPlay:DATA?");
    expect(fake.state.format).toBe("BMP");
  });

  it("refuses over a transport that truncates large replies, before sending anything", async () => {
    fake.state.completeLargeBlocks = false;
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBe(true);
    const text = getText(res);
    expect(text).toContain("144,800");
    expect(text).toMatch(/VXI-11/);
    expect(text).toContain("UTS_TRANSPORT");
    expect(fake.state.events).toEqual([]);
  });

  it("rejects a reply that is not a PNG, and restores the format", async () => {
    fake.state.binary = Buffer.from("BM" + "x".repeat(100));
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/not a PNG/);
    expect(fake.state.format).toBe("BMP");
  });

  it("rejects an empty reply", async () => {
    fake.state.binary = Buffer.alloc(0);
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBe(true);
  });

  it("reports an instrument error when selecting PNG and still tries to restore", async () => {
    fake.sendCommand.mockImplementationOnce(async () => {}); // *CLS
    fake.sendCommand.mockImplementationOnce(async () => { fake.state.errors.push('-224,"Illegal parameter value"'); });
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("-224");
  });

  it("reports an error (keeping the image) when restoring the format fails", async () => {
    let n = 0;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "*CLS") return;
      n++;
      if (cmd.endsWith(" BMP")) throw new Error("Write failed while sending " + cmd);
      const m = /FORMat (\S+)$/.exec(cmd);
      if (m) fake.state.format = m[1];
    });
    const res = await callTool(client, "screenshot");
    expect(n).toBeGreaterThan(1);
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/could not be restored to BMP/i);
    expect((res.content as Array<{ type: string }>).some((b) => b.type === "image")).toBe(true);
  });

  it("reports an unreadable picture format", async () => {
    fake.query.mockImplementationOnce(async () => { throw new Error("Query timeout after 5000ms for command: :SYSTem:PICture:FORMat?"); });
    const res = await callTool(client, "screenshot");
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain(":SYSTem:PICture:FORMat?");
    expect(fake.queryBinary).not.toHaveBeenCalled();
  });
});
