/*!
 * Bio-Radar rPPG — rppg-processor.js
 * Zero-dependency remote-photoplethysmography DSP engine.
 *
 * Pipeline (re-run on a sliding window every `updateInterval` seconds):
 *   raw ROI RGB @ variable camera rate
 *     → uniform resampling (linear interpolation, fs = 30 Hz)
 *     → POS projection (Wang et al. 2017, sliding 1.6 s overlap-add)
 *       or CHROM projection (de Haan & Jeanne 2013) using X = 3Rn − 2Gn, Y = 1.5Rn + Gn − 1.5Bn
 *     → moving-average detrend
 *     → zero-phase 2nd-order Butterworth band-pass (0.7–3.5 Hz) via forward/backward biquads
 *     → Hann window + radix-2 Cooley–Tukey FFT
 *     → dominant spectral peak (parabolic interpolation) → BPM
 *     → SNR (fundamental + 1st harmonic vs. residual in-band energy) → confidence
 *     → time-domain peak detection → inter-beat intervals → RMSSD / SDNN / Baevsky stress index
 *
 * Also provides:
 *   • 'contact' method — single-channel contact PPG for a fingertip pressed over the rear camera
 *   • ROIFusion — per-region (forehead / cheeks) quality scoring and adaptive weighting
 *
 * Works as a classic browser script (exposes `window.RPPG`) and as a CommonJS module (Node tests).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RPPG = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;

  var DEFAULTS = {
    fs: 30,                 // uniform analysis sample rate (Hz)
    windowSize: 256,        // analysis window length in samples (256 @ 30 Hz ≈ 8.5 s)
    minSeconds: 5,          // seconds of signal required before the first estimate
    maxRawSeconds: 14,      // raw sample history retained
    bandLow: 0.7,           // Hz  (42 BPM)
    bandHigh: 3.5,          // Hz  (210 BPM)
    fftSize: 1024,          // zero-padded FFT length (≥ windowSize, power of two)
    posWindowSec: 1.6,      // POS temporal window (Wang et al.: 1.6 s)
    detrendSec: 2.0,        // moving-average baseline window
    updateInterval: 0.2,    // seconds between full analyses
    method: 'pos',          // 'pos' | 'chrom' | 'contact' (fingertip over the rear camera)
    spectrumBins: 48,       // bars exported for visualisation
    minIbisForStress: 15,   // IBIs required before the stress index is reported
    ibiHistorySec: 90       // seconds of beat history kept for HRV
  };

  /* ------------------------------------------------------------------ *
   * Small numeric helpers
   * ------------------------------------------------------------------ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  function meanOf(a) {
    var s = 0, n = a.length;
    for (var i = 0; i < n; i++) s += a[i];
    return n ? s / n : 0;
  }

  function stdOf(a, m) {
    var n = a.length;
    if (n < 2) return 0;
    if (m === undefined) m = meanOf(a);
    var s = 0;
    for (var i = 0; i < n; i++) { var d = a[i] - m; s += d * d; }
    return Math.sqrt(s / n);
  }

  /* ------------------------------------------------------------------ *
   * Radix-2 Cooley–Tukey FFT (iterative, in place)
   * ------------------------------------------------------------------ */
  var twiddleCache = {};
  function getTwiddles(n) {
    var t = twiddleCache[n];
    if (!t) {
      var half = n >> 1;
      var cos = new Float64Array(half), sin = new Float64Array(half);
      for (var i = 0; i < half; i++) {
        cos[i] = Math.cos(TWO_PI * i / n);
        sin[i] = -Math.sin(TWO_PI * i / n);
      }
      t = { cos: cos, sin: sin };
      twiddleCache[n] = t;
    }
    return t;
  }

  /**
   * In-place forward FFT. `re`/`im` are equal-length typed arrays whose length is a power of two.
   */
  function fft(re, im) {
    var n = re.length;
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');
    var i, j, bit, tmp;
    // Bit-reversal permutation
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    // Butterflies
    var tw = getTwiddles(n), cos = tw.cos, sin = tw.sin;
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (i = 0; i < n; i += size) {
        for (var k = 0, t = 0; k < half; k++, t += step) {
          var a = i + k, b = a + half;
          var wr = cos[t], wi = sin[t];
          var xr = re[b] * wr - im[b] * wi;
          var xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Butterworth band-pass (2nd-order HP + 2nd-order LP biquads, bilinear
   * transform with frequency pre-warping — RBJ cookbook, Q = 1/√2)
   * ------------------------------------------------------------------ */
  function biquad(type, f0, fs, Q) {
    var w0 = TWO_PI * f0 / fs;
    var c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * Q);
    var b0, b1, b2;
    if (type === 'lowpass') {
      b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
    } else {
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2;
    }
    var a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function designButterworthBandpass(fLow, fHigh, fs) {
    var Q = Math.SQRT1_2;
    return [biquad('highpass', fLow, fs, Q), biquad('lowpass', fHigh, fs, Q)];
  }

  /** Cascaded biquads, transposed direct form II, operates in place on `y`. */
  function sosFilterInPlace(sos, y) {
    var n = y.length;
    for (var s = 0; s < sos.length; s++) {
      var q = sos[s], z1 = 0, z2 = 0;
      var b0 = q.b0, b1 = q.b1, b2 = q.b2, a1 = q.a1, a2 = q.a2;
      for (var i = 0; i < n; i++) {
        var x = y[i];
        var out = b0 * x + z1;
        z1 = b1 * x - a1 * out + z2;
        z2 = b2 * x - a2 * out;
        y[i] = out;
      }
    }
    return y;
  }

  function reverseInPlace(a) {
    for (var i = 0, j = a.length - 1; i < j; i++, j--) { var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /** Zero-phase filtering with odd-reflection padding to suppress edge transients. */
  function filtfilt(sos, x, padLen) {
    var n = x.length;
    if (n < 3) return Float64Array.from(x);
    var p = Math.min(padLen, n - 1);
    var ext = new Float64Array(n + 2 * p);
    var x0 = x[0], xn = x[n - 1], i;
    for (i = 0; i < p; i++) ext[i] = 2 * x0 - x[p - i];
    for (i = 0; i < n; i++) ext[p + i] = x[i];
    for (i = 0; i < p; i++) ext[p + n + i] = 2 * xn - x[n - 2 - i];
    sosFilterInPlace(sos, ext);
    reverseInPlace(ext);
    sosFilterInPlace(sos, ext);
    reverseInPlace(ext);
    return ext.slice(p, p + n);
  }

  /** Subtract a centred moving-average baseline (prefix sums, O(n)). */
  function detrendMovingAverage(x, w) {
    var n = x.length, half = Math.max(1, Math.floor(w / 2));
    var prefix = new Float64Array(n + 1), i;
    for (i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
    var y = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var lo = i - half < 0 ? 0 : i - half;
      var hi = i + half > n - 1 ? n - 1 : i + half;
      y[i] = x[i] - (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
    return y;
  }

  function hannWindow(n) {
    var w = new Float64Array(n);
    if (n === 1) { w[0] = 1; return w; }
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / (n - 1));
    return w;
  }

  /* ------------------------------------------------------------------ *
   * rPPG projections
   * ------------------------------------------------------------------ */

  /**
   * POS — Plane-Orthogonal-to-Skin (Wang, den Brinker, Stuijk, de Haan, IEEE TBME 2017).
   * Each sliding window of length l is temporally normalised by its own mean
   * (Rn = R / μR …), which cancels camera auto-exposure / illumination intensity, then
   *   S1 = Gn − Bn,  S2 = −2Rn + Gn + Bn,  h = S1 + (σ(S1)/σ(S2))·S2
   * and the zero-mean h is overlap-added into the output.
   */
  function posProjection(R, G, B, l) {
    var N = R.length;
    var H = new Float64Array(N);
    if (N < 2) return H;
    l = Math.max(2, Math.min(l, N));
    var s1 = new Float64Array(l), s2 = new Float64Array(l);
    for (var start = 0; start + l <= N; start++) {
      var mr = 0, mg = 0, mb = 0, k;
      for (k = 0; k < l; k++) { mr += R[start + k]; mg += G[start + k]; mb += B[start + k]; }
      mr /= l; mg /= l; mb /= l;
      if (mr <= 0 || mg <= 0 || mb <= 0) continue;
      var m1 = 0, m2 = 0;
      for (k = 0; k < l; k++) {
        var rn = R[start + k] / mr, gn = G[start + k] / mg, bn = B[start + k] / mb;
        s1[k] = gn - bn;
        s2[k] = -2 * rn + gn + bn;
        m1 += s1[k]; m2 += s2[k];
      }
      m1 /= l; m2 /= l;
      var v1 = 0, v2 = 0;
      for (k = 0; k < l; k++) {
        var d1 = s1[k] - m1, d2 = s2[k] - m2;
        v1 += d1 * d1; v2 += d2 * d2;
      }
      var sd2 = Math.sqrt(v2 / l);
      var alpha = sd2 > 1e-12 ? Math.sqrt(v1 / l) / sd2 : 0;
      var hm = m1 + alpha * m2;
      for (k = 0; k < l; k++) H[start + k] += s1[k] + alpha * s2[k] - hm;
    }
    return H;
  }

  /**
   * CHROM — chrominance projection (de Haan & Jeanne, IEEE TBME 2013) using the
   * planes X = 3Rn − 2Gn and Y = 1.5Rn + Gn − 1.5Bn over the whole window.
   * The pulse projects onto X and Y with opposite signs (while specular / intensity
   * changes project with the same sign), so the combination is S = Xf − (σX/σY)·Yf.
   */
  function chromProjection(R, G, B, sos, padLen) {
    var N = R.length;
    var mr = meanOf(R), mg = meanOf(G), mb = meanOf(B);
    var X = new Float64Array(N), Y = new Float64Array(N), i;
    if (mr <= 0 || mg <= 0 || mb <= 0) return X;
    for (i = 0; i < N; i++) {
      var rn = R[i] / mr, gn = G[i] / mg, bn = B[i] / mb;
      X[i] = 3 * rn - 2 * gn;
      Y[i] = 1.5 * rn + gn - 1.5 * bn;
    }
    var Xf = filtfilt(sos, X, padLen), Yf = filtfilt(sos, Y, padLen);
    var sy = stdOf(Yf);
    var alpha = sy > 1e-12 ? stdOf(Xf) / sy : 0;
    var S = new Float64Array(N);
    for (i = 0; i < N; i++) S[i] = Xf[i] - alpha * Yf[i];
    return S;
  }

  /**
   * Contact PPG (fingertip over camera + flash). Tissue fully covers the sensor, so a single
   * well-exposed channel carries the pulse: green when it is in range (strongest haemoglobin
   * absorption), otherwise red (dominant when the flash is unavailable), otherwise blue.
   * More blood ⇒ less transmitted light, so the signal is inverted to put systole on top.
   */
  function contactProjection(R, G, B) {
    var N = R.length, chans = [G, R, B], names = ['G', 'R', 'B'];
    var means = [meanOf(G), meanOf(R), meanOf(B)];
    var pick = -1, k, i;
    for (k = 0; k < 3; k++) if (means[k] >= 20 && means[k] <= 235) { pick = k; break; }
    if (pick < 0) pick = means[1] > 0 ? 1 : (means[0] > 0 ? 0 : 2);
    var c = chans[pick], m = means[pick], h = new Float64Array(N);
    if (m > 0) for (i = 0; i < N; i++) h[i] = -(c[i] / m - 1);
    return { h: h, channel: names[pick] };
  }

  /* ------------------------------------------------------------------ *
   * Processor
   * ------------------------------------------------------------------ */
  function RPPGProcessor(options) {
    this.opts = {};
    var k;
    for (k in DEFAULTS) this.opts[k] = DEFAULTS[k];
    if (options) for (k in options) this.opts[k] = options[k];
    var o = this.opts;
    this.sos = designButterworthBandpass(o.bandLow, o.bandHigh, o.fs);
    this.fftSize = Math.max(nextPow2(o.fftSize), nextPow2(o.windowSize));
    this.fftRe = new Float64Array(this.fftSize);
    this.fftIm = new Float64Array(this.fftSize);
    this.power = new Float64Array((this.fftSize >> 1) + 1);
    this._hannCache = {};
    this.version = 0;
    this.reset();
  }

  RPPGProcessor.prototype.reset = function () {
    this.tRaw = []; this.rRaw = []; this.gRaw = []; this.bRaw = []; this.mRaw = [];
    this.lastAnalysisT = -Infinity;
    this.bpm = 0;
    this.bpmHistory = [];
    this.jumpCount = 0;
    this.confidence = 0;
    this.locked = false;
    this.lockAccum = 0;
    this.unlockAccum = 0;
    this.lowConfAccum = 0;
    this.lastBeatTime = null;
    this.segmentOpen = false;
    this.ibis = [];           // validated inter-beat intervals {t, ibi, amp}
    this.beatLog = [];        // every committed beat {t, amp}
    this.result = {
      state: 'idle',            // idle | acquiring | analyzing | locked
      progress: 0,              // 0..1 while acquiring
      bufferSeconds: 0,
      bpm: 0,                   // tracked / smoothed BPM (0 = none)
      rawBpm: 0,                // instantaneous spectral estimate
      confidence: 0,            // 0..1
      snr: -Infinity,           // dB
      motion: 0,
      locked: false,
      method: this.opts.method,
      channel: null,            // contact mode: which colour channel carries the pulse
      pulse: new Float32Array(0),
      pulseT0: 0,
      fs: this.opts.fs,
      peakTimes: [],
      lastPeakTime: null,
      spectrum: new Float32Array(this.opts.spectrumBins),
      peakFreq: 0,
      hrv: { rmssd: 0, sdnn: 0, count: 0 },
      stress: null,             // { index 0..100, si, label } once calibrated
      stressProgress: 0,
      version: this.version
    };
  };

  /**
   * Feed one frame.
   * @param {number} t       timestamp in seconds (monotonic)
   * @param {number} r,g,b   mean ROI colour (0..255)
   * @param {number} motion  normalised head motion (0 = still, ≥1 = excessive)
   */
  RPPGProcessor.prototype.push = function (t, r, g, b, motion) {
    var n = this.tRaw.length;
    if (n && t <= this.tRaw[n - 1]) return;
    if (!(r >= 0 && g >= 0 && b >= 0) || r + g + b <= 0) return;
    this.tRaw.push(t); this.rRaw.push(r); this.gRaw.push(g); this.bRaw.push(b);
    this.mRaw.push(motion || 0);
    // Trim history (batched splice keeps this O(1) amortised)
    var limit = t - this.opts.maxRawSeconds, cut = 0;
    while (cut < this.tRaw.length && this.tRaw[cut] < limit) cut++;
    if (cut > 16) {
      this.tRaw.splice(0, cut); this.rRaw.splice(0, cut); this.gRaw.splice(0, cut);
      this.bRaw.splice(0, cut); this.mRaw.splice(0, cut);
    }
  };

  /** Seconds of contiguous signal available. */
  RPPGProcessor.prototype.duration = function () {
    var n = this.tRaw.length;
    return n > 1 ? this.tRaw[n - 1] - this.tRaw[0] : 0;
  };

  /** Run an analysis if the update interval elapsed. Returns the latest result object. */
  RPPGProcessor.prototype.update = function (t) {
    if (t - this.lastAnalysisT >= this.opts.updateInterval) {
      var dt = isFinite(this.lastAnalysisT) ? Math.min(1, t - this.lastAnalysisT) : this.opts.updateInterval;
      this.lastAnalysisT = t;
      this._analyze(dt);
    }
    return this.result;
  };

  RPPGProcessor.prototype._hann = function (n) {
    var w = this._hannCache[n];
    if (!w) { w = hannWindow(n); this._hannCache[n] = w; }
    return w;
  };

  /** Resample the trailing window onto a uniform grid ending at the newest sample. */
  RPPGProcessor.prototype._resample = function (N, t0) {
    var fs = this.opts.fs;
    var T = this.tRaw, Rr = this.rRaw, Gr = this.gRaw, Br = this.bRaw, Mr = this.mRaw;
    var R = new Float64Array(N), G = new Float64Array(N), B = new Float64Array(N);
    var n = T.length, j = 0, motionSum = 0;
    while (j < n - 2 && T[j + 1] < t0) j++;
    for (var i = 0; i < N; i++) {
      var t = t0 + i / fs;
      while (j < n - 2 && T[j + 1] < t) j++;
      var ta = T[j], tb = T[j + 1], f = tb > ta ? (t - ta) / (tb - ta) : 0;
      f = clamp(f, 0, 1);
      R[i] = Rr[j] + (Rr[j + 1] - Rr[j]) * f;
      G[i] = Gr[j] + (Gr[j + 1] - Gr[j]) * f;
      B[i] = Br[j] + (Br[j + 1] - Br[j]) * f;
      motionSum += Mr[j] + (Mr[j + 1] - Mr[j]) * f;
    }
    return { R: R, G: G, B: B, motion: motionSum / N };
  };

  RPPGProcessor.prototype._analyze = function (dt) {
    var o = this.opts, fs = o.fs, res = this.result, i, k;
    var n = this.tRaw.length;
    res.method = o.method;

    if (n < 2) {
      res.state = 'idle'; res.progress = 0; res.bufferSeconds = 0;
      res.confidence = this.confidence = 0;
      this._bump();
      return;
    }

    var tEnd = this.tRaw[n - 1];
    var span = tEnd - this.tRaw[0];
    res.bufferSeconds = span;
    res.progress = clamp(span / o.minSeconds, 0, 1);

    if (span < o.minSeconds) {
      res.state = 'acquiring';
      this.confidence *= 0.8;
      res.confidence = this.confidence;
      res.motion = meanOf(this.mRaw);
      this._bump();
      return;
    }

    /* ---- 1. Uniform resampling ---------------------------------------- */
    var N = Math.min(o.windowSize, Math.floor(span * fs) + 1);
    var t0 = tEnd - (N - 1) / fs;
    var rs = this._resample(N, t0);
    var padLen = Math.round(fs * 1.5);

    /* ---- 2. Colour-space projection ----------------------------------- */
    var h;
    res.channel = null;
    if (o.method === 'contact') {
      var cp = contactProjection(rs.R, rs.G, rs.B);
      h = cp.h;
      res.channel = cp.channel;
    } else if (o.method === 'chrom') {
      h = chromProjection(rs.R, rs.G, rs.B, this.sos, padLen);
    } else {
      h = posProjection(rs.R, rs.G, rs.B, Math.round(o.posWindowSec * fs));
    }

    /* ---- 3. Detrend + band-pass --------------------------------------- */
    h = detrendMovingAverage(h, Math.round(o.detrendSec * fs));
    var pulse = filtfilt(this.sos, h, padLen);
    var pm = meanOf(pulse), psd = stdOf(pulse, pm);
    if (psd > 1e-12) for (i = 0; i < N; i++) pulse[i] = (pulse[i] - pm) / psd;

    /* ---- 4. Spectrum --------------------------------------------------- */
    var M = this.fftSize, re = this.fftRe, im = this.fftIm, win = this._hann(N);
    for (i = 0; i < M; i++) { re[i] = i < N ? pulse[i] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    var half = M >> 1, P = this.power;
    for (k = 0; k <= half; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    var df = fs / M;
    var kLo = Math.max(1, Math.ceil(o.bandLow / df));
    var kHi = Math.min(half - 1, Math.floor(o.bandHigh / df));

    // Dominant peak, gently biased toward the tracked rate once locked (suppresses harmonic hops)
    var best = -1, bestW = -1;
    var priorBpm = this.locked && this.bpm > 0 ? this.bpm : 0;
    for (k = kLo; k <= kHi; k++) {
      var w = P[k];
      if (priorBpm) {
        var z = (k * df * 60 - priorBpm) / 22;
        w *= 0.45 + 0.55 * Math.exp(-0.5 * z * z);
      }
      if (w > bestW) { bestW = w; best = k; }
    }
    var delta = 0;
    if (best > kLo && best < kHi) {
      var a = P[best - 1], b = P[best], c = P[best + 1], den = a - 2 * b + c;
      if (den < 0) delta = clamp(0.5 * (a - c) / den, -0.5, 0.5);
    }
    var fPeak = (best + delta) * df;
    var rawBpm = fPeak * 60;

    /* ---- 5. SNR: fundamental ±0.1 Hz + 1st harmonic ±0.2 Hz vs. rest --- */
    var sig = 0, noise = 0;
    var nLo = Math.max(1, Math.floor(0.6 / df)), nHi = Math.min(half, Math.ceil(Math.min(4.0, fs / 2) / df));
    for (k = nLo; k <= nHi; k++) {
      var f = k * df;
      if (Math.abs(f - fPeak) <= 0.1 || Math.abs(f - 2 * fPeak) <= 0.2) sig += P[k];
      else noise += P[k];
    }
    var snr = noise > 0 && sig > 0 ? 10 * Math.log10(sig / noise) : -20;

    /* ---- 6. Confidence ------------------------------------------------- */
    this.bpmHistory.push(rawBpm);
    if (this.bpmHistory.length > 12) this.bpmHistory.shift();
    var stab = this.bpmHistory.length >= 3 ? stdOf(this.bpmHistory) : 12;
    var snrScore = clamp((snr + 1) / 8, 0, 1);
    var stabilityScore = clamp(1 - (stab - 1.5) / 10, 0, 1);
    var motionScore = clamp(1 - Math.max(0, rs.motion - 0.35) / 0.9, 0.15, 1);
    var fillScore = 0.7 + 0.3 * clamp((span - o.minSeconds) / Math.max(0.1, o.windowSize / fs - o.minSeconds), 0, 1);
    var conf = clamp((0.62 * snrScore + 0.38 * stabilityScore) * motionScore * fillScore, 0, 1);
    this.confidence += (conf - this.confidence) * 0.5;
    conf = this.confidence;

    /* ---- 7. BPM tracking ---------------------------------------------- */
    if (!this.bpm) {
      if (conf >= 0.4) this.bpm = rawBpm;
    } else {
      var diff = rawBpm - this.bpm;
      if (Math.abs(diff) > 15 && conf < 0.8) {
        this.jumpCount++;
        if (this.jumpCount >= 6 && conf >= 0.35) { this.bpm = rawBpm; this.jumpCount = 0; }
      } else if (conf >= 0.25) {
        this.jumpCount = 0;
        this.bpm += (0.06 + 0.3 * conf) * diff;
      }
    }
    if (conf < 0.2) this.lowConfAccum += dt; else this.lowConfAccum = 0;
    if (this.lowConfAccum > 6) { this.bpm = 0; this.locked = false; }

    /* ---- 8. Lock state machine ---------------------------------------- */
    if (conf >= 0.6) {
      this.lockAccum += dt; this.unlockAccum = 0;
      if (this.lockAccum >= 1.5 && this.bpm) this.locked = true;
    } else if (conf < 0.4) {
      this.unlockAccum += dt;
      this.lockAccum = Math.max(0, this.lockAccum - dt);
      if (this.unlockAccum >= 2) this.locked = false;
    }

    /* ---- 9. Time-domain beats ----------------------------------------- */
    // Peak timing uses a second, narrow band-pass that tracks the current rate
    // (HR ± 0.55 Hz, 4th-order each side). Broadband noise in 0.7–3.5 Hz otherwise
    // jitters individual peaks by ~100 ms; ±0.55 Hz still passes respiratory HRV sidebands.
    var refBpm = this.bpm || rawBpm;
    var periodSec = 60 / refBpm, periodSmp = periodSec * fs;
    var fRef = refBpm / 60;
    var bLo = Math.max(0.5, fRef - 0.55), bHi = Math.min(fs / 2 - 0.5, fRef + 0.55);
    var hpB = biquad('highpass', bLo, fs, Math.SQRT1_2), lpB = biquad('lowpass', bHi, fs, Math.SQRT1_2);
    var beatSig = filtfilt([hpB, hpB, lpB, lpB], h, padLen);
    var bsd = stdOf(beatSig);
    if (bsd > 1e-12) for (i = 0; i < N; i++) beatSig[i] /= bsd;
    var minDist = 0.55 * periodSmp;
    var edgeStart = Math.round(0.5 * fs), edgeEnd = N - Math.round(0.35 * fs);
    var cand = [];
    for (i = Math.max(1, edgeStart); i < Math.min(N - 1, edgeEnd); i++) {
      if (beatSig[i] > 0.2 && beatSig[i] > beatSig[i - 1] && beatSig[i] >= beatSig[i + 1]) cand.push(i);
    }
    cand.sort(function (x, y) { return beatSig[y] - beatSig[x]; });
    var accepted = [];
    for (i = 0; i < cand.length; i++) {
      var ok = true;
      for (var q = 0; q < accepted.length; q++) {
        if (Math.abs(accepted[q] - cand[i]) < minDist) { ok = false; break; }
      }
      if (ok) accepted.push(cand[i]);
    }
    accepted.sort(function (x, y) { return x - y; });
    var peakTimes = [], peakAmps = [];
    var halfP = Math.max(2, Math.round(periodSmp / 2));
    for (i = 0; i < accepted.length; i++) {
      var p = accepted[i];
      var pa = beatSig[p - 1], pb = beatSig[p], pc = beatSig[p + 1], dd = pa - 2 * pb + pc;
      var off = dd < 0 ? clamp(0.5 * (pa - pc) / dd, -0.5, 0.5) : 0;
      peakTimes.push(t0 + (p + off) / fs);
      // peak-to-preceding-trough amplitude in the un-normalised signal (respiratory AM source)
      var trough = pb;
      for (var tq = Math.max(0, p - halfP); tq < p; tq++) if (beatSig[tq] < trough) trough = beatSig[tq];
      peakAmps.push((pb - trough) * bsd);
    }

    // Beats are committed to the HRV history only once they sit ≥ 1.5 s inside the window,
    // where the zero-phase filter has settled (peaks near the trailing edge still drift).
    var settledT = tEnd - 1.5;
    if (conf >= 0.45 && this.bpm) {
      for (i = 0; i < peakTimes.length; i++) {
        var tp = peakTimes[i];
        if (tp > settledT) break;
        if (this.lastBeatTime === null || tp > this.lastBeatTime + 0.5 * periodSec) {
          if (this.segmentOpen && this.lastBeatTime !== null) {
            var ibi = tp - this.lastBeatTime;
            if (ibi >= 0.33 && ibi <= 1.5 && Math.abs(ibi - periodSec) / periodSec < 0.3) {
              this.ibis.push({ t: tp, ibi: ibi, amp: peakAmps[i] });
            }
          }
          this.beatLog.push({ t: tp, amp: peakAmps[i] });
          this.lastBeatTime = tp;
          this.segmentOpen = true;
        }
      }
    } else {
      this.segmentOpen = false;
    }
    var oldest = tEnd - o.ibiHistorySec;
    while (this.ibis.length && (this.ibis[0].t < oldest || this.ibis.length > 200)) this.ibis.shift();
    while (this.beatLog.length && (this.beatLog[0].t < oldest || this.beatLog.length > 200)) this.beatLog.shift();

    /* ---- 10. HRV & stress --------------------------------------------- */
    var ib = this.ibis.map(function (x) { return x.ibi; });
    var hrv = { rmssd: 0, sdnn: 0, count: ib.length };
    if (ib.length >= 3) {
      var sq = 0, cnt = 0;
      for (i = 1; i < ib.length; i++) {
        var dI = ib[i] - ib[i - 1];
        if (Math.abs(dI) < 0.25) { sq += dI * dI; cnt++; }
      }
      hrv.rmssd = cnt ? Math.sqrt(sq / cnt) * 1000 : 0;
      hrv.sdnn = stdOf(ib) * 1000;
    }
    res.stressProgress = clamp(ib.length / o.minIbisForStress, 0, 1);
    res.stress = ib.length >= o.minIbisForStress ? baevskyStress(ib) : null;

    /* ---- 11. Spectrum for display ------------------------------------- */
    var bins = o.spectrumBins, spec = res.spectrum, maxV = 0;
    var bw = (kHi - kLo + 1) / bins;
    for (i = 0; i < bins; i++) {
      var ks = kLo + Math.floor(i * bw), ke = Math.max(ks, kLo + Math.floor((i + 1) * bw) - 1), v = 0;
      for (k = ks; k <= ke; k++) if (P[k] > v) v = P[k];
      spec[i] = v;
      if (v > maxV) maxV = v;
    }
    if (maxV > 0) for (i = 0; i < bins; i++) spec[i] /= maxV;

    /* ---- Publish -------------------------------------------------------- */
    var pulse32 = new Float32Array(N);
    for (i = 0; i < N; i++) pulse32[i] = pulse[i];
    res.state = this.locked ? 'locked' : 'analyzing';
    res.progress = 1;
    res.rawBpm = rawBpm;
    res.bpm = this.bpm;
    res.confidence = conf;
    res.snr = snr;
    res.motion = rs.motion;
    res.locked = this.locked;
    res.pulse = pulse32;
    res.pulseT0 = t0;
    res.fs = fs;
    res.peakTimes = peakTimes;
    res.lastPeakTime = peakTimes.length ? peakTimes[peakTimes.length - 1] : null;
    res.peakFreq = fPeak;
    res.hrv = hrv;
    this._bump();
  };

  RPPGProcessor.prototype._bump = function () {
    this.version++;
    this.result.version = this.version;
  };

  /* ------------------------------------------------------------------ *
   * ROIFusion — smarter skin selection.
   * Each region (forehead, left cheek, right cheek) gets its own light-weight
   * RPPGProcessor that scores its SNR once per second. Regions are normalised by
   * their own slow running mean (τ = 3 s) before being mixed, so changing weights
   * never introduces brightness steps; the mix is then fed to the main processor.
   * ------------------------------------------------------------------ */
  function ROIFusion(count, options) {
    this.count = count;
    this.opts = { tau: 3, minPixels: 40, scoreInterval: 1.0, smoothing: 0.6 };
    if (options) for (var k in options) this.opts[k] = options[k];
    this.scorers = [];
    for (var i = 0; i < count; i++) {
      this.scorers.push(new RPPGProcessor({ updateInterval: this.opts.scoreInterval, method: 'pos' }));
    }
    this.reset();
  }

  ROIFusion.prototype.reset = function () {
    this.ema = [];
    this.weights = [];
    this.quality = [];
    this.lastT = null;
    for (var i = 0; i < this.count; i++) {
      this.ema.push(null);
      this.weights.push(1 / this.count);
      this.quality.push(0);
      this.scorers[i].reset();
    }
  };

  /**
   * @param {number} t        seconds
   * @param {Array} samples   per-region {r, g, b, count} (null = region unavailable)
   * @param {number} motion
   * @returns {{r,g,b}|null}  fused colour (scaled around 100) or null
   */
  ROIFusion.prototype.push = function (t, samples, motion) {
    var dt = this.lastT === null ? 1 / 30 : clamp(t - this.lastT, 0, 0.5);
    this.lastT = t;
    var k = 1 - Math.exp(-dt / this.opts.tau);
    var maxCount = 1, i;
    for (i = 0; i < this.count; i++) if (samples[i] && samples[i].count > maxCount) maxCount = samples[i].count;

    // score regions + adapt weights
    var target = [], tsum = 0;
    for (i = 0; i < this.count; i++) {
      var s = samples[i], sc = this.scorers[i];
      var valid = s && s.count >= this.opts.minPixels;
      if (valid) sc.push(t, s.r, s.g, s.b, motion);
      var res = sc.update(t);
      var q = res.state === 'analyzing' || res.state === 'locked' ? clamp((res.snr + 3) / 9, 0, 1) : 0.5;
      this.quality[i] = q;
      var tw = valid ? (0.08 + q * q) * Math.sqrt(s.count / maxCount) : 0;
      target.push(tw); tsum += tw;
    }
    var ka = 1 - Math.exp(-dt / this.opts.smoothing);
    for (i = 0; i < this.count; i++) {
      var goal = tsum > 0 ? target[i] / tsum : 0;
      this.weights[i] += (goal - this.weights[i]) * ka;
    }

    // normalise each region by its slow mean and mix
    var fr = 0, fg = 0, fb = 0, wsum = 0;
    for (i = 0; i < this.count; i++) {
      var x = samples[i];
      if (!x || x.count < this.opts.minPixels || !(x.r > 0 && x.g > 0 && x.b > 0)) continue;
      var e = this.ema[i];
      if (!e) { e = this.ema[i] = [x.r, x.g, x.b]; }
      else { e[0] += (x.r - e[0]) * k; e[1] += (x.g - e[1]) * k; e[2] += (x.b - e[2]) * k; }
      var w = this.weights[i];
      if (w <= 1e-4) continue;
      fr += w * x.r / e[0]; fg += w * x.g / e[1]; fb += w * x.b / e[2];
      wsum += w;
    }
    if (wsum <= 0) return null;
    return { r: 100 * fr / wsum, g: 100 * fg / wsum, b: 100 * fb / wsum };
  };

  /**
   * Baevsky stress index  SI = AMo / (2 · Mo · MxDMn)
   *   Mo    — mode of the IBI histogram (s, 50 ms bins)
   *   AMo   — share of IBIs in the modal bin (%)
   *   MxDMn — IBI range (s), 5th–95th percentile to reject residual artefacts
   * Mapped logarithmically to a 0–100 index (SI 25 → 0, SI 1000 → 100).
   */
  function baevskyStress(ib) {
    var n = ib.length;
    var sorted = ib.slice().sort(function (a, b) { return a - b; });
    var lo = sorted[Math.floor(0.05 * (n - 1))], hi = sorted[Math.ceil(0.95 * (n - 1))];
    var range = Math.max(hi - lo, 0.02);
    var counts = {}, modeBin = 0, modeCount = 0, i;
    for (i = 0; i < n; i++) {
      var bin = Math.floor(ib[i] / 0.05);
      counts[bin] = (counts[bin] || 0) + 1;
      if (counts[bin] > modeCount) { modeCount = counts[bin]; modeBin = bin; }
    }
    var Mo = (modeBin + 0.5) * 0.05;
    var AMo = modeCount / n * 100;
    var si = AMo / (2 * Mo * range);
    var index = clamp(100 * (Math.log10(si) - Math.log10(25)) / (Math.log10(1000) - Math.log10(25)), 0, 100);
    var label = index < 25 ? 'RELAXED' : index < 50 ? 'BALANCED' : index < 75 ? 'ELEVATED' : 'HIGH';
    return { index: index, si: si, label: label, mo: Mo, amo: AMo, range: range };
  }

  return {
    RPPGProcessor: RPPGProcessor,
    ROIFusion: ROIFusion,
    DEFAULTS: DEFAULTS,
    DSP: {
      fft: fft,
      nextPow2: nextPow2,
      biquad: biquad,
      designButterworthBandpass: designButterworthBandpass,
      sosFilterInPlace: sosFilterInPlace,
      filtfilt: filtfilt,
      detrendMovingAverage: detrendMovingAverage,
      hannWindow: hannWindow,
      posProjection: posProjection,
      chromProjection: chromProjection,
      contactProjection: contactProjection,
      baevskyStress: baevskyStress,
      mean: meanOf,
      std: stdOf
    }
  };
});
