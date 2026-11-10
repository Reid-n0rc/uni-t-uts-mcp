#!/usr/bin/env node
// Build the GitHub Pages site into _site/ (or --out <dir>): site/index.html with the tool list
// generated from docs/tools-reference.md. Plain Node, no dependencies; works on any OS.
//   node scripts/build-site.mjs [--out <dir>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseToolsReference, renderSite } from "./site-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function buildSite({ root = resolve(here, ".."), outDir = join(root, "_site") } = {}) {
  const siteDir = join(root, "site");
  const template = readFileSync(join(siteDir, "index.html"), "utf8");
  const groups = parseToolsReference(readFileSync(join(root, "docs", "tools-reference.md"), "utf8"));

  mkdirSync(outDir, { recursive: true });
  // Any extra assets next to the template are copied as they are.
  for (const entry of readdirSync(siteDir)) {
    if (entry === "index.html") continue;
    cpSync(join(siteDir, entry), join(outDir, entry), { recursive: true });
  }
  writeFileSync(join(outDir, "index.html"), renderSite(template, groups));
  writeFileSync(join(outDir, ".nojekyll"), "");

  return {
    outDir,
    toolCount: groups.reduce((n, g) => n + g.tools.length, 0),
    groupCount: groups.length,
  };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  const i = process.argv.indexOf("--out");
  const outDir = i >= 0 ? resolve(process.argv[i + 1]) : undefined;
  const result = buildSite(outDir ? { outDir } : {});
  console.log(`Built ${result.outDir}: ${result.toolCount} tools in ${result.groupCount} groups`);
  if (!existsSync(join(result.outDir, "index.html"))) process.exit(1);
}
