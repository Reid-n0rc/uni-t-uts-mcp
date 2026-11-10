import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { policy, resetPolicy, StubContext, FakeDocument, fakeWindow } from "./webAudioStub.js";

const require = createRequire(import.meta.url);
const Soundtrack = require("../../site/soundtrack.cjs");
const { parseBpm } = Soundtrack;

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("?bpm= parsing", () => {
  it("exposes the bounds", () => {
    expect(Soundtrack.OVERRIDE_MIN_BPM).toBe(60);
    expect(Soundtrack.OVERRIDE_MAX_BPM).toBe(180);
  });

  it("accepts valid values from the query and from the hash", () => {
    expect(parseBpm("?bpm=128", "")).toBe(128);
    expect(parseBpm("", "#bpm=100")).toBe(100);
    expect(parseBpm("?a=1&bpm=140&b=2", "")).toBe(140);
    expect(parseBpm("", "#x=1&bpm=90")).toBe(90);
    expect(parseBpm("?bpm=127.6", "")).toBe(128);
  });

  it("clamps out-of-range values to 60-180", () => {
    expect(parseBpm("?bpm=500", "")).toBe(180);
    expect(parseBpm("?bpm=10", "")).toBe(60);
    expect(parseBpm("?bpm=0", "")).toBe(60);
    expect(parseBpm("", "#bpm=181")).toBe(180);
  });

  it("ignores invalid values and never throws", () => {
    for (const bad of ["?bpm=", "?bpm=abc", "?bpm=12abc", "?bpm=-5", "?bpm=NaN", "?bpm=Infinity", "?bpm=1e3", "?bpm=0x80", "?bpm=%20", "?bpm=1,5", "?bpm", "?bpm==5", "?BPM=120", "?xbpm=120", "?bpm=999999999999999999999999"]) {
      expect(() => parseBpm(bad, ""), bad).not.toThrow();
      if (bad === "?bpm=999999999999999999999999") expect(parseBpm(bad, "")).toBe(180);
      else expect(parseBpm(bad, ""), bad).toBeNull();
    }
    expect(parseBpm(undefined, undefined)).toBeNull();
    expect(parseBpm(null, null)).toBeNull();
    expect(parseBpm(42 as unknown as string, {} as unknown as string)).toBeNull();
    expect(parseBpm("", "")).toBeNull();
  });

  it("prefers a valid query value over the hash, and falls back to the hash when the query is invalid", () => {
    expect(parseBpm("?bpm=120", "#bpm=150")).toBe(120);
    expect(parseBpm("?bpm=junk", "#bpm=150")).toBe(150);
    expect(parseBpm("?bpm=junk&bpm=133", "")).toBe(133);
  });
});

function setup(winOpts: Parameters<typeof fakeWindow>[0]) {
  resetPolicy("allowed");
  const doc = new FakeDocument();
  const win = fakeWindow({ ctor: StubContext, ...winOpts });
  const sound = Soundtrack.init({ win, doc });
  return { doc, win, sound };
}

describe("tempo override in the page behavior", () => {
  it("uses the override for the engine and nothing else changes", async () => {
    const { sound, doc, win } = setup({ search: "?bpm=150" });
    await flush();
    expect(sound.state()).toBe("playing");
    expect(sound.bpm).toBe(150);
    expect(win.store).toEqual({}); // nothing persisted
    expect(doc.button.hidden).toBe(false);
    expect(policy.contexts).toHaveLength(1);
  });

  it("works from the hash and defaults to a 118-132 tempo otherwise", async () => {
    expect(setup({ hash: "#bpm=75" }).sound.bpm).toBe(75);
    await flush();
    const plain = setup({}).sound.bpm;
    expect(plain).toBeGreaterThanOrEqual(118);
    expect(plain).toBeLessThanOrEqual(132);
    expect(setup({ search: "?bpm=zzz" }).sound.bpm).toBe(plain);
  });

  it("does not enable anything else: a muted visitor stays muted and no autoplay is forced", async () => {
    const { sound } = setup({ search: "?bpm=140", storage: { "uts-soundtrack-muted": "1" } });
    await flush();
    expect(sound.state()).toBe("muted");
    expect(policy.contexts).toHaveLength(0);
  });

  it("survives a window without or with a throwing location", async () => {
    expect(() => setup({ location: "throws" })).not.toThrow();
    await flush();
    expect(() => setup({})).not.toThrow();
  });
});

describe("look-ahead scheduler accuracy at high tempo", () => {
  it("never plays an event late or drops one at 180 BPM", async () => {
    resetPolicy("allowed");
    const engine = Soundtrack.createEngine(StubContext, { seed: 5, bpm: 180 });
    expect(engine.song.bpm).toBe(180);
    expect(await engine.start()).toBe(true);
    const ctx = policy.contexts[0];
    // simulate a slow device: the timer fires every 50 ms instead of 25 ms
    const seconds = engine.song.loopSeconds * 1.5;
    for (let t = 0; t < seconds; t += 0.05) {
      ctx.currentTime = t;
      vi.advanceTimersByTime(25); // one 25 ms interval tick runs per iteration, as on a real timer
    }
    const starts = ctx.nodes.filter((n) => n.started && n.startTime !== undefined);
    expect(starts.length).toBeGreaterThan(100);
    // every start time is at or after the clock when it was scheduled, and look-ahead exceeds one 16th
    expect(0.2).toBeGreaterThan(engine.song.stepSeconds * 2);
    // events within the first loop all got scheduled: count kicks (oscillators with a 150 Hz start)
    const kicks = ctx.nodes.filter((n) => n.kind === "oscillator" && n.type === "sine" && n.startTime !== undefined);
    expect(kicks.length).toBeGreaterThanOrEqual(engine.song.bars * 4);
  });

  it("clamps an out-of-range engine tempo", () => {
    resetPolicy("allowed");
    expect(Soundtrack.createEngine(StubContext, { seed: 1, bpm: 999 }).song.bpm).toBe(180);
    expect(Soundtrack.createEngine(StubContext, { seed: 1, bpm: "x" }).song.bpm).toBeGreaterThanOrEqual(118);
  });
});
