import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

/** Tool names from `### \`a\` / \`b\`` style headings (several tools may share one section). */
function documentedTools(doc: string): string[] {
  const names: string[] = [];
  for (const line of doc.split("\n")) {
    if (!/^###\s/.test(line)) continue;
    for (const m of line.matchAll(/`([a-z0-9_]+)`/g)) names.push(m[1]);
  }
  return names;
}

/**
 * Documentation is part of done: every registered tool must have a `### \`tool_name\`` heading
 * in docs/tools-reference.md. If this fails, add the missing section(s) describing the tool's
 * parameters and behavior to that file in the same PR that adds or renames the tool.
 */
describe("docs/tools-reference.md covers every registered tool", () => {
  it("has a heading for each tool", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "docs-coverage", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();

    const doc = readFileSync(new URL("../../docs/tools-reference.md", import.meta.url), "utf8");
    const documented = new Set(documentedTools(doc));
    const missing = tools.map((t) => t.name).filter((name) => !documented.has(name));

    expect(
      missing,
      `Add a "### \`name\`" section to docs/tools-reference.md for: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("does not document tools that no longer exist", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "docs-coverage", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();

    const doc = readFileSync(new URL("../../docs/tools-reference.md", import.meta.url), "utf8");
    const documented = documentedTools(doc);
    const registered = new Set(tools.map((t) => t.name));
    const stale = documented.filter((name) => !registered.has(name));
    expect(stale, `Remove or rename stale sections in docs/tools-reference.md: ${stale.join(", ")}`).toEqual([]);
  });
});
