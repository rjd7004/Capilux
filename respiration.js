/*!
 * Bio-Radar rPPG — respiration.js
 * Breathing-rate estimation and heart-rhythm resonance analysis (zero dependencies;
 * reuses the FFT / filters exported by rppg-processor.js).
 *
 * Breathing leaves four fingerprints in what the scanner already measures:
 *   HEAD  — the head/shoulders rise and fall slightly (face-landmark vertical position)
 *   RIIV  — respiratory-induced intensity variation (slow change in skin brightness)
 *   RIFV  — respiratory sinus arrhythmia: heart rate speeds up on inhale, slows on exhale
 *   RIAV  — respiratory-induced amplitude variation of each pulse
 * Each source is band-passed to 0.07–0.6 Hz (4–36 breaths/min) over a 32 s window and
 * turned into a spectrum. Spectra are fused, weighted by how concentrated (clean) each
 * one's peak is, and the fused peak gives the breathing rate.
 */
(function (root, factory) {
  'use strict';
  var rppg = root && root.RPPG ? root.RPPG : (typeof require === 'function' ? require('./rppg-processor.js') : null);
  var api = factory(rppg);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Respiration = api;
})(typeof self !== 'undefined' ? self : this, function (RPPG) {
  'use strict';

  var DSP = RPPG.DSP;
  var Q = Math.SQRT1_2;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Linear interpolation of an irregular series (ts ascending) onto a uniform grid. */
  function resampleIrregular(ts, vs, t0, N, fs) {
    var out = new Float64Array(N), n = ts.length, j = 0;
    if (!n) return out;
    for (var i = 0; i < N; i++) {
      var t = t0 + i / fs;
      if (t <= ts[0]) { out[i] = vs[0]; continue; }
      if (t >= ts[n - 1]) { out[i] = vs[n - 1]; continue; }
      while (j < n - 2 && ts[j + 1] < t) j++;
      var ta = ts[j], tb = ts[j + 1];
      var f = tb > ta ? (t - ta) / (tb - ta) : 0;
      out[i] = vs[j] + (vs[j + 1] - vs[j]) * f;
    }
    return out;
  }

  /** Coverage checks for event series: enough points and no long gaps inside [t0, t1]. */
  function eventCoverage(ts, t0, t1, maxGap) {
    var count = 0, prev = t0, worst = 0;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i] < t0 || ts[i] > t1) continue;
      worst = Math.max(worst, ts[i] - prev);
      prev = ts[i];
      count++;
    }
    worst = Math.max(worst, t1 - prev);
    return { count: count, ok: worst <= maxGap };
  }

  /* ==================================================================== */

  function RespirationEstimator(options) {
    this.opts = {
      fs: 4,              // Hz, analysis rate
      windowSec: 32,
      minSec: 18,
      bandLow: 0.07,      // 4.2 breaths/min
      bandHigh: 0.6,      // 36 breaths/min
      fftSize: 512,
      updateInterval: 1.0
    };
    if (options) for (var k in options) this.opts[k] = options[k];
    var o = this.opts;
    this.sos = [DSP.biquad('highpass', o.bandLow, o.fs, Q), DSP.biquad('lowpass', o.bandHigh, o.fs, Q)];
    this.re = new Float64Array(o.fftSize);
    this.im = new Float64Array(o.fftSize);
    this.reset();
  }

  RespirationEstimator.prototype.reset = function () {
    this.t = []; this.green = []; this.head = [];
    this.lastUpdate = -Infinity;
    this.rate = 0;
    this.confidence = 0;
    this.result = { state: 'idle', progress: 0, rate: 0, rawRate: 0, confidence: 0, sources: {} };
  };

  /**
   * @param {number} t       seconds
   * @param {number} green   skin brightness proxy (any positive scale)
   * @param {number|null} headY  vertical head position in face-heights (null in fingertip mode)
   */
  RespirationEstimator.prototype.pushFrame = function (t, green, headY) {
    var n = this.t.length;
    if (n && t <= this.t[n - 1]) return;
    this.t.push(t);
    this.green.push(green > 0 ? green : NaN);
    this.head.push(typeof headY === 'number' && isFinite(headY) ? headY : NaN);
    var limit = t - this.opts.windowSec - 4, cut = 0;
    while (cut < this.t.length && this.t[cut] < limit) cut++;
    if (cut > 30) { this.t.splice(0, cut); this.green.splice(0, cut); this.head.splice(0, cut); }
  };

  /** Spectrum of one source; returns normalised in-band power + peak concentration. */
  RespirationEstimator.prototype._spectrum = function (x) {
    var o = this.opts, N = x.length, M = o.fftSize, i;
    var m = DSP.mean(x);
    var y = new Float64Array(N);
    for (i = 0; i < N; i++) y[i] = x[i] - m;
    var sd = DSP.std(y, 0);
    if (!(sd > 1e-12)) return null;
    y = DSP.filtfilt(this.sos, y, Math.min(N - 1, o.fs * 8));
    var win = DSP.hannWindow(N), re = this.re, im = this.im;
    for (i = 0; i < M; i++) { re[i] = i < N ? y[i] * win[i] : 0; im[i] = 0; }
    DSP.fft(re, im);
    var df = o.fs / M;
    var kLo = Math.ceil(o.bandLow / df), kHi = Math.floor(o.bandHigh / df);
    var P = new Float64Array(kHi - kLo + 1), total = 0, best = 0;
    for (i = 0; i < P.length; i++) {
      var k = kLo + i;
      P[i] = re[k] * re[k] + im[k] * im[k];
      total += P[i];
      if (P[i] > P[best]) best = i;
    }
    if (!(total > 0)) return null;
    for (i = 0; i < P.length; i++) P[i] /= total;
    var half = Math.max(2, Math.round(0.03 / df)), conc = 0;
    for (i = Math.max(0, best - half); i <= Math.min(P.length - 1, best + half); i++) conc += P[i];
    return { P: P, kLo: kLo, df: df, peakHz: (kLo + best) * df, concentration: conc };
  };

  /**
   * @param {number} t      seconds
   * @param {Array} beats   processor.beatLog  [{t, amp}]
   * @param {Array} ibis    processor.ibis     [{t, ibi}]
   */
  RespirationEstimator.prototype.update = function (t, beats, ibis) {
    var o = this.opts, res = this.result;
    if (t - this.lastUpdate < o.updateInterval) return res;
    this.lastUpdate = t;
    var n = this.t.length;
    var span = n > 1 ? this.t[n - 1] - this.t[0] : 0;
    res.progress = clamp(span / o.minSec, 0, 1);
    if (span < o.minSec) {
      res.state = n ? 'acquiring' : 'idle';
      return res;
    }
    var tEnd = this.t[n - 1];
    var dur = Math.min(span, o.windowSec);
    var N = Math.floor(dur * o.fs);
    var t0 = tEnd - (N - 1) / o.fs;
    var specs = {}, i;

    // Waveform sources (drop NaN samples before interpolation)
    var self = this;
    function waveform(name, arr) {
      var ts = [], vs = [];
      for (var j = 0; j < n; j++) {
        if (self.t[j] >= t0 - 1 && isFinite(arr[j])) { ts.push(self.t[j]); vs.push(arr[j]); }
      }
      if (ts.length < dur * 5) return;              // need ≥ 5 Hz effective coverage
      var x = resampleIrregular(ts, vs, t0, N, o.fs);
      if (name === 'riiv') {                          // relative brightness
        var mm = DSP.mean(x);
        if (mm > 0) for (var q = 0; q < N; q++) x[q] /= mm;
      }
      var sp = self._spectrum(x);
      if (sp) specs[name] = sp;
    }
    waveform('head', this.head);
    waveform('riiv', this.green);

    // Beat-derived sources
    function events(name, list, valueOf) {
      var ts = [], vs = [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].t >= t0 - 2) { ts.push(list[j].t); vs.push(valueOf(list[j])); }
      }
      var cov = eventCoverage(ts, t0, tEnd - 1.5, 3.0);
      if (cov.count < dur * 0.6 || !cov.ok) return;  // ≥ ~36 beats/min coverage, no gaps > 3 s
      var sp = self._spectrum(resampleIrregular(ts, vs, t0, N, o.fs));
      if (sp) specs[name] = sp;
    }
    if (ibis && ibis.length) events('rifv', ibis, function (b) { return 60 / b.ibi; });
    if (beats && beats.length) events('riav', beats, function (b) { return b.amp; });

    // Fuse
    var names = Object.keys(specs);
    res.sources = {};
    if (!names.length) {
      res.state = 'analyzing';
      this.confidence *= 0.7;
      res.confidence = this.confidence;
      return res;
    }
    var ref = specs[names[0]], L = ref.P.length, F = new Float64Array(L), wsum = 0;
    for (i = 0; i < names.length; i++) {
      var sp = specs[names[i]];
      var w = sp.concentration * sp.concentration;
      res.sources[names[i]] = { rate: sp.peakHz * 60, quality: sp.concentration };
      for (var k = 0; k < L; k++) F[k] += w * sp.P[k];
      wsum += w;
    }
    var best = 0;
    for (i = 0; i < L; i++) { F[i] /= wsum; if (F[i] > F[best]) best = i; }
    var delta = 0;
    if (best > 0 && best < L - 1) {
      var a = F[best - 1], b = F[best], c = F[best + 1], den = a - 2 * b + c;
      if (den < 0) delta = clamp(0.5 * (a - c) / den, -0.5, 0.5);
    }
    var fHz = (ref.kLo + best + delta) * ref.df;
    var half = Math.max(2, Math.round(0.03 / ref.df)), conc = 0;
    for (i = Math.max(0, best - half); i <= Math.min(L - 1, best + half); i++) conc += F[i];
    var conf = clamp((conc - 0.22) / 0.45, 0, 1);
    this.confidence += (conf - this.confidence) * 0.4;

    var raw = fHz * 60;
    if (!this.rate) { if (this.confidence >= 0.3) this.rate = raw; }
    else if (this.confidence >= 0.25) {
      var d = raw - this.rate;
      this.rate += (Math.abs(d) > 6 ? 0.15 : 0.3) * d;
    }
    res.state = this.confidence >= 0.5 ? 'locked' : 'analyzing';
    res.rawRate = raw;
    res.rate = this.rate;
    res.confidence = this.confidence;
    return res;
  };

  /* ==================================================================== *
   * Heart-rhythm resonance (breathing-coach feedback)
   *   sync       share of heart-rate-variability power at the pacing frequency (0..1)
   *   coherence  share of power in the single dominant 0.04–0.26 Hz peak (0..1)
   *   swing      peak-to-trough heart-rate oscillation at the pacing rhythm (BPM)
   * ==================================================================== */
  function hrvResonance(ibis, tEnd, targetHz, windowSec) {
    windowSec = windowSec || 64;
    var fs = 4, M = 512;
    var ts = [], vs = [], i;
    for (i = 0; i < ibis.length; i++) {
      if (ibis[i].t >= tEnd - windowSec - 2) { ts.push(ibis[i].t); vs.push(60 / ibis[i].ibi); }
    }
    if (ts.length < 12) return null;
    var dur = Math.min(windowSec, tEnd - ts[0]);
    if (dur < 20) return null;
    var cov = eventCoverage(ts, tEnd - dur, tEnd - 1.5, 4.0);
    if (!cov.ok) return null;
    var N = Math.floor(dur * fs), t0 = tEnd - (N - 1) / fs;
    var x = resampleIrregular(ts, vs, t0, N, fs);
    var m = DSP.mean(x);
    for (i = 0; i < N; i++) x[i] -= m;
    var win = DSP.hannWindow(N), re = new Float64Array(M), im = new Float64Array(M);
    for (i = 0; i < N; i++) re[i] = x[i] * win[i];
    DSP.fft(re, im);
    var df = fs / M, total = 0, best = -1, bestP = -1;
    var P = new Float64Array(M / 2 + 1);
    for (i = 0; i <= M / 2; i++) {
      P[i] = re[i] * re[i] + im[i] * im[i];
      var f = i * df;
      if (f >= 0.04 && f <= 0.4) total += P[i];
      if (f >= 0.04 && f <= 0.26 && P[i] > bestP) { bestP = P[i]; best = i; }
    }
    if (!(total > 0) || best < 0) return null;
    function bandPower(fc, hw) {
      var s = 0;
      for (var k = Math.max(0, Math.floor((fc - hw) / df)); k <= Math.min(M / 2, Math.ceil((fc + hw) / df)); k++) s += P[k];
      return s;
    }
    // Each score is rescaled against the share a flat (white-noise) spectrum would put in the
    // same band, so pure measurement noise reads ≈ 0 % rather than ~10–20 %.
    function excess(share, width) {
      var floor = width / (0.4 - 0.04);
      return clamp((share - floor) / (1 - floor), 0, 1);
    }
    var coherence = excess(bandPower(best * df, 0.015) / total, 0.03);
    var sync = targetHz ? excess(bandPower(targetHz, 0.02) / total, 0.04) : null;
    var swing = 0;
    if (targetHz) {
      var lo = Math.max(0.03, targetHz * 0.6), hi = targetHz * 1.6;
      var y = DSP.filtfilt([DSP.biquad('highpass', lo, fs, Q), DSP.biquad('lowpass', hi, fs, Q)], x, Math.min(N - 1, 40));
      swing = 2 * Math.SQRT2 * DSP.std(y);
    }
    return { coherence: coherence, sync: sync, swing: swing, peakHz: best * df, beats: ts.length, seconds: dur };
  }

  return {
    RespirationEstimator: RespirationEstimator,
    hrvResonance: hrvResonance,
    resampleIrregular: resampleIrregular
  };
});
