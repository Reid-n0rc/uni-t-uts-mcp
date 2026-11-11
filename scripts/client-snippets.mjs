#!/usr/bin/env node
// Single source of truth for the "Add to your client" help (issue #88). The README table, the wiki
// page docs/wiki/Add-to-Client.md and the site section are all generated from CLIENTS below and
// written between <!-- clients:begin --> and <!-- clients:end --> markers, so they cannot disagree.
//   node scripts/client-snippets.mjs [--check]     (npm run clients:sync / npm run clients:check)
// The server specs come from scripts/client-config.mjs (the same code as `npm run client-config`).
// Only placeholders appear in the output: the host is PLACEHOLDER_HOST, there are no secrets.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISHED, buildServerConfig, claudeCodeCommand, dockerImage } from "./client-config.mjs";

export const PLACEHOLDER_HOST = "192.168.1.100";
export const BEGIN = "<!-- clients:begin -->";
export const END = "<!-- clients:end -->";
const RELEASES = "https://github.com/Reid-n0rc/uni-t-uts-mcp/releases";

const json = (v) => JSON.stringify(v, null, 2);

/** The spec every client launches: npm once published, otherwise the release tarball. */
const source = () => (NPM_PUBLISHED ? "npm" : "tarball");

/** Returns the clients with their snippets for a package version. */
export function buildClients(version) {
  const base = { host: PLACEHOLDER_HOST, source: source(), version };
  const unix = buildServerConfig({ ...base, platform: "linux" });
  const win = buildServerConfig({ ...base, platform: "win32" });
  const docker = buildServerConfig({ ...base, source: "docker", platform: "linux" });
  const noEnv = buildServerConfig({ ...base, host: undefined, platform: "linux" });
  const mcpServers = (cfg) => json({ mcpServers: { "uni-t-uts": cfg } });
  const vsServers = (cfg) => json({ servers: { "uni-t-uts": { type: "stdio", ...cfg } } });
  const jsonVariants = (wrap) => [
    { label: "npx (macOS / Linux)", lang: "json", text: wrap(unix) },
    { label: "npx (Windows)", lang: "json", text: wrap(win) },
    { label: "Docker", lang: "json", text: wrap(docker) },
  ];
  // Cursor's documented install link: cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the server JSON>.
  // No UTS_IP in the link (it would install a made-up address); the user tells the assistant where the analyzer is.
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=uni-t-uts&config=${Buffer.from(JSON.stringify(noEnv)).toString("base64")}`;
  const tail = `UTS_IP is optional: without it, tell the assistant "connect to the analyzer at ${PLACEHOLDER_HOST}".`;

  return [
    {
      id: "claude-code",
      name: "Claude Code",
      where: "terminal, or `.mcp.json` in a project",
      docs: "https://code.claude.com/docs/en/mcp",
      verified: "Command form and `.mcp.json` format checked against the Claude Code docs. Not run by the maintainer on a fresh machine.",
      steps: ["Run the command once in a terminal. Add `--scope user` to make it available in every project (`local` is the default, `project` writes `.mcp.json`).", tail],
      snippets: [
        { label: "npx (macOS / Linux)", lang: "sh", text: claudeCodeCommand({ ...base, platform: "linux" }) },
        { label: "npx (Windows)", lang: "sh", text: claudeCodeCommand({ ...base, platform: "win32" }) },
        { label: "Docker", lang: "sh", text: claudeCodeCommand({ ...base, source: "docker", platform: "linux" }) },
        { label: ".mcp.json (project scope)", lang: "json", text: mcpServers(unix) },
      ],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      where: "download the `.mcpb`, or `claude_desktop_config.json`",
      docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
      verified: "The `claude_desktop_config.json` format and paths are from the MCP docs. Installing the `.mcpb` in Claude Desktop itself is NOT verified yet (issue #86 tracks the manual check).",
      link: { label: "Download the .mcpb (GitHub releases)", href: `${RELEASES}/tag/v${version}` },
      steps: [
        `Easiest: download \`uni-t-uts-mcp-${version}.mcpb\` from the release and double-click it; the install dialog asks for the analyzer address. (Not verified in Claude Desktop yet.)`,
        "Or edit the config file (Settings > Developer > Edit Config): macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\\Claude\\claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`. Restart Claude Desktop completely afterwards.",
        tail,
      ],
      snippets: jsonVariants(mcpServers),
    },
    {
      id: "cursor",
      name: "Cursor",
      where: "install link, or `~/.cursor/mcp.json` / `.cursor/mcp.json`",
      docs: "https://cursor.com/docs/context/mcp",
      verified: "File locations and the install-link format are from Cursor's docs (https://cursor.com/docs/mcp/install-links). Not clicked in Cursor by the maintainer.",
      link: { label: "Add to Cursor", href: cursorLink },
      steps: [
        "The install link opens Cursor's install dialog with the npx command (no analyzer address; tell the assistant where it is, or add `UTS_IP` under `env` afterwards). On Windows use the config file below.",
        "Or put the JSON in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).",
      ],
      snippets: jsonVariants(mcpServers),
    },
    {
      id: "vscode",
      name: "VS Code",
      where: "`.vscode/mcp.json`, or `code --add-mcp`",
      docs: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
      verified: "The `servers` format, file locations and `code --add-mcp` are from the VS Code docs (which note the `servers` format belongs to the Local harness, deprecated from February 2027). No one-click link: the `vscode:mcp/install` format is not in the official docs, so none is offered. Not run by the maintainer.",
      steps: [
        "Workspace: save the JSON as `.vscode/mcp.json`. For your user profile run `code --add-mcp` with the JSON below, or use the Command Palette: MCP: Add Server.",
        tail,
      ],
      snippets: [
        { label: ".vscode/mcp.json (macOS / Linux)", lang: "json", text: vsServers(unix) },
        { label: ".vscode/mcp.json (Windows)", lang: "json", text: vsServers(win) },
        { label: "code --add-mcp (macOS / Linux)", lang: "sh", text: `code --add-mcp '${JSON.stringify({ name: "uni-t-uts", type: "stdio", ...unix })}'` },
      ],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      where: "`mcp_config.json` (Cascade > Open MCP config file)",
      docs: "https://docs.devin.ai/windsurf/plugins/cascade/mcp",
      verified: "The `mcpServers` format is from the Windsurf docs. Their path has moved: the current docs say `~/.config/devin/mcp_config.json` (macOS / Linux) or `%AppData%/devin/mcp_config.json` (Windows), older ones `~/.codeium/windsurf/mcp_config.json`. Use Cascade's Open MCP config file action to find the right one. No install link is documented. Not run by the maintainer.",
      steps: ["Open the file with Cascade's Open MCP config file action (or Settings > Tools > Windsurf Settings > Add Server) and add the entry.", tail],
      snippets: jsonVariants(mcpServers),
    },
    {
      id: "generic",
      name: "Other stdio clients",
      where: "any client that launches an MCP server over stdio",
      docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
      verified: "Plain MCP stdio: the client starts the command and talks over stdin/stdout. Key names differ per client; check its docs.",
      steps: [`Command \`${unix.command}\`, arguments \`${unix.args.join(" ")}\`, environment variable \`UTS_IP\` (optional, \`UTS_PORT\` defaults to 5025).`, "On Windows, where `npx` is a `.cmd` file, use `cmd` with arguments `/c npx -y uni-t-uts-mcp`."],
      snippets: jsonVariants(mcpServers),
    },
  ];
}

// ---------------------------------------------------------------- renderers

const fence = (s) => (s.lang === "sh" ? "sh" : s.lang);

export function renderReadmeTable(clients) {
  const rows = clients.map((c) => `| ${c.name} | ${c.where} | ${c.link ? `[${c.link.label}](${c.link.href})` : "-"} |`);
  return [
    "| Client | How | One-click |",
    "|---|---|---|",
    ...rows,
    "",
    "Copy-paste configs for each client, and what has and has not been verified, are on the [Add to Client wiki page](https://github.com/Reid-n0rc/uni-t-uts-mcp/wiki/Add-to-Client) and the [project site](https://reid-n0rc.github.io/uni-t-uts-mcp/#add-to-client).",
  ].join("\n");
}

export function renderWiki(clients) {
  const out = [];
  for (const c of clients) {
    out.push(`### ${c.name}`, "", `Source: ${c.docs}`, "", `Verification: ${c.verified}`, "");
    if (c.link) out.push(`One-click: [${c.link.label}](${c.link.href})`, "");
    for (const s of c.steps) out.push(`- ${s}`);
    out.push("");
    for (const s of c.snippets) out.push(`${s.label}:`, "", "```" + fence(s), s.text, "```", "");
  }
  return out.join("\n").trimEnd();
}

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\n", "&#10;");
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

export function renderSiteSection(clients) {
  const tabs = clients.map((c, i) => `<button type="button" role="tab" class="ctab" id="tab-${c.id}" aria-controls="panel-${c.id}" aria-selected="${i === 0}" data-client="${c.id}">${esc(c.name)}</button>`).join("\n        ");
  const panels = clients.map((c, i) => {
    const snippets = c.snippets.map((s) => `<div class="win"><div class="win-bar"><h4 class="win-title">${esc(s.label)}</h4><span class="win-btns" aria-hidden="true"><i></i><i></i></span></div>
            <div class="code-wrap"><button class="copy" type="button" data-copy="${esc(s.text)}">Copy</button>
<pre class="code"><code>${esc(s.text).replaceAll("&#10;", "\n")}</code></pre></div></div>`).join("\n          ");
    const link = c.link ? `<p><a class="btn alt" href="${esc(c.link.href)}">${esc(c.link.label)}</a></p>` : "";
    return `<div role="tabpanel" class="cpanel" id="panel-${c.id}" aria-labelledby="tab-${c.id}"${i === 0 ? "" : " data-later"}>
          <h3>${esc(c.name)}</h3>
          ${link}
          <ul>${c.steps.map((s) => `<li>${inline(s)}</li>`).join("")}</ul>
          ${snippets}
          <p class="callout">${inline(c.verified)} Source: <code>${esc(c.docs)}</code></p>
        </div>`;
  }).join("\n        ");
  return `<div class="ctabs" role="tablist" aria-label="MCP client">
        ${tabs}
      </div>
        ${panels}`;
}

// ---------------------------------------------------------------- syncing the files

export const TARGETS = [
  { file: "README.md", render: renderReadmeTable },
  { file: "docs/wiki/Add-to-Client.md", render: renderWiki },
  { file: "site/index.html", render: renderSiteSection },
];

export function replaceRegion(text, body, file = "file") {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${file}: missing ${BEGIN} / ${END} markers`);
  return `${text.slice(0, a + BEGIN.length)}\n${body}\n${text.slice(b)}`;
}

/** Returns the files whose generated region is out of date; writes them when write is true. */
export function sync({ root = resolve(fileURLToPath(new URL("../", import.meta.url))), write = false, version } = {}) {
  const v = version ?? JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const clients = buildClients(v);
  const stale = [];
  for (const t of TARGETS) {
    const path = resolve(root, t.file);
    const current = readFileSync(path, "utf8");
    const next = replaceRegion(current, t.render(clients), t.file);
    if (next !== current) {
      stale.push(t.file);
      if (write) writeFileSync(path, next);
    }
  }
  return stale;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = sync({ write: !check });
  if (check && stale.length) {
    process.stderr.write(`Out of date (run npm run clients:sync): ${stale.join(", ")}\n`);
    process.exitCode = 1;
  } else if (stale.length) process.stdout.write(`Updated: ${stale.join(", ")}\n`);
}
