import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Plain, precise wording: the instrument "ignores commands" (drops them) while a single sweep runs
 * on the raw socket. Describing that as the instrument being "hard of hearing" made a quirk sound
 * like a defect, so that word must not creep back into the docs, site, source or tests.
 * (The pattern is built from pieces so this file does not contain the word itself.)
 */
const BANNED = new RegExp("\\bde" + "af\\b", "i");
const ROOT = new URL("../../", import.meta.url);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "build") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(md|html|ts|mjs|json|yml|txt)$/.test(name)) out.push(path);
  }
  return out;
}

describe("wording", () => {
  it("does not use the old jargon in docs, site, source or tests", () => {
    const root = ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const files = [
      ...["docs", "site", "src", "tests", "scripts"].flatMap((d) => {
        try {
          return walk(join(root, d));
        } catch {
          return [];
        }
      }),
      join(root, "README.md"),
      join(root, "AGENTS.md"),
      join(root, "CONTRIBUTING.md"),
    ];
    const offenders = files.filter((f) => BANNED.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => f.slice(root.length)),
      "Use plain wording such as 'ignores commands during a single sweep' (see issue #80)."
    ).toEqual([]);
  });
});
