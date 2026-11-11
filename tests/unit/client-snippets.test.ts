import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildClients, sync, renderReadmeTable, renderSiteSection, renderWiki, PLACEHOLDER_HOST, BEGIN, END, replaceRegion } from "../../scripts/client-snippets.mjs";

const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const V = (JSON.parse(read("package.json")) as { version: string }).version;
const clients = buildClients(V);
const EXPECTED = ["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "generic"];

describe("client snippets (single source of truth)", () => {
  it("covers every supported client", () => {
    expect(clients.map((c) => c.id)).toEqual(EXPECTED);
    for (const c of clients) {
      expect(c.docs).toMatch(/^https:\/\//);
      expect(c.verified.length).toBeGreaterThan(20);
      expect(c.snippets.length).toBeGreaterThan(0);
    }
  });

  it("every JSON snippet parses, launches this server, and has no private data", () => {
    let n = 0;
    for (const c of clients) {
      for (const s of c.snippets) {
        if (s.lang !== "json") continue;
        n++;
        const parsed = JSON.parse(s.text) as Record<string, Record<string, { command: string; args: string[] }>>;
        const entry = (parsed.mcpServers ?? parsed.servers)["uni-t-uts"];
        expect(["npx", "cmd", "docker"]).toContain(entry.command);
        expect(entry.args.join(" ")).toMatch(/uni-t-uts-mcp/);
      }
    }
    expect(n).toBeGreaterThanOrEqual(10);
    const all = JSON.stringify(clients);
    expect(all).not.toMatch(/\b(?!192\.168\.1\.100\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(all).toContain(PLACEHOLDER_HOST);
    expect(all).not.toMatch(/@malmoset|serial|token|password|secret/i);
  });

  it("the VS Code snippet uses the documented servers key with type stdio", () => {
    const vs = clients.find((c) => c.id === "vscode")!;
    const parsed = JSON.parse(vs.snippets[0].text) as { servers: Record<string, { type: string }> };
    expect(parsed.servers["uni-t-uts"].type).toBe("stdio");
  });

  it("the Cursor link follows the documented install-link format and decodes to the server config", () => {
    const cursor = clients.find((c) => c.id === "cursor")!;
    const url = new URL(cursor.link!.href);
    expect(url.protocol).toBe("cursor:");
    expect(url.host).toBe("anysphere.cursor-deeplink");
    expect(url.pathname).toBe("/mcp/install");
    expect(url.searchParams.get("name")).toBe("uni-t-uts");
    const cfg = JSON.parse(Buffer.from(url.searchParams.get("config")!, "base64").toString("utf8")) as { command: string; args: string[]; env?: unknown };
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toEqual(["-y", "uni-t-uts-mcp"]);
    expect(cfg.env).toBeUndefined();
  });

  it("every link is a well-formed URL and nothing claims the .mcpb install is verified", () => {
    for (const c of clients) {
      if (c.link) expect(() => new URL(c.link!.href)).not.toThrow();
    }
    const desktop = clients.find((c) => c.id === "claude-desktop")!;
    expect(desktop.verified).toMatch(/NOT verified/);
  });

  it("README, wiki page and site are in sync with the generator", () => {
    expect(sync({ root })).toEqual([]);
  });

  it("the site section lists every client; the wiki page and sidebar exist; README has the table", () => {
    const site = read("site/index.html");
    for (const c of clients) {
      expect(site).toContain(`id="panel-${c.id}"`);
      expect(site).toContain(`data-client="${c.id}"`);
    }
    expect(site).toContain('id="add-to-client"');
    expect(read("docs/wiki/_Sidebar.md")).toContain("[Add to Client](Add-to-Client)");
    const readme = read("README.md");
    for (const c of clients) expect(readme).toContain(`| ${c.name} |`);
    expect(site).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/i);
  });

  it("rendering is deterministic and the marker replacement fails closed", () => {
    expect(renderReadmeTable(clients)).toBe(renderReadmeTable(buildClients(V)));
    expect(renderWiki(clients)).toContain("### Cursor");
    expect(renderSiteSection(clients)).toContain("role=\"tablist\"");
    expect(() => replaceRegion("no markers", "x")).toThrow(/markers/);
    expect(replaceRegion(`a${BEGIN}old${END}b`, "new")).toBe(`a${BEGIN}\nnew\n${END}b`);
  });
});
