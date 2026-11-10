// Release smoke check (a): the npm tarball must contain only the built JavaScript and
// declarations, README, LICENSE and package.json.
//
//   node scripts/check-pack.mjs            runs `npm pack --dry-run --json` and checks the file list
//   node scripts/check-pack.mjs list.json  checks a saved `npm pack --json` output instead
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_FILES = ["LICENSE", "README.md", "package.json"];
const REQUIRED = [...ROOT_FILES, "build/index.js"];
const BUILD_FILE = /^build\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:js|d\.ts)$/;

/** Returns a list of problems (empty when the tarball contents are acceptable). */
export function checkPackFiles(paths) {
  const problems = [];
  for (const p of paths) {
    const ok = ROOT_FILES.includes(p) || (BUILD_FILE.test(p) && !p.split("/").includes(".."));
    if (!ok) problems.push(`unexpected file in tarball: ${p}`);
  }
  for (const r of REQUIRED) {
    if (!paths.includes(r)) problems.push(`missing from tarball: ${r}`);
  }
  return problems;
}

function main() {
  const arg = process.argv[2];
  let raw;
  if (arg) {
    raw = readFileSync(arg, "utf8");
  } else {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    raw = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  }
  const files = JSON.parse(raw)[0].files.map((f) => f.path);
  const problems = checkPackFiles(files);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`OK: ${files.length} files, only build js/d.ts, README.md, LICENSE and package.json`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
