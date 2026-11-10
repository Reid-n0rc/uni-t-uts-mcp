import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "../../src/server.js";
import { callTool, getText, type ToolResult } from "../helpers.js";
import { APPLICABLE, CONTRACT, fake, type ContractEntry, type Mode } from "../toolContract.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../../src/connection.js", async () => ({ connection: (await import("../toolContract.js")).fakeConnection }));

/**
 * Error handling standard (AGENTS.md): for every registered tool, under every failure mode that applies
 * to it, the result is an isError result with a useful message, nothing is thrown, and nothing is sent
 * for invalid input. Tools missing from tests/toolContract.ts fail here.
 */

let client: Client;
let cleanup: () => Promise<void>;
let toolNames: string[] = [];

beforeAll(async () => {
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
beforeEach(() => fake.reset());

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
