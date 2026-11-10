// Helpers used by the release workflows (.github/workflows/npm-publish.yml and release.yml).
//
//   node scripts/release-tools.mjs check-tag <tag>        fail unless <tag> is v<package.json version>
//   node scripts/release-tools.mjs notes <tag> [out.md]   write the CHANGELOG section for <tag> (exit 3 if none)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Body of `## [version]` in a Keep a Changelog file, or null when missing or empty. */
export function extractChangelogSection(markdown, version) {
  const wanted = version.replace(/^v/, "").toLowerCase();
  const lines = markdown.split(/\r?\n/);
  const heading = /^##\s+\[?([^\]\s]+)\]?(?:\s|$)/;
  const start = lines.findIndex((l) => {
    const m = heading.exec(l);
    return m !== null && m[1].toLowerCase() === wanted;
  });
  if (start < 0) return null;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l) || /^\[[^\]]+\]:\s/.test(l)) break;
    body.push(l);
  }
  const text = body.join("\n").trim();
  return text === "" ? null : text;
}

/** Error message when the git tag does not match the package version, else null. */
export function checkTagMatchesVersion(tag, version) {
  const t = tag.replace(/^refs\/tags\//, "");
  if (!t.startsWith("v")) return `tag "${t}" must start with "v" (expected v${version})`;
  if (t.slice(1) !== version) {
    return `tag ${t} (version ${t.slice(1)}) does not match package.json version ${version}; bump package.json, merge, then tag v${version}`;
  }
  return null;
}

function main() {
  const [cmd, tag, out] = process.argv.slice(2);
  const root = new URL("../", import.meta.url);
  if (cmd === "check-tag" && tag) {
    const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const problem = checkTagMatchesVersion(tag, version);
    if (problem) {
      console.error(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`OK: tag ${tag} matches package.json version ${version}`);
  } else if (cmd === "notes" && tag) {
    const text = extractChangelogSection(readFileSync(new URL("CHANGELOG.md", root), "utf8"), tag);
    if (text === null) {
      console.error(`No CHANGELOG.md section for ${tag}`);
      process.exit(3);
    }
    if (out) writeFileSync(out, text + "\n");
    else console.log(text);
  } else {
    console.error("usage: release-tools.mjs check-tag <tag> | notes <tag> [out.md]");
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
