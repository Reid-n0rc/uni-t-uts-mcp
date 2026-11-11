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

  it("the server printed no uncaught exception", () => {
    expect(stderr.join("")).not.toMatch(/Uncaught exception|Unhandled rejection/);
  });
});
