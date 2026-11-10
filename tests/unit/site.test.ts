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

// The one allowed link to the outside: the canonical URL of the site itself (a hint for search engines, not a request).
const CANONICAL = '<link rel="canonical" href="https://reid-n0rc.github.io/uni-t-uts-mcp/">';

describe("site/index.html template", () => {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");

  it("has the generated placeholders", () => {
    expect(html).toContain("<!--TOOLS-->");
    expect(html).toContain("{{TOOL_COUNT}}");
  });

  it("is self-contained: no external scripts, stylesheets, fonts, images or imports", () => {
    expect(html).toContain(CANONICAL);
    expect(html).not.toMatch(/<script[^>]+\ssrc=/i);
    expect(html.split(CANONICAL).join("")).not.toMatch(/<link[^>]+href=["']?https?:/i);
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

describe("site/index.html hardware section (issue #82)", () => {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const section = /<section[^>]*id="real-hardware"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const cards = section.match(/<article[\s\S]*?<\/article>/g) ?? [];

  it("has a benefit-first heading and a nav link that points at the section", () => {
    expect(section).not.toBe("");
    expect(section).toMatch(/<h2[^>]*>\s*Built for[\s\S]*real hardware/i);
    expect(html).toContain('<a href="#real-hardware">Built for hardware</a>');
    expect(html).not.toContain("field-notes");
    expect(html).not.toMatch(/Field notes/i);
  });

  it("every in-page link has a matching id", () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const missing = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((a) => !ids.has(a));
    expect(missing).toEqual([]);
  });

  it("the lead names the tested hardware and firmware and the generated tool count", () => {
    const lead = /<p class="sub[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(section)?.[1] ?? "";
    expect(lead).toContain("{{TOOL_COUNT}}");
    expect(lead).toContain("UTS3036B");
    expect(lead).toContain("V1.04.0040");
  });

  it("has five cards, each with a benefit heading and a muted why line", () => {
    expect(cards).toHaveLength(5);
    for (const c of cards) {
      expect(c).toMatch(/<h3>[^<]{8,}<\/h3>/);
      expect(c).toMatch(/<p class="why">[^<]/);
    }
    // the benefit comes first, the instrument behavior second
    for (const c of cards.slice(0, 4)) expect(c.indexOf("<h3>")).toBeLessThan(c.indexOf('class="why"'));
  });

  it("no longer leads with the instrument's problems", () => {
    for (const old of [
      "It ignores commands during a sweep",
      "Settings clamp silently",
      "Bad queries leave a mess",
      "Bursts get mis-parsed",
      "No service requests here",
      "Field notes",
    ]) {
      expect(html).not.toContain(old);
    }
  });

  it("keeps the honest facts and the link to the hardware notes", () => {
    expect(section).toMatch(/ignores commands/i);
    expect(section).toMatch(/limits|clamp/i);
    expect(section).toContain("verified-hardware.md");
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

describe("site soundtrack (issue #91)", () => {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../site/soundtrack.cjs", import.meta.url), "utf8");
  const built = (() => {
    const out = mkdtempSync(join(tmpdir(), "uts-site-"));
    try {
      buildSite({ outDir: out });
      return { page: readFileSync(join(out, "index.html"), "utf8"), copied: existsSync(join(out, "soundtrack.cjs")) };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  })();
  const body = html.slice(html.indexOf("<body"));

  it("has a real button with aria-pressed and a clear label, first in the tab order", () => {
    const button = /<button[^>]*id="sound-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toMatch(/aria-pressed="(true|false)"/);
    expect(button).toMatch(/aria-label="[^"]*[Ss]oundtrack/);
    const focusable = [...body.matchAll(/<(a|button|input|select|textarea|summary)\b[^>]*>|\stabindex="[^"]*"/g)];
    expect(focusable[0][0]).toContain('id="sound-toggle"');
    expect(html).not.toMatch(/tabindex="[1-9]/);
    // and it comes before the skip link
    expect(body.indexOf('id="sound-toggle"')).toBeLessThan(body.indexOf('class="skip-link"'));
  });

  it("has a polite status prompt that says to tap anywhere", () => {
    expect(html).toMatch(/id="sound-prompt"[^>]*role="status"/);
    expect(html.toLowerCase()).toContain("tap anywhere to start the soundtrack");
  });

  it("uses no media elements, audio files or external requests", () => {
    for (const page of [html.split(CANONICAL).join(""), built.page.split(CANONICAL).join(""), source]) {
      expect(page).not.toMatch(/<(audio|video|source|track|embed|object|iframe)\b/i);
      expect(page).not.toMatch(/\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm|mp4)\b/i);
      expect(page).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|new\s+Audio\s*\(|importScripts|sendBeacon/);
      expect(page).not.toMatch(/\b(src|href|srcset)=["']?(https?:)?\/\/(?!github\.com\/Reid-n0rc)/i);
    }
  });

  it("is inlined into the single built page and not copied as a separate file", () => {
    expect(html).toContain("<!--SOUNDTRACK_JS-->");
    expect(source).not.toMatch(/<\/script|<!--/i);
    expect(built.page).not.toContain("<!--SOUNDTRACK_JS-->");
    expect(built.page).toContain("createEngine");
    expect(built.page).not.toMatch(/<script[^>]+\ssrc=/i);
    expect(built.copied).toBe(false);
  });

  it("the hero trace reads the analyser only while the soundtrack plays", () => {
    expect(html).toMatch(/Soundtrack\.[\s\S]*getSpectrum|\.getSpectrum\(/);
  });

  it("credits the generated music and says how to mute, in the footer", () => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "";
    expect(footer).toMatch(/generated live in your browser/i);
    expect(footer).toMatch(/mute/i);
    expect(footer).toMatch(/first click, tap or key press/i);
  });
});

describe("site hero marker readout (issue #106)", () => {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../site/hero-marker.cjs", import.meta.url), "utf8");
  const built = (() => {
    const out = mkdtempSync(join(tmpdir(), "uts-site-"));
    try {
      buildSite({ outDir: out });
      return { page: readFileSync(join(out, "index.html"), "utf8"), copied: existsSync(join(out, "hero-marker.cjs")) };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  })();
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  const rule = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(",").some((s) => s.trim().endsWith(selector))).map((m) => m[2]);

  it("no longer pins the readout to a corner of the hero", () => {
    for (const body of rule(".marker-win")) {
      expect(body).not.toMatch(/bottom\s*:\s*calc\(\s*30%/);
      expect(body).not.toMatch(/\bright\s*:/);
    }
    expect(css).not.toMatch(/\.marker-win\s*\{[^}]*bottom:\s*calc\(30%/);
  });

  it("keeps the readout, its ids and its label, and it is not a live region", () => {
    expect(html).toMatch(/class="win marker-win"[^>]*aria-label="[^"]+"/);
    expect(html).toContain('id="mk-f"');
    expect(html).toContain('id="mk-a"');
    expect(html).toContain("Illustrative signal");
    expect(html).not.toMatch(/aria-live/i);
    const group = /<div class="win marker-win"[^>]*>/.exec(html)?.[0] ?? "";
    expect(group).not.toMatch(/role="(status|alert|log)"/);
  });

  it("draws the flag, guide and leader in a hidden overlay", () => {
    const overlay = /<svg[^>]*id="mk-overlay"[^>]*>/.exec(html)?.[0] ?? "";
    expect(overlay).toContain('aria-hidden="true"');
    expect(html).toContain("<!--HERO_MARKER_JS-->");
  });

  it("the pure unit is inlined into the single built page and not shipped separately", () => {
    expect(source).not.toMatch(/<\/script|<!--/i);
    expect(built.page).not.toContain("<!--HERO_MARKER_JS-->");
    expect(built.page).toContain("placeCallout");
    expect(built.copied).toBe(false);
  });

  it("has a phone layout and a reduced-motion path, and makes no external requests", () => {
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*marker-win/);
    expect(html).toMatch(/HeroMarker\.[\s\S]*placeCallout|placeCallout/);
    for (const page of [html, built.page, source]) {
      expect(page).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
    }
    expect(source).not.toMatch(/new RegExp|RegExp\(/);
  });
});
