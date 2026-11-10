import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NPM_PUBLISHED, tarballUrl, githubSpec, dockerImage } from "../../scripts/client-config.mjs";

/**
 * Every install instruction in the README, site and docs must work today. The package is live on
 * npm (0.1.0), so `npx -y uni-t-uts-mcp` is the lead install form and must be present and unmarked:
 * no "coming soon" or "not published" wording about npm may remain. No regular expressions are
 * built from variable text here.
 */
const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
const V = pkg.version;
const read = (p: string) => readFileSync(join(root, p), "utf8");

const docFiles = ["README.md", ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const textFiles = [...docFiles, "site/index.html", "CONTRIBUTING.md"];

function jsonBlocks(md: string): { text: string; before: string }[] {
  const lines = md.split("\n");
  const out: { text: string; before: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "```json") {
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length && lines[j].trim() !== "```") body.push(lines[j++]);
      out.push({ text: body.join("\n"), before: lines.slice(Math.max(0, i - 4), i).join("\n") });
      i = j;
    }
  }
  return out;
}

const NPM_FORM = `npx -y ${pkg.name}`;
/** True when `text` contains the bare npm-registry form (not followed by a longer package name). */
function npmFormOffsets(text: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(NPM_FORM, from);
    if (i < 0) return hits;
    const next = text.charAt(i + NPM_FORM.length);
    if (next !== "-") hits.push(i);
    from = i + NPM_FORM.length;
  }
}

describe("install docs are truthful", () => {
  it("every JSON block in README and docs parses, and its command is something that works today", () => {
    let count = 0;
    for (const f of docFiles) {
      for (const b of jsonBlocks(read(f))) {
        let parsed: { mcpServers?: Record<string, { command: string; args?: string[] }> };
        expect(() => (parsed = JSON.parse(b.text)), `${f}: invalid JSON block`).not.toThrow();
        parsed = JSON.parse(b.text);
        if (!parsed.mcpServers) continue;
        for (const s of Object.values(parsed.mcpServers)) {
          count++;
          const args = s.args ?? [];
          const flat = [s.command, ...args];
          if (flat.includes("npx") || s.command === "npx") {
            const spec = args[args.length - 1];
            if (spec === pkg.name) {
              expect(/coming soon/i.test(b.before), `${f}: npm form must not be marked coming soon`).toBe(false);
            } else {
              expect([tarballUrl(V), githubSpec(V)], `${f}: unknown npx spec ${spec}`).toContain(spec);
            }
          } else if (s.command === "docker") {
            expect(args[args.length - 1], `${f}: docker image`).toBe(dockerImage(V));
          } else if (s.command === "node") {
            const entry = args[0].replaceAll("\\\\", "/").replaceAll("\\", "/");
            expect(entry.endsWith("/build/index.js") && existsSync(join(root, "src", "index.ts")), `${f}: node path ${entry}`).toBe(true);
          } else {
            expect(s.command, `${f}: unexpected command`).toBe("cmd");
            expect(args[0]).toBe("/c");
          }
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("README shows the working install commands for the current package version", () => {
    const readme = read("README.md");
    expect(readme).toContain(`npx -y ${tarballUrl(V)}`);
    expect(readme).toContain(`npx -y ${githubSpec(V)}`);
    expect(readme).toContain(`docker run -i --rm -e UTS_IP=192.168.1.100 ${dockerImage(V)}`);
    expect(readme).toContain("claude mcp add uni-t-uts -e UTS_IP=");
    expect(readme).toContain("npm run client-config");
    expect(readme).toContain("cmd /c");
    expect(readme).toMatch(/UTS_IP[^\n]*optional/i);
    expect(readme).toMatch(/connect to the analyzer at/i);
  });

  it("every release download URL and image tag in the docs matches the version format", () => {
    for (const f of textFiles) {
      const text = read(f);
      let from = 0;
      for (;;) {
        const i = text.indexOf("releases/download/", from);
        if (i < 0) break;
        let end = i;
        while (end < text.length && !" \"'`\n&".includes(text.charAt(end)) && (text.charAt(end) !== "<" || text.startsWith("<version>", end))) end++;
        const url = "https://github.com/Reid-n0rc/uni-t-uts-mcp/" + text.slice(i, end).replaceAll("<version>", V);
        if (!url.endsWith("/")) expect(url, `${f}`).toBe(tarballUrl(V));
        from = end;
      }
      from = 0;
      for (;;) {
        const i = text.indexOf("ghcr.io/reid-n0rc/uni-t-uts-mcp", from);
        if (i < 0) break;
        const rest = text.slice(i + "ghcr.io/reid-n0rc/uni-t-uts-mcp".length);
        if (rest.startsWith(":")) {
          const normalized = rest.slice(1).replaceAll("<version>", V).replaceAll("<major>.<minor>", V.split(".").slice(0, 2).join("."));
          const tag = normalized.split(/[\s"'`,)<&]/)[0];
          expect(["0.1.0", V, "latest", `${V.split(".").slice(0, 2).join(".")}`].includes(tag), `${f}: image tag ${tag}`).toBe(true);
        }
        from = i + 1;
      }
    }
  });

  it("npm is switched on and the package name in the README command matches package.json", () => {
    expect(NPM_PUBLISHED).toBe(true);
    expect(pkg.name).toBe("uni-t-uts-mcp");
    const readme = read("README.md");
    expect(readme).toContain(`claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y ${pkg.name}\n`);
    expect(readme).toContain(`claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- cmd /c npx -y ${pkg.name}\n`);
    expect(readme).toContain(`{ "mcpServers": { "uni-t-uts": { "command": "npx", "args": ["-y", "${pkg.name}"]`);
    expect(readme).toContain(`"args": ["/c", "npx", "-y", "${pkg.name}"]`);
    // the npm form comes first, ahead of the tarball, github: and Docker alternatives
    const npmAt = readme.indexOf(`-- npx -y ${pkg.name}\n`);
    expect(npmAt).toBeGreaterThan(-1);
    for (const alt of [tarballUrl(V), githubSpec(V), dockerImage(V)]) expect(npmAt).toBeLessThan(readme.indexOf(alt));
  });

  it("no document still says the npm package is coming soon or not published", () => {
    const stale = ["coming soon", "not published", "not been published", "after the first npm publish", "not on npm"];
    const wikiDir = "docs/wiki";
    const wikiFiles = readdirSync(join(root, wikiDir)).filter((f) => f.endsWith(".md")).map((f) => `${wikiDir}/${f}`);
    for (const f of [...textFiles, ...wikiFiles]) {
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        const l = line.toLowerCase();
        if (!l.includes("npm")) return;
        for (const phrase of stale) expect(l.includes(phrase), `${f}:${i + 1} still says "${phrase}" next to npm`).toBe(false);
      });
    }
    // the npm form appears in README, the site and the wiki Getting Started page
    for (const f of ["README.md", "site/index.html", "docs/wiki/Getting-Started.md"]) {
      expect(npmFormOffsets(read(f)).length, `${f}: needs the npm install form`).toBeGreaterThan(0);
    }
    // the CHANGELOG [Unreleased] section does not call npm coming soon either
    const unreleased = read("CHANGELOG.md").split("## [0.1.0]")[0].toLowerCase();
    expect(unreleased).not.toContain("coming soon");
  });

  it("the site quick start leads with the working commands and stays self-contained", () => {
    const site = read("site/index.html");
    expect(site).toContain(tarballUrl(V));
    expect(site).toContain(githubSpec(V));
    expect(site).toContain(dockerImage(V));
    expect(site).toContain("claude mcp add uni-t-uts");
    expect(site).not.toContain("Not on npm or Docker yet");
    const quick = site.slice(site.indexOf('id="quickstart"'));
    expect(quick.indexOf(tarballUrl(V))).toBeGreaterThan(-1);
    expect(quick).toContain(`claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y ${pkg.name}`);
    expect(quick.toLowerCase()).not.toContain("coming soon");
    expect(quick.indexOf(`-- npx -y ${pkg.name}`)).toBeLessThan(quick.indexOf(tarballUrl(V)));
    // no external requests: no script/link/img/iframe sources pointing at http(s)
    for (const tag of ['src="http', "src='http", '<link href="http', "url(http", "@import"]) expect(site).not.toContain(tag);
  });

  it("docs/releasing.md names every place to flip when npm goes live", () => {
    const rel = read("docs/releasing.md");
    expect(rel).toContain("NPM_PUBLISHED");
    expect(rel).toContain("scripts/client-config.mjs");
    expect(rel).not.toContain("Adding npm later");
  });

  it("docs/releasing.md documents that npm is live, trusted publishing and the asynchronous first publish", () => {
    const rel = read("docs/releasing.md");
    expect(rel).toContain("Trusted Publisher");
    expect(rel).toContain("npm-publish.yml");
    expect(rel).toContain("Reid-n0rc");
    expect(rel).toContain("NODE_AUTH_TOKEN");
    expect(rel).toContain("0.0.0-stage");
    expect(rel).toContain("npm view");
    expect(rel).not.toContain("is not on the npm registry");
  });
});
