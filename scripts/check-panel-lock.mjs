#!/usr/bin/env node
// Report whether the analyzer's front panel is locked, from a screenshot (issue #172). Run `npm run build` first.
//   node scripts/check-panel-lock.mjs                 screenshot over VXI-11 from $UTS_IP (or the first argument host)
//   node scripts/check-panel-lock.mjs --file shot.png [--origin 740,745]   classify a saved PNG/BMP (a crop needs --origin)
// Sends one query, :DISPlay:DATA? (no setters). Exit status: 0 unlocked, 1 locked (press Esc), 2 unknown/could not check.
// Prints one line; "press Esc" appears only when the panel is locked.
import { readFileSync } from "node:fs";
import { detectPanelLockInImageFile } from "../build/panelLock.js";
import { checkPanelLockOnInstrument } from "../build/panelLockCapture.js";

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const file = take("--file");
const originArg = take("--origin");
let origin;
if (originArg !== undefined) {
  const m = /^(\d+),(\d+)$/.exec(originArg);
  if (!m) {
    console.error("--origin must be x,y (screen position of the image's top-left pixel)");
    process.exit(2);
  }
  origin = { x: Number(m[1]), y: Number(m[2]) };
}

let result;
if (file) {
  try {
    result = detectPanelLockInImageFile(readFileSync(file), origin);
  } catch (err) {
    console.error(`cannot read ${file}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
} else {
  const host = args[0] || process.env.UTS_IP;
  if (!host) {
    console.error("Usage: node scripts/check-panel-lock.mjs [host] | --file <png|bmp> [--origin x,y]   (host defaults to $UTS_IP)");
    process.exit(2);
  }
  result = await checkPanelLockOnInstrument(host);
}

if (result.state === "locked") console.log(`LOCKED: press Esc on the analyzer to return it to local mode (${result.reason})`);
else if (result.state === "unlocked") console.log(`unlocked: the front panel is usable (${result.reason})`);
else console.log(`unknown: could not tell whether the panel is locked (${result.reason})`);
process.exit(result.state === "unlocked" ? 0 : result.state === "locked" ? 1 : 2);
