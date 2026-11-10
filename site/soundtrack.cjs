// Generated synthwave soundtrack for the project site. Original music, made live in the browser with
// the Web Audio API: no audio files, no external requests, no sampled or copyrighted material.
//
// Three layers, so the logic can be tested in Node without a browser:
//   1. compose(seed)      pure: scale, chords, bass/lead/pad/drum patterns as timed note events.
//   2. createEngine(Ctor) thin: schedules those events on an AudioContext with look-ahead timing.
//   3. init({win, doc})   the page behavior: autoplay attempt, first-gesture start, mute control.
//
// This file is inlined into site/index.html by scripts/build-site.mjs (placeholder SOUNDTRACK_JS), so
// the built page stays one self-contained file. It must not contain a closing script tag.
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Soundtrack = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ===================================================================== 1. composition (pure)
  var MIN_BPM = 80, MAX_BPM = 110;
  var STEPS_PER_BAR = 16; // sixteenth notes
  var BARS = 8;
  var MINOR = [0, 2, 3, 5, 7, 8, 10]; // natural minor
  // Chord roots as scale degrees (0 = tonic): i VI III VII, and variations with iv. All diatonic.
  var PROGRESSIONS = [[0, 5, 2, 6], [0, 5, 3, 6], [0, 3, 5, 6], [0, 2, 5, 6]];
  var LEAD_PATTERNS = [
    [0, 1, 2, 1, 0, 1, 2, 3, 2, 1, 2, 1, 0, 1, 2, 1],
    [0, 2, 1, 2, 0, 2, 3, 2, 1, 2, 0, 2, 1, 2, 3, 2],
    [2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 1, 3, 2, 1, 0],
  ];
  var PART_ORDER = { kick: 0, snare: 1, hat: 2, bass: 3, pad: 4, lead: 5 };

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  /** MIDI note of a scale degree (may exceed 6: wraps into the next octave). */
  function degreeMidi(root, degree) {
    return root + 12 * Math.floor(degree / 7) + MINOR[((degree % 7) + 7) % 7];
  }

  /**
   * An 8-bar loop in a minor key. Returns { seed, bpm, rootMidi, scale (pitch classes), bars,
   * stepsPerBar, stepSeconds, loopSeconds, events }. Each event: { part, step, time, dur, midi? },
   * sorted by time. The same seed always gives the same loop.
   */
  function compose(seed) {
    var rng = mulberry32(seed);
    var bpm = MIN_BPM + Math.floor(rng() * (MAX_BPM - MIN_BPM + 1));
    var rootMidi = 45 + Math.floor(rng() * 12);
    var scale = MINOR.map(function (i) { return (rootMidi + i) % 12; });
    var stepSeconds = 60 / bpm / 4;
    var progA = PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)];
    var progB = PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)];
    var events = [];
    function add(part, step, steps, midi) {
      var e = { part: part, step: step, time: step * stepSeconds, dur: steps * stepSeconds };
      if (midi !== undefined) e.midi = midi;
      events.push(e);
    }

    for (var bar = 0; bar < BARS; bar++) {
      var base = bar * STEPS_PER_BAR;
      var chord = (bar < 4 ? progA : progB)[bar % 4];
      var triad = [chord, chord + 2, chord + 4];

      // drums: four on the floor, snare on 2 and 4, off-beat hats
      for (var q = 0; q < 4; q++) add("kick", base + q * 4, 2);
      add("snare", base + 4, 2); add("snare", base + 12, 2);
      for (var h = 2; h < STEPS_PER_BAR; h += 4) add("hat", base + h, h === 14 && bar % 2 ? 1.5 : 0.4);
      if (rng() < 0.5) add("hat", base + 15, 0.4);

      // pad: the chord held for the bar, an octave up
      for (var k = 0; k < 3; k++) add("pad", base, STEPS_PER_BAR * 0.98, degreeMidi(rootMidi, triad[k]) + 12);

      // bass: driving eighths on the chord root, an octave below the key; never overlapping
      var bassRoot = degreeMidi(rootMidi, chord) - 12;
      for (var s = 0; s < STEPS_PER_BAR; s += 2) {
        if (s % 4 !== 0 && rng() < 0.12) continue; // a rest now and then
        add("bass", base + s, 1.6, bassRoot);
      }

      // lead: a 16th-note arpeggio over the chord (tones 0..2 plus the octave), with rests
      var pattern = LEAD_PATTERNS[Math.floor(rng() * LEAD_PATTERNS.length)];
      var tones = [chord, chord + 2, chord + 4, chord + 7];
      var notes = [];
      for (var n = 0; n < STEPS_PER_BAR; n++) notes.push(n % 4 !== 0 && rng() < 0.12 ? null : tones[pattern[n]]);
      for (var st = 0; st < STEPS_PER_BAR; st++) {
        if (notes[st] === null) continue;
        var last = bar === BARS - 1 && st === STEPS_PER_BAR - 1;
        var long = !last && st < STEPS_PER_BAR - 1 && notes[st + 1] === null && rng() < 0.4;
        add("lead", base + st, long ? 1.9 : 0.9, degreeMidi(rootMidi, notes[st]));
      }
    }

    events.sort(function (a, b) { return a.step - b.step || PART_ORDER[a.part] - PART_ORDER[b.part]; });
    return {
      seed: seed, bpm: bpm, rootMidi: rootMidi, scale: scale, bars: BARS, stepsPerBar: STEPS_PER_BAR,
      stepSeconds: stepSeconds, loopSeconds: BARS * STEPS_PER_BAR * stepSeconds, events: events,
    };
  }

  // ===================================================================== 2. audio engine (thin)
  var DEFAULT_VOLUME = 0.16; // low: this is background music on a documentation page
  var LOOKAHEAD = 0.2;       // seconds scheduled ahead of the audio clock
  var TICK_MS = 25;
  var RESUME_GRACE_MS = 300;
  var BIN_COUNT = 128;

  function getAudioContextCtor(win) {
    return (win && (win.AudioContext || win.webkitAudioContext)) || null;
  }

  function createEngine(Ctor, options) {
    options = options || {};
    var song = compose(options.seed === undefined ? 1992 : options.seed);
    var volume = clamp01(options.volume === undefined ? DEFAULT_VOLUME : options.volume);
    var ctx = null, master = null, analyser = null, bus = null, noise = null;
    var timer = null, idx = 0, loopStart = 0, started = false;

    function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

    function build() {
      ctx = new Ctor();
      master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
      analyser = ctx.createAnalyser(); analyser.fftSize = BIN_COUNT * 2; analyser.smoothingTimeConstant = 0.7;
      analyser.connect(master); // before the master gain, so the visuals do not depend on the volume
      bus = ctx.createGain(); bus.gain.value = 0.9; bus.connect(analyser);
      // dotted-eighth echo
      var delay = ctx.createDelay(2); delay.delayTime.value = song.stepSeconds * 3;
      var fb = ctx.createGain(); fb.gain.value = 0.32;
      var send = ctx.createGain(); send.gain.value = 0.22;
      send.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(bus);
      // light reverb from a generated, decaying noise impulse
      var verb = ctx.createConvolver(), len = Math.floor(ctx.sampleRate * 1.4);
      var imp = ctx.createBuffer(2, len, ctx.sampleRate);
      for (var c = 0; c < 2; c++) {
        var d = imp.getChannelData(c);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      verb.buffer = imp;
      var wet = ctx.createGain(); wet.gain.value = 0.18;
      verb.connect(wet); wet.connect(bus);
      ctx._sends = { delay: send, verb: verb };
      var nlen = ctx.sampleRate;
      noise = ctx.createBuffer(1, nlen, ctx.sampleRate);
      var nd = noise.getChannelData(0);
      for (var j = 0; j < nlen; j++) nd[j] = Math.random() * 2 - 1;
    }

    function route(node, wetDelay, wetVerb) {
      node.connect(bus);
      if (wetDelay) node.connect(ctx._sends.delay);
      if (wetVerb) node.connect(ctx._sends.verb);
    }

    function tone(type, freq, t, dur, peak, attack, release, cutoff, wetDelay, wetVerb, detune) {
      var osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), g = ctx.createGain();
      osc.type = type; osc.frequency.value = freq;
      if (detune) osc.detune.value = detune;
      filter.type = "lowpass"; filter.frequency.value = cutoff;
      var end = t + dur;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, Math.max(t + attack, end));
      g.gain.linearRampToValueAtTime(0, end + release);
      osc.connect(filter); filter.connect(g); route(g, wetDelay, wetVerb);
      osc.start(t); osc.stop(end + release + 0.05);
    }

    function hit(kind, t, dur) {
      var g = ctx.createGain();
      if (kind === "kick") {
        var o = ctx.createOscillator(); o.type = "sine";
        o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
        o.connect(g); route(g, false, false); o.start(t); o.stop(t + 0.35);
        return;
      }
      var src = ctx.createBufferSource(), f = ctx.createBiquadFilter();
      src.buffer = noise; f.type = "highpass";
      if (kind === "snare") {
        f.frequency.value = 1500;
        g.gain.setValueAtTime(0.38, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        var body = ctx.createOscillator(), bg = ctx.createGain(); body.type = "triangle"; body.frequency.value = 190;
        bg.gain.setValueAtTime(0.3, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        body.connect(bg); route(bg, false, true); body.start(t); body.stop(t + 0.12);
        src.connect(f); f.connect(g); route(g, false, true); src.start(t); src.stop(t + 0.25);
      } else {
        f.frequency.value = 7500;
        var len = Math.max(0.05, dur);
        g.gain.setValueAtTime(0.13, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        src.connect(f); f.connect(g); route(g, false, false); src.start(t); src.stop(t + len + 0.02);
      }
    }

    function play(e, t) {
      var dur = e.dur;
      if (e.part === "bass") tone("sawtooth", midiToHz(e.midi), t, dur, 0.42, 0.01, 0.05, 420, false, false);
      else if (e.part === "lead") {
        tone("sawtooth", midiToHz(e.midi), t, dur, 0.13, 0.005, 0.08, 2600, true, true, -6);
        tone("square", midiToHz(e.midi), t, dur, 0.05, 0.005, 0.08, 1800, true, true, 7);
      } else if (e.part === "pad") {
        tone("sawtooth", midiToHz(e.midi), t, dur, 0.06, 0.5, 0.6, 1100, false, true, -9);
        tone("sawtooth", midiToHz(e.midi), t, dur, 0.06, 0.5, 0.6, 1100, false, true, 9);
      } else hit(e.part, t, dur);
    }

    function tick() {
      if (!ctx || ctx.state !== "running") return;
      var horizon = ctx.currentTime + LOOKAHEAD, guard = 0;
      while (guard++ < 600) {
        var e = song.events[idx], t = loopStart + e.time;
        if (t > horizon) break;
        if (t >= ctx.currentTime - 0.05) play(e, Math.max(t, ctx.currentTime));
        if (++idx >= song.events.length) { idx = 0; loopStart += song.loopSeconds; }
      }
    }

    function startTimer() { if (timer === null) timer = setInterval(tick, TICK_MS); }
    function stopTimer() { if (timer !== null) { clearInterval(timer); timer = null; } }

    var engine = {
      song: song,
      binCount: BIN_COUNT,
      /** Resolves true when the context is running and music is scheduled; false when the browser refuses. Never rejects. */
      start: function () {
        try {
          if (!ctx) build();
          if (ctx.state === "closed") return Promise.resolve(false);
          var after = function () {
            if (ctx.state !== "running") return false;
            if (!started) { started = true; idx = 0; loopStart = ctx.currentTime + 0.05; }
            startTimer(); tick();
            return true;
          };
          if (ctx.addEventListener && !ctx._watched) {
            ctx._watched = true;
            ctx.addEventListener("statechange", function () { if (ctx.state === "running" && options.onRunning) { try { options.onRunning(); } catch (e) { /* ignore */ } } });
          }
          var p = ctx.resume();
          // Chrome leaves the resume() promise pending (it neither resolves nor rejects) while autoplay is
          // blocked, so do not wait for it forever: decide after a short grace period. If the context
          // starts running later (a gesture, or the browser's own allowance) the statechange listener
          // above reports it through onRunning.
          return new Promise(function (resolve) {
            var done = false, finish = function () { if (!done) { done = true; resolve(after()); } };
            Promise.resolve(p).then(finish, function () { if (!done) { done = true; resolve(false); } });
            setTimeout(finish, RESUME_GRACE_MS);
          });
        } catch (err) {
          return Promise.resolve(false);
        }
      },
      /** Best-effort resume that never throws or rejects. */
      pause: function () {
        stopTimer();
        try { return Promise.resolve(ctx && ctx.state === "running" ? ctx.suspend() : undefined).then(function () {}, function () {}); }
        catch (err) { return Promise.resolve(); }
      },
      setVolume: function (v) {
        volume = clamp01(v);
        if (master) master.gain.value = volume;
      },
      getVolume: function () { return volume; },
      isRunning: function () { return !!ctx && ctx.state === "running"; },
      /** Fill buf (Uint8Array of binCount) with the current spectrum. False when nothing is playing. */
      getSpectrum: function (buf) {
        if (!analyser || !ctx || ctx.state !== "running") return false;
        try { analyser.getByteFrequencyData(buf); return true; } catch (err) { return false; }
      },
    };
    return engine;
  }

  // ===================================================================== 3. page behavior
  var MUTE_KEY = "uts-soundtrack-muted";
  var GESTURES = ["pointerdown", "keydown", "touchend"];     // real user activation in every browser
  var HINTS = ["scroll", "wheel", "touchmove"];              // NOT activation: best-effort only, see below
  var MAX_HINT_TRIES = 3;

  /**
   * Wire up the control. States: "unsupported" (no Web Audio: the control is hidden), "starting" (first attempt in flight), "muted" (visitor
   * choice, remembered), "waiting" (blocked by the autoplay policy: prompt shown), "playing", "paused"
   * (tab hidden).
   *
   * Autoplay policy: we attempt to start on load. If the browser keeps the context suspended we wait for a
   * real user gesture (pointerdown, keydown, touchend) anywhere on the page. Scrolling, the wheel and
   * mouse movement are NOT user activation in Chrome, Safari or Firefox, so they never unlock audio; we
   * only make a few passive best-effort resume() attempts on scroll/wheel/touchmove, which can succeed
   * only in browsers that already let this site autoplay (for example Chrome with a high media
   * engagement score). Failures are swallowed, there are at most MAX_HINT_TRIES of them, and the prompt
   * stays up until audio really runs. We do nothing else to get around the policy.
   */
  function init(env) {
    var win = env.win, doc = env.doc;
    var Ctor = getAudioContextCtor(win);
    var button = doc.getElementById("sound-toggle");
    var prompt = doc.getElementById("sound-prompt");
    var label = doc.getElementById("sound-state");
    var state = "unsupported", wantPlay = false, engine = null, armed = false, hintTries = 0, inflight = null;

    var api = {
      binCount: BIN_COUNT,
      state: function () { return state; },
      getSpectrum: function (buf) { return state === "playing" && engine ? engine.getSpectrum(buf) : false; },
    };

    if (!Ctor) {
      if (button) button.hidden = true;
      if (prompt) prompt.hidden = true;
      return api;
    }

    function readMuted() { try { return win.localStorage.getItem(MUTE_KEY) === "1"; } catch (e) { return false; } }
    function writeMuted(on) {
      try { if (on) win.localStorage.setItem(MUTE_KEY, "1"); else win.localStorage.removeItem(MUTE_KEY); } catch (e) { /* storage blocked: the choice just is not remembered */ }
    }
    function show() {
      if (button) button.setAttribute("aria-pressed", state === "playing" || state === "paused" ? "true" : "false");
      if (label) label.textContent = state === "playing" || state === "paused" ? "on" : "off";
      if (prompt) prompt.hidden = state !== "waiting";
    }
    function set(next) { state = next; show(); }

    function listeners(add) {
      var fnG = add ? "addEventListener" : "removeEventListener";
      GESTURES.forEach(function (t) { doc[fnG](t, onGesture, true); });
      HINTS.forEach(function (t) { doc[fnG](t, onHint, { capture: true, passive: true }); });
      armed = add;
    }
    function arm() { if (!armed) listeners(true); }
    function disarm() { if (armed) listeners(false); }

    function getEngine() {
      if (!engine) engine = createEngine(Ctor, { onRunning: function () { if (wantPlay && !doc.hidden && state !== "playing") attempt(); } });
      return engine;
    }

    /** Try to start; settles into playing, waiting (blocked) or paused (tab hidden). Never rejects. */
    function attempt(force) {
      if (!wantPlay) return Promise.resolve();
      if (inflight && !force) return inflight; // a gesture always calls resume() itself, inside the gesture
      inflight = getEngine().start().then(function (ok) {
        inflight = null;
        if (!wantPlay) { engine.pause(); return; }
        if (ok && doc.hidden) { engine.pause(); set("paused"); return; }
        if (ok) { set("playing"); disarm(); return; }
        set("waiting");
        arm();
      }, function () { inflight = null; set("waiting"); arm(); });
      return inflight;
    }

    function onGesture(ev) {
      // A press on the control itself is handled by its click handler (otherwise start+mute would race).
      if (button && ev && (ev.target === button || (button.contains && button.contains(ev.target)))) return;
      if (!wantPlay || state === "playing") return;
      attempt(true);
    }
    function onHint() {
      if (!wantPlay || state === "playing") { return; }
      if (hintTries >= MAX_HINT_TRIES) { HINTS.forEach(function (t) { doc.removeEventListener(t, onHint, true); }); return; }
      hintTries++;
      attempt();
    }

    function mute() {
      wantPlay = false; writeMuted(true);
      if (engine) engine.pause();
      disarm(); set("muted");
    }
    function unmute() {
      wantPlay = true; writeMuted(false);
      return attempt();
    }

    if (button) {
      button.hidden = false;
      button.addEventListener("click", function () {
        if (state === "playing" || state === "paused") mute(); else unmute();
      });
    }
    doc.addEventListener("visibilitychange", function () {
      if (!wantPlay || !engine) return;
      if (doc.hidden) { if (state === "playing") { engine.pause(); set("paused"); } }
      else if (state === "paused") attempt();
    });

    if (readMuted()) { wantPlay = false; set("muted"); return api; }
    wantPlay = true;
    state = "starting"; show(); // no prompt until the first attempt has settled
    arm();
    attempt();
    return api;
  }

  return {
    compose: compose, midiToHz: midiToHz, createEngine: createEngine, init: init,
    getAudioContextCtor: getAudioContextCtor,
    MIN_BPM: MIN_BPM, MAX_BPM: MAX_BPM, STEPS_PER_BAR: STEPS_PER_BAR, MUTE_KEY: MUTE_KEY,
  };
});
