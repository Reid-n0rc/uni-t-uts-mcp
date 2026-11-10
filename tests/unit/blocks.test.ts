import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseBlock } from "../../src/blocks.js";

const payload = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
const block = (digits: number, data: Buffer) =>
  Buffer.concat([Buffer.from(`#${digits}${String(data.length).padStart(digits, "0")}`), data]);

describe("parseBlock", () => {
  it("parses a #3 block (short style from the UTS3000B manual)", () => {
    const data = payload(123);
    const r = parseBlock(Buffer.concat([Buffer.from("#3123"), data]));
    expect(r).toEqual({ status: "ok", data, consumed: 5 + 123, terminator: "none" });
  });

  it("parses a #9 block (style from the UTS1000B/T manual)", () => {
    const data = payload(40);
    const r = parseBlock(block(9, data));
    expect(r).toEqual({ status: "ok", data, consumed: 11 + 40, terminator: "none" });
  });

  it("parses a #1 block and an empty block", () => {
    expect(parseBlock(Buffer.from("#15ABCDE"))).toEqual({
      status: "ok",
      data: Buffer.from("ABCDE"),
      consumed: 8,
      terminator: "none",
    });
    expect(parseBlock(Buffer.from("#10"))).toEqual({
      status: "ok",
      data: Buffer.alloc(0),
      consumed: 3,
      terminator: "none",
    });
  });

  it("is binary safe (payload may contain # and newline bytes)", () => {
    const data = Buffer.from([0x23, 0x0a, 0x00, 0xff, 0x0a]);
    const r = parseBlock(block(1, data));
    expect(r).toMatchObject({ status: "ok", data });
  });

  it("reports incomplete for a truncated header", () => {
    expect(parseBlock(Buffer.alloc(0))).toEqual({ status: "incomplete" });
    expect(parseBlock(Buffer.from("#"))).toEqual({ status: "incomplete" });
    expect(parseBlock(Buffer.from("#9000"))).toEqual({ status: "incomplete" });
  });

  it("reports incomplete with the total bytes needed for a truncated payload", () => {
    const r = parseBlock(Buffer.from("#3123abc"));
    expect(r).toEqual({ status: "incomplete", needed: 5 + 123 });
  });

  it("consumes one trailing newline when present and leaves other bytes", () => {
    const data = Buffer.from("abc");
    const r = parseBlock(Buffer.concat([Buffer.from("#13abc\nNEXT")]));
    expect(r).toEqual({ status: "ok", data, consumed: 6 + 1, terminator: "complete" });
  });

  it("does not require a trailing newline", () => {
    expect(parseBlock(Buffer.from("#13abc"))).toMatchObject({ status: "ok", consumed: 6 });
  });

  it("honors a start offset", () => {
    const r = parseBlock(Buffer.from("xx#13abc"), 2);
    expect(r).toEqual({ status: "ok", data: Buffer.from("abc"), consumed: 6, terminator: "none" });
  });

  it("rejects input that does not start with #", () => {
    expect(parseBlock(Buffer.from("123,456\n"))).toMatchObject({ status: "invalid" });
  });

  it("rejects a bad digit count (#0 indefinite length, #x)", () => {
    expect(parseBlock(Buffer.from("#0abc"))).toMatchObject({ status: "invalid" });
    expect(parseBlock(Buffer.from("#xabc"))).toMatchObject({ status: "invalid" });
  });

  it("rejects non-numeric length digits", () => {
    expect(parseBlock(Buffer.from("#3a2bxyz"))).toMatchObject({ status: "invalid" });
  });

  it("rejects lengths above maxLength", () => {
    const r = parseBlock(Buffer.from("#9999999999"), 0, { maxLength: 1000 });
    expect(r).toMatchObject({ status: "invalid" });
  });

  describe("CRLF terminators (UTS3036B ends blocks with CRLF)", () => {
    it("consumes a trailing CRLF", () => {
      const r = parseBlock(Buffer.from("#13abc\r\nNEXT"));
      expect(r).toEqual({ status: "ok", data: Buffer.from("abc"), consumed: 6 + 2, terminator: "complete" });
    });

    it("consumes a lone trailing CR at the end of the buffer and reports it as partial", () => {
      const r = parseBlock(Buffer.from("#13abc\r"));
      expect(r).toEqual({ status: "ok", data: Buffer.from("abc"), consumed: 6 + 1, terminator: "cr" });
    });

    it("does not consume a CR that is followed by something other than LF", () => {
      const r = parseBlock(Buffer.from("#13abc\rX"));
      expect(r).toEqual({ status: "ok", data: Buffer.from("abc"), consumed: 6, terminator: "none" });
    });

    it("parses the real UTS3036B REAL32 and REAL64 trace captures (big-endian floats)", () => {
      const r32 = parseBlock(readFileSync(new URL("../fixtures/p2/trace1-real32.bin", import.meta.url)));
      expect(r32).toMatchObject({ status: "ok", terminator: "complete" });
      if (r32.status === "ok") {
        expect(r32.data.length).toBe(4004);
        expect(r32.consumed).toBe(4012);
        expect(r32.data.readFloatBE(0)).toBeGreaterThan(-150);
        expect(r32.data.readFloatBE(0)).toBeLessThan(0);
      }
      const r64 = parseBlock(readFileSync(new URL("../fixtures/p2/trace1-real64.bin", import.meta.url)));
      expect(r64).toMatchObject({ status: "ok", terminator: "complete" });
      if (r64.status === "ok") {
        expect(r64.data.length).toBe(8008);
        expect(r64.consumed).toBe(8016);
        expect(r64.data.readDoubleBE(0)).toBeGreaterThan(-150);
      }
    });
  });
});
