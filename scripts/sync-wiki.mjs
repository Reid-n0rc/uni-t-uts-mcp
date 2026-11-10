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

// ---- untrusted issue text (issue #103). Everything derived from an issue (title, label names) is
// attacker-controlled on a public repository, so it is rendered as plain text only: invisible and
// control characters are removed, private-looking data is redacted, the length is capped, bare URLs
// and @mentions are broken up and every markdown metacharacter is backslash-escaped.

export const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
export const MAX_TITLE_LENGTH = 120;
export const MAX_LABEL_LENGTH = 40;
const REDACTED = "[redacted]";

/** True for issues opened by someone with write access to the repository (author_association as the API reports it). */
export const isTrustedIssue = (issue) => TRUSTED_ASSOCIATIONS.includes(issue.authorAssociation);

/** Plain-text, single-line, length-capped text; `onRedact` is called when private-looking data was removed. */
export function sanitizeIssueText(value, { max = MAX_TITLE_LENGTH, onRedact } = {}) {
  let text = String(value ?? "").normalize("NFKC");
  // line breaks and control characters become spaces; format characters (bidi overrides, zero width,
  // joiners, BOM, tags), surrogates, private use and unassigned code points are dropped
  text = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, "");
  text = text.replace(/\s+/g, " ").trim();
  const redacted = redactPrivateData(text);
  if (redacted !== text && onRedact) onRedact();
  text = redacted;
  const chars = Array.from(text);
  if (chars.length > max) text = `${chars.slice(0, max).join("").trimEnd()}\u2026`;
  return neutralizeMarkdown(text);
}

/** Break up autolinks and mentions, then backslash-escape every markdown and HTML metacharacter. */
function neutralizeMarkdown(text) {
  return text
    .replace(/:\/\//g, "[:]//")
    .replace(/\bwww\./gi, "www[.]")
    .replace(/@/g, "\uFF20")
    .replace(/[\\`*_[\]()!#|~<>&]/g, "\\$&");
}

function issueLine(issue, onRedact) {
  const title = sanitizeIssueText(issue.title, { onRedact: () => onRedact(issue.number) }) || "(untitled)";
  const names = issue.labels
    .map((l) => sanitizeIssueText(l, { max: MAX_LABEL_LENGTH, onRedact: () => onRedact(issue.number) }))
    .filter(Boolean);
  const labels = names.length > 0 ? ` _(${names.join(", ")})_` : "";
  // the link target is built from the integer issue number only, never from text
  return `- [#${Number(issue.number)}](${REPO_URL}/issues/${Number(issue.number)}) ${title}${labels}`;
}

function roadmapPage(sources, issues, warnings) {
  let body;
  if (issues) {
    const trusted = issues.filter(isTrustedIssue);
    const skipped = issues.length - trusted.length;
    const onRedact = (n) => warnings.push(`issue #${n}: private-looking text in the title or labels was redacted`);
    const sorted = [...trusted].sort((a, b) => a.number - b.number);
    const open = sorted.filter((i) => i.state === "open");
    const closed = sorted.filter((i) => i.state !== "open");
    body = [
      `## Open issues (${open.length})`,
      "",
      ...open.map((i) => issueLine(i, onRedact)),
      "",
      `## Completed issues (${closed.length})`,
      "",
      ...closed.map((i) => issueLine(i, onRedact)),
      ...(skipped > 0 ? ["", `_${skipped} ${skipped === 1 ? "issue" : "issues"} from other authors ${skipped === 1 ? "is" : "are"} not listed._`] : []),
    ].join("\n");
  } else {
    body = `The issue lists are filled in by the automatic sync. This copy was built without access to the issue tracker, so see GitHub for the current lists: [open issues](${REPO_URL}/issues?q=is%3Aissue+is%3Aopen), [closed issues](${REPO_URL}/issues?q=is%3Aissue+is%3Aclosed).`;
  }
  return fill(sources.wiki.Roadmap ?? "", "Roadmap", "<!--ISSUES-->", body);
}

/** The complete page set, as { "Name.md": content }. `issues` is null when the tracker is unavailable. */
export function buildWikiPages(sources, { issues = null, warnings = [] } = {}) {
  const pages = {};
  for (const [name, text] of Object.entries(sources.wiki)) {
    if (!GENERATED_PAGES.includes(name)) pages[`${name}.md`] = text.replace(/\r\n/g, "\n");
  }
  pages["Home.md"] = homePage(sources);
  pages["Tools.md"] = toolsPage(sources);
  pages["Instrument-Behavior.md"] = behaviorPage(sources);
  pages["Roadmap.md"] = roadmapPage(sources, issues, warnings);
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
      authorAssociation: typeof i.author_association === "string" ? i.author_association : "NONE",
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

// Each rule is a fixed regular expression plus a test of the matched text.
const PRIVATE_RULES = [
  {
    re: /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    test: (ip) => !ip.split(".").some((o) => Number(o) > 255) && !ALLOWED_IPS.includes(ip) && !/^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip),
    describe: (m) => `IP address ${m}`,
  },
  {
    re: /UNI-T[A-Za-z]*,UTS\w+,([^,\s]+),/g,
    test: (m) => !m.split(",")[2].startsWith("<"),
    describe: (m) => `serial number in an identification string (${m})`,
  },
  { re: /\bserial(?: number)?\s*[:=]\s*[A-Za-z0-9]{8,}/gi, test: () => true, describe: (m) => `serial number (${m})` },
  {
    re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
    test: (m) => !/^noreply@|@users\.noreply\.github\.com$/.test(m),
    describe: (m) => `email address ${m}`,
  },
];

/** Things that must never appear in the wiki: serial numbers, real IP addresses, personal emails. */
export function findPrivateData(text) {
  const found = [];
  for (const rule of PRIVATE_RULES) {
    for (const m of text.matchAll(rule.re)) if (rule.test(m[0])) found.push(rule.describe(m[0]));
  }
  return found;
}

/** The text with everything findPrivateData would report replaced by "[redacted]". */
export function redactPrivateData(text) {
  let out = text;
  for (const rule of PRIVATE_RULES) out = out.replace(rule.re, (m) => (rule.test(m) ? REDACTED : m));
  return out;
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

  const warnings = [];
  const pages = buildWikiPages(loadSources(root), { issues, warnings });
  for (const w of warnings) console.warn(`wiki: warning: ${w}`);
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
