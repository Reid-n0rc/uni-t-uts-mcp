import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { parseToolsReference, renderToolGroups, renderSite } from "../../scripts/site-tools.mjs";
import { buildSite } from "../../scripts/build-site.mjs";

const SAMPLE = `# Tools Reference

Intro text that belongs to no group.

## Connection

Group intro.

### \`connect\`

Connect to a UNI-T UTS analyzer over **raw SCPI/TCP**. Verifies the link with \`*IDN?\` and returns the identification string.

| Parameter | Type |
|-----------|------|
| \`host\` | string |

### \`get_a\` / \`set_a\`

Read or set [the thing](https://example.com) in Hz.
Second line of the same paragraph.

Another paragraph that is ignored.

## Environment variables

| Variable | Description |
|----------|-------------|
| \`UTS_IP\` | host |
`;

describe("parseToolsReference", () => {
  const groups = parseToolsReference(SAMPLE);

  it("returns only groups that contain tools, in order", () => {
    expect(groups.map((g) => g.name)).toEqual(["Connection"]);
  });

  it("reads every tool name from a heading, including combined headings", () => {
    expect(groups[0].tools.map((t) => t.name)).toEqual(["connect", "get_a", "set_a"]);
  });

  it("uses the first sentence of the first paragraph as a plain-text summary", () => {
    expect(groups[0].tools[0].summary).toBe("Connect to a UNI-T UTS analyzer over raw SCPI/TCP.");
    expect(groups[0].tools[1].summary).toBe("Read or set the thing in Hz.");
    expect(groups[0].tools[2].summary).toBe(groups[0].tools[1].summary);
  });

  it("truncates very long summaries", () => {
    const md = `## G\n\n### \`t\`\n\n${"word ".repeat(100)}\n`;
    const [{ tools }] = parseToolsReference(md);
    expect(tools[0].summary.length).toBeLessThanOrEqual(200);
  });

  it("copes with a tool that has no description", () => {
    const [{ tools }] = parseToolsReference("## G\n\n### `t`\n\n## H\n");
    expect(tools[0]).toEqual({ name: "t", summary: "" });
  });
});

describe("real docs/tools-reference.md", () => {
  it("yields exactly the tools the server registers", async () => {
    const markdown = readFileSync(new URL("../../docs/tools-reference.md", import.meta.url), "utf8");
    const fromDocs = parseToolsReference(markdown).flatMap((g) => g.tools.map((t) => t.name)).sort();

    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "site-test", version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    await client.close();

    expect(fromDocs).toEqual(tools.map((t) => t.name).sort());
  });

  it("gives every tool a non-empty summary", () => {
    const markdown = readFileSync(new URL("../../docs/tools-reference.md", import.meta.url), "utf8");
    const empty = parseToolsReference(markdown)
      .flatMap((g) => g.tools)
      .filter((t) => t.summary.length === 0)
      .map((t) => t.name);
    expect(empty, `Add a description paragraph under these tools' headings: ${empty.join(", ")}`).toEqual([]);
  });
});

describe("renderToolGroups / renderSite", () => {
  const groups = [{ name: "A & B", tools: [{ name: "t_1", summary: "<script>alert(1)</script> & more" }] }];

  it("HTML-escapes everything it prints", () => {
    const html = renderToolGroups(groups);
    expect(html).not.toContain("<script>");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<code>t_1</code>");
  });

  it("replaces the placeholders and leaves none behind", () => {
    const page = renderSite("<p>{{TOOL_COUNT}} tools in {{GROUP_COUNT}} groups</p><!--TOOLS-->", groups);
    expect(page).toContain("1 tools in 1 groups");
    expect(page).not.toContain("<!--TOOLS-->");
    expect(page).not.toContain("{{");
  });

  it("fails loudly when the template has no tools placeholder", () => {
    expect(() => renderSite("<p>nothing</p>", groups)).toThrow(/TOOLS/);
  });
});

describe("site/index.html template", () => {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");

  it("has the generated placeholders", () => {
    expect(html).toContain("<!--TOOLS-->");
    expect(html).toContain("{{TOOL_COUNT}}");
  });

  it("is self-contained: no external scripts, stylesheets, fonts, images or imports", () => {
    expect(html).not.toMatch(/<script[^>]+\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']?https?:/i);
    expect(html).not.toMatch(/<img[^>]+src=["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("is accessible and responsive at a basic level", () => {
    expect(html).toMatch(/<html[^>]+lang="en"/);
    expect(html).toMatch(/<meta[^>]+name="viewport"/);
    expect(html).toMatch(/<title>[^<]{5,}<\/title>/);
    expect(html).toMatch(/prefers-reduced-motion/);
    expect(html).toMatch(/class="skip-link"/);
    expect(html).toMatch(/<main[\s>]/);
  });

  it("states the unaffiliated trademark note and never leaks a serial number or private IP", () => {
    expect(html).toMatch(/not affiliated/i);
    expect(html).not.toMatch(/ASA\d{6,}/);
    expect(html).not.toMatch(/\b10\.26\.\d+\.\d+\b/);
  });
});

describe("buildSite", () => {
  it("writes a complete page and .nojekyll into the output directory", () => {
    const out = mkdtempSync(join(tmpdir(), "uts-site-"));
    try {
      const result = buildSite({ outDir: out });
      expect(result.toolCount).toBeGreaterThan(10);
      expect(existsSync(join(out, ".nojekyll"))).toBe(true);
      const page = readFileSync(join(out, "index.html"), "utf8");
      expect(page).toContain("<code>set_frequency</code>");
      expect(page).not.toContain("{{");
      expect(page).not.toContain("<!--TOOLS-->");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("summary quality", () => {
  it("merges a very short first sentence with the next one", () => {
    const [{ tools }] = parseToolsReference("## G\n\n### `t`\n\nRead-only. Returns JSON with the frequency settings.\n");
    expect(tools[0].summary).toBe("Read-only. Returns JSON with the frequency settings.");
  });

  it("cuts a long sentence at a clause boundary instead of mid-phrase", () => {
    const long = "Frequency parameters are coupled, so choose one group per call; the settings are re-read afterwards and anything the instrument changed is listed in warnings including the step and the offset values.";
    const [{ tools }] = parseToolsReference(`## G\n\n### \`t\`\n\n${long}\n`);
    expect(tools[0].summary).toBe("Frequency parameters are coupled, so choose one group per call.");
  });
});

describe("renderToolGroups details", () => {
  it("prefers supplied tool descriptions (first sentence) over the docs summary", () => {
    const groups = [{ name: "G", tools: [{ name: "t_1", summary: "Docs summary." }] }];
    const html = renderToolGroups(groups, { t_1: "Get the thing, in Hz. More detail follows." });
    expect(html).toContain("Get the thing, in Hz.");
    expect(html).not.toContain("More detail");
    expect(html).not.toContain("Docs summary.");
  });

  it("shows paired tools that share one summary as a single row", () => {
    const groups = [{ name: "G", tools: [
      { name: "get_a", summary: "Read or set a." },
      { name: "set_a", summary: "Read or set a." },
      { name: "other", summary: "Something else." },
    ] }];
    const html = renderToolGroups(groups);
    expect(html).toContain("<code>get_a</code> <code>set_a</code>");
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("omits the decorative file name when the group name is long", () => {
    const groups = [{ name: "Bandwidth, sweep and detector", tools: [{ name: "t", summary: "x." }] }];
    expect(renderToolGroups(groups)).not.toContain(".exe");
    expect(renderToolGroups([{ name: "Frequency", tools: [{ name: "t", summary: "x." }] }])).toContain("frequency.exe");
  });

  it("buildSite uses descriptions when given", () => {
    const out = mkdtempSync(join(tmpdir(), "uts-site-"));
    try {
      buildSite({ outDir: out, descriptions: { set_frequency: "A custom one-line description." } });
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain("A custom one-line description.");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
