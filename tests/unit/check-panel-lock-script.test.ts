import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/check-panel-lock.mjs", import.meta.url));
const built = existsSync(fileURLToPath(new URL("../../build/panelLock.js", import.meta.url)));
const fixture = (n: string) => fileURLToPath(new URL(`../fixtures/panel-lock/${n}`, import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, UTS_IP: "" } });

// The script imports the built modules (as the other scripts do), so these run once `npm run build` has.
describe.skipIf(!built)("scripts/check-panel-lock.mjs", () => {
  it("exits 1 and says press Esc only when the panel is locked", () => {
    const r = run("--file", fixture("locked-statusbar.png"), "--origin", "740,745");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/press Esc/);
  });
  it("exits 0 without mentioning Esc when unlocked", () => {
    const r = run("--file", fixture("unlocked-statusbar.png"), "--origin", "740,745");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Esc/);
  });
  it("exits 2 for an unreadable image, a bad origin and a missing host", () => {
    expect(run("--file", fixture("locked-statusbar.png")).status).toBe(2); // a crop without --origin
    expect(run("--file", fixture("locked-statusbar.png"), "--origin", "x").status).toBe(2);
    expect(run().status).toBe(2);
  });
});
