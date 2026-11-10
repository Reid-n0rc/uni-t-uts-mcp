import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * .github/workflows/npm-publish.yml publishes in one of two ways: with the NPM_TOKEN secret, or
 * through npm trusted publishing (OIDC, no token) once the repository variable
 * NPM_TRUSTED_PUBLISHING is `true`. With neither it must skip cleanly (green run).
 * Plain string checks on the file, no YAML parser and no regular expressions built from text.
 */
const text = readFileSync(new URL("../../.github/workflows/npm-publish.yml", import.meta.url), "utf8");

/** Steps as text blocks, split on the "- name:" step markers. */
const steps = text.split("\n      - name: ").slice(1).map((block) => "- name: " + block);
const stepNamed = (fragment: string) => steps.find((s) => s.split("\n")[0].includes(fragment));
const withoutComments = (s: string) =>
  s
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

describe("npm-publish.yml (token or trusted publishing)", () => {
  it("only runs for version tags and has the id-token permission", () => {
    expect(text).toContain('- "v*"');
    expect(text).toContain("id-token: write");
    expect(withoutComments(text)).not.toContain("pull_request");
  });

  it("decides from both the secret and the NPM_TRUSTED_PUBLISHING variable", () => {
    expect(text).toContain("secrets.NPM_TOKEN != ''");
    expect(text).toContain("vars.NPM_TRUSTED_PUBLISHING == 'true'");
  });

  it("skips cleanly (a notice, no failure) only when neither is configured", () => {
    const skip = stepNamed("Skip when");
    expect(skip).toBeDefined();
    expect(skip!).toContain("env.HAS_NPM_TOKEN != 'true'");
    expect(skip!).toContain("env.TRUSTED_PUBLISHING != 'true'");
    expect(skip!).toContain("::notice::");
  });

  it("runs every other step when either the token or trusted publishing is enabled", () => {
    // The two Publish steps have their own, narrower conditions (tested below).
    const others = steps.filter((s) => !s.split("\n")[0].includes("Skip when") && !s.split("\n")[0].includes("Publish ("));
    expect(others.length).toBeGreaterThan(5);
    for (const s of others) {
      const condition = s.split("\n").find((l) => l.trim().startsWith("if:")) ?? "";
      expect(condition, `step "${s.split("\n")[0]}" needs the combined condition`).toContain("env.HAS_NPM_TOKEN == 'true'");
      expect(condition, `step "${s.split("\n")[0]}" needs the combined condition`).toContain("env.TRUSTED_PUBLISHING == 'true'");
    }
  });

  it("has a token publish step that passes the secret and runs only when the secret exists", () => {
    const s = stepNamed("Publish (token)");
    expect(s).toBeDefined();
    expect(s!).toContain("npm publish --provenance --access public");
    expect(s!).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(s!).toContain("env.HAS_NPM_TOKEN == 'true'");
  });

  it("has a trusted-publishing step with no token and no secret reference, used when there is no token", () => {
    const s = stepNamed("Publish (trusted publishing");
    expect(s).toBeDefined();
    expect(s!).toContain("npm publish --provenance --access public");
    expect(s!).not.toContain("NODE_AUTH_TOKEN");
    expect(s!).not.toContain("secrets.");
    expect(s!).toContain("env.HAS_NPM_TOKEN != 'true'");
    expect(s!).toContain("env.TRUSTED_PUBLISHING == 'true'");
  });

  it("still checks the tag against package.json and the tarball contents before publishing", () => {
    expect(stepNamed("Check the tag matches package.json")).toBeDefined();
    expect(stepNamed("Check the tarball contents")).toBeDefined();
  });

  it("references the secret only in the env mapping and the token step", () => {
    const occurrences = withoutComments(text)
      .split("\n")
      .filter((l) => l.includes("secrets."));
    expect(occurrences.length).toBe(2);
  });
});
