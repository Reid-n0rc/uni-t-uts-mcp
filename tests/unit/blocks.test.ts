import { describe, it, expect } from "vitest";
import { parseBlock } from "../../src/blocks.js";

const payload = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
const block = (digits: number, data: Buffer) =>
  Buffer.concat([Buffer.from(`#${digits}${String(data.length).padStart(digits, "0")}`), data]);

describe("parseBlock", () => {
  it("parses a #3 block (short style from the UTS3000B manual)", () => {
    const data = payload(123);
    const r = parseBlock(Buffer.concat([Buffer.from("#3123"), data]));
    expect(r).toEqual({ status: "ok", data, consumed: 5 + 123 });
  });

  it("parses a #9 block (style from the UTS1000B/T manual)", () => {
    const data = payload(40);
    const r = parseBlock(block(9, data));
    expect(r).toEqual({ status: "ok", data, consumed: 11 + 40 });
  });

  it("parses a #1 block and an empty block", () => {
    expect(parseBlock(Buffer.from("#15ABCDE"))).toEqual({
      status: "ok",
      data: Buffer.from("ABCDE"),
      consumed: 8,
    });
    expect(parseBlock(Buffer.from("#10"))).toEqual({
      status: "ok",
      data: Buffer.alloc(0),
      consumed: 3,
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
    expect(r).toEqual({ status: "ok", data, consumed: 6 + 1 });
  });

  it("does not require a trailing newline", () => {
    expect(parseBlock(Buffer.from("#13abc"))).toMatchObject({ status: "ok", consumed: 6 });
  });

  it("honors a start offset", () => {
    const r = parseBlock(Buffer.from("xx#13abc"), 2);
    expect(r).toEqual({ status: "ok", data: Buffer.from("abc"), consumed: 6 });
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
});
