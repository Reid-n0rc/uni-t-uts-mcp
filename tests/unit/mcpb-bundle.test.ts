import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBundleFiles, buildBundle, unpackBundle, validateManifest, MCPB_CLI_VERSION } from "../../scripts/build-mcpb.mjs";
import { smokeTest, countRegisteredTools } from "../../scripts/smoke-mcp.mjs";

const ROOT = new URL("../../", import.meta.url);
const rootPath = (rel: string) => new URL(rel, ROOT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pkg = JSON.parse(readFileSync(rootPath("package.json"), "utf8"));

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, base, out);
    else out.push(path.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

describe("checkBundleFiles (allowlist for the files inside the .mcpb)", () => {
  const good = [
    "manifest.json",
    "icon.png",
    "package.json",
    "LICENSE",
    "README.md",
    "build/index.js",
    "build/tools/trace.js",
    "node_modules/zod/index.js",
    "node_modules/@modelcontextprotocol/sdk/package.json",
  ];

  it("accepts the expected layout", () => {
    expect(checkBundleFiles(good)).toEqual([]);
  });

  it.each([
    "build/index.js.map",
    "build/index.d.ts",
    "src/index.ts",
    "tests/unit/scpi.test.ts",
    "docs/tools-reference.md",
    "site/index.html",
    "scripts/build-mcpb.mjs",
    ".github/workflows/ci.yml",
    ".env",
    ".env.local",
    "package-lock.json",
    "Dockerfile",
    "key.pem",
    "node_modules/zod/dist/index.js.map",
    "build/../escape.js",
  ])("rejects %s", (file) => {
    expect(checkBundleFiles([...good, file]).join("\n")).toContain(file);
  });

  it.each(["manifest.json", "icon.png", "package.json", "LICENSE", "README.md", "build/index.js"])(
    "requires %s",
    (file) => {
      expect(checkBundleFiles(good.filter((f) => f !== file)).join("\n")).toContain(file);
    }
  );

  it("requires production dependencies to be bundled", () => {
    expect(checkBundleFiles(good.filter((f) => !f.startsWith("node_modules/"))).join("\n")).toMatch(/node_modules/);
  });
});

// The real bundle is built with the official packer, fetched from npm (pinned), so these run only when asked for:
//   npm run test:mcpb          (or MCPB_BUNDLE_TEST=1 on a POSIX shell; CI runs it in the "mcpb bundle" job)
const wanted = Boolean(process.env.MCPB_BUNDLE_TEST) || process.env.npm_lifecycle_event === "test:mcpb";
describe.skipIf(!wanted)("the built .mcpb bundle", () => {
  let work: string;
  let file: string;
  let unpacked: string;
  let files: string[];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "uts-mcpb-test-"));
    ({ file } = await buildBundle({ outDir: join(work, "out") }));
    unpacked = join(work, "unpacked");
    await unpackBundle(file, unpacked);
    files = walk(unpacked);
  }, 600_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("is named uni-t-uts-mcp-<version>.mcpb", () => {
    expect(file.split(/[\\/]/).pop()).toBe(`uni-t-uts-mcp-${pkg.version}.mcpb`);
  });

  it("pins the official packer version", () => {
    expect(MCPB_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("passes the official manifest validator", async () => {
    await validateManifest(join(unpacked, "manifest.json"));
  });

  it("contains exactly the expected files", () => {
    expect(checkBundleFiles(files)).toEqual([]);
    const built = walk(rootPath("build")).filter((f) => f.endsWith(".js"));
    expect(files.filter((f) => f.startsWith("build/")).sort()).toEqual(built.map((f) => `build/${f}`).sort());
  });

  it("bundles only production dependencies", () => {
    const lock = JSON.parse(readFileSync(rootPath("package-lock.json"), "utf8"));
    const production = Object.entries<{ dev?: boolean }>(lock.packages)
      .filter(([path, meta]) => path.startsWith("node_modules/") && !meta.dev)
      .map(([path]) => path);
    const inBundle = new Set(files.filter((f) => f.startsWith("node_modules/")).map((f) => f.split("/node_modules/").length));
    expect(inBundle.size).toBeGreaterThan(0);
    for (const f of files.filter((f) => f.startsWith("node_modules/"))) {
      const owner = production.filter((p) => f === p || f.startsWith(`${p}/`));
      expect(owner.length, `${f} belongs to no production dependency`).toBeGreaterThan(0);
    }
    expect(files).not.toContain("node_modules/vitest/package.json");
    expect(files).not.toContain("node_modules/typescript/package.json");
  });

  it("has no source map references, absolute paths, addresses, serial numbers or secrets in its own files", () => {
    const own = files.filter((f) => !f.startsWith("node_modules/") && f !== "icon.png");
    for (const f of own) {
      const text = readFileSync(join(unpacked, f), "utf8");
      expect(text, `${f} refers to a source map`).not.toMatch(/sourceMappingURL/);
      expect(text, `${f} has an absolute path`).not.toMatch(/\/Users\/|\/home\/runner|[A-Za-z]:\\Users|\/private\/tmp/);
      expect(text, `${f} has a private key or token`).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|npm_[A-Za-z0-9]{30}/);
      const addresses = (text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []).filter(
        (a) => !["192.168.1.100", "127.0.0.1", "0.0.0.0"].includes(a)
      );
      expect(addresses, `${f} has an unexpected IP address`).toEqual([]);
      expect(text, `${f} has what looks like a serial number`).not.toMatch(/\bUTS\d{4}[A-Z]?\w*\s*(?:SN|serial)\b|\bSN[:= ]+[A-Z0-9]{8,}/i);
    }
  });

  it("starts from an empty folder as a stdio MCP server (initialize + tools/list)", async () => {
    const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
    const mc = manifest.server.mcp_config;
    const args = (mc.args as string[]).map((a) => a.replace("${__dirname}", unpacked));
    const result = await smokeTest({
      command: mc.command,
      args,
      expectedTools: await countRegisteredTools(),
      timeoutMs: 60_000,
    });
    expect(result.serverName).toBe("uni-t-uts-mcp");
  }, 120_000);
});
