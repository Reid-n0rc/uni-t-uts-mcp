import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../../site/hero-marker.cjs");

type Rect = { left: number; top: number; right: number; bottom: number };
const boxOf = (p: { left: number; top: number }, s: { w: number; h: number }): Rect => ({ left: p.left, top: p.top, right: p.left + s.w, bottom: p.top + s.h });
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function trace(n: number, peaks: Array<[number, number]>, floor = -90): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = floor;
    for (const [at, level] of peaks) v = Math.max(v, level - Math.abs(i - at) * 0.5);
    out.push(v);
  }
  return out;
}

describe("smooth and findPeak", () => {
  it("smooth keeps the length and flattens a lone spike", () => {
    const a = new Array(101).fill(-80);
    a[50] = -10;
    const s = M.smooth(a, 9);
    expect(s).toHaveLength(101);
    expect(s[50]).toBeLessThan(-60);
    expect(s[0]).toBeCloseTo(-80, 6);
  });

  it("finds the highest broad peak", () => {
    const { index, value } = M.findPeak(trace(1001, [[300, -40], [700, -20]]), { window: 9 });
    expect(Math.abs(index - 700)).toBeLessThanOrEqual(2);
    expect(value).toBeGreaterThan(-25);
  });

  it("ignores a one-sample noise spike taller than a real peak", () => {
    const a = trace(1001, [[400, -30]]);
    a[900] = -5; // lone spike
    const { index } = M.findPeak(a, { window: 15 });
    expect(Math.abs(index - 400)).toBeLessThanOrEqual(2);
  });

  it("handles flat, tiny and empty input without throwing", () => {
    expect(M.findPeak(new Array(10).fill(-50), { window: 5 }).index).toBeGreaterThanOrEqual(0);
    expect(M.findPeak([-50], { window: 5 }).index).toBe(0);
    expect(M.findPeak([], { window: 5 })).toEqual({ index: 0, value: Number.NEGATIVE_INFINITY });
  });
});

describe("trackPeak and stepToward", () => {
  it("starts on the peak", () => {
    const st = M.trackPeak(null, trace(1001, [[550, -27]]), { window: 9 });
    expect(Math.abs(st.target - 550)).toBeLessThanOrEqual(2);
  });

  it("does not hop to a rival peak that is only slightly higher", () => {
    let st = M.trackPeak(null, trace(1001, [[300, -30], [700, -31]]), { window: 9 });
    const first = st.target;
    st = M.trackPeak(st, trace(1001, [[300, -30], [700, -29.5]]), { window: 9, holdDb: 1.5 });
    expect(st.target).toBe(first);
  });

  it("hops once a rival is clearly higher", () => {
    let st = M.trackPeak(null, trace(1001, [[300, -30], [700, -50]]), { window: 9 });
    st = M.trackPeak(st, trace(1001, [[300, -30], [700, -20]]), { window: 9, holdDb: 1.5 });
    expect(Math.abs(st.target - 700)).toBeLessThanOrEqual(2);
  });

  it("follows a peak that drifts a little", () => {
    let st = M.trackPeak(null, trace(1001, [[500, -30]]), { window: 9 });
    st = M.trackPeak(st, trace(1001, [[510, -30]]), { window: 9, holdDb: 1.5 });
    expect(Math.abs(st.target - 510)).toBeLessThanOrEqual(2);
  });

  it("stepToward eases without overshooting and is stable for any frame time", () => {
    let pos = 0;
    for (let k = 0; k < 10; k++) {
      const next = M.stepToward(pos, 100, 33, 140);
      expect(next).toBeGreaterThan(pos);
      expect(next).toBeLessThanOrEqual(100);
      pos = next;
    }
    expect(M.stepToward(0, 100, 100000, 140)).toBeCloseTo(100, 3);
    expect(M.stepToward(40, 40, 33, 140)).toBe(40);
    expect(M.stepToward(0, 100, 0, 140)).toBe(0);
  });

  it("sampleAt interpolates between samples and clamps at the ends", () => {
    expect(M.sampleAt([0, 10], 0.5)).toBeCloseTo(5, 9);
    expect(M.sampleAt([0, 10], -3)).toBe(0);
    expect(M.sampleAt([0, 10], 9)).toBe(10);
  });
});

describe("position to frequency and level", () => {
  it("maps the trace ends to 10 MHz and 3.6 GHz", () => {
    expect(M.indexToFrequencyHz(0, 1001)).toBeCloseTo(10e6, 0);
    expect(M.indexToFrequencyHz(1000, 1001)).toBeCloseTo(3.6e9, 0);
    expect(M.xToFrequencyHz(0, 800)).toBeCloseTo(10e6, 0);
    expect(M.xToFrequencyHz(800, 800)).toBeCloseTo(3.6e9, 0);
    expect(M.xToFrequencyHz(400, 800)).toBeCloseTo(1.805e9, -3);
  });

  it("formats frequency in GHz or MHz", () => {
    expect(M.formatFrequency(1.805e9)).toBe("1.805 GHz");
    expect(M.formatFrequency(10e6)).toBe("10.000 MHz");
    expect(M.formatFrequency(950.25e6)).toBe("950.250 MHz");
  });

  it("level and y are inverse, higher on screen is stronger, and the scale reaches about 0 dBm at the top", () => {
    for (const db of [-100, -75, -32, -12, 0]) {
      expect(M.yToLevelDbm(M.levelToY(db, 300), 300)).toBeCloseTo(db, 6);
    }
    expect(M.levelToY(-20, 300)).toBeLessThan(M.levelToY(-60, 300));
    expect(M.levelToY(0, 300)).toBeGreaterThanOrEqual(0);
    expect(M.levelToY(0, 300)).toBeLessThan(0.3 * 300);
  });

  it("formats level with one decimal and a minus sign", () => {
    expect(M.formatLevel(-32)).toBe("-32.0 dBm");
    expect(M.formatLevel(-27.04)).toBe("-27.0 dBm");
  });
});

describe("placeCallout", () => {
  const bounds = { w: 1280, h: 800 };
  const size = { w: 230, h: 110 };

  it("puts the callout above the marker when there is room, inside the bounds", () => {
    const r = M.placeCallout({ anchor: { x: 700, y: 500 }, size, bounds });
    expect(r.side).toBe("above");
    const b = boxOf(r, size);
    expect(b.bottom).toBeLessThanOrEqual(500);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(bounds.w);
    expect(b.top).toBeGreaterThanOrEqual(0);
  });

  it("clamps horizontally near either edge", () => {
    const left = M.placeCallout({ anchor: { x: 5, y: 500 }, size, bounds, margin: 8 });
    expect(left.left).toBeGreaterThanOrEqual(8);
    const right = M.placeCallout({ anchor: { x: 1278, y: 500 }, size, bounds, margin: 8 });
    expect(right.left + size.w).toBeLessThanOrEqual(bounds.w - 8);
  });

  it("flips below the marker when there is no room above", () => {
    const r = M.placeCallout({ anchor: { x: 640, y: 60 }, size, bounds, order: ["above", "below"] });
    expect(r.side).toBe("below");
    expect(r.top).toBeGreaterThan(60);
  });

  it("goes to the side when above would hit the hero text", () => {
    const text: Rect = { left: 0, top: 150, right: 900, bottom: 420 };
    const r = M.placeCallout({ anchor: { x: 700, y: 500 }, size, bounds, avoid: [text] });
    expect(overlaps(boxOf(r, size), text)).toBe(false);
  });

  it("never overlaps any avoided rectangle when a free spot exists", () => {
    const avoid: Rect[] = [{ left: 0, top: 100, right: 600, bottom: 300 }, { left: 0, top: 300, right: 400, bottom: 360 }];
    for (let x = 20; x < 1260; x += 40) {
      const r = M.placeCallout({ anchor: { x, y: 520 }, size, bounds, avoid });
      const b = boxOf(r, size);
      for (const a of avoid) expect(overlaps(b, a), `x=${x} side=${r.side}`).toBe(false);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(bounds.w);
    }
  });

  it("with a single allowed side (phones) it still clamps to the bounds", () => {
    const phone = { w: 390, h: 844 };
    const small = { w: 200, h: 80 };
    for (const x of [0, 30, 195, 360, 390]) {
      const r = M.placeCallout({ anchor: { x, y: 600 }, size: small, bounds: phone, order: ["above"], margin: 12 });
      expect(r.side).toBe("above");
      expect(r.left).toBeGreaterThanOrEqual(12);
      expect(r.left + small.w).toBeLessThanOrEqual(phone.w - 12);
    }
  });

  it("falls back to the least-overlapping spot instead of failing when everything collides", () => {
    const wall: Rect = { left: -10, top: -10, right: 2000, bottom: 2000 };
    const r = M.placeCallout({ anchor: { x: 600, y: 400 }, size, bounds, avoid: [wall] });
    expect(Number.isFinite(r.left) && Number.isFinite(r.top)).toBe(true);
  });

  it("a side window slides down until it clears the text above it", () => {
    const text: Rect = { left: 0, top: 100, right: 900, bottom: 300 };
    const r = M.placeCallout({ anchor: { x: 760, y: 360 }, size, bounds, avoid: [text], order: ["right"] });
    expect(r.side).toBe("right");
    expect(r.top).toBeGreaterThanOrEqual(300);
    expect(r.left).toBeGreaterThan(760);
  });

  it("keeps the previous side while it is still free (no flip-flopping)", () => {
    const r = M.placeCallout({ anchor: { x: 700, y: 500 }, size, bounds, prefer: "right" });
    expect(r.side).toBe("right");
    const blocked = M.placeCallout({ anchor: { x: 700, y: 500 }, size, bounds, prefer: "right", avoid: [{ left: 700, top: 0, right: 1280, bottom: 800 }] });
    expect(blocked.side).not.toBe("right");
  });

  it("is deterministic", () => {
    const a = M.placeCallout({ anchor: { x: 700, y: 500 }, size, bounds });
    const b = M.placeCallout({ anchor: { x: 700, y: 500 }, size, bounds });
    expect(a).toEqual(b);
  });
});
