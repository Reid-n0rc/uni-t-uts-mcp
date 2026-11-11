import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pluginFiles, sync, PLACEHOLDER_HOST } from "../../scripts/client-snippets.mjs";

// The Claude Code plugin and marketplace (issue #87). Field rules are from the official docs:
// https://code.claude.com/docs/en/plugins/marketplace-reference.md (marketplace.json, plugin entries)
// https://code.claude.com/docs/en/plugins-reference (plugin.json, userConfig, ${user_config.KEY})
// https://code.claude.com/docs/en/mcp (plugin .mcp.json uses the mcpServers wrapper)
const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLUGIN_DIR = "plugins/uni-t-uts";

const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as {
  name: string;
  owner: { name: string };
  description?: string;
  plugins: { name: string; source: string; description?: string }[];
};
const manifest = JSON.parse(read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)) as {
  name: string;
  version: string;
  description: string;
  author: { name: string };
  license: string;
  userConfig: Record<string, { type: string; title: string; description: string; default?: unknown; options?: string[]; sensitive?: boolean; min?: number; max?: number; required?: boolean }>;
};
const mcp = JSON.parse(read(`${PLUGIN_DIR}/.mcp.json`)) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };

describe(".claude-plugin/marketplace.json", () => {
  it("has the required top-level fields and valid, non-reserved names", () => {
    expect(marketplace.name).toMatch(NAME);
    expect(marketplace.name).not.toMatch(/^(claude|anthropic)|official/i);
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.description).toBeTruthy();
    expect(Array.isArray(marketplace.plugins)).toBe(true);
  });

  it("lists the uni-t-uts plugin by a relative ./ source that exists and has no ..", () => {
    expect(marketplace.plugins.map((p) => p.name)).toEqual(["uni-t-uts"]);
    const entry = marketplace.plugins[0];
    expect(entry.name).toMatch(NAME);
    expect(entry.source).toBe(`./${PLUGIN_DIR}`);
    expect(entry.source).not.toContain("..");
    expect(existsSync(join(root, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
    expect(entry.description).toBeTruthy();
  });

  it("entry name equals the manifest name", () => {
    expect(manifest.name).toBe(marketplace.plugins[0].name);
  });
});

describe("plugin.json", () => {
  it("is consistent with package.json", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe("MIT");
    expect(manifest.description).toBeTruthy();
    expect(manifest.author.name).toBeTruthy();
  });

  it("declares user config in the documented shape (host, port, transport; nothing sensitive)", () => {
    expect(Object.keys(manifest.userConfig).sort()).toEqual(["analyzer_host", "analyzer_port", "transport"]);
    for (const [key, o] of Object.entries(manifest.userConfig)) {
      expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(["string", "number", "boolean", "directory", "file"]).toContain(o.type);
      expect(o.title).toBeTruthy();
      expect(o.description).toBeTruthy();
      expect(o.sensitive).toBeUndefined();
      expect(Object.keys(o).every((k) => ["type", "title", "description", "required", "default", "options", "multiple", "sensitive", "min", "max"].includes(k))).toBe(true);
    }
    expect(manifest.userConfig.analyzer_port).toMatchObject({ type: "number", default: 5025, min: 1, max: 65535 });
    expect(manifest.userConfig.transport.options).toEqual(["auto", "raw", "vxi11"]);
    expect(manifest.userConfig.transport.default).toBe("auto");
    expect(manifest.userConfig.analyzer_host.required).not.toBe(true);
  });
});

describe("plugins/uni-t-uts/.mcp.json", () => {
  const server = mcp.mcpServers["uni-t-uts"];

  it("starts the published npm package pinned to the package.json version", () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(["uni-t-uts"]);
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", `uni-t-uts-mcp@${pkg.version}`]);
  });

  it("passes host, port and transport from the plugin user config, and references only declared options", () => {
    expect(server.env).toEqual({
      UTS_IP: "${user_config.analyzer_host}",
      UTS_PORT: "${user_config.analyzer_port}",
      UTS_TRANSPORT: "${user_config.transport}",
    });
    for (const v of Object.values(server.env)) {
      const key = /^\$\{user_config\.(\w+)\}$/.exec(v)?.[1];
      expect(manifest.userConfig).toHaveProperty(key!);
    }
  });
});

describe("plugin files are generated and private-data free", () => {
  it("clients:check finds them in sync", () => {
    expect(sync({ root })).toEqual([]);
  });

  it("pluginFiles(version) renders the pin for any version", () => {
    const files = pluginFiles("9.8.7") as Record<string, string>;
    expect(JSON.parse(files[`${PLUGIN_DIR}/.mcp.json`]).mcpServers["uni-t-uts"].args).toEqual(["-y", "uni-t-uts-mcp@9.8.7"]);
    expect(JSON.parse(files[`${PLUGIN_DIR}/.claude-plugin/plugin.json`]).version).toBe("9.8.7");
  });

  it("contains no real address, secret or serial number", () => {
    const all = [".claude-plugin/marketplace.json", `${PLUGIN_DIR}/.claude-plugin/plugin.json`, `${PLUGIN_DIR}/.mcp.json`].map(read).join("\n");
    expect(all).not.toMatch(/\b(?!192\.168\.1\.100\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(all).not.toMatch(/serial|token|password|secret/i);
    expect(PLACEHOLDER_HOST).toBe("192.168.1.100");
  });

  it("the docs describe the two commands", () => {
    for (const f of ["README.md", "docs/wiki/Getting-Started.md", "docs/wiki/Add-to-Client.md", "docs/releasing.md"]) {
      expect(read(f), f).toContain("plugin");
    }
    expect(read("docs/wiki/Add-to-Client.md")).toContain("/plugin marketplace add Reid-n0rc/uni-t-uts-mcp");
    expect(read("docs/wiki/Add-to-Client.md")).toContain("/plugin install uni-t-uts@uni-t-uts-mcp");
    expect(read("docs/releasing.md")).toContain("plugins/uni-t-uts");
  });
});
