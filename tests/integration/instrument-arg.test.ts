import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { instruments } from "../../src/registry.js";
import { callTool, getText } from "../helpers.js";
import { startFakeUts, type FakeUts } from "../fakeUts.js";

/** The `instrument` argument on instrument tools: real registry and connections, two stateful fake analyzers, no mocks. */
let client: Client;
let a: FakeUts;
let b: FakeUts;

const json = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await callTool(client, name, args);
  return { isError: res.isError === true, text: getText(res), json: (() => { try { return JSON.parse(getText(res)); } catch { return undefined; } })() };
};

beforeAll(async () => {
  a = await startFakeUts();
  b = await startFakeUts();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  for (const [name, f] of [["a", a], ["b", b]] as const) {
    const r = await json("connect", { name, host: "127.0.0.1", port: f.port, transport: "raw" });
    expect(r.isError, r.text).toBe(false);
  }
});
afterAll(async () => {
  await instruments.shutdown();
  for (const n of instruments.names()) instruments.remove(n);
  await client.close();
  await a.close();
  await b.close();
});

describe("instrument argument", () => {
  it("routes each call to its own instrument", async () => {
    expect((await json("set_frequency", { center_hz: 100e6, instrument: "a" })).isError).toBe(false);
    expect((await json("set_frequency", { center_hz: 200e6, instrument: "b" })).isError).toBe(false);
    expect((await json("get_frequency", { instrument: "a" })).json.center_hz).toBe(100e6);
    expect((await json("get_frequency", { instrument: "b" })).json.center_hz).toBe(200e6);
    expect(a.model.num("fc")).toBe(100e6);
    expect(b.model.num("fc")).toBe(200e6);
  });

  it("scpi_query and identify reach the named instrument", async () => {
    expect((await json("scpi_query", { command: "*IDN?", instrument: "b" })).text).toContain("UTS3036B");
    expect((await json("identify", { name: "a" })).text).toContain("UTS3036B");
  });

  it("without the argument and several instruments but no `default`, the call says which names exist", async () => {
    for (const call of [json("get_frequency"), json("scpi_query", { command: "*IDN?" }), json("get_marker", { marker: 1 })]) {
      const r = await call;
      expect(r.isError).toBe(true);
      expect(r.text).toContain("a, b");
      expect(r.text).toMatch(/instrument/);
    }
  });

  it("an unknown name lists the configured ones", async () => {
    const r = await json("get_frequency", { instrument: "c" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown instrument "c".*a, b/s);
  });

  it("an instrument that is not connected says so and does not affect the other", async () => {
    await json("disconnect", { name: "a" });
    const r = await json("get_frequency", { instrument: "a" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not connected/i);
    expect((await json("get_frequency", { instrument: "b" })).json.center_hz).toBe(200e6);
  });

  it("with an instrument called `default` a call without the argument uses it", async () => {
    const r = await json("connect", { name: "default", host: "127.0.0.1", port: a.port, transport: "raw" });
    expect(r.isError, r.text).toBe(false);
    expect((await json("get_frequency")).json.center_hz).toBe(100e6);
    expect((await json("get_frequency", { instrument: "b" })).json.center_hz).toBe(200e6);
    expect((await json("list_instruments")).json.instruments.find((i: { name: string }) => i.name === "default").isDefault).toBe(true);
  });
});
