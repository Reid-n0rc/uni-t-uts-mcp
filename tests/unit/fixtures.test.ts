import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Captured instrument fixtures must stay byte-exact on every OS. A git checkout that
// converts line endings (core.autocrlf) or re-encodes them would change these hashes;
// .gitattributes marks tests/fixtures/** as -text to prevent that.
const FIXTURES: Record<string, { size: number; sha256: string }> = {
  "p1-basics-probe.txt": { size: 2121, sha256: "e0161b7b7d4a1ef681e503430e0b10fc089a389b0c59f6400e13724c54e530e5" },
  "p2/p2-probe-output.txt": { size: 1753, sha256: "6e405b6c753fb0f12fecaf1a3a48f4d4113b283b2f2c271545190850b4f8db32" },
  "p2/screenshot-data-header.hex": { size: 98, sha256: "ffd0f74344924883629d06760341ebf222723c415e7a0cf07b845fbf549ba327" },
  "p2/screenshot-zbmp-header.hex": { size: 98, sha256: "24762b2bd223624b9c44f1ccd3804dbb069d7b504ebfe01291922b12bba78228" },
  "p2/trace1-ascii.txt": { size: 14015, sha256: "b47d2bd73b633167b9a0f9643a974d6f9152d06ecc752279a9ffe7233b558f8b" },
  "p2/trace1-real32.bin": { size: 4012, sha256: "a649ec94fa141b965e0b8153381b9b32f8325192e18b9911bd888adf6ca87013" },
  "p2/trace1-real64.bin": { size: 8016, sha256: "f598ca6d8bcb716d6742bd26896380115a572eac5586c7b0d787655a1bbc2dc3" },
};

describe("fixtures are byte-exact", () => {
  for (const [name, expected] of Object.entries(FIXTURES)) {
    it(name, () => {
      const data = readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
      expect(data.length, "size (line-ending conversion changes it)").toBe(expected.size);
      expect(createHash("sha256").update(data).digest("hex")).toBe(expected.sha256);
    });
  }

  it("the ASCII trace keeps its CRLF terminator", () => {
    const data = readFileSync(new URL("../fixtures/p2/trace1-ascii.txt", import.meta.url));
    expect(data.subarray(-2).toString("latin1")).toBe("\r\n");
  });
});
