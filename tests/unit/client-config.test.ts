import { describe, it, expect } from "vitest";
import {
  NPM_PUBLISHED,
  buildServerConfig,
  claudeCodeCommand,
  jsonConfig,
  main,
  tarballUrl,
  githubSpec,
  dockerImage,
  validateHost,
} from "../../scripts/client-config.mjs";

const V = "0.1.0";
const HOST = "192.168.1.100";
const POSIX_ENTRY = "/home/user/uni-t-uts-mcp/build/index.js";
const WIN_ENTRY = "C:\\Users\\user\\uni-t-uts-mcp\\build\\index.js";

describe("client config printer", () => {
  it("builds the release URLs from the version", () => {
    expect(tarballUrl(V)).toBe("https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/download/v0.1.0/uni-t-uts-mcp-0.1.0.tgz");
    expect(githubSpec(V)).toBe("github:Reid-n0rc/uni-t-uts-mcp#v0.1.0");
    expect(dockerImage(V)).toBe("ghcr.io/reid-n0rc/uni-t-uts-mcp:0.1.0");
  });

  it("local config on posix runs node on the absolute path", () => {
    expect(buildServerConfig({ host: HOST, source: "local", version: V, platform: "linux", entry: POSIX_ENTRY })).toEqual({
      command: "node",
      args: [POSIX_ENTRY],
      env: { UTS_IP: HOST },
    });
  });

  it("local config on Windows keeps the backslash path, and the JSON escapes it", () => {
    const opts = { host: HOST, source: "local" as const, version: V, platform: "win32", entry: WIN_ENTRY };
    expect(buildServerConfig(opts).args).toEqual([WIN_ENTRY]);
    const parsed = JSON.parse(jsonConfig(opts));
    expect(parsed.mcpServers["uni-t-uts"].args[0]).toBe(WIN_ENTRY);
    expect(jsonConfig(opts)).toContain("C:\\\\Users");
  });

  it("npx forms use cmd /c on Windows only", () => {
    const posix = buildServerConfig({ host: HOST, source: "tarball", version: V, platform: "darwin" });
    expect(posix).toEqual({ command: "npx", args: ["-y", tarballUrl(V)], env: { UTS_IP: HOST } });
    const win = buildServerConfig({ host: HOST, source: "github", version: V, platform: "win32" });
    expect(win).toEqual({ command: "cmd", args: ["/c", "npx", "-y", githubSpec(V)], env: { UTS_IP: HOST } });
  });

  it("docker passes the address with -e and pins the version", () => {
    expect(buildServerConfig({ host: HOST, source: "docker", version: V, platform: "linux" })).toEqual({
      command: "docker",
      args: ["run", "-i", "--rm", "-e", `UTS_IP=${HOST}`, dockerImage(V)],
    });
  });

  it("omits UTS_IP when no host is given", () => {
    const cfg = buildServerConfig({ source: "tarball", version: V, platform: "linux" });
    expect(cfg.env).toBeUndefined();
    expect(claudeCodeCommand({ source: "tarball", version: V, platform: "linux" })).toBe(`claude mcp add uni-t-uts -- npx -y ${tarballUrl(V)}`);
  });

  it("prints the Claude Code one-liner for posix and Windows", () => {
    expect(claudeCodeCommand({ host: HOST, source: "tarball", version: V, platform: "linux" })).toBe(
      `claude mcp add uni-t-uts -e UTS_IP=${HOST} -- npx -y ${tarballUrl(V)}`
    );
    expect(claudeCodeCommand({ host: HOST, source: "tarball", version: V, platform: "win32" })).toBe(
      `claude mcp add uni-t-uts -e UTS_IP=${HOST} -- cmd /c npx -y ${tarballUrl(V)}`
    );
    expect(claudeCodeCommand({ host: HOST, source: "local", version: V, platform: "linux", entry: "/home/my user/x/build/index.js" })).toBe(
      `claude mcp add uni-t-uts -e UTS_IP=${HOST} -- node '/home/my user/x/build/index.js'`
    );
    expect(claudeCodeCommand({ host: HOST, source: "local", version: V, platform: "win32", entry: "C:\\Program Files\\x\\build\\index.js" })).toBe(
      `claude mcp add uni-t-uts -e UTS_IP=${HOST} -- node "C:\\Program Files\\x\\build\\index.js"`
    );
  });

  it("rejects unsafe hosts", () => {
    expect(validateHost(HOST)).toBeNull();
    expect(validateHost("analyzer.local")).toBeNull();
    expect(validateHost("a b")).not.toBeNull();
    expect(validateHost("1.2.3.4; rm -rf /")).not.toBeNull();
    expect(validateHost("")).not.toBeNull();
  });

  it("main prints both blocks, never writes, and reports bad arguments", () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), platform: "linux", entry: POSIX_ENTRY, version: V };
    expect(main(["--host", HOST], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`claude mcp add uni-t-uts -e UTS_IP=${HOST} -- node ${POSIX_ENTRY}`);
    expect(text).toContain('"mcpServers"');
    expect(text).toContain("connect to the analyzer at");
    expect(main(["--host", "bad host"], io)).toBe(2);
    expect(main(["--bogus"], io)).toBe(2);
    expect(main(["--from", "nope"], io)).toBe(2);
    if (!NPM_PUBLISHED) expect(main(["--from", "npm"], io)).toBe(2);
  });
});
