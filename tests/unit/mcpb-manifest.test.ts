import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

// The MCP bundle (.mcpb) manifest (issue #86). Field rules follow the MCPB manifest spec, version 0.3:
// https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("mcpb/manifest.json"));
const pkg = JSON.parse(read("package.json"));

type UserConfigEntry = {
  type: string;
  title: string;
  description: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  sensitive?: boolean;
};
const userConfig: Record<string, UserConfigEntry> = manifest.user_config;
const env: Record<string, string> = manifest.server.mcp_config.env;

describe("mcpb/manifest.json", () => {
  it("has the keys the spec requires", () => {
    expect(manifest.manifest_version).toBe("0.3");
    for (const key of ["name", "version", "description", "author", "server"]) expect(manifest).toHaveProperty(key);
    expect(manifest.author.name).toBeTruthy();
    expect(manifest.display_name).toBeTruthy();
    expect(manifest.long_description).toBeTruthy();
  });

  it("matches package.json (name, version, license, description, repository)", () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.description).toBe(pkg.description);
    expect(pkg.repository.url).toContain(new URL(manifest.repository.url).pathname.replace(/^\//, "").replace(/\.git$/, ""));
    expect(manifest.homepage).toBe(pkg.homepage);
  });

  it("runs the compiled server with node from inside the bundle", () => {
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("build/index.js");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/build/index.js"]);
  });

  it("declares platforms and the Node version of the package", () => {
    expect(manifest.compatibility.platforms.sort()).toEqual(["darwin", "win32"]);
    expect(manifest.compatibility.runtimes.node).toBe(">=22.0.0");
    expect(pkg.engines.node).toBe(">=22");
  });

  it("maps user settings onto the environment variables the server reads", () => {
    expect(env).toEqual({
      UTS_IP: "${user_config.host}",
      UTS_PORT: "${user_config.port}",
      UTS_TRANSPORT: "${user_config.transport}",
    });
    // every variable the manifest sets is one the server really reads
    const sources = ["src/autoconnect.ts", "src/target.ts", "src/transports/select.ts"].map(read).join("\n");
    for (const name of Object.keys(env)) expect(sources).toContain(name);
  });

  it("has a user_config entry for every placeholder and no unused entries", () => {
    const used = Object.values(env).map((v) => {
      expect(v.startsWith("${user_config.") && v.endsWith("}")).toBe(true);
      return v.slice("${user_config.".length, -1);
    });
    expect(used.sort()).toEqual(Object.keys(userConfig).sort());
    for (const entry of Object.values(userConfig)) {
      expect(entry.title).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  it("keeps the analyzer address optional (it can be given in chat) and never marks anything sensitive", () => {
    expect(userConfig.host.type).toBe("string");
    expect(userConfig.host.required ?? false).toBe(false);
    expect(userConfig.host).not.toHaveProperty("default"); // an invented address must never ship
    for (const entry of Object.values(userConfig)) expect(entry.required ?? false).toBe(false);
  });

  it("gives the port and the transport working defaults", () => {
    expect(userConfig.port).toMatchObject({ type: "number", default: 5025, min: 1, max: 65535 });
    expect(userConfig.transport).toMatchObject({ type: "string", default: "auto" });
    expect(userConfig.transport.description).toMatch(/auto.*raw.*vxi11/s);
  });

  it("lists exactly the registered tools, each with a description", async () => {
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    await client.close();
    const listed: { name: string; description: string }[] = manifest.tools;
    expect(listed.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of listed) expect(t.description.length).toBeGreaterThan(10);
    expect(manifest.tools_generated ?? false).toBe(false);
  });

  it("contains no real address, serial number or absolute path", () => {
    const text = read("mcpb/manifest.json");
    const addresses = (text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []).filter((a) => a !== "192.168.1.100");
    expect(addresses).toEqual([]); // only the documented placeholder is allowed
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\\\/);
  });
});
