import { ReplyError } from "./instrument.js";

// Pure helpers for trace data (:TRACe:DATA?): strict parsing of the ASCII and binary replies, the linear
// frequency (or time) axis, peak-preserving decimation and summary statistics. No instrument access here.
// Reply layouts verified on the UTS3036B (docs/verified-hardware.md, "Trace data").

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NON_FINITE_RE = /^([+-]?)(nan|inf|infinity)$/i;
const QUOTE_CHARS = 60;

const start = (reply: string): string => JSON.stringify(reply.length > QUOTE_CHARS ? reply.slice(0, QUOTE_CHARS) + "..." : reply);

/**
 * Parse an ASCII trace reply: comma-separated numbers (CRLF at the end is ignored). `nan`/`inf` tokens are kept
 * as non-finite values; anything else that is not a number, and empty fields, are errors.
 */
export function parseAsciiTrace(command: string, reply: string): number[] {
  const text = reply.trim();
  if (text === "") throw new ReplyError(command, reply, "empty reply (expected comma-separated trace values)");
  const parts = text.split(",");
  const values: number[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (NUMBER_RE.test(token)) {
      values[i] = Number(token);
      continue;
    }
    const special = NON_FINITE_RE.exec(token);
    if (special) {
      values[i] = special[2].toLowerCase() === "nan" ? Number.NaN : special[1] === "-" ? -Infinity : Infinity;
      continue;
    }
    throw new ReplyError(
      command,
      reply,
      `value ${i + 1} of ${parts.length} is ${JSON.stringify(token.slice(0, 20))}, not a number; the reply starts with ${start(reply)}`
    );
  }
  return values;
}

/** Parse the payload of a REAL32 (4 bytes) or REAL64 (8 bytes) block: big-endian IEEE 754 values. */
export function parseBinaryTrace(command: string, payload: Buffer, bytesPerValue: 4 | 8): number[] {
  if (payload.length === 0) throw new ReplyError(command, "", "the binary block is empty");
  if (payload.length % bytesPerValue !== 0) {
    throw new ReplyError(
      command,
      "",
      `the binary block holds ${payload.length} bytes, which is not a multiple of ${bytesPerValue} (REAL${bytesPerValue * 8}); the block starts with ${JSON.stringify(payload.subarray(0, 8).toString("hex"))} (hex)`
    );
  }
  const count = payload.length / bytesPerValue;
  const values: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = bytesPerValue === 4 ? payload.readFloatBE(i * 4) : payload.readDoubleBE(i * 8);
  }
  return values;
}

function checkPoints(points: number): void {
  if (!Number.isInteger(points) || points < 1) throw new Error(`points must be an integer >= 1, got ${points}`);
}

/** Linear axis `f_i = start + i*(stop-start)/(points-1)`; one point sits at the start frequency. */
export function frequencyAxis(startHz: number, stopHz: number, points: number): number[] {
  checkPoints(points);
  if (points === 1) return [startHz];
  const axis: number[] = new Array(points);
  const step = (stopHz - startHz) / (points - 1);
  for (let i = 0; i < points; i++) axis[i] = i === points - 1 ? stopHz : startHz + i * step;
  return axis;
}

/** Zero-span time axis: 0 at the first point, the sweep time at the last. */
export function timeAxis(sweepTimeS: number, points: number): number[] {
  checkPoints(points);
  return frequencyAxis(0, sweepTimeS, points);
}

export interface Decimated {
  /** Indices into the original trace, strictly increasing. */
  indices: number[];
  values: number[];
}

/**
 * Peak-preserving decimation: the trace is cut into `floor(maxPoints/2)` buckets of (nearly) equal size and each
 * bucket keeps its minimum and its maximum (first occurrence, non-finite values skipped), in index order. The
 * global peak and the global minimum are therefore always kept. Returns everything when no reduction is needed.
 */
export function decimateMinMax(values: readonly number[], maxPoints: number): Decimated {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new Error(`max_points must be an integer >= 2, got ${maxPoints}`);
  const n = values.length;
  if (n <= maxPoints) return { indices: values.map((_, i) => i), values: [...values] };
  const buckets = Math.floor(maxPoints / 2);
  const indices: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.floor(((b + 1) * n) / buckets);
    let lo = -1;
    let hi = -1;
    for (let i = from; i < to; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (lo < 0 || v < values[lo]) lo = i;
      if (hi < 0 || v > values[hi]) hi = i;
    }
    if (lo < 0) continue;
    if (lo === hi) indices.push(lo);
    else if (lo < hi) indices.push(lo, hi);
    else indices.push(hi, lo);
  }
  return { indices, values: indices.map((i) => values[i]) };
}

export interface TraceSummary {
  points: number;
  finite_points: number;
  non_finite_points: number;
  min: number;
  max: number;
  mean: number;
  /** Index of the first maximum. */
  peak_index: number;
}

/** Statistics over the finite values; null when there is none. */
export function summarizeTrace(values: readonly number[]): TraceSummary | null {
  let finite = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let peak = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    finite++;
    sum += v;
    if (v < min) min = v;
    if (v > max) {
      max = v;
      peak = i;
    }
  }
  if (finite === 0) return null;
  return { points: values.length, finite_points: finite, non_finite_points: values.length - finite, min, max, mean: sum / finite, peak_index: peak };
}
