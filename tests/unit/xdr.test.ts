import { describe, expect, it } from "vitest";
import { MAX_OPAQUE_BYTES, XdrError, XdrReader, XdrWriter } from "../../src/vxi11/xdr.js";

describe("XdrWriter / XdrReader integers", () => {
  it("round trips u32 including the extremes", () => {
    const buf = new XdrWriter().u32(0).u32(1).u32(0x7fffffff).u32(0x80000000).u32(0xffffffff).toBuffer();
    expect(buf.length).toBe(20);
    const r = new XdrReader(buf);
    expect([r.u32(), r.u32(), r.u32(), r.u32(), r.u32()]).toEqual([0, 1, 0x7fffffff, 0x80000000, 0xffffffff]);
    r.expectEnd();
  });

  it("writes big-endian", () => {
    expect([...new XdrWriter().u32(0x01020304).toBuffer()]).toEqual([1, 2, 3, 4]);
  });

  it("round trips i32 including negative values", () => {
    const buf = new XdrWriter().i32(-1).i32(-0x80000000).i32(0x7fffffff).toBuffer();
    const r = new XdrReader(buf);
    expect([r.i32(), r.i32(), r.i32()]).toEqual([-1, -0x80000000, 0x7fffffff]);
  });

  it("reads the same bytes as unsigned or signed", () => {
    const b = new XdrWriter().i32(-2).toBuffer();
    expect(new XdrReader(b).u32()).toBe(0xfffffffe);
  });

  it.each([-1, 0x100000000, 1.5, NaN, Infinity, 2 ** 53])("rejects u32 %s", (v) => {
    expect(() => new XdrWriter().u32(v)).toThrow(XdrError);
  });

  it.each([0x80000000, -0x80000001, 0.5, NaN, -Infinity])("rejects i32 %s", (v) => {
    expect(() => new XdrWriter().i32(v)).toThrow(XdrError);
  });
});

describe("bool", () => {
  it("round trips", () => {
    const r = new XdrReader(new XdrWriter().bool(true).bool(false).toBuffer());
    expect([r.bool(), r.bool()]).toEqual([true, false]);
  });
  it("rejects values other than 0 and 1", () => {
    expect(() => new XdrReader(new XdrWriter().u32(2).toBuffer()).bool()).toThrow(XdrError);
    expect(() => new XdrReader(new XdrWriter().u32(0xffffffff).toBuffer()).bool()).toThrow(XdrError);
  });
});

describe("opaque and string", () => {
  it("encodes an empty opaque as just a zero length", () => {
    const b = new XdrWriter().opaque(Buffer.alloc(0)).toBuffer();
    expect([...b]).toEqual([0, 0, 0, 0]);
    expect(new XdrReader(b).opaque().length).toBe(0);
  });

  it.each([1, 2, 3, 4, 5, 7, 8, 9])("pads %i byte(s) to a multiple of four with zeros", (n) => {
    const data = Buffer.alloc(n, 0xab);
    const b = new XdrWriter().opaque(data).toBuffer();
    expect(b.length).toBe(4 + Math.ceil(n / 4) * 4);
    expect(b.readUInt32BE(0)).toBe(n);
    expect([...b.subarray(4 + n)].every((x) => x === 0)).toBe(true);
    const r = new XdrReader(Buffer.concat([b, new XdrWriter().u32(77).toBuffer()]));
    expect(r.opaque().equals(data)).toBe(true);
    expect(r.u32()).toBe(77); // padding was skipped correctly
  });

  it("fixed opaque has no length prefix but is padded", () => {
    const b = new XdrWriter().opaqueFixed(Buffer.from([1, 2, 3])).toBuffer();
    expect([...b]).toEqual([1, 2, 3, 0]);
    expect([...new XdrReader(b).opaqueFixed(3)]).toEqual([1, 2, 3]);
  });

  it("round trips strings and rejects unencodable characters", () => {
    const b = new XdrWriter().string("inst0").toBuffer();
    expect(b.length).toBe(12);
    expect(new XdrReader(b).string()).toBe("inst0");
    expect(() => new XdrWriter().string("€")).toThrow(XdrError);
  });

  it("accepts an opaque exactly at the limit and rejects one byte over (writer and reader)", () => {
    const ok = new XdrWriter().opaque(Buffer.alloc(8), 8).toBuffer();
    expect(new XdrReader(ok).opaque(8).length).toBe(8);
    expect(() => new XdrWriter().opaque(Buffer.alloc(9), 8)).toThrow(XdrError);
    expect(() => new XdrReader(new XdrWriter().opaque(Buffer.alloc(9)).toBuffer()).opaque(8)).toThrow(/exceeds the limit/);
  });

  it("rejects a huge announced length before reading (default cap)", () => {
    const evil = new XdrWriter().u32(MAX_OPAQUE_BYTES + 1).toBuffer();
    expect(() => new XdrReader(evil).opaque()).toThrow(/exceeds the limit/);
    const evil2 = new XdrWriter().u32(0xffffffff).toBuffer();
    expect(() => new XdrReader(evil2).opaque()).toThrow(XdrError);
    expect(() => new XdrReader(evil2).string()).toThrow(XdrError);
  });

  it("returns copies, not views of the input", () => {
    const src = new XdrWriter().opaque(Buffer.from([9, 9, 9, 9])).toBuffer();
    const out = new XdrReader(src).opaque();
    src.fill(0);
    expect([...out]).toEqual([9, 9, 9, 9]);
  });
});

describe("truncated and malformed input", () => {
  it("rejects reads past the end", () => {
    expect(() => new XdrReader(Buffer.alloc(0)).u32()).toThrow(/truncated/);
    expect(() => new XdrReader(Buffer.alloc(3)).u32()).toThrow(XdrError);
    expect(() => new XdrReader(Buffer.alloc(3)).i32()).toThrow(XdrError);
    expect(() => new XdrReader(Buffer.alloc(3)).bool()).toThrow(XdrError);
  });

  it("rejects an opaque whose data or padding is cut off", () => {
    const full = new XdrWriter().opaque(Buffer.from([1, 2, 3, 4, 5])).toBuffer(); // 4 + 8
    for (let cut = 0; cut < full.length; cut++) {
      expect(() => new XdrReader(full.subarray(0, cut)).opaque()).toThrow(XdrError);
    }
  });

  it("rejects negative or fractional fixed lengths", () => {
    expect(() => new XdrReader(Buffer.alloc(8)).opaqueFixed(-1)).toThrow(XdrError);
    expect(() => new XdrReader(Buffer.alloc(8)).opaqueFixed(1.5)).toThrow(XdrError);
  });

  it("does not advance past the end after a failed read", () => {
    const r = new XdrReader(Buffer.alloc(2));
    expect(() => r.u32()).toThrow();
    expect(r.remaining).toBe(2);
  });

  it("expectEnd rejects trailing bytes", () => {
    const r = new XdrReader(new XdrWriter().u32(1).u32(2).toBuffer());
    r.u32();
    expect(() => r.expectEnd()).toThrow(/trailing/);
  });

  it("honours the byteOffset of a Buffer view", () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xff]), new XdrWriter().u32(5).toBuffer()]);
    expect(new XdrReader(big.subarray(2)).u32()).toBe(5);
  });
});

describe("fuzz", () => {
  it("only ever throws XdrError on random input and never reads out of range", () => {
    let seed = 12345;
    const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let i = 0; i < 2000; i++) {
      const buf = Buffer.alloc(rnd() % 24);
      for (let j = 0; j < buf.length; j++) buf[j] = rnd() & 0xff;
      const r = new XdrReader(buf);
      try {
        for (let k = 0; k < 6; k++) {
          switch (rnd() % 5) {
            case 0: r.u32(); break;
            case 1: r.i32(); break;
            case 2: r.bool(); break;
            case 3: r.opaque(64); break;
            default: r.string(64);
          }
          expect(r.remaining).toBeGreaterThanOrEqual(0);
        }
      } catch (err) {
        expect(err).toBeInstanceOf(XdrError);
      }
    }
  });
});
