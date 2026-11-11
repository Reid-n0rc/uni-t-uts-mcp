import { deflateSync } from "node:zlib";

/** Builders for synthetic PNG and BMP files used by the panel-lock tests. */
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
export const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
export const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function png(w: number, h: number, colorType: number, rowBytes: number, row: (y: number) => Buffer, opts: { interlace?: number; filter?: (y: number) => number; extra?: Buffer[]; bitDepth?: number } = {}) {
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
export function bmp(w: number, h: number, bpp: number, px: (x: number, y: number) => [number, number, number], topDown = false) {
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

