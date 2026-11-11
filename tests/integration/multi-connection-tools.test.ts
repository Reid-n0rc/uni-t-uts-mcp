import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerConnectionTools } from "../../src/tools/connection.js";
import { connection } from "../../src/connection.js";
import { instruments } from "../../src/registry.js";
import { startFakeScpi, type FakeScpi } from "../fakeScpiServer.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Real registry and connections against two fake SCPI servers (no mocks): the name argument of the connection tools. */
const idn = (model: string) => (line: string, socket: { write(s: string): void }) => {
  if (line === "*IDN?") socket.write(`UNI-TREND,${model},<serial>,V0.0.0\r\n`);
};
let client: Client;
let cleanup: () => Promise<void>;
let a: FakeScpi;
let b: FakeScpi;

beforeAll(async () => {
  ({ client, cleanup } = await createTestServer(registerConnectionTools));
});
afterAll(async () => cleanup());
beforeEach(async () => {
  a = await startFakeScpi(idn("UTSA"));
  b = await startFakeScpi(idn("UTSB"));
});
afterEach(async () => {
  await instruments.shutdown();
  for (const n of instruments.names()) instruments.get(n)!.disconnect();
  await a.close();
  await b.close();
  // Forget every instrument between tests.
  for (const n of instruments.names()) instruments.remove(n);
});

const text = async (name: string, args: Record<string, unknown>) => {
  const r = await callTool(client, name, args);
  return { isError: !!r.isError, text: getText(r) };
};
const raw = (port: number, extra: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port, transport: "raw", ...extra });

describe("connect with a name", () => {
  it("without a name connects the default instrument, as before", async () => {
    const r = await text("connect", raw(a.port));
    expect(r.isError).toBe(false);
    expect(r.text).toContain("UTSA");
    expect(instruments.names()).toEqual(["default"]);
    expect(connection.isConnected()).toBe(true);
  });

  it("connects two names independently and creates them on first use", async () => {
    expect((await text("connect", raw(a.port, { name: "sa1" }))).text).toContain("UTSA");
    expect((await text("connect", raw(b.port, { name: "sa2" }))).text).toContain("UTSB");
    expect(instruments.names()).toEqual(["sa1", "sa2"]);
    expect(instruments.get("sa1")!.isConnected()).toBe(true);
    expect(instruments.get("sa2")!.isConnected()).toBe(true);
    expect((await text("identify", { name: "sa1" })).text).toContain("UTSA");
    expect((await text("identify", { name: "sa2" })).text).toContain("UTSB");
  });

  it("uses the host and port declared in UTS_INSTRUMENTS when none are given", async () => {
    instruments.declare("bench", { host: "127.0.0.1", port: a.port });
    const r = await text("connect", { name: "bench", transport: "raw" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("UTSA");
  });

  it("a name without a host or declared target says what to do", async () => {
    const r = await text("connect", { name: "nowhere" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nowhere/);
    expect(r.text).toMatch(/UTS_INSTRUMENTS|host/);
  });

  it("rejects an invalid name before touching anything", async () => {
    const r = await text("connect", raw(a.port, { name: "bad name!" }));
    expect(r.isError).toBe(true);
    expect(instruments.names()).toEqual([]);
  });

  it("does not leave a half-created instrument registered as connected after a failed connect", async () => {
    const r = await text("connect", { host: "127.0.0.1", port: 1, transport: "raw", name: "dead" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Connection failed|ECONNREFUSED|timeout/i);
    expect(instruments.get("dead")?.isConnected()).not.toBe(true);
  });

  it("without a name is an actionable error when several are configured and none is `default`", async () => {
    instruments.declare("x");
    instruments.declare("y");
    const r = await text("connect", raw(a.port));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/x, y/);
    expect(r.text).toMatch(/name/);
  });
});

describe("disconnect and identify with a name", () => {
  beforeEach(async () => {
    await text("connect", raw(a.port, { name: "sa1" }));
    await text("connect", raw(b.port, { name: "sa2" }));
  });

  it("disconnecting one leaves the other alive", async () => {
    const r = await text("disconnect", { name: "sa1" });
    expect(r.isError).toBe(false);
    expect(instruments.get("sa1")!.isConnected()).toBe(false);
    expect(instruments.get("sa2")!.isConnected()).toBe(true);
    expect((await text("identify", { name: "sa2" })).text).toContain("UTSB");
    expect((await text("identify", { name: "sa1" })).isError).toBe(true);
  });

  it("an unknown name is an error listing the configured ones and changes nothing", async () => {
    for (const tool of ["disconnect", "identify"]) {
      const r = await text(tool, { name: "nope" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Unknown instrument "nope"/);
      expect(r.text).toContain("sa1, sa2");
    }
    expect(instruments.get("sa1")!.isConnected()).toBe(true);
  });

  it("without a name is ambiguous here and says which names exist", async () => {
    for (const tool of ["disconnect", "identify"]) {
      const r = await text(tool, {});
      expect(r.isError).toBe(true);
      expect(r.text).toContain("sa1, sa2");
    }
  });

  it("reconnecting a name replaces only its own link", async () => {
    const r = await text("connect", raw(b.port, { name: "sa1" }));
    expect(r.text).toContain("UTSB");
    expect((await text("identify", { name: "sa2" })).text).toContain("UTSB");
  });
});

describe("list_instruments", () => {
  it("says nothing is configured when the registry is empty", async () => {
    const r = await text("list_instruments", {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).instruments).toEqual([]);
    expect(JSON.parse(r.text).hint).toMatch(/connect/);
  });

  it("lists names, state and the default without serial numbers", async () => {
    await text("connect", raw(a.port, { name: "sa1" }));
    instruments.declare("sa2", { host: "192.168.1.102" });
    instruments.declare("default");
    const r = await text("list_instruments", {});
    expect(r.isError).toBe(false);
    const list = JSON.parse(r.text);
    expect(list.instruments).toEqual([
      expect.objectContaining({ name: "sa1", connected: true, isDefault: false, transport: "raw SCPI over TCP" }),
      expect.objectContaining({ name: "sa2", connected: false, isDefault: false, configured: "192.168.1.102" }),
      expect.objectContaining({ name: "default", connected: false, isDefault: true }),
    ]);
    expect(r.text).not.toContain("<serial>");
    expect(list.instruments[0].connection).toContain(String(a.port));
  });

  it("marks the only instrument as the default one", async () => {
    await text("connect", raw(a.port, { name: "solo" }));
    expect(JSON.parse((await text("list_instruments", {})).text).instruments[0].isDefault).toBe(true);
  });

  it("is read-only and does not wait for a busy instrument", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "list_instruments")?.annotations?.readOnlyHint).toBe(true);
  });
});
