/**
 * Front-panel lock detection from a screenshot of the analyzer (issue #172).
 *
 * On the UTS3036B (V1.04.0040) the first ordinary SCPI query puts the analyzer in remote mode and locks the touch
 * screen and buttons until the physical Esc key is pressed, and no readback reports it reliably
 * (docs/verified-hardware.md, "Front-panel lock"). What does show it is the status bar of the 1280x800 screen:
 * while locked a padlock icon appears next to the connection icon (which moves 18 px to the left), and a
 * mouse/touch arrow icon appears behind it.
 *
 * This module decodes the screenshot (PNG as the `screenshot` tool returns it, or the BMP the analyzer sends by
 * default, 24/32 bit; zero dependencies, `node:zlib` only), cuts out the icon area of the status bar and compares it
 * with two reference icons (the padlock and the connection icon) taken from real captures, tolerating a few pixels of
 * shift. It answers "locked", "unlocked" or "unknown": any picture that does not look like that status bar (another
 * screen size, a dialog over the icons, a black screen, a decode failure) is "unknown", never a guess.
 *
 * Image data is untrusted: dimensions and inflated size are capped and every length is checked.
 */
import { inflateSync } from "node:zlib";

/** An 8-bit luminance image, row-major, top row first. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The image cannot be decoded (unsupported format, truncated, corrupt or too large). */
export class PanelImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelImageError";
  }
}

const MAX_SIDE = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const luma = (r: number, g: number, b: number): number => Math.round((299 * r + 587 * g + 114 * b) / 1000);

function checkSize(width: number, height: number, format: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PanelImageError(`${format} image has invalid dimensions ${width}x${height}`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new PanelImageError(`${format} image is too large (${width}x${height}; limit ${MAX_SIDE} per side, ${MAX_PIXELS} pixels)`);
  }
}

/** Decode a PNG (8-bit gray, RGB, palette, gray+alpha or RGBA, not interlaced) or a 24/32-bit BMP to luminance. */
export function decodeImage(input: Uint8Array): GrayImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(buf);
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return decodeBmp(buf);
  throw new PanelImageError("not a PNG or BMP image");
}

function decodePng(buf: Buffer): GrayImage {
  let pos = 8;
  let ihdr: { width: number; height: number; colorType: number } | undefined;
  let palette: Buffer | undefined;
  const idat: Buffer[] = [];
  let ended = false;
  while (pos + 8 <= buf.length && !ended) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const start = pos + 8;
    if (length > buf.length - start - 4) throw new PanelImageError(`truncated PNG (chunk ${type})`);
    const body = buf.subarray(start, start + length);
    if (type === "IHDR") {
      if (length !== 13) throw new PanelImageError("bad PNG header");
      const width = body.readUInt32BE(0);
      const height = body.readUInt32BE(4);
      checkSize(width, height, "PNG");
      if (body[8] !== 8) throw new PanelImageError(`unsupported PNG bit depth ${body[8]} (only 8)`);
      if (body[12] !== 0) throw new PanelImageError("interlaced PNG is not supported");
      const colorType = body[9]!;
      if (![0, 2, 3, 4, 6].includes(colorType)) throw new PanelImageError(`unsupported PNG color type ${colorType}`);
      ihdr = { width, height, colorType };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") ended = true;
    pos = start + length + 4;
  }
  if (!ihdr) throw new PanelImageError("PNG has no header");
  if (idat.length === 0) throw new PanelImageError("PNG has no image data");
  const { width, height, colorType } = ihdr;
  if (colorType === 3 && (!palette || palette.length < 3)) throw new PanelImageError("palette PNG without a palette");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const rowBytes = width * channels;
  const expected = (rowBytes + 1) * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (err) {
    throw new PanelImageError(`PNG image data is corrupt or larger than its header says: ${(err as Error).message}`);
  }
  if (raw.length !== expected) throw new PanelImageError(`PNG image data is ${raw.length} bytes, expected ${expected}`);

  const data = new Uint8Array(width * height);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!;
    const row = Buffer.from(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)));
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let add: number;
      switch (filter) {
        case 0:
          add = 0;
          break;
        case 1:
          add = a;
          break;
        case 2:
          add = b;
          break;
        case 3:
          add = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new PanelImageError(`unknown PNG filter type ${filter}`);
      }
      row[i] = (row[i]! + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const p = x * channels;
      let v: number;
      if (colorType === 0 || colorType === 4) v = row[p]!;
      else if (colorType === 2 || colorType === 6) v = luma(row[p]!, row[p + 1]!, row[p + 2]!);
      else {
        const idx = row[p]!;
        if (idx * 3 + 2 >= palette!.length) throw new PanelImageError("PNG palette index out of range");
        v = luma(palette![idx * 3]!, palette![idx * 3 + 1]!, palette![idx * 3 + 2]!);
      }
      data[y * width + x] = v;
    }
    prev = row;
  }
  return { width, height, data };
}

function decodeBmp(buf: Buffer): GrayImage {
  if (buf.length < 54) throw new PanelImageError("truncated BMP");
  const offset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) throw new PanelImageError(`unsupported BMP header size ${headerSize}`);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  checkSize(width, height, "BMP");
  if (bpp !== 24 && bpp !== 32) throw new PanelImageError(`unsupported BMP depth ${bpp} bit (only 24 and 32)`);
  if (compression !== 0 && !(compression === 3 && bpp === 32)) throw new PanelImageError(`unsupported BMP compression ${compression}`);
  const bytes = bpp / 8;
  const stride = Math.ceil((width * bytes) / 4) * 4;
  if (offset < 54 || offset + stride * height > buf.length) throw new PanelImageError("truncated BMP pixel data");
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const src = offset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = src + x * bytes;
      data[y * width + x] = luma(buf[p + 2]!, buf[p + 1]!, buf[p]!);
    }
  }
  return { width, height, data };
}

// ---- classification -----------------------------------------------------------------------------------------

export type PanelLockState = "locked" | "unlocked" | "unknown";

export interface PanelLockResult {
  state: PanelLockState;
  /** Best overlap (0..1, intersection over union) of the padlock icon with the status bar. */
  padlockScore: number;
  /** Best overlap (0..1) of the connection icon with the status bar. */
  monitorScore: number;
  /** One sentence saying why (always set; for "unknown" it says what was missing). */
  reason: string;
}

/** Screen size the reference positions belong to (UTS3036B). */
const SCREEN = { width: 1280, height: 800 };
/** A pixel at least this bright (0..255) belongs to an icon. */
const ICON_THRESHOLD = 80;
/** Search range around the nominal icon position, in pixels, in x and y. */
const SEARCH = 3;
const LOCKED_MIN = 0.85;
const UNLOCKED_MIN = 0.85;
/** The connection icon itself overlaps the padlock search box by up to ~0.5, so the "no padlock" bound sits above that. */
const UNLOCKED_PADLOCK_MAX = 0.7;

// Reference icons from live captures of a UTS3036B V1.04.0040 status bar (1280x800), thresholded at ICON_THRESHOLD.
// `x`,`y` is the nominal screen position of the top-left corner. The connection icon is at x=785 while unlocked
// and at x=767 while locked (the padlock takes its place at x=787 and shifts it left), so it is searched over both.
const PADLOCK = {
  x: 787,
  y: 757,
  rows: [
    "...######...",
    "..#......#..",
    "..#......#..",
    "..#......#..",
    "..#......#..",
    ".##########.",
    "############",
    "##........##",
    "##...##...##",
    "##...##...##",
    "##........##",
    "############",
  ],
};
const MONITOR = {
  x: 785,
  y: 755,
  /** Search from the locked position (767) to the unlocked one (785), plus the tolerance. */
  xMin: 767 - SEARCH,
  xMax: 785 + SEARCH,
  rows: [
    "#########.......",
    "#.......#.......",
    "#.......#.......",
    "#.......#.......",
    "#########.......",
    "#....###........",
    "####.###########",
    ".#####.........#",
    "....##.........#",
    "....##.........#",
    "....##.........#",
    "....##.........#",
    "....############",
    "....##....#....#",
    ".....##########.",
    ".......######...",
  ],
};

interface Template {
  w: number;
  h: number;
  cells: Array<[number, number]>;
}
const toTemplate = (rows: string[]): Template => ({
  w: rows[0]!.length,
  h: rows.length,
  cells: rows.flatMap((r, y) => Array.from(r).flatMap((c, x): Array<[number, number]> => (c === "#" ? [[x, y]] : []))),
});
const PADLOCK_T = toTemplate(PADLOCK.rows);
const MONITOR_T = toTemplate(MONITOR.rows);

/** Screen area the detector reads (everything both searches can touch), top-left inclusive, bottom-right exclusive. */
const AREA = {
  x0: MONITOR.xMin,
  y0: Math.min(PADLOCK.y, MONITOR.y) - SEARCH,
  x1: Math.max(PADLOCK.x + SEARCH + PADLOCK_T.w, MONITOR.xMax + MONITOR_T.w),
  y1: Math.max(PADLOCK.y + PADLOCK_T.h, MONITOR.y + MONITOR_T.h) + SEARCH,
};

/**
 * Best intersection-over-union of the template's set pixels with the image's bright pixels inside the template box,
 * over the allowed positions. `at(x, y)` gives the brightness at a screen position.
 */
function bestOverlap(t: Template, xs: [number, number], ys: [number, number], at: (x: number, y: number) => number): number {
  let best = 0;
  const tset = new Set(t.cells.map(([x, y]) => y * t.w + x));
  for (let ty = ys[0]; ty <= ys[1]; ty++) {
    for (let tx = xs[0]; tx <= xs[1]; tx++) {
      let inter = 0;
      let imageSet = 0;
      for (let y = 0; y < t.h; y++) {
        for (let x = 0; x < t.w; x++) {
          const bright = at(tx + x, ty + y) >= ICON_THRESHOLD;
          if (bright) imageSet++;
          if (bright && tset.has(y * t.w + x)) inter++;
        }
      }
      const union = t.cells.length + imageSet - inter;
      best = Math.max(best, inter / union); // union >= template size > 0
    }
  }
  return best;
}

/**
 * Classify the front-panel lock from a decoded screenshot.
 *
 * `origin` is the screen position of the image's top-left pixel. Omit it for a full 1280x800 screenshot; pass it for
 * a crop (a crop must cover the status-bar icon area, x 764..806, y 752..778). Anything that is not recognizably
 * that status bar is "unknown".
 */
export function detectPanelLock(image: GrayImage, origin?: { x: number; y: number }): PanelLockResult {
  const unknown = (reason: string, padlockScore = 0, monitorScore = 0): PanelLockResult => ({ state: "unknown", padlockScore, monitorScore, reason });
  if (!origin && (image.width !== SCREEN.width || image.height !== SCREEN.height)) {
    return unknown(`image is ${image.width}x${image.height}, not the ${SCREEN.width}x${SCREEN.height} screen (pass an origin for a crop)`);
  }
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  if (ox > AREA.x0 || oy > AREA.y0 || ox + image.width < AREA.x1 || oy + image.height < AREA.y1) {
    return unknown(`image is too small: it must cover the status-bar icon area x ${AREA.x0}..${AREA.x1 - 1}, y ${AREA.y0}..${AREA.y1 - 1}`);
  }
  const at = (x: number, y: number): number => image.data[(y - oy) * image.width + (x - ox)]!;
  const padlockScore = bestOverlap(PADLOCK_T, [PADLOCK.x - SEARCH, PADLOCK.x + SEARCH], [PADLOCK.y - SEARCH, PADLOCK.y + SEARCH], at);
  const monitorScore = bestOverlap(MONITOR_T, [MONITOR.xMin, MONITOR.xMax], [MONITOR.y - SEARCH, MONITOR.y + SEARCH], at);
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  if (padlockScore >= LOCKED_MIN) {
    return { state: "locked", padlockScore, monitorScore, reason: `padlock icon found in the status bar (match ${pct(padlockScore)})` };
  }
  if (monitorScore >= UNLOCKED_MIN && padlockScore < UNLOCKED_PADLOCK_MAX) {
    return {
      state: "unlocked",
      padlockScore,
      monitorScore,
      reason: `status bar recognized (connection icon match ${pct(monitorScore)}) and no padlock icon (match ${pct(padlockScore)})`,
    };
  }
  return unknown(
    `status bar not recognized (padlock match ${pct(padlockScore)}, connection icon match ${pct(monitorScore)}): another screen, a dialog over the icons, or a different model`,
    padlockScore,
    monitorScore
  );
}

/** Decode a PNG/BMP file and classify it; a decode failure is reported as "unknown" with the reason (never thrown). */
export function detectPanelLockInImageFile(file: Uint8Array, origin?: { x: number; y: number }): PanelLockResult {
  let image: GrayImage;
  try {
    image = decodeImage(file);
  } catch (err) {
    // decodeImage only throws PanelImageError (zlib errors are wrapped), so anything caught is a decode failure
    return { state: "unknown", padlockScore: 0, monitorScore: 0, reason: `cannot read the image: ${(err as Error).message}` };
  }
  return detectPanelLock(image, origin);
}
