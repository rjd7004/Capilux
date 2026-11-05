/*!
 * Bio-Radar rPPG — coach.js
 * Guided resonance-breathing coach.
 *   • Visual pacer (drawn by the HUD) leads slow breathing, default 6 breaths/min.
 *   • Optional soft Web Audio cues: rising tone on inhale, falling tone on exhale.
 *   • Live feedback from the beat series: SYNC (share of heart-rate variability at the
 *     pacing rhythm) and HR SWING (peak-to-trough heart-rate oscillation, BPM).
 *   • Heart rate naturally rises on inhale and falls on exhale; at ~6 breaths/min these
 *     swings become large, so they stand out well above the camera's timing noise.
 */
(function (global) {
  'use strict';

  var FONT = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ease(x) { return 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(sec) { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ':' + pad2(sec % 60); }

  function BreathingCoach(els, hooks) {
    this.els = els;
    this.hooks = hooks || {};
    this.state = 'idle';
    this.pace = 6;
    this.inhaleRatio = 0.4;
    this.durationSec = 180;
    this.sound = true;
    this.audio = null;
    this.lastInhale = null;
    this.lastUpdate = 0;
    this.history = [];
    this.latest = null;
    this._bindSetup();
  }

  BreathingCoach.prototype._bindSetup = function () {
    var self = this, els = this.els;
    function choose(group, attr, apply) {
      Array.prototype.forEach.call(group, function (btn) {
        btn.addEventListener('click', function () {
          Array.prototype.forEach.call(group, function (b) { b.classList.toggle('is-active', b === btn); });
          apply(Number(btn.getAttribute(attr)));
        });
      });
    }
    choose(els.paceBtns, 'data-pace', function (v) { self.pace = v; });
    choose(els.durBtns, 'data-dur', function (v) { self.durationSec = v; });
    els.sound.addEventListener('change', function () { self.sound = els.sound.checked; });
    els.startBtn.addEventListener('click', function () { self.start(performance.now()); });
    els.stopBtn.addEventListener('click', function () {
      if (self.state === 'running') self.finish(performance.now(), 'stopped');
      else self.close();
    });
  };

  BreathingCoach.prototype.isRunning = function () { return this.state === 'running'; };

  BreathingCoach.prototype.start = function (nowMs) {
    var err = this.hooks.canStart ? this.hooks.canStart() : null;
    if (err) { this.els.setupMsg.textContent = err; return; }
    this.els.setupMsg.textContent = '';
    this.state = 'running';
    this.startT = nowMs;
    this.lastInhale = null;
    this.history = [];
    this.latest = null;
    this.lastUpdate = 0;
    if (this.sound) this._initAudio();
    var els = this.els;
    els.card.hidden = false;
    els.summary.hidden = true;
    els.stats.hidden = false;
    els.canvas.hidden = false;
    els.stopBtn.textContent = 'END SESSION';
    els.pace.textContent = this.pace.toFixed(1);
    els.sync.textContent = '--';
    els.swing.textContent = '--';
    els.title.textContent = 'RESONANCE BREATHING';
    if (this.hooks.onStart) this.hooks.onStart({ pace: this.pace, duration: this.durationSec });
  };

  BreathingCoach.prototype._initAudio = function () {
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      if (!this.audio) this.audio = new AC();
      if (this.audio.state === 'suspended') this.audio.resume();
    } catch (e) { this.audio = null; }
  };

  BreathingCoach.prototype._chime = function (inhale) {
    if (!this.sound || !this.audio) return;
    var ctx = this.audio, t = ctx.currentTime;
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(inhale ? 196 : 294, t);
    osc.frequency.exponentialRampToValueAtTime(inhale ? 294 : 196, t + 0.9);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 1.15);
  };

  /** Pacer state for the HUD (null when not running). */
  BreathingCoach.prototype.pacer = function (nowMs) {
    if (this.state !== 'running') return null;
    var elapsed = (nowMs - this.startT) / 1000;
    if (elapsed >= this.durationSec) { this.finish(nowMs, 'complete'); return null; }
    var cycle = 60 / this.pace, inT = cycle * this.inhaleRatio;
    var tt = elapsed % cycle;
    var inhale = tt < inT;
    var frac = inhale ? tt / inT : (tt - inT) / (cycle - inT);
    if (inhale !== this.lastInhale) { this._chime(inhale); this.lastInhale = inhale; }
    return {
      inhale: inhale,
      level: inhale ? ease(frac) : 1 - ease(frac),
      label: inhale ? 'INHALE' : 'EXHALE',
      secs: Math.ceil(inhale ? inT - tt : cycle - tt),
      remaining: this.durationSec - elapsed
    };
  };

  /** Called each frame; recomputes feedback once per second. */
  BreathingCoach.prototype.update = function (nowMs, processor) {
    if (this.state !== 'running') return;
    var els = this.els;
    els.time.textContent = fmt(this.durationSec - (nowMs - this.startT) / 1000);
    if (nowMs - this.lastUpdate < 1000) return;
    this.lastUpdate = nowMs;
    var tNow = nowMs / 1000;
    var z = global.Respiration.hrvResonance(processor.ibis, tNow, this.pace / 60, 60);
    var hr = processor.result.bpm;
    this.latest = z;
    if (z) {
      els.sync.textContent = Math.round(z.sync * 100) + '%';
      els.swing.textContent = '±' + (z.swing / 2).toFixed(1);
      this.history.push({ t: tNow, sync: z.sync, swing: z.swing, hr: hr });
    } else {
      els.sync.textContent = (nowMs - this.startT) / 1000 < 25 ? 'WAIT' : '--';
      els.swing.textContent = '--';
      if (hr > 0) this.history.push({ t: tNow, sync: null, swing: null, hr: hr });
    }
    this._drawTrace(nowMs, processor);
  };

  BreathingCoach.prototype._drawTrace = function (nowMs, processor) {
    var canvas = this.els.canvas;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var W = Math.max(1, canvas.clientWidth), H = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var tNow = nowMs / 1000, span = 60, t0 = tNow - span;
    var pts = processor.ibis.filter(function (b) { return b.t >= t0; });
    ctx.font = '600 8px ' + FONT;
    ctx.fillStyle = 'rgba(170,225,235,0.55)';
    ctx.textBaseline = 'top';
    ctx.fillText('HEART RATE vs PACER · 60 s', 2, 1);
    // pacer guide wave
    var cycle = 60 / this.pace, inT = cycle * this.inhaleRatio, self = this;
    ctx.strokeStyle = 'rgba(61,255,168,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (var x = 0; x <= W; x += 3) {
      var t = t0 + span * x / W;
      var el = (t * 1000 - self.startT) / 1000;
      var lv = 0.5;
      if (el >= 0) {
        var tt = el % cycle;
        lv = tt < inT ? ease(tt / inT) : 1 - ease((tt - inT) / (cycle - inT));
      }
      var y = H - 6 - lv * (H - 18);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (pts.length < 2) return;
    var vals = pts.map(function (b) { return 60 / b.ibi; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 6) { var mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
    ctx.beginPath();
    pts.forEach(function (b, i) {
      var px = (b.t - t0) / span * W, py = H - 6 - (vals[i] - lo) / (hi - lo) * (H - 18);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = 'rgba(0,240,255,0.25)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,240,255,0.95)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = 'rgba(170,225,235,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(hi) + ' / ' + Math.round(lo) + ' BPM', W - 2, 1);
    ctx.textAlign = 'left';
  };

  BreathingCoach.prototype.finish = function (nowMs, reason) {
    if (this.state !== 'running') return;
    this.state = 'done';
    var elapsed = (nowMs - this.startT) / 1000;
    var syncs = this.history.filter(function (h) { return h.sync !== null; });
    var hrs = this.history.filter(function (h) { return h.hr > 0; });
    function avg(arr, k) { if (!arr.length) return null; var s = 0; arr.forEach(function (a) { s += a[k]; }); return s / arr.length; }
    var maxSwing = syncs.reduce(function (m, h) { return Math.max(m, h.swing); }, 0);
    var summary = {
      pace: this.pace,
      elapsed: Math.round(elapsed),
      reason: reason,
      sync: syncs.length ? Math.round(avg(syncs, 'sync') * 100) : null,
      peakSync: syncs.length ? Math.round(syncs.reduce(function (m, h) { return Math.max(m, h.sync); }, 0) * 100) : null,
      swing: syncs.length ? Math.round(maxSwing * 10) / 10 : null,
      avgHr: hrs.length ? Math.round(avg(hrs, 'hr')) : null
    };
    var els = this.els;
    els.title.textContent = reason === 'complete' ? 'SESSION COMPLETE' : 'SESSION ENDED';
    els.stats.hidden = true;
    els.canvas.hidden = true;
    els.summary.hidden = false;
    els.summary.innerHTML =
      '<div><span>DURATION</span><b>' + fmt(summary.elapsed) + '</b></div>' +
      '<div><span>AVG SYNC</span><b>' + (summary.sync === null ? '--' : summary.sync + '%') + '</b></div>' +
      '<div><span>PEAK SYNC</span><b>' + (summary.peakSync === null ? '--' : summary.peakSync + '%') + '</b></div>' +
      '<div><span>MAX SWING</span><b>' + (summary.swing === null ? '--' : summary.swing + '<i> BPM</i>') + '</b></div>' +
      '<p>' + (summary.sync === null
        ? 'Not enough clean beats were detected for feedback. Try brighter light, keep still — or use fingertip mode for the strongest signal.'
        : summary.sync >= 50
          ? 'Strong heart-rhythm resonance: your heart rate rose and fell in step with your breathing.'
          : 'Keep practising: breathe smoothly from the belly and follow the ring without straining.') + '</p>';
    els.stopBtn.textContent = 'CLOSE';
    els.time.textContent = '';
    if (this.hooks.onFinish) this.hooks.onFinish(summary);
  };

  BreathingCoach.prototype.close = function () {
    this.state = 'idle';
    this.els.card.hidden = true;
    if (this.hooks.onClose) this.hooks.onClose();
  };

  /** Abort without a summary (e.g. scanner halted / app backgrounded). */
  BreathingCoach.prototype.abort = function (nowMs) {
    if (this.state === 'running') this.finish(nowMs, 'interrupted');
  };

  global.BreathingCoach = BreathingCoach;
})(typeof window !== 'undefined' ? window : this);
