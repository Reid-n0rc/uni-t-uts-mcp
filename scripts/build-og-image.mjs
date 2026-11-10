#!/usr/bin/env node
// Render the social preview images from site/og/og.html with headless Chrome (no network, no external assets):
//   site/og.png               1200x630  Open Graph / Twitter card (served by the Pages site)
//   site/social-preview.png   1280x640  GitHub repository social preview (upload by hand in Settings > Social preview)
// The tool count on the image is the number of tools the built server registers (run `npm run build` first),
// so regenerating after adding tools keeps it current. Plain Node, no dependencies.
//   node scripts/build-og-image.mjs [--chrome <path>] [--check]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export const TARGETS = [
  { file: "site/og.png", width: 1200, height: 630 },
  { file: "site/social-preview.png", width: 1280, height: 640 },
];

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChrome(explicit) {
  const found = [explicit, process.env.CHROME_PATH, ...CHROME_CANDIDATES].find((p) => p && existsSync(p));
  if (!found) throw new Error("Chrome not found: pass --chrome <path> or set CHROME_PATH");
  return found;
}

/** Number of tools registered by the built server (build/server.js). */
export async function registeredToolCount() {
  const serverJs = join(root, "build", "server.js");
  if (!existsSync(serverJs)) throw new Error("build/server.js is missing: run `npm run build` first");
  const sdk = (p) => import(pathToFileURL(join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href);
  const { createServer } = await import(pathToFileURL(serverJs).href);
  const { Client } = await sdk("client/index.js");
  const { InMemoryTransport } = await sdk("inMemory.js");
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "og-image", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

/** The HTML source with the tool count filled in and the canvas size set. */
export function renderHtml(template, toolCount, width, height) {
  if (!template.includes("{{TOOLS}}")) throw new Error("site/og/og.html is missing the {{TOOLS}} placeholder");
  return template.split("{{TOOLS}}").join(String(toolCount)).split("--w: 1200px; --h: 630px;").join(`--w: ${width}px; --h: ${height}px;`);
}

export async function buildOgImages({ chrome } = {}) {
  const chromePath = findChrome(chrome);
  const toolCount = await registeredToolCount();
  const template = readFileSync(join(root, "site", "og", "og.html"), "utf8");
  const tmp = mkdtempSync(join(tmpdir(), "og-"));
  try {
    for (const t of TARGETS) {
      const html = join(tmp, `${t.width}x${t.height}.html`);
      writeFileSync(html, renderHtml(template, toolCount, t.width, t.height));
      execFileSync(chromePath, [
        "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
        "--no-first-run", "--disable-extensions", `--user-data-dir=${join(tmp, "profile")}`,
        `--window-size=${t.width},${t.height}`, `--screenshot=${join(root, t.file)}`, pathToFileURL(html).href,
      ], { stdio: "ignore", timeout: 60000 });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { toolCount, files: TARGETS.map((t) => t.file) };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  const i = process.argv.indexOf("--chrome");
  const result = await buildOgImages({ chrome: i >= 0 ? process.argv[i + 1] : undefined });
  console.log(`Rendered ${result.files.join(" and ")} (${result.toolCount} tools)`);
}
