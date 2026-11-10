// Prints (never writes) the MCP client configuration for this server.
//   npm run client-config -- --host 192.168.1.100 [--from local|tarball|github|docker|npm]
// It is also the single place that knows how the server is installed: README, the site and the docs
// are checked against these values by tests/unit/install-docs.test.ts.
import { readFileSync } from "node:fs";
import { resolve, win32, posix } from "node:path";
import { fileURLToPath } from "node:url";

// true since uni-t-uts-mcp 0.1.0 went live on npm (see docs/releasing.md, "npm publishing").
export const NPM_PUBLISHED = true;
export const REPO = "Reid-n0rc/uni-t-uts-mcp";
export const IMAGE = "ghcr.io/reid-n0rc/uni-t-uts-mcp";

export const tarballUrl = (v) => `https://github.com/${REPO}/releases/download/v${v}/uni-t-uts-mcp-${v}.tgz`;
export const githubSpec = (v) => `github:${REPO}#v${v}`;
export const dockerImage = (v) => `${IMAGE}:${v}`;

/** Returns an error message, or null when the host is a plain hostname or IP address. */
export function validateHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return "--host needs a hostname or IP address";
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return "--host may only contain letters, digits, dots, dashes, underscores and colons";
  return null;
}

const isWin = (platform) => platform === "win32";

/** The command and arguments an MCP client launches. */
export function buildServerConfig({ host, source = "local", version, platform = process.platform, entry }) {
  const env = host ? { UTS_IP: host } : undefined;
  let command;
  let args;
  if (source === "local") {
    if (!entry) throw new Error("source local needs an entry path");
    command = "node";
    args = [entry];
  } else if (source === "docker") {
    command = "docker";
    args = ["run", "-i", "--rm", ...(host ? ["-e", `UTS_IP=${host}`] : []), dockerImage(version)];
    return { command, args };
  } else {
    const spec = source === "tarball" ? tarballUrl(version) : source === "github" ? githubSpec(version) : "uni-t-uts-mcp";
    command = "npx";
    args = ["-y", spec];
    // npx is a .cmd file on Windows; most clients cannot launch it directly.
    if (isWin(platform)) {
      args = ["/c", "npx", ...args];
      command = "cmd";
    }
  }
  return env ? { command, args, env } : { command, args };
}

function quote(arg, platform) {
  if (isWin(platform)) return /[\s"&|<>^%]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
  return /^[A-Za-z0-9_@%+=:,./#-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The `claude mcp add` one-liner. */
export function claudeCodeCommand(opts) {
  const platform = opts.platform ?? process.platform;
  const cfg = buildServerConfig(opts);
  const envPart = cfg.env?.UTS_IP && cfg.command !== "docker" ? ` -e ${quote(`UTS_IP=${cfg.env.UTS_IP}`, platform)}` : "";
  const rest = [cfg.command, ...cfg.args].map((a) => quote(a, platform)).join(" ");
  return `claude mcp add uni-t-uts${envPart} -- ${rest}`;
}

/** The JSON for Claude Desktop, Cursor, VS Code-style clients. */
export function jsonConfig(opts) {
  return JSON.stringify({ mcpServers: { "uni-t-uts": buildServerConfig(opts) } }, null, 2);
}

export function render(opts) {
  const lines = [
    `# Claude Code (run once in a terminal):`,
    claudeCodeCommand(opts),
    ``,
    `# Claude Desktop, Cursor, VS Code and other clients that read an mcpServers block:`,
    jsonConfig(opts),
  ];
  if (!opts.host) {
    lines.push(``, `# No --host given, so UTS_IP is not set. Either rerun with --host <address> or tell the assistant:`, `# "connect to the analyzer at <address>".`);
  } else {
    lines.push(``, `# UTS_IP is optional: without it, tell the assistant "connect to the analyzer at ${opts.host}".`);
  }
  return lines.join("\n");
}

const SOURCES = ["local", "tarball", "github", "docker", "npm"];

export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s + "\n"));
  const err = io.err ?? ((s) => process.stderr.write(s + "\n"));
  const platform = io.platform ?? process.platform;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const version = io.version ?? JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  let host;
  let source = "local";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--from") source = argv[++i];
    else if (a === "--help" || a === "-h") {
      out("Usage: npm run client-config -- [--host <address>] [--from local|tarball|github|docker|npm]\nPrints the MCP client configuration; it never writes any file.");
      return 0;
    } else {
      err(`Unknown argument: ${a}`);
      return 2;
    }
  }
  if (host !== undefined) {
    const problem = validateHost(host);
    if (problem) {
      err(problem);
      return 2;
    }
  }
  if (!SOURCES.includes(source)) {
    err(`--from must be one of ${SOURCES.join(", ")}`);
    return 2;
  }
  if (source === "npm" && !NPM_PUBLISHED) {
    err("The npm package is not published yet. Use --from tarball, github, docker or local.");
    return 2;
  }
  const join = isWin(platform) ? win32 : posix;
  const entry = io.entry ?? join.resolve(root, "build", "index.js");
  out(render({ host, source, version, platform, entry }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
