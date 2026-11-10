import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { buildSite } from "../../scripts/build-site.mjs";
import { renderHtml, registeredToolCount, TARGETS } from "../../scripts/build-og-image.mjs";

const BASE = "https://reid-n0rc.github.io/uni-t-uts-mcp/";
const html = readFileSync("site/index.html", "utf8");
const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

/** Content of <meta name|property="key" content="..."> (attribute order as written in the template). */
function meta(key: string): string | undefined {
  for (const tag of head.match(/<meta [^>]*>/g) ?? []) {
    for (const attr of ["name", "property"]) {
      const prefix = `${attr}="${key}" content="`;
      const at = tag.indexOf(prefix);
      if (at >= 0) return tag.slice(at + prefix.length, tag.indexOf('"', at + prefix.length));
    }
  }
  return undefined;
}

function pngSize(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(b.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

describe("social preview meta tags (issue #111)", () => {
  it("has every required tag", () => {
    for (const k of ["description", "theme-color", "og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "og:image:width", "og:image:height", "og:image:alt", "twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"]) {
      expect(meta(k), k).toBeTruthy();
    }
    expect(meta("og:type")).toBe("website");
    expect(meta("twitter:card")).toBe("summary_large_image");
  });

  it("uses absolute https URLs under the site base", () => {
    expect(meta("og:url")).toBe(BASE);
    expect(meta("og:image")).toBe(`${BASE}og.png`);
    expect(meta("twitter:image")).toBe(`${BASE}og.png`);
    expect(head).toContain(`<link rel="canonical" href="${BASE}">`);
  });

  it("keeps title and description a sensible length and alt texts short but present", () => {
    expect(meta("og:title")!.length).toBeLessThan(60);
    expect(meta("twitter:title")!.length).toBeLessThan(60);
    expect(meta("description")!.length).toBeLessThan(160);
    expect(meta("og:description")!.length).toBeLessThan(160);
    expect(meta("twitter:description")!.length).toBeLessThan(160);
    for (const k of ["og:image:alt", "twitter:image:alt"]) {
      expect(meta(k)!.length).toBeGreaterThan(20);
      expect(meta(k)!.length).toBeLessThan(420);
    }
  });

  it("adds no http:// URL and no external request to the head", () => {
    const withoutSvgNamespace = head.split("http://www.w3.org/2000/svg").join("");
    expect(withoutSvgNamespace).not.toContain("http://");
    for (const tag of head.match(/<(link|script|img)\b[^>]*>/g) ?? []) {
      const url = tag.includes('href="') ? tag.split('href="')[1] : tag.includes('src="') ? tag.split('src="')[1] : "";
      if (tag.includes('rel="canonical"')) continue;
      expect(url.startsWith("https://") || url.startsWith("http://"), tag).toBe(false);
    }
  });
});

describe("social preview images", () => {
  it("are real PNGs of the right size and under the size limit", () => {
    expect(TARGETS.map((t) => t.file)).toEqual(["site/og.png", "site/social-preview.png"]);
    const og = pngSize("site/og.png");
    expect([og.width, og.height]).toEqual([1200, 630]);
    expect(og.bytes).toBeLessThan(400 * 1024);
    const sp = pngSize("site/social-preview.png");
    expect([sp.width, sp.height]).toEqual([1280, 640]);
    expect(sp.bytes).toBeLessThan(400 * 1024);
  });

  it("match the width and height tags", () => {
    const og = pngSize("site/og.png");
    expect(meta("og:image:width")).toBe(String(og.width));
    expect(meta("og:image:height")).toBe(String(og.height));
  });

  it("ship in the built site, without the render source", () => {
    const out = mkdtempSync(join(tmpdir(), "site-og-"));
    try {
      buildSite({ outDir: out });
      expect(existsSync(join(out, "og.png"))).toBe(true);
      expect(statSync(join(out, "og.png")).size).toBeGreaterThan(1000);
      expect(existsSync(join(out, "og"))).toBe(false);
      expect(existsSync(join(out, "index.html"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("social preview source", () => {
  const source = readFileSync("site/og/og.html", "utf8");

  it("takes the tool count from a placeholder, not a hard-coded number", () => {
    expect(source).toContain("{{TOOLS}} tools");
    const rendered = renderHtml(source, 31, 1280, 640);
    expect(rendered).toContain("31 tools");
    expect(rendered).not.toContain("{{TOOLS}}");
    expect(rendered).toContain("--w: 1280px; --h: 640px;");
  });

  it("is self-contained: no external URLs, fonts or images", () => {
    expect(source.split("http://www.w3.org/2000/svg").join("")).not.toContain("http");
    expect(source).not.toContain("@import");
    expect(source).not.toContain("<img");
    expect(source).not.toContain("url(\"");
  });

  it("states the headline, the name and the chips", () => {
    for (const text of ["UNI-T UTS MCP", "Talk to your", "analyzer.", "SCPI over LAN", "MIT"]) expect(source).toContain(text);
  });

  it("reads the tool count from the registered tools", async () => {
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    const { tools } = await client.listTools();
    await client.close();
    expect(await registeredToolCount()).toBe(tools.length);
  });
});
