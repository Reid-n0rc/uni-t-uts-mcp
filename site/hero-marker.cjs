// Marker logic for the project site hero: which point of the drawn trace the marker sits on, what
// frequency and level that position stands for, and where the readout window goes. Pure functions
// only (no DOM, no timers), so they are tested in Node; the page only applies the results.
//
// This file is inlined into site/index.html by scripts/build-site.mjs (placeholder HERO_MARKER_JS), so
// the built page stays one self-contained file. It must not contain a closing script tag.
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HeroMarker = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Illustrative display scale. The trace canvas draws -100 dBm at 90% of its height and -12 dBm at 28%;
  // the same line, extended, reaches 0 dBm near the top. The frequency axis is the analyzer's 10 MHz-3.6 GHz.
  var START_HZ = 10e6, STOP_HZ = 3.6e9;
  var LEVEL_MIN = -100, LEVEL_MAX = -12;
  var Y_AT_MIN = 0.9, Y_AT_MAX = 0.28;

  // ---------------------------------------------------------------- peak finding
  /** Moving average with an odd window (shrinks at the ends). */
  function smooth(samples, window) {
    var n = samples.length, half = Math.max(0, Math.floor((window || 1) / 2));
    var out = new Array(n), i, j, lo, hi, sum;
    for (i = 0; i < n; i++) {
      lo = Math.max(0, i - half); hi = Math.min(n - 1, i + half); sum = 0;
      for (j = lo; j <= hi; j++) sum += samples[j];
      out[i] = sum / (hi - lo + 1);
    }
    return out;
  }

  /** Highest point of the smoothed trace, so a single noisy sample cannot win. */
  function findPeak(samples, opts) {
    var n = samples.length;
    if (n === 0) return { index: 0, value: Number.NEGATIVE_INFINITY };
    var s = smooth(samples, (opts && opts.window) || 15), best = 0, i;
    for (i = 1; i < n; i++) if (s[i] > s[best]) best = i;
    return { index: best, value: s[best] };
  }

  /**
   * Peak with hysteresis: stay with the current peak (following it as it drifts) unless a rival that is
   * somewhere else beats it by more than holdDb. state is null at the start; returns { target, value }.
   */
  function trackPeak(state, samples, opts) {
    var window = (opts && opts.window) || 15, holdDb = opts && opts.holdDb != null ? opts.holdDb : 1.5;
    var best = findPeak(samples, { window: window });
    if (!state || !samples.length) return { target: best.index, value: best.value };
    var s = smooth(samples, window), n = s.length, radius = window * 3;
    var lo = Math.max(0, Math.round(state.target) - radius), hi = Math.min(n - 1, Math.round(state.target) + radius);
    var local = lo, i;
    for (i = lo + 1; i <= hi; i++) if (s[i] > s[local]) local = i;
    if (best.index >= lo && best.index <= hi) return { target: best.index, value: best.value };
    if (best.value > s[local] + holdDb) return { target: best.index, value: best.value };
    return { target: local, value: s[local] };
  }

  /** One easing step toward target; frame-rate independent, never overshoots. */
  function stepToward(pos, target, dtMs, tauMs) {
    if (!(dtMs > 0)) return pos;
    var k = 1 - Math.exp(-dtMs / (tauMs || 140));
    return pos + (target - pos) * k;
  }

  /** Value of the samples at a fractional index (linear), clamped to the ends. */
  function sampleAt(samples, pos) {
    var n = samples.length;
    if (n === 0) return NaN;
    if (pos <= 0) return samples[0];
    if (pos >= n - 1) return samples[n - 1];
    var i = Math.floor(pos), f = pos - i;
    return samples[i] + (samples[i + 1] - samples[i]) * f;
  }

  // ---------------------------------------------------------------- position to numbers
  function xToFrequencyHz(x, width) {
    var f = width > 0 ? Math.min(1, Math.max(0, x / width)) : 0;
    return START_HZ + (STOP_HZ - START_HZ) * f;
  }
  function indexToFrequencyHz(index, count) {
    return xToFrequencyHz(index, count - 1);
  }
  function levelToY(dbm, height) {
    return height * (Y_AT_MIN + (Y_AT_MAX - Y_AT_MIN) * (dbm - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN));
  }
  function yToLevelDbm(y, height) {
    return LEVEL_MIN + (LEVEL_MAX - LEVEL_MIN) * (y / height - Y_AT_MIN) / (Y_AT_MAX - Y_AT_MIN);
  }
  function formatFrequency(hz) {
    return hz >= 1e9 ? (hz / 1e9).toFixed(3) + " GHz" : (hz / 1e6).toFixed(3) + " MHz";
  }
  function formatLevel(dbm) {
    var t = dbm.toFixed(1);
    return (t === "-0.0" ? "0.0" : t) + " dBm";
  }

  // ---------------------------------------------------------------- readout placement
  function overlapArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function clamp(v, lo, hi) { return hi < lo ? lo : Math.min(hi, Math.max(lo, v)); }

  /**
   * Where to put the readout window for a marker at opts.anchor ({x, y}, the flag), inside opts.bounds
   * ({w, h}), without covering any rectangle in opts.avoid ({left, top, right, bottom}). Tries the sides in
   * opts.order (default above, right, left, below; opts.prefer, the side used last time, goes first so the
   * window does not flip back and forth): above and below slide sideways to stay inside the bounds; right
   * and left are skipped when they do not fit (that is the flip) and slide down from level with the top of
   * the flag until they are clear. If every spot collides the one with the least overlap wins.
   * Returns { left, top, side }.
   */
  function placeCallout(opts) {
    var a = opts.anchor, size = opts.size, bounds = opts.bounds;
    var margin = opts.margin != null ? opts.margin : 8, gap = opts.gap != null ? opts.gap : 22;
    var order = (opts.order || ["above", "right", "left", "below"]).slice(), avoid = opts.avoid || [];
    var minLeft = margin, maxLeft = bounds.w - margin - size.w, minTop = margin, maxTop = bounds.h - margin - size.h;
    var best = null, k, c, cands, j, i, area, fits, top0, steps = 14;
    var p = order.indexOf(opts.prefer);
    if (p > 0) { order.splice(p, 1); order.unshift(opts.prefer); }

    function cost(left, top) {
      var box = { left: left, top: top, right: left + size.w, bottom: top + size.h }, sum = 0, n;
      for (n = 0; n < avoid.length; n++) sum += overlapArea(box, avoid[n]);
      return sum;
    }
    for (k = 0; k < order.length; k++) {
      c = order[k];
      cands = [];
      if (c === "above" || c === "below") {
        cands.push({ left: clamp(a.x - size.w * 0.3, minLeft, maxLeft), top: c === "above" ? a.y - gap - size.h : a.y + gap });
      } else {
        // from sitting high beside the flag down to being level with it
        top0 = a.y - size.h - 4;
        for (j = 0; j <= steps; j++) cands.push({ left: c === "right" ? a.x + gap : a.x - gap - size.w, top: top0 + (size.h - 4) * j / steps });
      }
      for (j = 0; j < cands.length; j++) {
        var cand = cands[j];
        if (c === "above" || c === "below") fits = cand.top >= minTop && cand.top <= maxTop;
        else { cand.top = clamp(cand.top, minTop, maxTop); fits = cand.left >= minLeft && cand.left <= maxLeft; }
        area = cost(cand.left, cand.top);
        if (fits && area === 0) return { left: cand.left, top: cand.top, side: c };
        // a spot that does not fit the bounds is only a last resort, behind every fitting one
        area += fits ? 0 : 1e9;
        if (!best || area < best.area) best = { area: area, left: cand.left, top: cand.top, side: c };
      }
    }
    return {
      left: clamp(best.left, minLeft, maxLeft),
      top: clamp(best.top, minTop, maxTop),
      side: best.side
    };
  }

  return {
    START_HZ: START_HZ, STOP_HZ: STOP_HZ,
    smooth: smooth, findPeak: findPeak, trackPeak: trackPeak, stepToward: stepToward, sampleAt: sampleAt,
    xToFrequencyHz: xToFrequencyHz, indexToFrequencyHz: indexToFrequencyHz,
    levelToY: levelToY, yToLevelDbm: yToLevelDbm, formatFrequency: formatFrequency, formatLevel: formatLevel,
    placeCallout: placeCallout
  };
});
