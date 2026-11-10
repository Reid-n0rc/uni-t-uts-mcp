import { describe, it, expect } from "vitest";
import { checkPackFiles } from "../../scripts/check-pack.mjs";
import { smokeTest } from "../../scripts/smoke-mcp.mjs";

describe("checkPackFiles (npm tarball allowlist)", () => {
  const good = [
    "LICENSE",
    "README.md",
    "package.json",
    "build/index.js",
    "build/index.d.ts",
    "build/tools/trace.js",
    "build/transports/raw.d.ts",
  ];

  it("accepts build js/d.ts plus README, LICENSE and package.json", () => {
    expect(checkPackFiles(good)).toEqual([]);
  });

  it("requires the entry point and the bin target", () => {
    expect(checkPackFiles(["LICENSE", "README.md", "package.json"]).join("\n")).toMatch(/build\/index\.js/);
  });

  it("requires README, LICENSE and package.json", () => {
    const problems = checkPackFiles(good.filter((f) => f !== "LICENSE"));
    expect(problems.join("\n")).toMatch(/LICENSE/);
  });

  it.each([
    "tests/unit/scpi.test.ts",
    "docs/tools-reference.md",
    "scripts/build-site.mjs",
    "src/index.ts",
    "node_modules/zod/index.js",
    "build/index.js.map",
    "build/index.d.ts.map",
    ".github/workflows/ci.yml",
    "Dockerfile",
    ".mcp.json",
    "build/notes.txt",
    "build/../evil.js",
  ])("rejects unexpected file %s", (bad) => {
    const problems = checkPackFiles([...good, bad]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(bad);
  });
});

const fakeServer = (name: string, tools: number) =>
  `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(name)}, version: "1" } } }));
  if (m.method === "tools/list") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: Array.from({ length: ${tools} }, (_, i) => ({ name: "t" + i, inputSchema: { type: "object" } })) } }));
});`;

describe("smokeTest (stdio MCP initialize + tools/list)", () => {
  it("passes when name and tool count match", async () => {
    const r = await smokeTest({ command: process.execPath, args: ["-e", fakeServer("uni-t-uts-mcp", 3)], expectedTools: 3, timeoutMs: 10000 });
    expect(r).toMatchObject({ serverName: "uni-t-uts-mcp", toolCount: 3 });
  });

  it("fails on the wrong server name", async () => {
    await expect(
      smokeTest({ command: process.execPath, args: ["-e", fakeServer("other", 3)], expectedTools: 3, timeoutMs: 10000 })
    ).rejects.toThrow(/server name/);
  });

  it("fails on the wrong tool count", async () => {
    await expect(
      smokeTest({ command: process.execPath, args: ["-e", fakeServer("uni-t-uts-mcp", 2)], expectedTools: 3, timeoutMs: 10000 })
    ).rejects.toThrow(/tool count/);
  });

  it("fails when the server never answers", async () => {
    await expect(
      smokeTest({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], expectedTools: 1, timeoutMs: 1500 })
    ).rejects.toThrow(/timed out/);
  });

  it("fails when the process exits early", async () => {
    await expect(
      smokeTest({ command: process.execPath, args: ["-e", "process.exit(3)"], expectedTools: 1, timeoutMs: 5000 })
    ).rejects.toThrow(/exited/);
  });
});
