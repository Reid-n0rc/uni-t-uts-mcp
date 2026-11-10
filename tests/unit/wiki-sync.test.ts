import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import {
  buildWikiPages,
  checkPages,
  findPrivateData,
  loadSources,
  parseIssues,
  slugify,
  writePages,
  type WikiIssue,
  type WikiSources,
} from "../../scripts/sync-wiki.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const sample: WikiSources = {
  toolsReference:
    "# Tools Reference\n\nSee [hardware](verified-hardware.md) and [guide](programming-guide.md#sec).\n\n" +
    "## Alpha group\n\n### `get_a` / `set_a`\n\nRead or set A. More text.\n\n## Beta\n\n### `do_b`\n\nDo B.\n",
  verifiedHardware:
    "# Verified hardware\n\nSee [guide](programming-guide.md) and [fixture](../tests/fixtures/x.txt).\n\n## Section One\n\nText.\n",
  version: "1.2.3",
  wiki: {
    Home: "# Home\n\nVersion <!--VERSION-->, <!--TOOL_COUNT--> tools in <!--GROUP_COUNT--> groups.\n\n<!--TOOL_GROUPS-->\n\n[Tools](Tools)\n",
    Roadmap: "# Roadmap\n\n<!--ISSUES-->\n",
    "Getting-Started": "# Getting Started\n\nBack to [Home](Home).\n",
    _Sidebar: "- [Home](Home)\n- [Getting Started](Getting-Started)\n- [Tools](Tools)\n- [Instrument Behavior](Instrument-Behavior)\n- [Roadmap](Roadmap)\n",
    _Footer: "Footer text.\n",
  },
};

const issues: WikiIssue[] = [
  { number: 20, title: "Later thing", state: "open", labels: ["needs-hardware"] },
  { number: 3, title: "First thing", state: "closed", labels: [] },
  { number: 10, title: "Open early", state: "open", labels: [] },
];

describe("buildWikiPages", () => {
  it("produces every page: generated ones plus the hand-written ones, as .md files", () => {
    const pages = buildWikiPages(sample, { issues });
    expect(Object.keys(pages).sort()).toEqual(
      ["Getting-Started.md", "Home.md", "Instrument-Behavior.md", "Roadmap.md", "Tools.md", "_Footer.md", "_Sidebar.md"].sort()
    );
  });

  it("Tools comes from the tools reference with links rewritten for the wiki", () => {
    const tools = buildWikiPages(sample, { issues })["Tools.md"];
    expect(tools).toContain("## Alpha group");
    expect(tools).toContain("### `get_a` / `set_a`");
    expect(tools).toContain("](Instrument-Behavior)");
    expect(tools).toContain("](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/programming-guide.md#sec)");
    expect(tools).not.toContain("](verified-hardware.md)");
    expect(tools).toMatch(/generated/i);
    expect(tools).toContain("docs/tools-reference.md");
  });

  it("Instrument Behavior comes from verified-hardware.md with repo-relative links made absolute", () => {
    const page = buildWikiPages(sample, { issues })["Instrument-Behavior.md"];
    expect(page).toContain("## Section One");
    expect(page).toContain("](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/programming-guide.md)");
    expect(page).toContain("](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/tests/fixtures/x.txt)");
    expect(page).toContain("docs/verified-hardware.md");
  });

  it("Home shows the package version, tool and group counts and a table of tools per group", () => {
    const home = buildWikiPages(sample, { issues })["Home.md"];
    expect(home).toContain("Version 1.2.3, 3 tools in 2 groups.");
    expect(home).toContain("| Alpha group | `get_a`, `set_a` |");
    expect(home).toContain("| Beta | `do_b` |");
    expect(home).not.toContain("<!--");
  });

  it("Roadmap lists open and closed issues sorted by number with labels", () => {
    const roadmap = buildWikiPages(sample, { issues })["Roadmap.md"];
    const open = roadmap.indexOf("#10");
    expect(open).toBeGreaterThan(-1);
    expect(roadmap.indexOf("#20")).toBeGreaterThan(open);
    expect(roadmap).toContain("[#3](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/3) First thing");
    expect(roadmap).toContain("_(needs-hardware)_");
    expect(roadmap.indexOf("Open issues")).toBeLessThan(roadmap.indexOf("Completed issues"));
    expect(roadmap).not.toContain("<!--");
  });

  it("Roadmap without issue data (no token) is a deterministic fallback that links to the issues", () => {
    const a = buildWikiPages(sample, { issues: null })["Roadmap.md"];
    const b = buildWikiPages(sample)["Roadmap.md"];
    expect(a).toBe(b);
    expect(a).toContain("https://github.com/Reid-n0rc/uni-t-uts-mcp/issues");
    expect(a).not.toContain("<!--");
  });

  it("is deterministic and fails loudly when a template placeholder is missing", () => {
    expect(buildWikiPages(sample, { issues })).toEqual(buildWikiPages(sample, { issues }));
    const broken = { ...sample, wiki: { ...sample.wiki, Home: "# Home\n" } };
    expect(() => buildWikiPages(broken, { issues })).toThrow(/Home/);
    const noRoadmap = { ...sample, wiki: { ...sample.wiki, Roadmap: "# Roadmap\n" } };
    expect(() => buildWikiPages(noRoadmap, { issues })).toThrow(/Roadmap/);
  });
});

describe("parseIssues", () => {
  it("keeps issues, drops pull requests, maps state and label names", () => {
    const parsed = parseIssues([
      { number: 1, title: "Epic", state: "open", labels: [{ name: "epic" }, "plain"] },
      { number: 2, title: "A PR", state: "closed", pull_request: {}, labels: [] },
      { number: 3, title: "Done", state: "closed", labels: [] },
    ]);
    expect(parsed).toEqual([
      { number: 1, title: "Epic", state: "open", labels: ["epic", "plain"] },
      { number: 3, title: "Done", state: "closed", labels: [] },
    ]);
  });
  it("rejects data that is not a list of issues", () => {
    expect(() => parseIssues({ message: "Bad credentials" })).toThrow();
  });
});

describe("checkPages", () => {
  const good = () => buildWikiPages(sample, { issues });
  it("accepts a consistent page set", () => {
    expect(checkPages(good())).toEqual([]);
  });
  it("reports a link to a page that does not exist", () => {
    const pages = { ...good(), "Getting-Started.md": "# Getting Started\n\n[x](Missing-Page)\n" };
    expect(checkPages(pages).join("\n")).toContain("Missing-Page");
  });
  it("reports an anchor that does not exist on the target page, and accepts one that does", () => {
    const bad = { ...good(), "Getting-Started.md": "# Getting Started\n\n[x](Tools#no-such-heading)\n" };
    expect(checkPages(bad).join("\n")).toContain("no-such-heading");
    const ok = { ...good(), "Getting-Started.md": "# Getting Started\n\n[x](Tools#alpha-group) [y](#getting-started)\n" };
    expect(checkPages(ok)).toEqual([]);
  });
  it("ignores things that look like links inside code", () => {
    const pages = { ...good(), "Getting-Started.md": "# Getting Started\n\n```\n[x](Missing-Page)\n```\n`[y](Nope)`\n" };
    expect(checkPages(pages)).toEqual([]);
  });
  it("reports a page that is not linked from the sidebar", () => {
    const pages = { ...good(), "Extra.md": "# Extra\n" };
    expect(checkPages(pages).join("\n")).toContain("Extra");
  });
  it("reports links to repository files that do not exist", () => {
    const pages = {
      ...good(),
      "Getting-Started.md": "# Getting Started\n\n[x](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/does-not-exist.md)\n",
    };
    expect(checkPages(pages, { repoRoot: ROOT }).join("\n")).toContain("does-not-exist.md");
  });
  it("reports an anchor that does not exist in a linked repository markdown file", () => {
    const pages = {
      ...good(),
      "Getting-Started.md": "# Getting Started\n\n[x](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/programming-guide.md#no-such-section)\n",
    };
    expect(checkPages(pages, { repoRoot: ROOT }).join("\n")).toContain("no-such-section");
  });
  it("reports private data in any page", () => {
    const pages = { ...good(), "Getting-Started.md": "# Getting Started\n\nUse 10.20.30.40 here.\n" };
    expect(checkPages(pages).join("\n")).toContain("10.20.30.40");
  });
});

describe("findPrivateData", () => {
  it("flags real-looking IPs, serial numbers in an *IDN? reply and personal email addresses", () => {
    expect(findPrivateData("host 10.20.30.40")).toHaveLength(1);
    expect(findPrivateData("UNI-TREND,UTS3036B,UTS3036B12345678,V1.04.0040")).toHaveLength(1);
    expect(findPrivateData("mail someone@example.org")).toHaveLength(1);
    expect(findPrivateData("Serial: 123456789012")).toHaveLength(1);
  });
  it("allows placeholders and documentation addresses", () => {
    expect(findPrivateData("nc 192.168.1.100 5025, 127.0.0.1, 0.0.0.0, 192.0.2.7, version 1.04.0040")).toEqual([]);
    expect(findPrivateData("UNI-TREND,UTS3036B,<serial>,V1.04.0040")).toEqual([]);
    expect(findPrivateData("Co-Authored-By: Claude <noreply@anthropic.com>")).toEqual([]);
  });
});

describe("slugify", () => {
  it("follows the GitHub heading anchor rules", () => {
    expect(slugify("Alpha group")).toBe("alpha-group");
    expect(slugify("Bandwidth, sweep and detector")).toBe("bandwidth-sweep-and-detector");
    expect(slugify("Concurrency (all tools)")).toBe("concurrency-all-tools");
    expect(slugify("VXI-11 transport (prototype 2026-11-10, issue #64)")).toBe("vxi-11-transport-prototype-2026-11-10-issue-64");
    expect(slugify("`connect` tool")).toBe("connect-tool");
  });
});

describe("the real wiki built from this repository", () => {
  const sources = loadSources(ROOT);
  const pages = buildWikiPages(sources, { issues: null });

  it("has every page the sidebar links to, and passes the link, anchor and privacy checks", () => {
    expect(checkPages(pages, { repoRoot: ROOT })).toEqual([]);
    for (const name of ["Home", "Getting-Started", "Tools", "Instrument-Behavior", "Architecture", "Safety-and-Security", "Troubleshooting", "Development", "Roadmap"]) {
      expect(pages[`${name}.md`], name).toBeTruthy();
    }
  });

  it("keeps the hand-written pages in the repository under docs/wiki/", () => {
    for (const name of ["Getting-Started", "Architecture", "Safety-and-Security", "Troubleshooting", "Development", "_Sidebar", "_Footer", "Home", "Roadmap"]) {
      expect(existsSync(join(ROOT, "docs", "wiki", `${name}.md`)), name).toBe(true);
    }
    // Generated bodies are not duplicated by hand.
    expect(existsSync(join(ROOT, "docs", "wiki", "Tools.md"))).toBe(false);
    expect(existsSync(join(ROOT, "docs", "wiki", "Instrument-Behavior.md"))).toBe(false);
  });

  it("lists every registered tool on the Tools page", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "wiki-sync", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    const toolsPage = pages["Tools.md"];
    const missing = tools.map((t) => t.name).filter((name) => !toolsPage.includes(`\`${name}\``));
    expect(missing).toEqual([]);
    expect(pages["Home.md"]).toContain(`${tools.length} tools`);
  });

  it("shows the current version on Home and no longer says the project is unreleased", () => {
    const version = JSON.parse(read("package.json")).version as string;
    expect(pages["Home.md"]).toContain(`v${version}`);
    for (const [name, text] of Object.entries(pages)) {
      expect(text, name).not.toContain("Nothing has been published");
      expect(text, name).not.toContain("Nothing is published");
      expect(text, name).not.toContain("not yet made safe");
      expect(text, name).not.toContain("Parallel tool calls are not yet");
      expect(text, name).not.toContain("call tools **one at a time**");
      expect(text, name).not.toContain("Trace data, markers, measurements and the screenshot tool are not implemented");
    }
  });

  it("documents the install paths, the concurrency guarantee, VXI-11 and the trace tools truthfully", () => {
    const start = pages["Getting-Started.md"];
    expect(start).toContain("uni-t-uts-mcp-0.1.0.tgz");
    expect(start).toContain("github:Reid-n0rc/uni-t-uts-mcp#v0.1.0");
    expect(start).toContain("ghcr.io/reid-n0rc/uni-t-uts-mcp");
    expect(start).toContain("claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y uni-t-uts-mcp");
    expect(start.toLowerCase()).not.toContain("coming soon");
    expect(start).toContain("UTS_TRANSPORT");
    expect(start).toContain("UTS_BUSY_TIMEOUT_S");
    expect(pages["Architecture.md"]).toContain("UTS_BUSY_TIMEOUT_S");
    expect(pages["Architecture.md"]).toContain("VXI-11");
    expect(pages["Troubleshooting.md"]).toContain("Instrument busy");
    expect(pages["Home.md"]).toContain("get_trace");
    expect(pages["Development.md"]).toContain("docs/wiki");
    expect(pages["Development.md"]).toContain("sync-wiki");
  });

  it("uses plain wording", () => {
    const banned = new RegExp("\\bde" + "af\\b", "i");
    for (const [name, text] of Object.entries(pages)) expect(banned.test(text), name).toBe(false);
  });

  it("writes the pages to a directory and removes stale generated pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-out-"));
    writeFileSync(join(dir, "Stale.md"), "old");
    writeFileSync(join(dir, "keep.png"), "x");
    writePages(dir, pages);
    const files = readdirSync(dir);
    expect(files).not.toContain("Stale.md");
    expect(files).toContain("keep.png");
    expect(files).toContain("Home.md");
    expect(readFileSync(join(dir, "Tools.md"), "utf8")).toBe(pages["Tools.md"]);
  });
});

describe("scripts/sync-wiki.mjs command line", () => {
  it("builds into --out using --issues-file, and --check passes on this repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-cli-"));
    const issuesFile = join(dir, "issues.json");
    writeFileSync(issuesFile, JSON.stringify([{ number: 7, title: "Sample issue", state: "open", labels: [] }]));
    const out = join(dir, "out");
    execFileSync(process.execPath, [join(ROOT, "scripts", "sync-wiki.mjs"), "--out", out, "--issues-file", issuesFile], { cwd: ROOT, stdio: "pipe" });
    expect(readFileSync(join(out, "Roadmap.md"), "utf8")).toContain("Sample issue");
    expect(readFileSync(join(out, "Home.md"), "utf8")).toContain("tools");
    execFileSync(process.execPath, [join(ROOT, "scripts", "sync-wiki.mjs"), "--check"], { cwd: ROOT, stdio: "pipe" });
  });
});

describe("workflows and docs", () => {
  const workflow = read(".github/workflows/wiki-sync.yml");
  it("the sync workflow pushes plain commits with the default token only", () => {
    expect(workflow).toContain("branches: [main]");
    for (const path of ["docs/**", "README.md", "CHANGELOG.md", "package.json", "scripts/sync-wiki.mjs"]) expect(workflow).toContain(`"${path}"`);
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("github.repository }}.wiki");
    expect(workflow).toContain("git diff --cached --quiet");
    expect(workflow).toContain("git push");
    expect(workflow).not.toMatch(/git push[^\n]*(--force|-f\b|--force-with-lease)/);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("GH_PAT");
    for (const line of workflow.split("\n")) {
      const use = line.match(/^\s*-?\s*uses:\s*(\S+)/);
      if (use) expect(use[1], line).toMatch(/@v\d+(\.\d+)*$|@[0-9a-f]{40}$/);
    }
  });
  it("CI checks at pull request time that the wiki pages build", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("node scripts/sync-wiki.mjs --check");
  });
  it("README links to the wiki and the project site; AGENTS.md says where wiki content lives", () => {
    const readme = read("README.md");
    expect(readme).toContain("https://github.com/Reid-n0rc/uni-t-uts-mcp/wiki");
    expect(readme).toContain("https://reid-n0rc.github.io/uni-t-uts-mcp/");
    const agents = read("AGENTS.md");
    expect(agents).toContain("docs/wiki/");
    expect(agents).toContain("scripts/sync-wiki.mjs");
    expect(agents).toContain("wiki-sync.yml");
  });
});
