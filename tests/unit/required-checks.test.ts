import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** The checks documented in docs/releasing.md as required by the protect-main ruleset (issue #148). */
function documented(): string[] {
  const doc = read("docs/releasing.md");
  const m = /<!-- required-checks:begin -->\s*```text\n([\s\S]*?)```\s*<!-- required-checks:end -->/.exec(doc);
  if (!m) throw new Error("required-checks block missing from docs/releasing.md");
  return m[1].split("\n").map((l) => l.trim()).filter(Boolean);
}

const list = (s: string): string[] => s.split(",").map((x) => x.trim());

/** Expected check names from the workflows (simple parse; update it if a job's naming scheme changes). */
function expected(): string[] {
  const ci = read(".github/workflows/ci.yml");
  const out: string[] = ["CodeQL"];
  const jobs = ci.slice(ci.indexOf("\njobs:")).split(/\n {2}(?=[a-z][\w-]*:\n)/).slice(1);
  for (const job of jobs) {
    const id = job.split(":")[0];
    const nameLine = /^ {4}name: (.+)$/m.exec(job)?.[1];
    const name = nameLine?.replace(/^"|"$/g, "") ?? id;
    const os = /^ {8}os: \[(.+)\]$/m.exec(job)?.[1];
    const node = /^ {8}node-version: \[(.+)\]$/m.exec(job)?.[1];
    const include = [...job.matchAll(/- \{ os: ([\w-]+), node-version: (\d+),/g)];
    if (job.includes("github.event_name != 'schedule'") === false && /^ {4}if: /m.test(job)) {
      throw new Error(`job ${id} has a condition; a conditional job must not be required`);
    }
    if (id === "test" && os && node) {
      for (const o of list(os)) for (const n of list(node)) out.push(`test (${o}, ${n})`);
    } else if (id === "mcpb-bundle" && os) {
      for (const o of list(os)) out.push(`mcpb bundle (${o})`);
    } else if (id === "install-smoke") {
      for (const m of include) out.push(`npm install smoke (${m[1]}, node ${m[2]})`);
    } else {
      expect(name, `job ${id} has an unexpanded matrix name`).not.toContain("${{");
      out.push(name);
    }
  }
  const cq = read(".github/workflows/codeql.yml");
  for (const m of cq.matchAll(/^ +- language: ([\w-]+)$/gm)) out.push(`Analyze (${m[1]})`);
  return out;
}

describe("required status checks (issue #148)", () => {
  it("docs/releasing.md lists exactly the checks the workflows produce", () => {
    expect([...documented()].sort()).toEqual([...expected()].sort());
  });

  it("the list has 21 entries and no codecov or CodeRabbit check", () => {
    const d = documented();
    expect(d).toHaveLength(21);
    expect(d.join("\n")).not.toMatch(/codecov|coderabbit/i);
  });
});
