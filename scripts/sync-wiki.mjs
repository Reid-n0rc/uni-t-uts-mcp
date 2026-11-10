#!/usr/bin/env node
// Builds the GitHub wiki page set from the repository's sources (issue #70). Plain Node, no
// dependencies; works on Linux, macOS and Windows.
//
//   node scripts/sync-wiki.mjs [--out <dir>] [--issues-file <json>] [--no-issues] [--check]
//
// Sources of truth (the wiki repository is only ever written by this script):
//   Tools               <- docs/tools-reference.md          (generated)
//   Instrument-Behavior <- docs/verified-hardware.md        (generated)
//   Home                <- docs/wiki/Home.md template + package.json version + tool list (generated)
//   Roadmap             <- docs/wiki/Roadmap.md template + open/closed issues via `gh api` (generated)
//   everything else     <- docs/wiki/*.md, copied as they are (hand-written, reviewed in PRs)
//
// --check builds in memory and verifies that every internal link and anchor resolves, that links
// to repository files point at files that exist, that the sidebar lists every page, and that no
// serial numbers, real IP addresses or personal email addresses are present. It exits 1 on problems.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseToolsReference } from "./site-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_URL = "https://github.com/Reid-n0rc/uni-t-uts-mcp";
const REPO_SLUG = "Reid-n0rc/uni-t-uts-mcp";
const BLOB = `${REPO_URL}/blob/main/`;
export const GENERATED_PAGES = ["Home", "Tools", "Instrument-Behavior", "Roadmap"];

// ---------------------------------------------------------------- reading the sources

export function loadSources(root = resolve(here, "..")) {
  const wikiDir = join(root, "docs", "wiki");
  const wiki = {};
  for (const file of readdirSync(wikiDir).sort()) {
    if (file.endsWith(".md")) wiki[file.slice(0, -3)] = readFileSync(join(wikiDir, file), "utf8");
  }
  return {
    toolsReference: readFileSync(join(root, "docs", "tools-reference.md"), "utf8"),
    verifiedHardware: readFileSync(join(root, "docs", "verified-hardware.md"), "utf8"),
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    wiki,
  };
}

// ---------------------------------------------------------------- markdown helpers

/** Split markdown into lines tagged with whether they are inside a fenced code block. */
function linesWithFences(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map((text) => {
    const m = /^\s*(```+|~~~+)/.exec(text);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return { text, code: true };
    }
    return { text, code: fence !== null };
  });
}

/** GitHub's heading anchor: lower case, drop punctuation, spaces to hyphens. */
export function slugify(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = new Set();
  for (const { text, code } of linesWithFences(markdown)) {
    const m = !code && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
    if (!m) continue;
    const base = slugify(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Link targets of `[text](target)` outside code blocks and inline code. */
function linkTargets(markdown) {
  const out = [];
  for (const { text, code } of linesWithFences(markdown)) {
    if (code) continue;
    const noInline = text.replace(/`[^`]*`/g, "");
    for (const m of noInline.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  }
  return out;
}

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target);

/**
 * Make links in a generated page work from the wiki: links to the two pages that are generated
 * become wiki links, every other repository-relative link becomes an absolute GitHub link.
 * `baseDir` is the repository directory of the source file (posix, e.g. "docs").
 */
function rewriteLinks(markdown, baseDir) {
  return linesWithFences(markdown)
    .map(({ text, code }) => {
      if (code) return text;
      return text.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
        if (isExternal(target) || target.startsWith("#")) return whole;
        const hash = target.indexOf("#");
        const path = hash >= 0 ? target.slice(0, hash) : target;
        const anchor = hash >= 0 ? target.slice(hash) : "";
        const resolved = posix.normalize(posix.join(baseDir, path));
        if (resolved === "docs/tools-reference.md") return `](Tools${anchor})`;
        if (resolved === "docs/verified-hardware.md") return `](Instrument-Behavior${anchor})`;
        return `](${BLOB}${resolved}${anchor})`;
      });
    })
    .join("\n");
}

function dropFirstHeading(markdown) {
  return markdown.replace(/^#\s+.*\r?\n+/, "");
}

function fill(template, page, marker, value) {
  if (!template.includes(marker)) {
    throw new Error(`docs/wiki/${page}.md is missing the ${marker} placeholder`);
  }
  return template.split(marker).join(value);
}

// ---------------------------------------------------------------- generated pages

function toolsPage(sources) {
  const body = dropFirstHeading(rewriteLinks(sources.toolsReference.replace(/\r\n/g, "\n"), "docs"));
  return `# Tools

> This page is generated from [docs/tools-reference.md](${BLOB}docs/tools-reference.md) in the repository on every change to \`main\`. Do not edit it here; change that file in a pull request.

${body.trimEnd()}
`;
}

function behaviorPage(sources) {
  const body = dropFirstHeading(rewriteLinks(sources.verifiedHardware.replace(/\r\n/g, "\n"), "docs"));
  return `# Instrument Behavior

> This page is generated from [docs/verified-hardware.md](${BLOB}docs/verified-hardware.md) in the repository on every change to \`main\`. Do not edit it here; change that file in a pull request.

${body.trimEnd()}
`;
}

function homePage(sources) {
  const groups = parseToolsReference(sources.toolsReference);
  const toolCount = groups.reduce((n, g) => n + g.tools.length, 0);
  const table = [
    "| Group | Tools |",
    "|-------|-------|",
    ...groups.map((g) => `| ${g.name} | ${g.tools.map((t) => `\`${t.name}\``).join(", ")} |`),
  ].join("\n");
  const template = sources.wiki.Home ?? "";
  let page = fill(template, "Home", "<!--VERSION-->", sources.version);
  page = fill(page, "Home", "<!--TOOL_COUNT-->", String(toolCount));
  page = fill(page, "Home", "<!--GROUP_COUNT-->", String(groups.length));
  return fill(page, "Home", "<!--TOOL_GROUPS-->", table);
}

const cleanTitle = (title) => String(title).replace(/\s+/g, " ").replace(/</g, "&lt;").trim();

function issueLine(issue) {
  const labels = issue.labels.length > 0 ? ` _(${issue.labels.join(", ")})_` : "";
  return `- [#${issue.number}](${REPO_URL}/issues/${issue.number}) ${cleanTitle(issue.title)}${labels}`;
}

function roadmapPage(sources, issues) {
  let body;
  if (issues) {
    const sorted = [...issues].sort((a, b) => a.number - b.number);
    const open = sorted.filter((i) => i.state === "open");
    const closed = sorted.filter((i) => i.state !== "open");
    body = [
      `## Open issues (${open.length})`,
      "",
      ...open.map(issueLine),
      "",
      `## Completed issues (${closed.length})`,
      "",
      ...closed.map(issueLine),
    ].join("\n");
  } else {
    body = `The issue lists are filled in by the automatic sync. This copy was built without access to the issue tracker, so see GitHub for the current lists: [open issues](${REPO_URL}/issues?q=is%3Aissue+is%3Aopen), [closed issues](${REPO_URL}/issues?q=is%3Aissue+is%3Aclosed).`;
  }
  return fill(sources.wiki.Roadmap ?? "", "Roadmap", "<!--ISSUES-->", body);
}

/** The complete page set, as { "Name.md": content }. `issues` is null when the tracker is unavailable. */
export function buildWikiPages(sources, { issues = null } = {}) {
  const pages = {};
  for (const [name, text] of Object.entries(sources.wiki)) {
    if (!GENERATED_PAGES.includes(name)) pages[`${name}.md`] = text.replace(/\r\n/g, "\n");
  }
  pages["Home.md"] = homePage(sources);
  pages["Tools.md"] = toolsPage(sources);
  pages["Instrument-Behavior.md"] = behaviorPage(sources);
  pages["Roadmap.md"] = roadmapPage(sources, issues);
  return Object.fromEntries(Object.entries(pages).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------- issues

export function parseIssues(json) {
  if (!Array.isArray(json)) throw new Error("Expected a list of issues from the GitHub API");
  return json
    .filter((i) => i && !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state === "open" ? "open" : "closed",
      labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    }));
}

/** Issues via `gh api` when a token is present; null (the deterministic fallback) when not. Failures throw. */
export function fetchIssues({ repo = REPO_SLUG, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  if (!token) return null;
  const out = execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repo}/issues?state=all&per_page=100`], {
    env: { ...process.env, GH_TOKEN: token },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseIssues(JSON.parse(out).flat());
}

// ---------------------------------------------------------------- checks

const ALLOWED_IPS = ["192.168.1.100", "127.0.0.1", "0.0.0.0"];

/** Things that must never appear in the wiki: serial numbers, real IP addresses, personal emails. */
export function findPrivateData(text) {
  const found = [];
  for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.some((o) => o > 255)) continue;
    const ip = m[0];
    if (ALLOWED_IPS.includes(ip)) continue;
    if (/^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip)) continue;
    found.push(`IP address ${ip}`);
  }
  for (const m of text.matchAll(/UNI-T[A-Za-z]*,UTS\w+,([^,\s]+),/g)) {
    if (!m[1].startsWith("<")) found.push(`serial number in an identification string (${m[0]})`);
  }
  for (const m of text.matchAll(/\bserial(?: number)?\s*[:=]\s*[A-Za-z0-9]{8,}/gi)) found.push(`serial number (${m[0]})`);
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    if (!/^noreply@|@users\.noreply\.github\.com$/.test(m[0])) found.push(`email address ${m[0]}`);
  }
  return found;
}

/** Problems with a page set; an empty list means it is fine to publish. */
export function checkPages(pages, { repoRoot } = {}) {
  const problems = [];
  const names = new Set(Object.keys(pages).map((f) => f.replace(/\.md$/, "")));
  const anchors = Object.fromEntries(Object.entries(pages).map(([f, text]) => [f.replace(/\.md$/, ""), anchorsOf(text)]));

  for (const [file, text] of Object.entries(pages)) {
    const page = file.replace(/\.md$/, "");
    for (const target of linkTargets(text)) {
      if (target.startsWith(BLOB) || target.startsWith(`${REPO_URL}/tree/main/`)) {
        if (!repoRoot) continue;
        const [pathPart, anchor = ""] = target.replace(/^.*?\/(blob|tree)\/main\//, "").split("#");
        const rel = decodeURIComponent(pathPart.split("?")[0]);
        if (rel && !existsSync(join(repoRoot, rel))) {
          problems.push(`${file}: link to a repository file that does not exist: ${rel}`);
        } else if (anchor && rel.endsWith(".md") && !anchorsOf(readFileSync(join(repoRoot, rel), "utf8")).has(anchor)) {
          problems.push(`${file}: link to an anchor that does not exist in ${rel}: #${anchor}`);
        }
        continue;
      }
      if (isExternal(target)) continue;
      const hash = target.indexOf("#");
      const targetPage = hash === 0 ? page : hash > 0 ? target.slice(0, hash) : target;
      const anchor = hash >= 0 ? target.slice(hash + 1) : "";
      if (!names.has(targetPage)) {
        problems.push(`${file}: link to a page that does not exist: ${target}`);
      } else if (anchor && !anchors[targetPage].has(anchor)) {
        problems.push(`${file}: link to an anchor that does not exist: ${target}`);
      }
    }
    for (const item of findPrivateData(text)) problems.push(`${file}: private data: ${item}`);
  }

  const sidebar = pages["_Sidebar.md"];
  if (sidebar === undefined) {
    problems.push("_Sidebar.md is missing");
  } else {
    const linked = new Set(linkTargets(sidebar).map((t) => t.split("#")[0]));
    for (const name of names) {
      if (!name.startsWith("_") && !linked.has(name)) problems.push(`${name}.md is not linked from _Sidebar.md`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- writing and command line

/** Write the pages into `dir`, removing .md files that are no longer part of the set. */
export function writePages(dir, pages) {
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".md") && !(file in pages)) rmSync(join(dir, file));
  }
  for (const [file, text] of Object.entries(pages)) writeFileSync(join(dir, file), text);
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(here, "..");
  const check = argv.includes("--check");
  const outArg = arg("--out");
  const issuesFile = arg("--issues-file");
  let issues = null;
  if (issuesFile) issues = parseIssues(JSON.parse(readFileSync(resolve(issuesFile), "utf8")));
  else if (!argv.includes("--no-issues") && !check) issues = fetchIssues();

  const pages = buildWikiPages(loadSources(root), { issues });
  const problems = checkPages(pages, { repoRoot: root });
  if (problems.length > 0) {
    for (const p of problems) console.error(`wiki: ${p}`);
    console.error(`wiki: ${problems.length} problem(s); nothing written`);
    return 1;
  }
  if (outArg || !check) {
    const out = resolve(outArg ?? join(root, "_wiki"));
    writePages(out, pages);
    console.log(`Built ${Object.keys(pages).length} wiki pages in ${out} (${issues ? `${issues.length} issues` : "no issue data"})`);
  } else {
    console.log(`Wiki check passed: ${Object.keys(pages).length} pages, all links resolve, no private data.`);
  }
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) process.exit(main(process.argv.slice(2)));
