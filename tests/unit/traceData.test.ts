import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseBlock } from "../../src/blocks.js";
import { ReplyError } from "../../src/instrument.js";
import {
  parseAsciiTrace,
  parseBinaryTrace,
  frequencyAxis,
  timeAxis,
  decimateMinMax,
  summarizeTrace,
} from "../../src/traceData.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/p2/${name}`, import.meta.url));
const CMD = ":TRACe:DATA? TRACE1";

/** Build the reply the instrument sends for REAL32/REAL64: `#4<byte length>` + big-endian values + CRLF. */
function block(values: number[], bytes: 4 | 8): Buffer {
  const data = Buffer.alloc(values.length * bytes);
  values.forEach((v, i) => (bytes === 4 ? data.writeFloatBE(v, i * 4) : data.writeDoubleBE(v, i * 8)));
  return Buffer.concat([Buffer.from(`#4${String(data.length).padStart(4, "0")}`), data, Buffer.from("\r\n")]);
}
const payloadOf = (raw: Buffer): Buffer => {
  const r = parseBlock(raw);
  if (r.status !== "ok") throw new Error("fixture block did not parse");
  return r.data;
};

describe("parseAsciiTrace (real capture)", () => {
  const values = parseAsciiTrace(CMD, fixture("trace1-ascii.txt").toString("latin1"));

  it("returns the 1001 values of the capture in order", () => {
    expect(values).toHaveLength(1001);
    expect(values.slice(0, 3)).toEqual([-61.12838, -91.29078, -68.55595]);
    expect(Math.min(...values)).toBeCloseTo(-110.1, 1);
    expect(Math.max(...values)).toBeCloseTo(-57.8, 1);
  });

  it("accepts a reply without the CRLF terminator and with spaces around the values", () => {
    expect(parseAsciiTrace(CMD, "-1.5e+01, -2.5e+01 ,3e0")).toEqual([-15, -25, 3]);
  });

  it("rejects an empty reply, empty fields and non-numeric text, naming the command and the start of the reply", () => {
    for (const reply of ["", "\r\n", "1,,2", "1,2,", "-61.1,abc,3", "garbage ???", "0x10,1"]) {
      let error: unknown;
      try {
        parseAsciiTrace(CMD, reply);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(reply)).toBeInstanceOf(ReplyError);
      expect((error as Error).message).toContain(CMD);
    }
    expect(() => parseAsciiTrace(CMD, "-61.1,abc,3")).toThrow(/"-61\.1,abc,3"/);
  });

  it("quotes only the start of a long malformed reply", () => {
    const long = "-61.1," + "x".repeat(5000);
    try {
      parseAsciiTrace(CMD, long);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(400);
    }
  });

  it("keeps nan and inf tokens as non-finite values instead of failing", () => {
    const v = parseAsciiTrace(CMD, "1,nan,-inf,+Inf,2");
    expect(v[0]).toBe(1);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBe(-Infinity);
    expect(v[3]).toBe(Infinity);
    expect(v[4]).toBe(2);
  });
});

describe("parseBinaryTrace", () => {
  const ascii = parseAsciiTrace(CMD, fixture("trace1-ascii.txt").toString("latin1"));

  it("parses the real REAL32 capture (big-endian, 1001 values)", () => {
    const values = parseBinaryTrace(CMD, payloadOf(fixture("trace1-real32.bin")), 4);
    expect(values).toHaveLength(1001);
    expect(values[0]).toBeCloseTo(-64.63521575927734, 9);
    expect(values[1]).toBeCloseTo(-83.1951904296875, 9);
    expect(values.every((v) => v > -200 && v < 50)).toBe(true);
  });

  it("parses the real REAL64 capture (big-endian, 1001 values)", () => {
    const values = parseBinaryTrace(CMD, payloadOf(fixture("trace1-real64.bin")), 8);
    expect(values).toHaveLength(1001);
    expect(values[0]).toBeCloseTo(-61.2449150085449, 6);
    expect(values.every((v) => v > -200 && v < 50)).toBe(true);
  });

  it("gives the same values as ASCII within float tolerance (the same trace encoded in all three formats)", () => {
    const f32 = parseBinaryTrace(CMD, payloadOf(block(ascii, 4)), 4);
    const f64 = parseBinaryTrace(CMD, payloadOf(block(ascii, 8)), 8);
    expect(f64).toEqual(ascii);
    f32.forEach((v, i) => expect(Math.abs(v - ascii[i])).toBeLessThan(1e-5));
  });

  it("rejects a payload that is not a whole number of values", () => {
    expect(() => parseBinaryTrace(CMD, Buffer.alloc(10), 4)).toThrow(/not a multiple of 4/);
    expect(() => parseBinaryTrace(CMD, Buffer.alloc(12), 8)).toThrow(/not a multiple of 8/);
    expect(() => parseBinaryTrace(CMD, Buffer.alloc(10), 4)).toThrow(CMD);
  });

  it("rejects an empty payload", () => {
    expect(() => parseBinaryTrace(CMD, Buffer.alloc(0), 4)).toThrow(ReplyError);
  });

  it("returns non-finite floats as they are", () => {
    const v = parseBinaryTrace(CMD, payloadOf(block([1, NaN, -Infinity], 4)), 4);
    expect(v[0]).toBe(1);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBe(-Infinity);
  });
});

describe("frequencyAxis", () => {
  it("is linear from start to stop inclusive: f_i = start + i*(stop-start)/(points-1)", () => {
    const f = frequencyAxis(10e6, 3.6e9, 1001);
    expect(f).toHaveLength(1001);
    expect(f[0]).toBe(10e6);
    expect(f[1000]).toBe(3.6e9);
    expect(f[1]).toBeCloseTo(10e6 + 3.59e9 / 1000, 3);
    expect(f[500]).toBeCloseTo(1.805e9, 3);
  });

  it("returns exactly the stop frequency at the last point", () => {
    expect(frequencyAxis(1, 0.3, 4)[3]).toBe(0.3);
    expect(frequencyAxis(100e6, 200e6, 7)[6]).toBe(200e6);
  });

  it("one point sits at the start frequency", () => {
    expect(frequencyAxis(5e6, 7e6, 1)).toEqual([5e6]);
  });

  it("two points are start and stop", () => {
    expect(frequencyAxis(5e6, 7e6, 2)).toEqual([5e6, 7e6]);
  });

  it("works for a descending range and rejects bad point counts", () => {
    expect(frequencyAxis(10, 0, 3)).toEqual([10, 5, 0]);
    expect(() => frequencyAxis(0, 10, 0)).toThrow(/points/);
    expect(() => frequencyAxis(0, 10, 2.5)).toThrow(/points/);
  });
});

describe("timeAxis (zero span)", () => {
  it("runs from 0 to the sweep time inclusive", () => {
    expect(timeAxis(0.01, 3)).toEqual([0, 0.005, 0.01]);
    expect(timeAxis(2, 1)).toEqual([0]);
  });
});

describe("decimateMinMax", () => {
  it("returns everything unchanged when the trace is not larger than max_points", () => {
    const v = [3, 1, 2];
    expect(decimateMinMax(v, 3)).toEqual({ indices: [0, 1, 2], values: [3, 1, 2] });
    expect(decimateMinMax(v, 100)).toEqual({ indices: [0, 1, 2], values: [3, 1, 2] });
  });

  it("keeps the minimum and maximum of every bucket, in index order, with their original indices", () => {
    // 8 values, 4 points = 2 buckets of 4: bucket 0 [5,1,9,2] -> idx 1 (1) and 2 (9); bucket 1 [4,8,0,3] -> idx 6 (0) and 5 (8)
    const r = decimateMinMax([5, 1, 9, 2, 4, 8, 0, 3], 4);
    expect(r.indices).toEqual([1, 2, 5, 6]);
    expect(r.values).toEqual([1, 9, 8, 0]);
  });

  it("preserves the global peak and the global minimum of a real trace and never exceeds max_points", () => {
    const v = parseAsciiTrace(CMD, fixture("trace1-ascii.txt").toString("latin1"));
    for (const max of [2, 3, 10, 51, 100, 250, 999, 1000]) {
      const r = decimateMinMax(v, max);
      expect(r.values.length, `max ${max}`).toBeLessThanOrEqual(max);
      expect(r.values.length, `max ${max}`).toBeGreaterThan(1);
      expect(Math.max(...r.values), `max ${max}`).toBe(Math.max(...v));
      expect(Math.min(...r.values), `max ${max}`).toBe(Math.min(...v));
      expect(r.indices.every((x, i) => i === 0 || x > r.indices[i - 1]), `max ${max}: strictly increasing`).toBe(true);
      r.indices.forEach((x, i) => expect(r.values[i]).toBe(v[x]));
    }
  });

  it("spans the whole trace: the buckets cover the first and the last point", () => {
    const v = Array.from({ length: 1001 }, (_, i) => Math.sin(i / 7));
    const r = decimateMinMax(v, 100);
    expect(r.indices[0]).toBeLessThan(25);
    expect(r.indices[r.indices.length - 1]).toBeGreaterThan(975);
  });

  it("skips non-finite values when picking the extremes", () => {
    const r = decimateMinMax([NaN, 1, 5, NaN, 2, Infinity, -3, 0], 4);
    expect(r.values.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("rejects max_points below 2 and non-integers", () => {
    expect(() => decimateMinMax([1, 2, 3], 1)).toThrow(/max_points/);
    expect(() => decimateMinMax([1, 2, 3], 2.5)).toThrow(/max_points/);
  });
});

describe("summarizeTrace", () => {
  it("gives min, max, mean and the first index of the peak", () => {
    const s = summarizeTrace([-80, -20, -50, -20]);
    expect(s).toEqual({
      points: 4, finite_points: 4, non_finite_points: 0, min: -80, max: -20, mean: -42.5, peak_index: 1,
    });
  });

  it("ignores non-finite values and counts them", () => {
    const s = summarizeTrace([NaN, -10, -Infinity, -30]);
    expect(s).toMatchObject({ points: 4, finite_points: 2, non_finite_points: 2, min: -30, max: -10, mean: -20, peak_index: 1 });
  });

  it("summarises the real capture", () => {
    const v = parseAsciiTrace(CMD, fixture("trace1-ascii.txt").toString("latin1"));
    const s = summarizeTrace(v);
    expect(s?.points).toBe(1001);
    expect(s?.max).toBeCloseTo(-57.8, 1);
    expect(v[s!.peak_index]).toBe(s!.max);
  });

  it("returns null when there is no finite value", () => {
    expect(summarizeTrace([NaN, Infinity])).toBeNull();
    expect(summarizeTrace([])).toBeNull();
  });
});
