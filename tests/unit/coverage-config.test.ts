import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("coverage reporting (Codecov)", () => {
  it("has a test:coverage script and the v8 provider as a dev dependency", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["test:coverage"]).toContain("--coverage");
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBeTruthy();
    expect(pkg.dependencies?.["@vitest/coverage-v8"]).toBeUndefined();
  });

  it("writes lcov for src only and keeps the output out of git", () => {
    const cfg = read("vitest.config.ts");
    expect(cfg).toContain('provider: "v8"');
    expect(cfg).toContain("lcov");
    expect(cfg).toContain("src/**");
    expect(read(".gitignore").split("\n")).toContain("coverage/");
  });

  it("has a codecov.yml", () => {
    expect(existsSync(new URL("../../codecov.yml", import.meta.url))).toBe(true);
  });

  it("uploads from exactly one CI job with a SHA-pinned action and the token from a secret", () => {
    const ci = read(".github/workflows/ci.yml");
    const uses = ci.split("\n").filter((l) => l.includes("codecov/codecov-action"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/@[0-9a-f]{40} # v/);
    expect(ci).toContain("token: ${{ secrets.CODECOV_TOKEN }}");
    expect(ci).toContain("fail_ci_if_error: false");
    expect(ci).toContain("npm run test:coverage");
  });

  it("shows the badge in the README", () => {
    expect(read("README.md")).toContain("codecov.io/gh/Reid-n0rc/uni-t-uts-mcp");
  });
});
