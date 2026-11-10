import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS = join(__dirname, "..", "..", ".github", "workflows");

const isHex40 = (s: string): boolean => s.length === 40 && [...s].every((c) => "0123456789abcdef".includes(c));

/** Returns a problem description for a workflow line, or null when the line is fine (plain string scanning, no dynamic regex). */
export function checkUsesLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return null;
  const dash = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
  if (!dash.startsWith("uses:")) return null;
  const hash = dash.indexOf("#");
  const comment = hash >= 0 ? dash.slice(hash + 1).trim() : "";
  const ref = (hash >= 0 ? dash.slice(0, hash) : dash).slice("uses:".length).trim().replace(/^["']|["']$/g, "");
  if (ref.startsWith("./") || ref.startsWith("docker://")) return null;
  const at = ref.lastIndexOf("@");
  if (at < 0 || !ref.slice(0, at).includes("/")) return `not owner/repo@<sha>: ${ref}`;
  if (!isHex40(ref.slice(at + 1))) return `not pinned to a 40-hex commit SHA: ${ref}`;
  if (comment === "") return `missing "# <version>" comment: ${ref}`;
  return null;
}

describe("GitHub Actions are pinned to commit SHAs", () => {
  it("checker accepts pinned, local and docker:// uses and rejects the rest", () => {
    const sha = "a".repeat(40);
    expect(checkUsesLine(`  - uses: actions/checkout@${sha} # v7`)).toBeNull();
    expect(checkUsesLine(`        uses: github/codeql-action/init@${sha} # v4`)).toBeNull();
    expect(checkUsesLine("      - uses: ./.github/actions/local")).toBeNull();
    expect(checkUsesLine("      - uses: docker://alpine:3.20")).toBeNull();
    expect(checkUsesLine("#   uses: actions/setup-example@v1")).toBeNull();
    expect(checkUsesLine("  - uses: actions/checkout@v7")).not.toBeNull();
    expect(checkUsesLine("  - uses: actions/checkout@main # main")).not.toBeNull();
    expect(checkUsesLine(`  - uses: actions/checkout@${sha}`)).not.toBeNull();
    expect(checkUsesLine(`  - uses: actions/checkout@${"g".repeat(40)} # v7`)).not.toBeNull();
    expect(checkUsesLine(`  - uses: actions/checkout@${sha.slice(1)} # v7`)).not.toBeNull();
  });

  it("every uses: in .github/workflows is pinned and has a version comment", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(join(WORKFLOWS, f), "utf8").split("\n").forEach((line, i) => {
        const problem = checkUsesLine(line);
        if (problem) offenders.push(`${f}:${i + 1}: ${problem}`);
      });
    }
    expect(offenders, `Unpinned actions:\n${offenders.join("\n")}`).toEqual([]);
  });
});
