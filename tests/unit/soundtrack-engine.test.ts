import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { policy, resetPolicy, StubContext, FakeDocument, fakeWindow } from "./webAudioStub.js";

const require = createRequire(import.meta.url);
const Soundtrack = require("../../site/soundtrack.cjs");

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const KEY = "uts-soundtrack-muted";
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => { unhandled.push(r); };

beforeEach(() => {
  vi.useFakeTimers();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
});

function setup(mode: "allowed" | "suspended" | "reject", winOpts: Parameters<typeof fakeWindow>[0] = {}) {
  resetPolicy(mode);
  const doc = new FakeDocument();
  const win = fakeWindow({ ctor: StubContext, ...winOpts });
  const sound = Soundtrack.init({ win, doc });
  return { doc, win, sound };
}
const oscCount = () => policy.contexts.flatMap((c) => c.nodes).filter((n) => n.kind === "oscillator" && n.started).length;

describe("engine", () => {
  it("starts, schedules notes ahead, and stops scheduling when paused", async () => {
    resetPolicy("allowed");
    const engine = Soundtrack.createEngine(StubContext, { volume: 0.2, seed: 3 });
    expect(await engine.start()).toBe(true);
    const ctx = policy.contexts[0];
    vi.advanceTimersByTime(50);
    const first = oscCount();
    expect(first).toBeGreaterThan(0);
    ctx.currentTime = 2; // time passes: the look-ahead scheduler queues more
    vi.advanceTimersByTime(50);
    expect(oscCount()).toBeGreaterThan(first);
    await engine.pause();
    expect(ctx.suspendCalls).toBe(1);
    const n = oscCount();
    ctx.currentTime = 6;
    vi.advanceTimersByTime(500);
    expect(oscCount()).toBe(n);
  });

  it("sets and clamps the volume, defaulting low", () => {
    resetPolicy("allowed");
    const engine = Soundtrack.createEngine(StubContext, { seed: 1 });
    expect(engine.getVolume()).toBeGreaterThan(0);
    expect(engine.getVolume()).toBeLessThanOrEqual(0.3);
    engine.setVolume(0.1);
    expect(engine.getVolume()).toBeCloseTo(0.1);
    engine.setVolume(5);
    expect(engine.getVolume()).toBeLessThanOrEqual(1);
    engine.setVolume(-1);
    expect(engine.getVolume()).toBe(0);
  });

  it("fills a spectrum buffer from the analyser", async () => {
    resetPolicy("allowed");
    const engine = Soundtrack.createEngine(StubContext, { seed: 1 });
    await engine.start();
    const buf = new Uint8Array(engine.binCount);
    expect(engine.getSpectrum(buf)).toBe(true);
    expect(Array.from(buf).some((v) => v > 0)).toBe(true);
  });

  it("start() reports false (never throws) when the browser refuses", async () => {
    resetPolicy("reject");
    const engine = Soundtrack.createEngine(StubContext, { seed: 1 });
    expect(await engine.start()).toBe(false);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("is a graceful no-op without Web Audio", async () => {
    expect(Soundtrack.getAudioContextCtor({})).toBeNull();
    resetPolicy("allowed");
    const { doc, sound } = setup("allowed", { ctor: undefined });
    await flush();
    expect(sound.state()).toBe("unsupported");
    expect(doc.button.hidden).toBe(true);
    expect(doc.listenerCount("pointerdown")).toBe(0);
    expect(policy.contexts).toHaveLength(0);
  });

  it("falls back to webkitAudioContext", async () => {
    resetPolicy("allowed");
    const doc = new FakeDocument();
    const win = fakeWindow({ webkit: StubContext });
    expect(Soundtrack.getAudioContextCtor(win)).toBe(StubContext);
    const sound = Soundtrack.init({ win, doc });
    await flush();
    expect(sound.state()).toBe("playing");
  });
});

describe("autoplay: allowed", () => {
  it("starts on load, shows the control as pressed, no prompt", async () => {
    const { doc, sound } = setup("allowed");
    await flush();
    expect(sound.state()).toBe("playing");
    expect(doc.button.getAttribute("aria-pressed")).toBe("true");
    expect(doc.prompt.hidden).toBe(true);
    vi.advanceTimersByTime(50);
    expect(oscCount()).toBeGreaterThan(0);
  });

  it("mute stops it, persists, and a later visit does not autoplay", async () => {
    const { doc, win, sound } = setup("allowed");
    await flush();
    doc.button.click();
    await flush();
    expect(sound.state()).toBe("muted");
    expect(doc.button.getAttribute("aria-pressed")).toBe("false");
    expect(win.store[KEY]).toBe("1");
    expect(policy.contexts[0].state).toBe("suspended");

    // next visit
    const next = setup("allowed", { storage: { [KEY]: "1" } });
    await flush();
    expect(next.sound.state()).toBe("muted");
    expect(policy.contexts).toHaveLength(0);
    expect(next.doc.prompt.hidden).toBe(true);
    expect(next.doc.button.getAttribute("aria-pressed")).toBe("false");
    expect(oscCount()).toBe(0);
  });

  it("unmuting plays and clears the remembered choice", async () => {
    const { doc, win, sound } = setup("allowed", { storage: { [KEY]: "1" } });
    await flush();
    doc.button.click();
    await flush();
    expect(sound.state()).toBe("playing");
    expect(win.store[KEY]).toBeUndefined();
    expect(doc.button.getAttribute("aria-pressed")).toBe("true");
  });

  it("still works when localStorage throws", async () => {
    const { doc, sound } = setup("allowed", { storage: "throws" });
    await flush();
    expect(sound.state()).toBe("playing");
    doc.button.click();
    await flush();
    expect(sound.state()).toBe("muted");
  });

  it("pauses when the tab is hidden and resumes when visible, unless muted", async () => {
    const { doc, sound } = setup("allowed");
    await flush();
    const ctx = policy.contexts[0];
    doc.hidden = true; doc.dispatch("visibilitychange");
    await flush();
    expect(ctx.state).toBe("suspended");
    doc.hidden = false; doc.dispatch("visibilitychange");
    await flush();
    expect(ctx.state).toBe("running");
    expect(sound.state()).toBe("playing");

    doc.button.click(); await flush();
    expect(sound.state()).toBe("muted");
    doc.hidden = true; doc.dispatch("visibilitychange"); await flush();
    doc.hidden = false; doc.dispatch("visibilitychange"); await flush();
    expect(ctx.state).toBe("suspended");
    expect(sound.state()).toBe("muted");
  });

  it("exposes a spectrum only while playing", async () => {
    const { doc, sound } = setup("allowed");
    await flush();
    const buf = new Uint8Array(sound.binCount);
    expect(sound.getSpectrum(buf)).toBe(true);
    doc.button.click(); await flush();
    expect(sound.getSpectrum(buf)).toBe(false);
  });
});

describe.each(["suspended", "reject"] as const)("autoplay: blocked by the browser (%s)", (mode) => {
  it("shows the prompt and waits; nothing plays", async () => {
    const { doc, sound } = setup(mode);
    await flush();
    expect(sound.state()).toBe("waiting");
    expect(doc.prompt.hidden).toBe(false);
    expect(doc.prompt.textContent.toLowerCase()).toContain("tap anywhere to start the soundtrack");
    expect(doc.button.getAttribute("aria-pressed")).toBe("false");
    expect(oscCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it.each(["pointerdown", "keydown", "touchend"])("starts on the first %s and hides the prompt", async (type) => {
    const { doc, sound } = setup(mode);
    await flush();
    policy.unlocked = true; // the browser grants activation with a real gesture
    doc.dispatch(type, { tagName: "BODY" });
    await flush();
    expect(sound.state()).toBe("playing");
    expect(doc.prompt.hidden).toBe(true);
    expect(doc.button.getAttribute("aria-pressed")).toBe("true");
    expect(doc.listenerCount("pointerdown")).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it.each(["mousemove", "scroll", "wheel", "touchmove"])("does NOT treat %s as a gesture", async (type) => {
    const { doc, sound } = setup(mode);
    await flush();
    for (let i = 0; i < 10; i++) { doc.dispatch(type, { tagName: "BODY" }); await flush(); }
    expect(sound.state()).toBe("waiting");
    expect(doc.prompt.hidden).toBe(false);
    expect(oscCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("a gesture the browser does not accept keeps waiting and keeps the prompt", async () => {
    const { doc, sound } = setup(mode);
    await flush();
    doc.dispatch("keydown", { tagName: "BODY" }); // e.g. a modifier key: not activation
    await flush();
    expect(sound.state()).toBe("waiting");
    expect(doc.prompt.hidden).toBe(false);
    expect(doc.listenerCount("pointerdown")).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("clicking the control starts it once (the click is the gesture, not a mute)", async () => {
    const { doc, sound } = setup(mode);
    await flush();
    policy.unlocked = true;
    doc.dispatch("pointerdown", doc.button); // fires before click on the same press
    doc.button.click();
    await flush();
    expect(sound.state()).toBe("playing");
  });

  it("a muted visitor is never prompted and nothing is created", async () => {
    const { doc, sound } = setup(mode, { storage: { [KEY]: "1" } });
    await flush();
    expect(sound.state()).toBe("muted");
    expect(doc.prompt.hidden).toBe(true);
    expect(policy.contexts).toHaveLength(0);
    doc.dispatch("pointerdown", { tagName: "BODY" });
    await flush();
    expect(sound.state()).toBe("muted");
    expect(policy.contexts).toHaveLength(0);
  });
});

describe("best-effort attempt on scroll", () => {
  it("tries resume() a few times at most, passively, and swallows rejections", async () => {
    const { doc } = setup("reject");
    await flush();
    const before = policy.resumeCalls;
    for (let i = 0; i < 50; i++) { doc.dispatch(i % 2 ? "scroll" : "wheel"); await flush(); }
    const attempts = policy.resumeCalls - before;
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(unhandled).toEqual([]);
  });

  it("can succeed where the browser already allows autoplay (and then plays)", async () => {
    const { doc, sound } = setup("suspended");
    await flush();
    policy.unlocked = true; // e.g. high media-engagement score: resume() works without a click
    doc.dispatch("scroll");
    await flush();
    expect(sound.state()).toBe("playing");
    expect(doc.prompt.hidden).toBe(true);
  });
});

describe("visual reaction", () => {
  it("getSpectrum is false when not playing, and the mapping is bounded", async () => {
    const { sound } = setup("suspended");
    await flush();
    expect(sound.getSpectrum(new Uint8Array(sound.binCount))).toBe(false);
  });
});
