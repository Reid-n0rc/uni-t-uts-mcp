import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { compose, midiToHz, MIN_BPM, MAX_BPM, DEFAULT_BPM, STEPS_PER_BAR } = require("../../site/soundtrack.cjs");

type Ev = { part: string; step: number; time: number; dur: number; midi?: number };
const SEEDS = [1, 2, 3, 42, 1992, 31337, 0xdeadbeef];
const inScale = (midi: number, scale: number[]) => scale.includes(((midi % 12) + 12) % 12);

describe("soundtrack composition (pure)", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    expect(compose(42)).toEqual(compose(42));
    expect(JSON.stringify(compose(1))).not.toEqual(JSON.stringify(compose(2)));
  });

  it("keeps the tempo within 118-132 BPM (default about 124) and the key minor", () => {
    expect(MIN_BPM).toBe(118);
    expect(MAX_BPM).toBe(132);
    expect(DEFAULT_BPM).toBe(124);
    for (const seed of SEEDS) {
      const c = compose(seed);
      expect(c.bpm).toBeGreaterThanOrEqual(118);
      expect(c.bpm).toBeLessThanOrEqual(132);
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
    expect(part("snare").filter((e: any) => !e.fill)).toHaveLength(c.bars * 2);
    expect(part("kick").every((e) => e.step % 4 === 0)).toBe(true);
    expect(part("snare").filter((e: any) => !e.fill).every((e) => e.step % 16 === 4 || e.step % 16 === 12)).toBe(true);
    expect(part("hat").length).toBeGreaterThanOrEqual(c.bars * 4);
    expect(part("pad").length).toBeGreaterThanOrEqual(c.bars * 3); // a triad per bar
    expect(part("bass").length).toBeGreaterThanOrEqual(c.bars * 8);
    expect(part("lead").length).toBeGreaterThan(c.bars * 4);
  });

  it("puts a kick on every beat and a snare on 2 and 4 in every bar, for every seed", () => {
    for (const seed of SEEDS) {
      const c = compose(seed);
      const steps = (p: string) => new Set((c.events as Ev[]).filter((e) => e.part === p).map((e) => e.step));
      for (let bar = 0; bar < c.bars; bar++) {
        for (let q = 0; q < 4; q++) expect(steps("kick").has(bar * 16 + q * 4), `kick bar ${bar} beat ${q}`).toBe(true);
        expect(steps("snare").has(bar * 16 + 4), `snare 2 bar ${bar}`).toBe(true);
        expect(steps("snare").has(bar * 16 + 12), `snare 4 bar ${bar}`).toBe(true);
      }
    }
  });

  it("plays open hats on the off-beats, longer than the closed ticks", () => {
    const c = compose(11);
    const hats = (c.events as Ev[]).filter((e) => e.part === "hat");
    for (let bar = 0; bar < c.bars; bar++) {
      for (const off of [2, 6, 10, 14]) {
        if (bar === c.bars - 1 && off >= 8) continue; // the fill bar leaves room for the snare roll
        const h = hats.find((e) => e.step === bar * 16 + off);
        expect(h, `open hat bar ${bar} step ${off}`).toBeDefined();
        expect(h!.dur).toBeGreaterThan(1);
      }
    }
  });

  it("gallops the bass: eighth then two sixteenths, on the chord root", () => {
    const c = compose(9);
    const bass = (c.events as Ev[]).filter((e) => e.part === "bass");
    const inBar = (bar: number) => bass.filter((e) => Math.floor(e.step / 16) === bar);
    expect(bass.some((e) => e.step % 4 === 3)).toBe(true); // sixteenth pickups
    for (let bar = 0; bar < c.bars; bar++) {
      const bar0 = inBar(bar);
      expect(bar0.some((e) => e.step % 16 === 0)).toBe(true);
      expect(new Set(bar0.map((e) => e.midi)).size).toBe(1);
      for (const e of bar0) expect([0, 2, 3]).toContain(e.step % 4);
    }
    expect(bass.length).toBeGreaterThanOrEqual(c.bars * 9);
  });

  it("gates the arpeggio: mostly short sixteenth notes with rests", () => {
    for (const seed of SEEDS) {
      const c = compose(seed);
      const lead = (c.events as Ev[]).filter((e) => e.part === "lead");
      const short = lead.filter((e) => e.dur < 1).length;
      expect(short / lead.length, `seed ${seed}`).toBeGreaterThan(0.7);
      expect(lead.length).toBeLessThan(c.bars * 16); // some rests
    }
  });

  it("moves the pad filter with the chords: each pad note carries an opening sweep", () => {
    const c = compose(4);
    const pads = (c.events as Ev[] & { cutoffFrom?: number; cutoffTo?: number }[]).filter((e) => e.part === "pad") as any[];
    expect(pads.length).toBeGreaterThan(0);
    for (const p of pads) {
      expect(p.cutoffFrom).toBeGreaterThan(0);
      expect(p.cutoffTo).toBeGreaterThan(p.cutoffFrom);
    }
    const bars = new Set(pads.map((p) => p.cutoffTo));
    expect(bars.size).toBeGreaterThan(1); // opens and closes: not the same every bar
  });

  it("adds a snare-roll fill in the last bar of the 8-bar loop only", () => {
    const c = compose(21);
    const fills = (c.events as any[]).filter((e) => e.part === "snare" && e.fill);
    expect(fills.length).toBeGreaterThanOrEqual(4);
    const lastBar = (c.bars - 1) * 16;
    for (const f of fills) {
      expect(f.step).toBeGreaterThanOrEqual(lastBar + 8);
      expect(f.step).toBeLessThan(lastBar + 16);
    }
    // consecutive sixteenths at the end of the roll
    const steps = fills.map((f) => f.step);
    for (const s of [lastBar + 13, lastBar + 14, lastBar + 15]) expect(steps).toContain(s);
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

  it("honors a tempo override (clamped 60-180) without changing the pattern", () => {
    const base = compose(7);
    const fast = compose(7, 160);
    expect(fast.bpm).toBe(160);
    expect(fast.stepSeconds).toBeCloseTo(60 / 160 / 4, 10);
    expect(fast.events.map((e: Ev) => [e.part, e.step, e.midi])).toEqual(base.events.map((e: Ev) => [e.part, e.step, e.midi]));
    expect(compose(7, 500).bpm).toBe(180);
    expect(compose(7, 5).bpm).toBe(60);
    expect(compose(7, NaN)).toEqual(base);
    expect(compose(7, undefined)).toEqual(base);
  });

  it("converts MIDI notes to frequencies", () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(57)).toBeCloseTo(220, 6);
  });
});
