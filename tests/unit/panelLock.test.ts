import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { decodeImage, detectPanelLock, detectPanelLockInImageFile, PanelImageError, type GrayImage } from "../../src/panelLock.js";

// Fixtures: 95x35 crops of the status bar (x 740, y 745 of the 1280x800 screen) of a UTS3036B V1.04.0040:
// only the connection/lock icons, no text, serial number or address (docs/verified-hardware.md, "Front-panel lock").
const ORIGIN = { x: 740, y: 745 };
const fixture = (name: string) => readFileSync(new URL(`../fixtures/panel-lock/${name}`, import.meta.url));

// ---- helpers to build images -------------------------------------------------------------------------------

const CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = ~0;
  for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(w: number, h: number, colorType: number, rowBytes: number, row: (y: number) => Buffer, opts: { interlace?: number; filter?: (y: number) => number; extra?: Buffer[]; bitDepth?: number } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ?? 0;
  const raw = Buffer.alloc((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = opts.filter?.(y) ?? 0;
    row(y).copy(raw, y * (rowBytes + 1) + 1);
  }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), ...(opts.extra ?? []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function bmp(w: number, h: number, bpp: number, px: (x: number, y: number) => [number, number, number], topDown = false) {
  const bytes = bpp / 8;
  const stride = Math.ceil((w * bytes) / 4) * 4;
  const out = Buffer.alloc(54 + stride * h);
  out.write("BM", 0, "latin1");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(topDown ? -h : h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bpp, 28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const row = topDown ? y : h - 1 - y;
      const p = 54 + row * stride + x * bytes;
      out[p] = b;
      out[p + 1] = g;
      out[p + 2] = r;
    }
  }
  return out;
}

// ---- decoding -----------------------------------------------------------------------------------------------

describe("decodeImage", () => {
  it("decodes an 8-bit RGB PNG to luminance", () => {
    const img = decodeImage(png(2, 1, 2, 6, () => Buffer.from([255, 0, 0, 0, 255, 0])));
    expect(img.width).toBe(2);
    expect(img.height).toBe(1);
    expect(Array.from(img.data)).toEqual([76, 150]);
  });

  it("decodes RGBA, gray and gray+alpha PNGs", () => {
    expect(Array.from(decodeImage(png(1, 1, 6, 4, () => Buffer.from([255, 255, 255, 0]))).data)).toEqual([255]);
    expect(Array.from(decodeImage(png(3, 1, 0, 3, () => Buffer.from([0, 128, 255]))).data)).toEqual([0, 128, 255]);
    expect(Array.from(decodeImage(png(2, 1, 4, 4, () => Buffer.from([10, 255, 200, 0]))).data)).toEqual([10, 200]);
  });

  it("decodes a palette PNG", () => {
    const plte = chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255]));
    const img = decodeImage(png(2, 1, 3, 2, () => Buffer.from([1, 0]), { extra: [plte] }));
    expect(Array.from(img.data)).toEqual([255, 0]);
  });

  it("undoes every PNG row filter", () => {
    // 3x5 gray image; row y uses filter y (None, Sub, Up, Average, Paeth) applied by hand to the plain rows.
    const plain = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
      [130, 140, 150],
    ];
    const filtered = (y: number): Buffer => {
      const cur = plain[y]!;
      const up = y > 0 ? plain[y - 1]! : [0, 0, 0];
      return Buffer.from(
        cur.map((v, i) => {
          const a = i > 0 ? cur[i - 1]! : 0;
          const b = up[i]!;
          const c = i > 0 ? up[i - 1]! : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          const pred = [0, a, b, (a + b) >> 1, paeth][y]!;
          return (v - pred) & 255;
        })
      );
    };
    const img = decodeImage(png(3, 5, 0, 3, filtered, { filter: (y) => y }));
    expect(Array.from(img.data)).toEqual(plain.flat());
  });

  it("decodes bottom-up and top-down 24 and 32 bit BMPs", () => {
    const px = (x: number, y: number): [number, number, number] => (x === 1 && y === 0 ? [255, 255, 255] : [0, 0, 0]);
    for (const bpp of [24, 32]) {
      for (const topDown of [false, true]) {
        const img = decodeImage(bmp(3, 2, bpp, px, topDown));
        expect([img.width, img.height]).toEqual([3, 2]);
        expect(Array.from(img.data)).toEqual([0, 255, 0, 0, 0, 0]);
      }
    }
  });

  it("rejects what it cannot decode with a PanelImageError", () => {
    const bad: Record<string, Buffer> = {
      empty: Buffer.alloc(0),
      "unknown format": Buffer.from("GIF89a....."),
      "truncated PNG": png(2, 1, 2, 6, () => Buffer.alloc(6)).subarray(0, 40),
      "interlaced PNG": png(2, 1, 2, 6, () => Buffer.alloc(6), { interlace: 1 }),
      "16-bit PNG": png(1, 1, 0, 2, () => Buffer.alloc(2), { bitDepth: 16 }),
      "bad filter": png(1, 1, 0, 1, () => Buffer.alloc(1), { filter: () => 9 }),
      "palette without PLTE": png(1, 1, 3, 1, () => Buffer.alloc(1)),
      "truncated BMP": bmp(4, 4, 24, () => [0, 0, 0]).subarray(0, 60),
      "8-bit BMP": (() => {
        const b = bmp(2, 2, 24, () => [0, 0, 0]);
        b.writeUInt16LE(8, 28);
        return b;
      })(),
    };
    for (const [name, data] of Object.entries(bad)) {
      expect(() => decodeImage(data), name).toThrow(PanelImageError);
    }
  });

  it("refuses absurd dimensions instead of allocating them", () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(100000, 0);
    ihdr.writeUInt32BE(100000, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const huge = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(8))), chunk("IEND", Buffer.alloc(0))]);
    expect(() => decodeImage(huge)).toThrow(/too large/i);
    const b = bmp(2, 2, 24, () => [0, 0, 0]);
    b.writeInt32LE(100000, 18);
    b.writeInt32LE(100000, 22);
    expect(() => decodeImage(b)).toThrow(/too large/i);
  });

  it("does not inflate a PNG without bound", () => {
    // 1x1 image whose IDAT inflates to far more than the header says it needs.
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    const bomb = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(50_000_000))), chunk("IEND", Buffer.alloc(0))]);
    expect(() => decodeImage(bomb)).toThrow(PanelImageError);
  });
});

// ---- classification -----------------------------------------------------------------------------------------

describe("detectPanelLock on real status-bar crops", () => {
  it("reports the locked fixture as locked", () => {
    const r = detectPanelLockInImageFile(fixture("locked-statusbar.png"), ORIGIN);
    expect(r.state).toBe("locked");
    expect(r.padlockScore).toBeGreaterThan(0.9);
  });

  it("reports the unlocked fixture as unlocked", () => {
    const r = detectPanelLockInImageFile(fixture("unlocked-statusbar.png"), ORIGIN);
    expect(r.state).toBe("unlocked");
    expect(r.monitorScore).toBeGreaterThan(0.9);
    expect(r.padlockScore).toBeLessThan(0.7);
  });

  it("still classifies when the icons are one or two pixels off", () => {
    for (const name of ["locked-statusbar.png", "unlocked-statusbar.png"]) {
      const expected = name.startsWith("locked") ? "locked" : "unlocked";
      for (const dx of [-2, -1, 1, 2]) {
        for (const dy of [-1, 1]) {
          const r = detectPanelLockInImageFile(fixture(name), { x: ORIGIN.x + dx, y: ORIGIN.y + dy });
          expect(r.state, `${name} shifted ${dx},${dy}`).toBe(expected);
        }
      }
    }
  });

  it("is insensitive to a uniform brightness change and mild noise", () => {
    const img = decodeImage(fixture("locked-statusbar.png"));
    const noisy: GrayImage = { ...img, data: img.data.map((v, i) => Math.min(255, Math.max(0, Math.round(v * 0.9) + (i % 3) - 1))) };
    expect(detectPanelLock(noisy, ORIGIN).state).toBe("locked");
  });

  it("works on a full 1280x800 screenshot, as PNG or BMP", () => {
    const crop = decodeImage(fixture("locked-statusbar.png"));
    const full = (locked: boolean) => (x: number, y: number): [number, number, number] => {
      const cx = x - ORIGIN.x;
      const cy = y - ORIGIN.y;
      if (!locked) return [0, 0, 0];
      const v = cx >= 0 && cy >= 0 && cx < crop.width && cy < crop.height ? crop.data[cy * crop.width + cx]! : 0;
      return [v, v, v];
    };
    const shot = bmp(1280, 800, 32, full(true));
    expect(detectPanelLockInImageFile(shot).state).toBe("locked");
    const shotPng = png(1280, 800, 2, 1280 * 3, (y) => {
      const row = Buffer.alloc(1280 * 3);
      for (let x = 0; x < 1280; x++) row.set(full(true)(x, y), x * 3);
      return row;
    });
    expect(detectPanelLockInImageFile(shotPng).state).toBe("locked");
  });
});

describe("detectPanelLock reports unknown rather than guessing", () => {
  const blank = (w: number, h: number, v = 0): GrayImage => ({ width: w, height: h, data: new Uint8Array(w * h).fill(v) });

  it("black, white and uniform-gray status bars are unknown", () => {
    for (const v of [0, 128, 255]) expect(detectPanelLock(blank(95, 35, v), ORIGIN).state).toBe("unknown");
  });

  it("a crop that does not cover the status-bar icons is unknown", () => {
    const r = detectPanelLock(blank(30, 10), ORIGIN);
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(/cover|small/i);
  });

  it("a full-screen image of another size is unknown", () => {
    expect(detectPanelLock(blank(800, 480)).state).toBe("unknown");
  });

  it("an undecodable file is unknown with the decode error as the reason, not a throw", () => {
    const r = detectPanelLockInImageFile(Buffer.from("not an image"));
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(/PNG|BMP|image/i);
  });
});
