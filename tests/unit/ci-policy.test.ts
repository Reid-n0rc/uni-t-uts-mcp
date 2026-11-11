import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("CI policy (issue #145)", () => {
  const ci = read(".github/workflows/ci.yml");

  it("ci.yml has an audit job that fails on high advisories and uses no secrets", () => {
    expect(ci).toMatch(/^ {2}audit:/m);
    expect(ci).toContain("npm audit --omit=dev --audit-level=high");
    const job = ci.slice(ci.indexOf("  audit:"));
    expect(job.split("\n  ")[0]).not.toContain("secrets.");
  });

  it("ci.yml also runs weekly so new advisories surface without a pull request", () => {
    expect(ci).toMatch(/schedule:\s*\n\s*- cron:/);
  });

  it("the scheduled run only executes the audit job", () => {
    const tests = ci.slice(ci.indexOf("  test:"), ci.indexOf("  wiki-check:"));
    expect(tests).toContain("github.event_name != 'schedule'");
  });

  it("dependabot covers npm and github-actions", () => {
    const d = read(".github/dependabot.yml");
    expect(d).toContain("package-ecosystem: npm");
    expect(d).toContain("package-ecosystem: github-actions");
  });

  it("the flaky-test policy is documented", () => {
    const doc = read("CONTRIBUTING.md");
    expect(doc).toMatch(/## Flaky tests/);
    expect(doc).toContain("`flaky`");
  });
});
