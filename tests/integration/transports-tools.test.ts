import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { connection } from "../../src/connection.js";
import { callTool, getText } from "../helpers.js";
import { CONTRACT, defaultReply, type ContractEntry } from "../toolContract.js";
import { startFakeScpi, type FakeScpi } from "../fakeScpiServer.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";

/**
 * Every tool, with the valid arguments of the tool contract table, works over both transports
 * against the fake instruments (raw TCP and VXI-11), and the connect tool reports the transport.
 */
const PNG_HEAD = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const reply = (cmd: string): string | undefined => {
  if (cmd === ":SYSTem:ERRor?") return '0,"No error"';
  if (cmd.endsWith("?")) return defaultReply(cmd);
  return undefined;
};

let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "both-transports", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});
afterAll(async () => close());

const entries = (Object.entries(CONTRACT) as Array<[string, ContractEntry]>).filter(
  ([, e]) => e.kind !== "connect" && e.kind !== "disconnect"
);

describe.each(["raw", "vxi11"] as const)("all tools over the %s transport", (transport) => {
  let raw: FakeScpi | undefined;
  let vxi: FakeVxi11Instrument | undefined;
  afterEach(async () => {
    connection.disconnect();
    await raw?.close();
    await vxi?.close();
    raw = vxi = undefined;
  });

  async function start(): Promise<string> {
    if (transport === "raw") {
      raw = await startFakeScpi((line, socket) => {
        const r = reply(line);
        if (r !== undefined) socket.write(r + "\r\n");
      });
      const res = await callTool(client, "connect", { host: "127.0.0.1", port: raw.port, transport: "raw" });
      return getText(res) + (res.isError ? " [error]" : "");
    }
    vxi = await startFakeVxi11Instrument({
      scpi: (c) => (c === ":DISPlay:DATA?" ? Buffer.concat([Buffer.from("#216"), PNG_HEAD]) : reply(c)),
    });
    // the portmapper port is not a tool parameter (VXI-11 uses port 111); connect directly for the fake
    await connection.connect("127.0.0.1", 5025, { transport: "vxi11", vxi11PortmapperPort: vxi.port });
    return "";
  }

  it("connects and reports the transport", async () => {
    const out = await start();
    if (transport === "raw") expect(out).toContain("Transport: raw");
    expect(connection.transportName).toBe(transport);
    const id = await callTool(client, "identify", {});
    expect(id.isError).toBeFalsy();
    expect(getText(id)).toContain("UTS3036B");
    expect(getText(id)).toMatch(transport === "raw" ? /Transport: raw/ : /Transport: VXI-11/);
  });

  it.each(entries)("%s runs with its valid arguments", async (name, entry) => {
    await start();
    const res = await callTool(client, name, entry.args);
    if (name === "screenshot" && transport === "raw") {
      // raw TCP truncates large replies (issue #42): the tool refuses with instructions instead of hanging
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("VXI-11");
      return;
    }
    expect(res.isError, `${name}: ${getText(res)}`).toBeFalsy();
  });
});
