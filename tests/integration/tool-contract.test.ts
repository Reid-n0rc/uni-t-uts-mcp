import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer } from "../../src/server.js";
import { probeTuning, forgetSavedSettings } from "../../src/tools/measurement.js";
import { callTool, getText, type ToolResult } from "../helpers.js";
import { APPLICABLE, CONTRACT, fake, type ContractEntry, type Mode } from "../toolContract.js";
import { readdirSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../../src/connection.js", async () => ({ connection: (await import("../toolContract.js")).fakeConnection }));
// discover_instruments uses real sockets: the contract test must never touch the network.
vi.mock("../../src/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/discovery.js")>()),
  discoverInstruments: async () => ({ instruments: [], notes: [] }),
}));

/**
 * Error handling standard (AGENTS.md): for every registered tool, under every failure mode that applies
 * to it, the result is an isError result with a useful message, nothing is thrown, and nothing is sent
 * for invalid input. Tools missing from tests/toolContract.ts fail here.
 */

let client: Client;
let cleanup: () => Promise<void>;
let toolNames: string[] = [];

beforeAll(async () => {
  probeTuning.recoveryMs = 0;
  probeTuning.settleMs = 0; // no real pauses after the fake's probe timeouts
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "contract", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
  toolNames = (await client.listTools()).tools.map((t) => t.name);
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  forgetSavedSettings();
});
afterEach(() => {
  // Every operation of every test must have run inside an exclusive session (defineTool).
  expect(fake.violations, "instrument operations outside an exclusive session: a tool bypasses defineTool()").toEqual([]);
});

const entries = Object.entries(CONTRACT) as Array<[string, ContractEntry]>;

function isErrorResult(res: ToolResult): boolean {
  return res.isError === true;
}

/** An error result that came from our own errorResult(), not from an exception caught by the SDK. */
function expectCleanError(res: ToolResult, who: string): string {
  expect(isErrorResult(res), `${who} should return isError`).toBe(true);
  const text = getText(res);
  expect(text, `${who}: message must come from errorResult(), not a thrown exception`).toMatch(/^Error: /);
  expect(text.length, `${who}: message too short to be useful`).toBeGreaterThan(20);
  expect(text).not.toMatch(/undefined|\[object|NaN/);
  return text;
}

describe("contract table", () => {
  it("covers every registered tool (add new tools to tests/toolContract.ts)", () => {
    const missing = toolNames.filter((n) => !(n in CONTRACT));
    expect(
      missing,
      `Registered tools missing from tests/toolContract.ts: ${missing.join(", ")}. Add an entry to CONTRACT ` +
        `(kind, valid args, invalid args, warn args; see the header comment there and the "Error handling standard" in AGENTS.md).`
    ).toEqual([]);
  });

  it("has no entries for tools that are not registered", () => {
    const stale = Object.keys(CONTRACT).filter((n) => !toolNames.includes(n));
    expect(stale, `Entries for unregistered tools: ${stale.join(", ")}`).toEqual([]);
  });

  it("marks read-only tools with readOnlyHint (getters, scpi_query)", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const kind = CONTRACT[t.name]?.kind;
      if (kind === "getter" || kind === "rawQuery") expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    }
  });
});

describe.each(entries)("%s", (name, entry) => {
  it("works with valid replies (baseline for the failure-mode tests)", async () => {
    fake.reset();
    const res = await callTool(client, name, entry.args);
    expect(res.isError, getText(res)).toBeFalsy();
  });

  for (const args of entry.invalid ?? []) {
    it(`rejects invalid input ${JSON.stringify(args)} and sends nothing`, async () => {
      const res = await callTool(client, name, args);
      expect(isErrorResult(res)).toBe(true);
      expect(fake.ops).toEqual([]);
      expect(fake.connectCalls).toBe(0);
    });
  }

  for (const args of entry.warn ?? []) {
    it(`reports a value the instrument did not take as a warning: ${JSON.stringify(args)}`, async () => {
      const res = await callTool(client, name, args);
      expect(res.isError, getText(res)).toBeFalsy();
      const parsed = JSON.parse(getText(res)) as { warnings?: string[] };
      expect(parsed.warnings?.length, "expected a non-empty warnings array").toBeGreaterThan(0);
    });
  }

  for (const mode of APPLICABLE[entry.kind]) {
    const skipReason = entry.skip?.[mode];
    if (skipReason) {
      it.skip(`${mode} (skipped: ${skipReason})`, () => {});
      continue;
    }
    if (mode === "partial") {
      it("fails cleanly when any single operation fails part-way", async () => {
        fake.reset();
        const ok = await callTool(client, name, entry.args);
        expect(ok.isError, getText(ok)).toBeFalsy();
        const total = fake.ops.length;
        expect(total).toBeGreaterThan(0);
        for (let i = 0; i < total; i++) {
          fake.reset("partial", i);
          const res = await callTool(client, name, entry.args);
          const who = `${name} with operation #${i} failing (${fake.ops[i] ?? "?"})`;
          const text = expectCleanError(res, who);
          if (entry.kind !== "getter" && fake.sent.length > 0) {
            expect(text, `${who}: must say the settings may already be applied`).toMatch(/applied/i);
          }
        }
      });
      continue;
    }
    it(`${mode}: isError with a useful message`, async () => {
      fake.reset(mode);
      const res = await callTool(client, name, entry.args);
      const text = expectCleanError(res, name);
      switch (mode) {
        case "notConnected":
          expect(text).toMatch(/not connected/i);
          expect(text).toMatch(/connect/);
          break;
        case "timeout":
          expect(text).toMatch(/timeout|timed out/i);
          if (entry.kind !== "connect") {
            expect(fake.failed.some((cmd) => text.includes(cmd)), `message must name the command: ${text}`).toBe(true);
          }
          break;
        case "writeFailure":
          expect(text).toMatch(/fail/i);
          if (entry.kind !== "connect") {
            expect(fake.failed.some((cmd) => text.includes(cmd)), `message must name the command: ${text}`).toBe(true);
          }
          break;
        case "garbage":
        case "empty":
          expect(fake.bad.length, "tool never queried anything").toBeGreaterThan(0);
          expect(fake.bad.some((cmd) => text.includes(cmd)), `message must name the command: ${text}`).toBe(true);
          if (mode === "garbage") expect(text).toContain("garbage ???");
          break;
        case "instrumentError":
          expect(text).toContain("-131");
          expect(text).toMatch(/applied/i);
          if (fake.sent.length > 0) {
            expect(fake.sent.some((cmd) => text.includes(cmd)), `message must name the command: ${text}`).toBe(true);
          }
          break;
      }
    });
  }
});

// ---------- concurrency (issue #66) ----------

describe("every tool is an exclusive instrument session", () => {
  it("registers tools only through defineTool (no server.tool()/registerTool() in src/tools)", () => {
    const dir = new URL("../../src/tools/", import.meta.url);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file === "util.ts") continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, `${file} must register tools with defineTool(server, ...) from ./util.js`).not.toMatch(
        /\bserver\s*\.\s*(tool|registerTool)\s*\(/
      );
    }
  });

  it("makes server.tool() and server.registerTool() throw on the real server, so a bypass fails at startup", () => {
    const server = createServer() as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(() => server.tool("x", {}, async () => ({ content: [] }))).toThrow(/defineTool/);
    expect(() => server.registerTool("x", {}, async () => ({ content: [] }))).toThrow(/defineTool/);
  });

  it("runs the instrument operations of every tool inside a session (see the afterEach check)", async () => {
    for (const [name, entry] of entries) {
      fake.reset();
      await callTool(client, name, entry.args);
      expect(fake.violations, name).toEqual([]);
    }
  });
});

describe("parallel mode", () => {
  const instrumentTools = entries.filter(([, e]) => e.kind !== "connect" && e.kind !== "disconnect" && e.kind !== "discover");

  /** Session ids in the order operations ran; a session id that comes back after another one means interleaving. */
  function expectContiguous(): number[] {
    const order: number[] = [];
    for (const id of fake.opSessions) if (order[order.length - 1] !== id) order.push(id);
    expect(new Set(order).size, `sessions interleaved: ${fake.ops.join(" | ")}`).toBe(order.length);
    expect(order).not.toContain(0);
    return order;
  }

  describe.each(entries)("%s", (name, entry) => {
    it("three parallel calls run one after another: each has exactly the single-call command sequence", async () => {
      fake.reset();
      const single = await callTool(client, name, entry.args);
      expect(single.isError, getText(single)).toBeFalsy();
      const baseline = [...fake.ops];

      fake.reset();
      fake.yieldOps = true;
      const results = await Promise.all([1, 2, 3].map(() => callTool(client, name, entry.args)));
      for (const r of results) expect(r.isError, getText(r)).toBeFalsy();
      const order = expectContiguous();
      expect(order).toHaveLength(baseline.length === 0 ? 0 : 3);
      for (const id of order) {
        expect(fake.ops.filter((_, i) => fake.opSessions[i] === id)).toEqual(baseline);
      }
    });
  });

  it("all tools at once: every call succeeds and no two tools' operations interleave", async () => {
    fake.reset();
    fake.yieldOps = true;
    const results = await Promise.all(instrumentTools.map(([name, e]) => callTool(client, name, e.args)));
    results.forEach((r, i) => expect(r.isError, `${instrumentTools[i][0]}: ${getText(r)}`).toBeFalsy());
    expectContiguous();
  });

  it("a failure is attributed to the call that owns the failing operation, and to no other", async () => {
    const tools = instrumentTools.filter(([name]) => name !== "wait_for_sweep_complete");
    fake.reset();
    fake.yieldOps = true;
    await Promise.all(tools.map(([name, e]) => callTool(client, name, e.args)));
    const total = fake.ops.length;
    for (const failAt of [0, 1, 5, Math.floor(total / 3), Math.floor(total / 2), total - 2, total - 1]) {
      fake.reset("partial", failAt);
      fake.yieldOps = true;
      const results = await Promise.all(tools.map(([name, e]) => callTool(client, name, e.args)));
      const owner = fake.sessionLabels.get(fake.opSessions[failAt]);
      const failed = tools.map(([name], i) => [name, results[i]] as const).filter(([, r]) => r.isError);
      expect(failed.map(([n]) => n), `failing operation #${failAt} (${fake.ops[failAt]}) belongs to ${owner}`).toEqual([owner]);
      expect(getText(failed[0][1])).toContain(fake.failed[0]);
      expectContiguous();
    }
  });
});

/** Tools that select an instrument with `instrument`; the connection tools use `name`, the listing tools take none (issue #165). */
const NAME_TOOLS = ["connect", "disconnect", "identify"];
const NO_INSTRUMENT_TOOLS = ["discover_instruments", "list_instruments"];

describe("instrument selection", () => {
  it("every instrument tool takes an optional `instrument` argument, the connection tools `name`, the listing tools neither", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      const required = (t.inputSchema as { required?: string[] }).required ?? [];
      expect(required, t.name).not.toContain("instrument");
      if (NO_INSTRUMENT_TOOLS.includes(t.name)) expect(props, t.name).not.toContain("instrument");
      else if (NAME_TOOLS.includes(t.name)) expect(props, t.name).toContain("name");
      else expect(props, t.name).toContain("instrument");
    }
  });

  // `connect` registers an unknown name instead of refusing it (covered in multi-connection-tools.test.ts).
  const selecting = entries.filter(([name]) => !NO_INSTRUMENT_TOOLS.includes(name) && name !== "connect");
  it.each(selecting)("%s: an unknown instrument is refused before anything is sent", async (name, entry) => {
    fake.reset();
    const arg = NAME_TOOLS.includes(name) ? "name" : "instrument";
    const res = await callTool(client, name, { ...entry.args, [arg]: "nope" });
    expect(expectCleanError(res, name)).toMatch(/Unknown instrument "nope"/);
    expect(fake.opCount, `${name} touched the instrument`).toBe(0);
    expect(fake.connectCalls).toBe(0);
  });

  it.each(selecting.filter(([name]) => !NAME_TOOLS.includes(name)))("%s: an invalid instrument name is refused before anything is sent", async (name, entry) => {
    fake.reset();
    const res = await callTool(client, name, { ...entry.args, instrument: "bad name!" });
    expectCleanError(res, name);
    expect(fake.opCount).toBe(0);
  });
});
