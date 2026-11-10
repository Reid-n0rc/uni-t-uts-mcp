#!/usr/bin/env node
// Build the GitHub Pages site into _site/ (or --out <dir>): site/index.html with the tool list
// generated from docs/tools-reference.md. Plain Node, no dependencies; works on any OS.
//   node scripts/build-site.mjs [--out <dir>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseToolsReference, renderSite } from "./site-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function buildSite({ root = resolve(here, ".."), outDir = join(root, "_site"), descriptions = {} } = {}) {
  const siteDir = join(root, "site");
  const soundtrack = readFileSync(join(siteDir, "soundtrack.cjs"), "utf8");
  if (/<\/script|<!--/i.test(soundtrack)) throw new Error("site/soundtrack.cjs must not contain a closing script tag or an HTML comment opener");
  let template = readFileSync(join(siteDir, "index.html"), "utf8");
  if (!template.includes("<!--SOUNDTRACK_JS-->")) throw new Error("Template is missing the <!--SOUNDTRACK_JS--> placeholder");
  template = template.split("<!--SOUNDTRACK_JS-->").join(soundtrack);
  const groups = parseToolsReference(readFileSync(join(root, "docs", "tools-reference.md"), "utf8"));

  mkdirSync(outDir, { recursive: true });
  // Any extra assets next to the template are copied as they are.
  for (const entry of readdirSync(siteDir)) {
    if (entry === "index.html" || entry === "soundtrack.cjs") continue; // the soundtrack is inlined, not shipped
    cpSync(join(siteDir, entry), join(outDir, entry), { recursive: true });
  }
  writeFileSync(join(outDir, "index.html"), renderSite(template, groups, descriptions));
  writeFileSync(join(outDir, ".nojekyll"), "");

  return {
    outDir,
    toolCount: groups.reduce((n, g) => n + g.tools.length, 0),
    groupCount: groups.length,
  };
}

/** Tool descriptions as registered by the built server (build/server.js), if it has been built. */
async function loadDescriptions(root) {
  const serverJs = join(root, "build", "server.js");
  if (!existsSync(serverJs)) return {};
  try {
    const { createServer } = await import(pathToFileURL(serverJs).href);
    const sdk = (path) => import(pathToFileURL(join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", path)).href);
    const { Client } = await sdk("client/index.js");
    const { InMemoryTransport } = await sdk("inMemory.js");
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "site-build", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    return Object.fromEntries(tools.filter((t) => t.description).map((t) => [t.name, t.description]));
  } catch (err) {
    console.warn(`Could not read tool descriptions from the built server (${err.message}); using the docs.`);
    return {};
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  const i = process.argv.indexOf("--out");
  const outDir = i >= 0 ? resolve(process.argv[i + 1]) : undefined;
  const root = resolve(here, "..");
  const descriptions = await loadDescriptions(root);
  const result = buildSite({ ...(outDir ? { outDir } : {}), descriptions });
  console.log(`Built ${result.outDir}: ${result.toolCount} tools in ${result.groupCount} groups (${Object.keys(descriptions).length} descriptions from the server)`);
  if (!existsSync(join(result.outDir, "index.html"))) process.exit(1);
}
