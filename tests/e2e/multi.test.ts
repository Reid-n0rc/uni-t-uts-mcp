import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeUts, type FakeUts } from "../fakeUts.js";

/**
 * Several analyzers over real stdio (issue #166): the BUILT server is started with UTS_INSTRUMENTS naming two fake
 * analyzers, connects both at startup, and drives them independently and in parallel through `instrument`.
 */
const SERVER = fileURLToPath(new URL("../../build/index.js", import.meta.url));
let a: FakeUts;
let b: FakeUts;
let client: Client;
const stderr: string[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  let json: any;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { isError: res.isError === true, text, json };
};

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("build/index.js is missing: run `npm run build` before the end to end tests");
  a = await startFakeUts({ tgSweepScale: 0.05 });
  b = await startFakeUts({ tgSweepScale: 0.05 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("UTS_")) env[k] = v;
  env.UTS_INSTRUMENTS = `sa1=127.0.0.1:${a.port},sa2=127.0.0.1:${b.port}`;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  client = new Client({ name: "e2e-multi", version: "0.0.0" });
  await client.connect(transport);
  // Startup auto-connect runs in the background: wait until both are connected.
  for (let i = 0; i < 100; i++) {
    const list = (await call("list_instruments")).json?.instruments as Array<{ connected: boolean }> | undefined;
    if (list?.length === 2 && list.every((x) => x.connected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`instruments did not connect at startup: ${stderr.join("")}`);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await a?.close();
  await b?.close();
});

describe("stdio end to end with two fake analyzers (UTS_INSTRUMENTS)", () => {
  it("list_instruments shows both, connected, and no default", async () => {
    const r = await call("list_instruments");
    expect(r.json.instruments.map((i: { name: string; isDefault: boolean }) => [i.name, i.isDefault])).toEqual([["sa1", false], ["sa2", false]]);
    expect(r.text).not.toMatch(/\d{6,}/); // no serial number
  });

  it("parallel setters on different instruments each land on their own analyzer", async () => {
    const results = await Promise.all([
      call("set_frequency", { center_hz: 111e6, instrument: "sa1" }),
      call("set_frequency", { center_hz: 222e6, instrument: "sa2" }),
      call("set_amplitude", { reference_level: -5, instrument: "sa1" }),
      call("set_amplitude", { reference_level: -15, instrument: "sa2" }),
    ]);
    results.forEach((r) => expect(r.isError, r.text).toBe(false));
    expect(a.model.num("fc")).toBe(111e6);
    expect(b.model.num("fc")).toBe(222e6);
    expect((await call("get_amplitude", { instrument: "sa1" })).json.reference_level).toBe(-5);
    expect((await call("get_amplitude", { instrument: "sa2" })).json.reference_level).toBe(-15);
  });

  it("a call without `instrument` asks for a name when none is `default`", async () => {
    const r = await call("get_frequency");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("sa1, sa2");
  });

  it("disconnecting sa1 leaves sa2 working", async () => {
    expect((await call("disconnect", { name: "sa1" })).isError).toBe(false);
    expect((await call("get_frequency", { instrument: "sa1" })).isError).toBe(true);
    expect((await call("get_frequency", { instrument: "sa2" })).json.center_hz).toBe(222e6);
  });

  it("the server printed no uncaught exception", () => {
    expect(stderr.join("")).not.toMatch(/Uncaught exception|Unhandled rejection/);
  });
});
