/**
 * A minimal stand-in for the Web Audio API and the bits of the DOM the soundtrack uses, so the
 * engine and the autoplay logic can be tested in Node. It models the browser autoplay policy:
 * a context created without user activation stays "suspended" (or rejects resume()) until
 * `policy.unlocked` is set to true, which tests do right before dispatching a real gesture.
 */
export type Mode = "allowed" | "suspended" | "reject";

export const policy: { mode: Mode; unlocked: boolean; contexts: StubContext[]; resumeCalls: number } = {
  mode: "allowed",
  unlocked: false,
  contexts: [],
  resumeCalls: 0,
};

export function resetPolicy(mode: Mode): void {
  policy.mode = mode;
  policy.unlocked = false;
  policy.contexts = [];
  policy.resumeCalls = 0;
}

export class StubParam {
  value = 0;
  calls: string[] = [];
  setValueAtTime(v: number) { this.value = v; this.calls.push("set"); return this; }
  linearRampToValueAtTime(v: number) { this.value = v; this.calls.push("lin"); return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; this.calls.push("exp"); return this; }
  setTargetAtTime(v: number) { this.value = v; this.calls.push("target"); return this; }
  cancelScheduledValues() { return this; }
}

export class StubNode {
  gain = new StubParam();
  frequency = new StubParam();
  detune = new StubParam();
  Q = new StubParam();
  delayTime = new StubParam();
  type = "";
  buffer: unknown = null;
  loop = false;
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 64;
  started = false;
  stopped = false;
  connections: unknown[] = [];
  constructor(public kind: string) {}
  connect(to: unknown) { this.connections.push(to); return to; }
  disconnect() { this.connections = []; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  getByteFrequencyData(a: Uint8Array) { a.fill(120); }
  getFloatFrequencyData(a: Float32Array) { a.fill(-60); }
}

export class StubContext {
  state: "running" | "suspended" | "closed";
  currentTime = 0;
  sampleRate = 44100;
  destination = new StubNode("destination");
  nodes: StubNode[] = [];
  listeners: Record<string, Array<() => void>> = {};
  suspendCalls = 0;
  constructor() {
    this.state = policy.mode === "allowed" ? "running" : "suspended";
    policy.contexts.push(this);
  }
  private make(kind: string) { const n = new StubNode(kind); this.nodes.push(n); return n; }
  createGain() { return this.make("gain"); }
  createOscillator() { return this.make("oscillator"); }
  createBiquadFilter() { return this.make("filter"); }
  createAnalyser() { return this.make("analyser"); }
  createDelay() { return this.make("delay"); }
  createConvolver() { return this.make("convolver"); }
  createBufferSource() { return this.make("source"); }
  createDynamicsCompressor() { return this.make("compressor"); }
  createBuffer(_c: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  private setState(s: "running" | "suspended") {
    if (this.state === s) return;
    this.state = s;
    (this.listeners.statechange ?? []).forEach((f) => f());
  }
  resume(): Promise<void> {
    policy.resumeCalls++;
    if (this.state === "closed") return Promise.reject(new Error("closed"));
    if (this.state === "running" || policy.unlocked) { this.setState("running"); return Promise.resolve(); }
    if (policy.mode === "reject") return Promise.reject(new DOMException("The AudioContext was not allowed to start.", "NotAllowedError"));
    return Promise.resolve(); // stays suspended
  }
  suspend(): Promise<void> { this.suspendCalls++; this.setState("suspended"); return Promise.resolve(); }
  close(): Promise<void> { this.state = "closed"; return Promise.resolve(); }
}

// ---- tiny fake DOM ----
export class FakeElement {
  attrs: Record<string, string> = {};
  hidden = false;
  textContent = "";
  listeners: Record<string, Array<(e: any) => void>> = {};
  constructor(public id: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: (e: any) => void) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  contains(t: unknown) { return t === this; }
  click() { (this.listeners.click ?? []).slice().forEach((f) => f({ target: this })); }
}

export class FakeDocument {
  hidden = false;
  button = new FakeElement("sound-toggle");
  prompt = new FakeElement("sound-prompt");
  state = new FakeElement("sound-state");
  listeners: Record<string, Array<(e: any) => void>> = {};
  constructor() { this.prompt.hidden = true; }
  getElementById(id: string) {
    return ({ "sound-toggle": this.button, "sound-prompt": this.prompt, "sound-state": this.state } as Record<string, FakeElement>)[id] ?? null;
  }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: (e: any) => void) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatch(type: string, target: unknown = this) { (this.listeners[type] ?? []).slice().forEach((f) => f({ type, target })); }
  listenerCount(type: string) { return (this.listeners[type] ?? []).length; }
}

export function fakeWindow(opts: { ctor?: unknown; webkit?: unknown; storage?: Record<string, string> | "throws" } = {}) {
  const store: Record<string, string> = opts.storage && opts.storage !== "throws" ? opts.storage : {};
  const win: any = { AudioContext: opts.ctor, webkitAudioContext: opts.webkit, store };
  if (opts.storage === "throws") {
    Object.defineProperty(win, "localStorage", { get() { throw new Error("blocked"); } });
  } else {
    win.localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
  }
  return win;
}
