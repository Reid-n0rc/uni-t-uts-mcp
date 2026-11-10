import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractChangelogSection, checkTagMatchesVersion } from "../../scripts/release-tools.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Something new.

## [0.2.0] - 2026-02-01

### Fixed
- A bug.

## [0.1.0] - 2026-01-01

### Added
- First release.

[Unreleased]: https://example.invalid/compare/v0.2.0...HEAD
[0.2.0]: https://example.invalid/compare/v0.1.0...v0.2.0
`;

describe("extractChangelogSection", () => {
  it("returns the body of the matching version section", () => {
    expect(extractChangelogSection(CHANGELOG, "0.2.0")).toBe("### Fixed\n- A bug.");
  });

  it("accepts a leading v and stops at link reference definitions", () => {
    expect(extractChangelogSection(CHANGELOG, "v0.1.0")).toBe("### Added\n- First release.");
  });

  it("returns null when there is no such section or it is empty", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
    expect(extractChangelogSection("## [1.0.0] - 2026-01-01\n\n## [0.9.0]\n- x\n", "1.0.0")).toBeNull();
  });

  it("does not match a version that is only a prefix", () => {
    expect(extractChangelogSection(CHANGELOG, "0.1")).toBeNull();
  });
});

describe("checkTagMatchesVersion", () => {
  it("accepts v<version>", () => {
    expect(checkTagMatchesVersion("v0.1.0", "0.1.0")).toBeNull();
  });
  it("accepts refs/tags/ form", () => {
    expect(checkTagMatchesVersion("refs/tags/v1.2.3", "1.2.3")).toBeNull();
  });
  it("explains a mismatch", () => {
    expect(checkTagMatchesVersion("v0.1.0", "0.0.0")).toMatch(/v0\.1\.0.*0\.1\.0.*0\.0\.0/);
  });
  it("rejects a tag without the v prefix", () => {
    expect(checkTagMatchesVersion("0.1.0", "0.1.0")).toMatch(/start with "v"/);
  });
});

describe("repository changelog", () => {
  const text = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

  it("has an Unreleased heading (it is empty right after a release)", () => {
    expect(text).toMatch(/^## \[Unreleased\]/m);
  });

  it("has a non-empty section for the version in package.json, so the release workflow can use it as notes", () => {
    expect(text).toMatch(new RegExp(`^## \\[${pkg.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`, "m"));
    const section = extractChangelogSection(text, pkg.version);
    expect(section).not.toBeNull();
    expect(section!.trim().length).toBeGreaterThan(0);
  });

  it("links the Unreleased and current-version sections", () => {
    expect(text).toMatch(/^\[Unreleased\]: https:\/\/github\.com\/Reid-n0rc\/uni-t-uts-mcp\/compare\/v[0-9.]+\.\.\.HEAD$/m);
    expect(text).toMatch(new RegExp(`^\\[${pkg.version.replace(/\./g, "\\.")}\\]: https://github\\.com/`, "m"));
  });
});

describe("installing straight from GitHub (no registry)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

  it("builds on git installs via the prepare script", () => {
    expect(pkg.scripts.prepare).toBe("npm run build");
  });

  it("keeps the Docker image build independent of prepare (no sources or tsc at npm ci time)", () => {
    const installs = dockerfile.split("\n").filter((l) => /npm ci/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).toContain("--ignore-scripts");
  });
});
