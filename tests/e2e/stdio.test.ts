import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeUts, type FakeUts } from "../fakeUts.js";
import { E2E, ORDER, type E2eContext } from "./e2eTable.js";

/**
 * End to end over real stdio: the BUILT server (`node build/index.js`) talks raw SCPI over TCP to the stateful
 * fake analyzer (tests/fakeUts.ts). EVERY registered tool must have an entry in tests/e2e/e2eTable.ts, like
 * the CONTRACT table: a new tool without one fails the "every tool has an entry" test below.
 */

const SERVER = fileURLToPath(new URL("../../build/index.js", import.meta.url));

let fake: FakeUts;
let client: Client;
let toolNames: string[] = [];
const stderr: string[] = [];

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("build/index.js is missing: run `npm run build` before the end to end tests");
  fake = await startFakeUts({ tgSweepScale: 0.05 }); // the 2.15 s generator sweep would only slow the test down
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("UTS_")) env[k] = v;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  toolNames = (await client.listTools()).tools.map((t) => t.name);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await fake?.close();
});

const ctx = (): E2eContext => ({
  fake,
  port: fake.port,
  async call(name, args = {}) {
    const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n");
    return { isError: res.isError === true, text, json: tryJson(text) };
  },
});

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

describe("stdio end to end against the fake UTS", () => {
  it("every registered tool has an entry in the table, and every entry names a registered tool", () => {
    expect(toolNames.filter((n) => !(n in E2E)), "tools missing from tests/e2e/e2eTable.ts").toEqual([]);
    expect(Object.keys(E2E).filter((n) => !toolNames.includes(n)), "table entries for tools that no longer exist").toEqual([]);
    expect([...ORDER].sort(), "ORDER must list each entry exactly once").toEqual(Object.keys(E2E).sort());
  });

  for (const name of ORDER) {
    const entry = E2E[name]!;
    const run = entry.skip ? it.skip : it;
    run(`${name}${entry.skip ? ` (skipped: ${entry.skip})` : ""}`, async () => {
      const c = ctx();
      for (const step of entry.steps) {
        const res = await c.call(step.tool ?? name, typeof step.args === "function" ? step.args(c) : step.args);
        step.check(res, c);
      }
    }, entry.timeoutMs ?? 20_000);
  }

  it("every instrument tool refuses an unknown `instrument` (the connection tools: `name`) and the listing tools take none", async () => {
    const c = ctx();
    for (const name of toolNames) {
      if (["discover_instruments", "list_instruments", "connect"].includes(name)) continue; // connect registers a new name
      const arg = ["connect", "disconnect", "identify"].includes(name) ? "name" : "instrument";
      const res = await c.call(name, { [arg]: "nope" });
      expect(res.isError, `${name}: ${res.text}`).toBe(true);
      expect(res.text, name).toMatch(/Unknown instrument "nope"/);
    }
  });

  it("a second analyzer connected by name is driven independently through `instrument`", async () => {
    const second = await startFakeUts({ tgSweepScale: 0.05 });
    try {
      const c = ctx();
      const r = await c.call("connect", { name: "second", host: "127.0.0.1", port: second.port, transport: "raw" });
      expect(r.isError, r.text).toBe(false);
      const before = fake.model.num("fc");
      expect((await c.call("set_frequency", { center_hz: 321e6, instrument: "second" })).isError).toBe(false);
      expect(second.model.num("fc")).toBe(321e6);
      expect(fake.model.num("fc")).toBe(before);
      expect((await c.call("get_frequency", { instrument: "second" })).json.center_hz).toBe(321e6);
      const list = (await c.call("list_instruments")).json.instruments as Array<{ name: string; connected: boolean }>;
      expect(list.map((i) => i.name)).toEqual(["default", "second"]);
      expect(list.find((i) => i.name === "second")!.connected).toBe(true);
    } finally {
      await ctx().call("disconnect", { name: "second" });
      await second.close();
    }
  });

  it("the server printed no uncaught exception", () => {
    expect(stderr.join("")).not.toMatch(/Uncaught exception|Unhandled rejection/);
  });
});
