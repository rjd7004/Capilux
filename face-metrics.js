/*!
 * Bio-Radar rPPG — face-metrics.js
 * Eye and expression metrics from MediaPipe FaceLandmarker blendshapes.
 *
 *   BlinkMonitor    blink rate, PERCLOS (share of time eyes ≥ 80 % closed over 60 s),
 *                   long closures / micro-sleeps → OK · FATIGUE · DROWSY
 *   TensionMonitor  facial tension index from brow lowering, lip pressing, nose
 *                   wrinkling, frowning and (non-smile) squinting, relative to the
 *                   user's own recent neutral baseline. A rough indicator only.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FaceMetrics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Convert MediaPipe `categories` [{categoryName, score}] into a name → score map. */
  function blendshapeMap(categories) {
    var m = {};
    if (!categories) return m;
    for (var i = 0; i < categories.length; i++) m[categories[i].categoryName] = categories[i].score;
    return m;
  }

  /* ==================================================================== */

  function BlinkMonitor(options) {
    this.opts = { closeOn: 0.5, closeOff: 0.35, perclosLevel: 0.8, windowSec: 60, gapSec: 1.0 };
    if (options) for (var k in options) this.opts[k] = options[k];
    this.reset();
  }

  BlinkMonitor.prototype.reset = function () {
    this.closed = false;
    this.closeStart = 0;
    this.blinks = [];          // blink end times
    this.longClosures = [];    // {t, dur}
    this.samples = [];         // [t, score]
    this.lastT = null;
    this.observed = 0;         // seconds of continuous observation (capped by window)
    this.score = 0;
  };

  /** @param {number} score  eye-closure 0..1 (mean of eyeBlinkLeft/Right) */
  BlinkMonitor.prototype.push = function (t, score) {
    var o = this.opts;
    if (this.lastT !== null) {
      var dt = t - this.lastT;
      if (dt > o.gapSec) { this.closed = false; }      // face was lost: don't bridge the gap
      else this.observed = Math.min(o.windowSec, this.observed + dt);
    }
    this.lastT = t;
    this.score = score;
    this.samples.push([t, score]);
    while (this.samples.length && this.samples[0][0] < t - o.windowSec) this.samples.shift();

    if (!this.closed && score > o.closeOn) {
      this.closed = true;
      this.closeStart = t;
    } else if (this.closed && score < o.closeOff) {
      this.closed = false;
      var dur = t - this.closeStart;
      if (dur >= 0.04 && dur <= 0.5) this.blinks.push(t);
      else if (dur > 0.5) this.longClosures.push({ t: t, dur: dur });
    }
    while (this.blinks.length && this.blinks[0] < t - o.windowSec) this.blinks.shift();
    while (this.longClosures.length && this.longClosures[0].t < t - o.windowSec) this.longClosures.shift();
  };

  BlinkMonitor.prototype.metrics = function (t) {
    var o = this.opts;
    var rate = this.observed >= 15 ? this.blinks.length * 60 / this.observed : null;
    // time-weighted PERCLOS
    var closedT = 0, totalT = 0;
    for (var i = 1; i < this.samples.length; i++) {
      var dt = Math.min(0.25, this.samples[i][0] - this.samples[i - 1][0]);
      totalT += dt;
      if (this.samples[i][1] >= o.perclosLevel) closedT += dt;
    }
    var perclos = totalT >= 10 ? closedT / totalT : null;
    var closingNow = this.closed ? t - this.closeStart : 0;
    var microsleep = closingNow > 1.5;
    for (var j = 0; j < this.longClosures.length; j++) {
      if (this.longClosures[j].dur > 1.5 && this.longClosures[j].t > t - 30) microsleep = true;
    }
    var level = 'calibrating';
    if (microsleep || (perclos !== null && perclos > 0.15)) level = 'drowsy';
    else if (rate !== null && this.observed >= 45 && rate < 8) level = 'fatigue';
    else if (rate !== null) level = 'ok';
    return { rate: rate, perclos: perclos, closing: closingNow, microsleep: microsleep, level: level, observed: this.observed };
  };

  /* ==================================================================== */

  function TensionMonitor() { this.reset(); }

  TensionMonitor.prototype.reset = function () {
    this.history = [];        // [t, raw]
    this.baseline = null;
    this.value = 0;
    this.lastT = null;
    this.observed = 0;
    this.lastBaselineT = -Infinity;
  };

  function avg2(m, a, b) { return ((m[a] || 0) + (m[b] || 0)) / 2; }

  TensionMonitor.prototype.push = function (t, bs) {
    var smile = avg2(bs, 'mouthSmileLeft', 'mouthSmileRight');
    var raw =
      0.35 * avg2(bs, 'browDownLeft', 'browDownRight') +
      0.20 * avg2(bs, 'mouthPressLeft', 'mouthPressRight') +
      0.15 * avg2(bs, 'noseSneerLeft', 'noseSneerRight') +
      0.15 * avg2(bs, 'mouthFrownLeft', 'mouthFrownRight') +
      0.15 * avg2(bs, 'eyeSquintLeft', 'eyeSquintRight') * (1 - clamp(smile * 1.5, 0, 1));

    if (this.lastT !== null) {
      var dt = t - this.lastT;
      if (dt <= 1.0) this.observed += dt;
    }
    this.lastT = t;
    this.history.push([t, raw]);
    while (this.history.length && this.history[0][0] < t - 45) this.history.shift();

    if (t - this.lastBaselineT > 0.5 && this.history.length > 10) {
      this.lastBaselineT = t;
      var vals = this.history.map(function (h) { return h[1]; }).sort(function (a, b) { return a - b; });
      this.baseline = vals[Math.floor(vals.length * 0.15)];
    }
    var base = this.baseline === null ? raw : this.baseline;
    var relative = clamp((raw - base) / 0.18, 0, 1);
    var absolute = clamp(raw / 0.45, 0, 1);
    var target = 100 * (0.6 * relative + 0.4 * absolute);
    this.value += (target - this.value) * 0.12;
  };

  TensionMonitor.prototype.metrics = function () {
    if (this.observed < 8) return { index: null, label: 'CALIBRATING' };
    var v = this.value;
    return { index: v, label: v < 25 ? 'LOW' : v < 55 ? 'MODERATE' : 'HIGH' };
  };

  return { BlinkMonitor: BlinkMonitor, TensionMonitor: TensionMonitor, blendshapeMap: blendshapeMap };
});
