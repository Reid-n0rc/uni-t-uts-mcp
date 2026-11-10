import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { compose, midiToHz, MIN_BPM, MAX_BPM, STEPS_PER_BAR } = require("../../site/soundtrack.cjs");

type Ev = { part: string; step: number; time: number; dur: number; midi?: number };
const SEEDS = [1, 2, 3, 42, 1992, 31337, 0xdeadbeef];
const inScale = (midi: number, scale: number[]) => scale.includes(((midi % 12) + 12) % 12);

describe("soundtrack composition (pure)", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    expect(compose(42)).toEqual(compose(42));
    expect(JSON.stringify(compose(1))).not.toEqual(JSON.stringify(compose(2)));
  });

  it("keeps the tempo within 80-110 BPM and the key minor", () => {
    expect(MIN_BPM).toBe(80);
    expect(MAX_BPM).toBe(110);
    for (const seed of SEEDS) {
      const c = compose(seed);
      expect(c.bpm).toBeGreaterThanOrEqual(80);
      expect(c.bpm).toBeLessThanOrEqual(110);
      // natural minor: intervals 0 2 3 5 7 8 10 from the root
      const root = c.rootMidi % 12;
      expect([...c.scale].sort((a: number, b: number) => a - b)).toEqual(
        [0, 2, 3, 5, 7, 8, 10].map((i) => (root + i) % 12).sort((a, b) => a - b)
      );
    }
  });

  it("only plays notes from the scale", () => {
    for (const seed of SEEDS) {
      const c = compose(seed);
      const notes = (c.events as Ev[]).filter((e) => e.midi !== undefined);
      expect(notes.length).toBeGreaterThan(0);
      for (const e of notes) expect(inScale(e.midi!, c.scale), `${e.part} ${e.midi} seed ${seed}`).toBe(true);
    }
  });

  it("has consistent timing: steps map to seconds, events stay inside the loop", () => {
    for (const seed of SEEDS) {
      const c = compose(seed);
      expect(c.stepSeconds).toBeCloseTo(60 / c.bpm / 4, 10);
      expect(c.loopSeconds).toBeCloseTo(c.bars * STEPS_PER_BAR * c.stepSeconds, 10);
      for (const e of c.events as Ev[]) {
        expect(e.time).toBeCloseTo(e.step * c.stepSeconds, 10);
        expect(e.step).toBeGreaterThanOrEqual(0);
        expect(e.step).toBeLessThan(c.bars * STEPS_PER_BAR);
        expect(e.dur).toBeGreaterThan(0);
        expect(e.time + e.dur).toBeLessThanOrEqual(c.loopSeconds + 1e-9);
      }
      const sorted = [...(c.events as Ev[])].sort((a, b) => a.time - b.time);
      expect(c.events.map((e: Ev) => e.time)).toEqual(sorted.map((e) => e.time));
    }
  });

  it("has the drum pattern lengths of a four-on-the-floor loop", () => {
    const c = compose(7);
    const part = (p: string) => (c.events as Ev[]).filter((e) => e.part === p);
    expect(c.bars).toBeGreaterThanOrEqual(4);
    expect(STEPS_PER_BAR).toBe(16);
    expect(part("kick")).toHaveLength(c.bars * 4);
    expect(part("snare")).toHaveLength(c.bars * 2);
    expect(part("kick").every((e) => e.step % 4 === 0)).toBe(true);
    expect(part("snare").every((e) => e.step % 16 === 4 || e.step % 16 === 12)).toBe(true);
    expect(part("hat").length).toBeGreaterThanOrEqual(c.bars * 4);
    expect(part("pad").length).toBeGreaterThanOrEqual(c.bars * 3); // a triad per bar
    expect(part("bass").length).toBeGreaterThanOrEqual(c.bars * 4);
    expect(part("lead").length).toBeGreaterThan(c.bars * 4);
  });

  it("never overlaps notes within the bass or the lead", () => {
    for (const seed of SEEDS) {
      const c = compose(seed);
      for (const p of ["bass", "lead"]) {
        const ev = (c.events as Ev[]).filter((e) => e.part === p).sort((a, b) => a.time - b.time);
        for (let i = 1; i < ev.length; i++) {
          expect(ev[i - 1].time + ev[i - 1].dur, `${p} seed ${seed} index ${i}`).toBeLessThanOrEqual(ev[i].time + 1e-9);
        }
      }
    }
  });

  it("keeps the bass low and the lead above it", () => {
    const c = compose(5);
    const mids = (p: string) => (c.events as Ev[]).filter((e) => e.part === p).map((e) => e.midi!);
    expect(Math.max(...mids("bass"))).toBeLessThan(Math.min(...mids("lead")));
  });

  it("converts MIDI notes to frequencies", () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(57)).toBeCloseTo(220, 6);
  });
});
