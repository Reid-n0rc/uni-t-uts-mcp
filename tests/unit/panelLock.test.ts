import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { bmp, chunk, png, SIG } from "../panelLockImages.js";
import { decodeImage, detectPanelLock, detectPanelLockInImageFile, PanelImageError, type GrayImage } from "../../src/panelLock.js";

// Fixtures: 95x35 crops of the status bar (x 740, y 745 of the 1280x800 screen) of a UTS3036B V1.04.0040:
// only the connection/lock icons, no text, serial number or address (docs/verified-hardware.md, "Front-panel lock").
const ORIGIN = { x: 740, y: 745 };
const fixture = (name: string) => readFileSync(new URL(`../fixtures/panel-lock/${name}`, import.meta.url));

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

  it("rejects more malformed files", () => {
    const ihdr = (len: number, w = 1, h = 1, ct = 0) => {
      const b = Buffer.alloc(len);
      b.writeUInt32BE(w, 0);
      b.writeUInt32BE(h, 4);
      b[8] = 8;
      b[9] = ct;
      return chunk("IHDR", b);
    };
    const idat = (n: number) => chunk("IDAT", deflateSync(Buffer.alloc(n)));
    const end = chunk("IEND", Buffer.alloc(0));
    const bad: Record<string, Buffer> = {
      "chunk longer than file": png(2, 1, 2, 6, () => Buffer.alloc(6)).subarray(0, 50),
      "short IHDR": Buffer.concat([SIG, ihdr(12), idat(2), end]),
      "unknown color type": Buffer.concat([SIG, ihdr(13, 1, 1, 5), idat(2), end]),
      "no IHDR": Buffer.concat([SIG, end]),
      "no IDAT": Buffer.concat([SIG, ihdr(13), end]),
      "zero width": Buffer.concat([SIG, ihdr(13, 0, 1), idat(2), end]),
      "corrupt zlib": Buffer.concat([SIG, ihdr(13), chunk("IDAT", Buffer.from("garbage")), end]),
      "too little data": Buffer.concat([SIG, ihdr(13, 4, 4), idat(3), end]),
      "palette index out of range": png(1, 1, 3, 1, () => Buffer.from([5]), { extra: [chunk("PLTE", Buffer.from([0, 0, 0, 1, 1, 1]))] }),
      "tiny BMP": Buffer.from("BM" + "x".repeat(20), "latin1"),
      "old BMP header": (() => {
        const b = bmp(2, 2, 24, () => [0, 0, 0]);
        b.writeUInt32LE(12, 14);
        return b;
      })(),
      "compressed BMP": (() => {
        const b = bmp(2, 2, 24, () => [0, 0, 0]);
        b.writeUInt32LE(1, 30);
        return b;
      })(),
      "zero-width BMP": (() => {
        const b = bmp(2, 2, 24, () => [0, 0, 0]);
        b.writeInt32LE(0, 18);
        return b;
      })(),
    };
    for (const [name, data] of Object.entries(bad)) expect(() => decodeImage(data), name).toThrow(PanelImageError);
  });

  it("decodes a 32-bit BMP with bit fields and Paeth-filtered rows of varied data", () => {
    const b = bmp(2, 2, 32, () => [9, 9, 9]);
    b.writeUInt32LE(3, 30);
    expect(Array.from(decodeImage(b).data)).toEqual([9, 9, 9, 9]);
    // Pseudo-random 6x6 gray image, every row Paeth filtered, exercises all three Paeth predictor outcomes.
    const w = 6;
    const h = 6;
    const plain = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x * 37 + y * 91 + ((x * y) % 5) * 53) & 255));
    const row = (y: number) =>
      Buffer.from(
        plain[y]!.map((v, i) => {
          const a = i > 0 ? plain[y]![i - 1]! : 0;
          const bb = y > 0 ? plain[y - 1]![i]! : 0;
          const c = i > 0 && y > 0 ? plain[y - 1]![i - 1]! : 0;
          const p = a + bb - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - bb);
          const pc = Math.abs(p - c);
          return (v - (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
        })
      );
    expect(Array.from(decodeImage(png(w, h, 0, w, row, { filter: () => 4 })).data)).toEqual(plain.flat());
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
