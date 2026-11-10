// Builds the Claude Desktop MCP bundle (issue #86): uni-t-uts-mcp-<version>.mcpb
//
//   npm run build && node scripts/build-mcpb.mjs [--out <dir>]      (default output folder: dist)
//
// The bundle is a zip made by the official packer (@anthropic-ai/mcpb, pinned below and fetched from npm into a
// temporary folder, never installed into this project or globally). It holds exactly: manifest.json, icon.png,
// package.json, LICENSE, README.md, the compiled server (build/**/*.js) and the production dependencies
// (node_modules, installed with `npm ci --omit=dev --ignore-scripts` from package-lock.json).
// Node only, so it runs the same on Linux, macOS and Windows.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/** The packer/validator version used here and in CI; bump deliberately. */
export const MCPB_CLI_VERSION = "2.1.2";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const ROOT_FILES = ["manifest.json", "icon.png", "package.json", "LICENSE", "README.md"];
const BUILD_FILE = /^build\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/;
const FORBIDDEN_IN_DEPENDENCIES = /\.map$|(?:^|\/)\.env|\.pem$|\.key$|\.p12$/;

/** Returns a list of problems (empty when the bundle contains exactly what it should). */
export function checkBundleFiles(paths) {
  const problems = [];
  for (const p of paths) {
    if (p.split("/").includes("..")) {
      problems.push(`unexpected file in bundle: ${p}`);
    } else if (p.startsWith("node_modules/")) {
      if (FORBIDDEN_IN_DEPENDENCIES.test(p)) problems.push(`unexpected file in bundle: ${p}`);
    } else if (!(ROOT_FILES.includes(p) || BUILD_FILE.test(p))) {
      problems.push(`unexpected file in bundle: ${p}`);
    }
  }
  for (const r of [...ROOT_FILES, "build/index.js"]) {
    if (!paths.includes(r)) problems.push(`missing from bundle: ${r}`);
  }
  if (!paths.some((p) => p.startsWith("node_modules/"))) problems.push("missing from bundle: node_modules (production dependencies)");
  return problems;
}

function npm(args, cwd) {
  return execFileSync(isWindows ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: isWindows, stdio: ["ignore", "pipe", "inherit"] });
}

let cliPath;
let cliDir;

/** Fetch the pinned packer into a temporary folder (once per process) and return the path of its entry script. */
function ensureCli() {
  if (cliPath) return cliPath;
  cliDir = mkdtempSync(join(tmpdir(), "uts-mcpb-cli-"));
  process.on("exit", () => rmSync(cliDir, { recursive: true, force: true }));
  writeFileSync(join(cliDir, "package.json"), '{ "name": "mcpb-tool", "private": true }\n');
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", `@anthropic-ai/mcpb@${MCPB_CLI_VERSION}`], cliDir);
  cliPath = join(cliDir, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
  return cliPath;
}

function mcpb(args) {
  return execFileSync(process.execPath, [ensureCli(), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** Validate a manifest.json with the official validator; throws when it is not valid. */
export async function validateManifest(manifestPath) {
  mcpb(["validate", manifestPath]);
}

/** Unpack a .mcpb into `dir` with the official tool. */
export async function unpackBundle(file, dir) {
  mkdirSync(dir, { recursive: true });
  mcpb(["unpack", file, dir]);
}

// --- icon: a 512x512 PNG drawn here (a spectrum trace on a dark tile), so no image file or download is needed ---

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function makeIconPng(size = 512) {
  const trace = [
    [0.12, 0.66], [0.26, 0.64], [0.34, 0.5], [0.4, 0.66], [0.5, 0.2], [0.6, 0.66], [0.68, 0.58], [0.76, 0.66], [0.88, 0.64],
  ].map(([x, y]) => [x * size, y * size]);
  const dist = (px, py, [ax, ay], [bx, by]) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const radius = size * 0.18;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let x = 0; x < size; x++) {
      // rounded square tile, transparent outside
      const cx = Math.min(Math.max(x, radius), size - 1 - radius);
      const cy = Math.min(Math.max(y, radius), size - 1 - radius);
      const inside = Math.hypot(x - cx, y - cy) <= radius;
      let rgba = [0, 0, 0, 0];
      if (inside) {
        rgba = [15, 42, 63, 255];
        if (x % (size / 8) < 2 || y % (size / 8) < 2) rgba = [28, 62, 88, 255]; // graticule
        let d = Infinity;
        for (let i = 0; i + 1 < trace.length; i++) d = Math.min(d, dist(x, y, trace[i], trace[i + 1]));
        if (d <= size * 0.016) rgba = [64, 224, 170, 255];
      }
      row.set(rgba, 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function listJs(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listJs(path, base, out);
    else if (/\.js$/.test(name)) out.push(path.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

function listAll(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listAll(path, base, out);
    else out.push(path.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

/** Stage exactly the files the bundle needs into `stage` (an empty folder). */
function stage(stageDir) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(`mcpb/manifest.json version ${manifest.version} does not match package.json ${pkg.version}`);
  }
  if (!existsSync(join(ROOT, "build", "index.js"))) throw new Error("build/index.js not found: run `npm run build` first");

  copyFileSync(join(ROOT, "mcpb", "manifest.json"), join(stageDir, "manifest.json"));
  writeFileSync(join(stageDir, "icon.png"), makeIconPng());
  for (const f of ["package.json", "package-lock.json", "LICENSE", "README.md"]) copyFileSync(join(ROOT, f), join(stageDir, f));
  for (const rel of listJs(join(ROOT, "build"))) {
    const to = join(stageDir, "build", rel);
    mkdirSync(dirname(to), { recursive: true });
    // The .map files are not shipped, so drop the comment that points at them.
    const js = readFileSync(join(ROOT, "build", rel), "utf8").replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm, "");
    writeFileSync(to, js);
  }
  // Production dependencies only; --ignore-scripts keeps the `prepare` script (tsc) from running here.
  npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stageDir);
  rmSync(join(stageDir, "package-lock.json"), { force: true });
  rmSync(join(stageDir, "node_modules", ".package-lock.json"), { force: true });
  rmSync(join(stageDir, "node_modules", ".bin"), { recursive: true, force: true });
}

/** Build the bundle into `outDir` (default `dist`) and check what went into it. Resolves with the file path. */
export async function buildBundle({ outDir = join(ROOT, "dist") } = {}) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const work = mkdtempSync(join(tmpdir(), "uts-mcpb-build-"));
  try {
    const stageDir = join(work, "stage");
    mkdirSync(stageDir);
    stage(stageDir);
    await validateManifest(join(stageDir, "manifest.json"));
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `${pkg.name}-${pkg.version}.mcpb`);
    mcpb(["pack", stageDir, file]);
    const check = join(work, "check");
    await unpackBundle(file, check);
    const problems = checkBundleFiles(listAll(check));
    if (problems.length) throw new Error(`bundle contents are wrong:\n${problems.join("\n")}`);
    return { file };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const outDir = i >= 0 ? resolve(argv[i + 1] ?? "") : join(ROOT, "dist");
  const { file } = await buildBundle({ outDir });
  console.log(`Built ${file} (${statSync(file).size} bytes)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`FAIL ${e.message}`);
    process.exit(1);
  });
}
