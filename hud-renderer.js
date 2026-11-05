/*!
 * Bio-Radar rPPG — hud-renderer.js
 * Canvas 2D graphics engine for the bio-scanner HUD:
 *   • face-locked target reticle with smoothed interpolation, rotating rings and scan beam
 *   • ROI polygon highlights (forehead / cheeks) pulsing with the detected beat
 *   • radar-sweep alignment guide when no subject is present
 *   • rolling ECG-style pulse waveform with glow + trailing fade + beat markers
 *   • signal-quality arc gauge and pulse-spectrum bars
 *   • fingertip-sensor target (rear-camera contact mode)
 *   • breathing-coach pacer ring
 *
 * Mobile performance notes: no shadowBlur (expensive on WebKit); glow is faked with
 * layered strokes; static grids are cached on offscreen canvases; DPR is capped at 2.
 */
(function (global) {
  'use strict';

  var PALETTE = {
    cyan: [0, 240, 255],
    amber: [255, 176, 0],
    green: [61, 255, 168],
    red: [255, 59, 92],
    white: [220, 250, 255]
  };
  var FONT = '"SF Mono", ui-monospace, Menlo, Consolas, "Roboto Mono", monospace';
  var MAX_DPR = 2;

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function mixColor(a, b, t) {
    return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
  }

  /** Size a canvas's backing store to its CSS box × DPR. Returns a drawing surface descriptor. */
  function fitCanvas(canvas) {
    var dpr = Math.min(global.devicePixelRatio || 1, MAX_DPR);
    var w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas: canvas, ctx: ctx, w: w, h: h, dpr: dpr };
  }

  function makeOffscreen(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function accentFor(phase) {
    switch (phase) {
      case 'locked': return PALETTE.green;
      case 'analyzing':
      case 'acquiring': return PALETTE.cyan;
      default: return PALETTE.amber;
    }
  }

  /* ==================================================================== */

  function HUDRenderer(opts) {
    this.overlayEl = opts.overlay;
    this.waveEl = opts.wave;
    this.gaugeEl = opts.gauge;
    this.spectrumEl = opts.spectrum || null;

    this.videoW = 1280;
    this.videoH = 720;
    this.mirrored = true;

    this.reticle = null;       // smoothed screen-space face box
    this.reticleAlpha = 0;
    this.accent = PALETTE.amber.slice();
    this.lastNow = 0;

    this.waveScale = 2.5;
    this.waveEnd = null;       // smoothed display end-time (s)
    this.waveSeconds = 6;

    this.gaugeValue = 0;
    this.gaugeDrawn = -1;
    this.gaugeAccentKey = '';

    this.spectrumVersion = -1;

    this.resize();
  }

  HUDRenderer.prototype.resize = function () {
    this.ov = fitCanvas(this.overlayEl);
    this.wv = fitCanvas(this.waveEl);
    this.gg = fitCanvas(this.gaugeEl);
    if (this.spectrumEl) this.sp = fitCanvas(this.spectrumEl);
    this._buildWaveGrid();
    this.gaugeDrawn = -1;
    this.spectrumVersion = -1;
  };

  HUDRenderer.prototype.setVideoSize = function (w, h, mirrored) {
    if (w > 0 && h > 0) { this.videoW = w; this.videoH = h; }
    if (typeof mirrored === 'boolean') this.mirrored = mirrored;
  };

  /** Video-pixel → overlay CSS-pixel mapping replicating `object-fit: cover` + mirroring. */
  HUDRenderer.prototype._coverTransform = function () {
    var W = this.ov.w, H = this.ov.h;
    var s = Math.max(W / this.videoW, H / this.videoH);
    return { s: s, ox: (W - this.videoW * s) / 2, oy: (H - this.videoH * s) / 2, W: W };
  };

  HUDRenderer.prototype._mapPoint = function (T, x, y) {
    var sx = T.ox + x * T.s, sy = T.oy + y * T.s;
    return { x: this.mirrored ? T.W - sx : sx, y: sy };
  };

  /* -------------------------------------------------------------------- *
   * Main frame
   * -------------------------------------------------------------------- */
  /**
   * @param {object} f
   *   now        ms timestamp (rAF clock)
   *   phase      'standby' | 'searching' | 'acquiring' | 'analyzing' | 'locked'
   *   face       null | { bbox:{x,y,w,h}, rois:[[{x,y}..]..] }  (video pixels)
   *   result     RPPGProcessor result
   *   beat       0..1 pulse intensity (1 at systolic peak)
   *   confidence 0..1
   */
  HUDRenderer.prototype.render = function (f) {
    var now = f.now;
    var dt = this.lastNow ? clamp((now - this.lastNow) / 1000, 0, 0.1) : 1 / 60;
    this.lastNow = now;
    var target = accentFor(f.phase);
    var k = 1 - Math.exp(-dt * 4);
    this.accent = mixColor(this.accent, target, k);

    this._drawOverlay(f, dt);
    this._drawWave(f, dt);
    this._drawGauge(f, dt);
    if (this.sp) this._drawSpectrum(f);
  };

  /* -------------------------------------------------------------------- *
   * Overlay: reticle / ROIs / radar guide / frame chrome
   * -------------------------------------------------------------------- */
  HUDRenderer.prototype._drawOverlay = function (f, dt) {
    var S = this.ov, ctx = S.ctx, W = S.w, H = S.h, t = f.now / 1000;
    ctx.clearRect(0, 0, W, H);
    var acc = this.accent;

    this._drawFrameChrome(ctx, W, H, t, acc);

    if (f.phase === 'standby') return;

    if (f.mode === 'finger') {
      var fr = Math.min(W, H) * 0.26;
      this._drawFinger(ctx, W / 2, H * 0.4, fr, t, f, acc);
      if (f.pacer) this._drawPacer(ctx, W / 2, H * 0.4, fr * 1.15, f.pacer);
      this.reticle = null;
      return;
    }

    var T = this._coverTransform();
    if (f.face) {
      var b = f.face.bbox;
      var p0 = this._mapPoint(T, b.x, b.y), p1 = this._mapPoint(T, b.x + b.w, b.y + b.h);
      var tx = Math.min(p0.x, p1.x), ty = Math.min(p0.y, p1.y);
      var tw = Math.abs(p1.x - p0.x), th = Math.abs(p1.y - p0.y);
      // pad to frame the full head
      var padX = tw * 0.12, padY = th * 0.14;
      var goal = { x: tx - padX, y: ty - padY * 1.3, w: tw + padX * 2, h: th + padY * 2 };
      if (!this.reticle) {
        this.reticle = { x: W / 2 - goal.w / 2, y: H / 2 - goal.h / 2, w: goal.w, h: goal.h };
      }
      var s = 1 - Math.exp(-dt * 14);
      var r = this.reticle;
      r.x = lerp(r.x, goal.x, s); r.y = lerp(r.y, goal.y, s);
      r.w = lerp(r.w, goal.w, s); r.h = lerp(r.h, goal.h, s);
      this.reticleAlpha = Math.min(1, this.reticleAlpha + dt * 4);
    } else {
      this.reticleAlpha = Math.max(0, this.reticleAlpha - dt * 3);
    }

    if (this.reticle && this.reticleAlpha > 0.01) {
      ctx.globalAlpha = this.reticleAlpha;
      if (f.face) this._drawROIs(ctx, T, f.face.rois, acc, f.beat || 0, f.face.weights);
      if (!f.pacer) this._drawReticle(ctx, this.reticle, t, acc, f);
      ctx.globalAlpha = 1;
    }
    if (!f.face) {
      ctx.globalAlpha = 1 - this.reticleAlpha * 0.7;
      if (!f.pacer) this._drawRadarGuide(ctx, W, H, t);
      ctx.globalAlpha = 1;
      if (this.reticleAlpha <= 0.01) this.reticle = null;
    }
    if (f.pacer) {
      var rc = this.reticle;
      var pcx = rc ? rc.x + rc.w / 2 : W / 2, pcy = rc ? rc.y + rc.h / 2 : H * 0.4;
      var pr = rc ? Math.max(rc.w, rc.h) * 0.55 : Math.min(W, H) * 0.3;
      pr = Math.min(pr, Math.min(W, H) * 0.42);
      this._drawPacer(ctx, pcx, pcy, pr, f.pacer);
    }
  };

  /* Breathing pacer: ring grows on inhale, shrinks on exhale */
  HUDRenderer.prototype._drawPacer = function (ctx, cx, cy, R, p) {
    var green = PALETTE.green, cyan = PALETTE.cyan;
    var col = p.inhale ? green : cyan;
    var r = R * (0.55 + 0.45 * p.level);
    // target bounds
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(col, 0.25);
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // breathing body
    var g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(0.75, rgba(col, 0.06 + 0.06 * p.level));
    g.addColorStop(1, rgba(col, 0.22));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.25);
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.95);
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    // label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(2,7,11,0.55)';
    ctx.fillRect(cx - 62, cy - 24, 124, 48);
    ctx.fillStyle = rgba(col, 1);
    ctx.font = '800 17px ' + FONT;
    ctx.fillText(p.label, cx, cy - 7);
    ctx.font = '600 11px ' + FONT;
    ctx.fillStyle = 'rgba(216,248,255,0.85)';
    ctx.fillText(p.secs + 's', cx, cy + 12);
  };

  /* Fingertip contact-sensor target */
  HUDRenderer.prototype._drawFinger = function (ctx, cx, cy, R, t, f, acc) {
    var fi = f.finger || {}, beat = f.beat || 0, red = PALETTE.red;
    var present = !!fi.present;
    var cov = clamp(fi.coverage || 0, 0, 1);
    // glow body
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rgba(red, present ? 0.18 + 0.3 * beat : 0.04));
    g.addColorStop(1, rgba(red, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    // rotating dashed rim
    ctx.save();
    ctx.setLineDash([5, 7]);
    ctx.lineDashOffset = -t * 18;
    ctx.strokeStyle = rgba(acc, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // coverage arc
    ctx.strokeStyle = rgba(acc, 0.2);
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.1, -Math.PI / 2, Math.PI * 1.5); ctx.stroke();
    ctx.strokeStyle = rgba(acc, 0.95);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cov); ctx.stroke();
    // fingerprint ridges
    ctx.strokeStyle = rgba(present ? red : acc, present ? 0.35 + 0.4 * beat : 0.25);
    ctx.lineWidth = 1.2;
    for (var i = 1; i <= 5; i++) {
      var rr = R * 0.14 * i;
      ctx.beginPath();
      ctx.arc(cx, cy + R * 0.05, rr, Math.PI * (1.05 + i * 0.02), Math.PI * (1.95 - i * 0.02));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - R * 0.02, rr * 0.92, Math.PI * (0.15 + i * 0.03), Math.PI * (0.85 - i * 0.03));
      ctx.stroke();
    }
    // labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '700 11px ' + FONT;
    ctx.fillStyle = rgba(present ? PALETTE.green : PALETTE.amber, (Math.floor(t * 2) % 2 || present) ? 0.95 : 0.5);
    ctx.fillText(present ? '[ FINGERTIP CONTACT ]' : '[ COVER REAR CAMERA ]', cx, cy + R * 1.1 + 14);
    ctx.font = '600 9px ' + FONT;
    ctx.fillStyle = rgba(acc, 0.7);
    ctx.fillText((fi.torch ? 'TORCH ON' : 'TORCH UNAVAILABLE · USE BRIGHT LIGHT') + ' · COVER ' + Math.round(cov * 100) + '%', cx, cy + R * 1.1 + 30);
  };

  HUDRenderer.prototype._drawFrameChrome = function (ctx, W, H, t, acc) {
    var m = 10, L = 22;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(acc, 0.55);
    ctx.beginPath();
    // screen corner brackets
    ctx.moveTo(m, m + L); ctx.lineTo(m, m); ctx.lineTo(m + L, m);
    ctx.moveTo(W - m - L, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + L);
    ctx.moveTo(m, H - m - L); ctx.lineTo(m, H - m); ctx.lineTo(m + L, H - m);
    ctx.moveTo(W - m - L, H - m); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m, H - m - L);
    ctx.stroke();

    // scrolling side rulers
    ctx.strokeStyle = rgba(acc, 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    var gap = 14, off = (t * 18) % gap;
    for (var y = H * 0.18 + off; y < H * 0.62; y += gap) {
      var long = Math.round((y - off) / gap) % 4 === 0;
      ctx.moveTo(m, y); ctx.lineTo(m + (long ? 9 : 5), y);
      ctx.moveTo(W - m, y); ctx.lineTo(W - m - (long ? 9 : 5), y);
    }
    ctx.stroke();
  };

  HUDRenderer.prototype._drawROIs = function (ctx, T, rois, acc, beat, weights) {
    if (!rois) return;
    ctx.lineWidth = 1;
    for (var i = 0; i < rois.length; i++) {
      var poly = rois[i];
      if (!poly || poly.length < 3) continue;
      // brightness follows each region's fusion weight (smarter skin selection)
      var wgt = weights && weights[i] !== undefined ? clamp(weights[i] * 2.5, 0.12, 1) : 1;
      ctx.fillStyle = rgba(acc, (0.03 + 0.17 * beat) * wgt + 0.02);
      ctx.strokeStyle = rgba(acc, (0.25 + 0.45 * beat) * wgt + 0.1);
      ctx.beginPath();
      for (var j = 0; j < poly.length; j++) {
        var p = this._mapPoint(T, poly[j].x, poly[j].y);
        if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  };

  HUDRenderer.prototype._drawReticle = function (ctx, r, t, acc, f) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var L = Math.min(r.w, r.h) * 0.16;
    var beat = f.beat || 0;

    // faint frame
    ctx.strokeStyle = rgba(acc, 0.12);
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // corner brackets (double stroke = cheap glow)
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + L); ctx.lineTo(r.x, r.y); ctx.lineTo(r.x + L, r.y);
    ctx.moveTo(r.x + r.w - L, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + L);
    ctx.moveTo(r.x, r.y + r.h - L); ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x + L, r.y + r.h);
    ctx.moveTo(r.x + r.w - L, r.y + r.h); ctx.lineTo(r.x + r.w, r.y + r.h); ctx.lineTo(r.x + r.w, r.y + r.h - L);
    ctx.strokeStyle = rgba(acc, 0.25);
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = rgba(acc, 0.95);
    ctx.lineWidth = 2;
    ctx.stroke();

    // rotating segmented rings
    var R = Math.max(r.w, r.h) * 0.6;
    var rot = t * 0.55, i, a;
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(acc, 0.55);
    for (i = 0; i < 3; i++) {
      a = rot + i * (Math.PI * 2 / 3);
      ctx.beginPath();
      ctx.arc(cx, cy, R, a, a + 0.75);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(acc, 0.3 + 0.3 * beat);
    for (i = 0; i < 4; i++) {
      a = -rot * 1.6 + i * (Math.PI / 2);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.07 + beat * 4, a, a + 0.32);
      ctx.stroke();
    }
    // tick ring
    ctx.strokeStyle = rgba(acc, 0.28);
    ctx.beginPath();
    for (i = 0; i < 48; i++) {
      a = i * (Math.PI * 2 / 48) + rot * 0.2;
      var r0 = R * 1.14, r1 = R * (i % 4 === 0 ? 1.2 : 1.17);
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    ctx.stroke();

    // centre crosshair
    var ch = Math.min(r.w, r.h) * 0.05;
    ctx.strokeStyle = rgba(acc, 0.7);
    ctx.beginPath();
    ctx.moveTo(cx - ch, cy); ctx.lineTo(cx - ch * 0.35, cy);
    ctx.moveTo(cx + ch * 0.35, cy); ctx.lineTo(cx + ch, cy);
    ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy - ch * 0.35);
    ctx.moveTo(cx, cy + ch * 0.35); ctx.lineTo(cx, cy + ch);
    ctx.stroke();

    // vertical scan beam
    var period = f.phase === 'locked' ? 3.2 : 1.8;
    var sy = r.y + ((t / period) % 1) * r.h;
    var grad = ctx.createLinearGradient(0, sy - 28, 0, sy + 2);
    grad.addColorStop(0, rgba(acc, 0));
    grad.addColorStop(1, rgba(acc, 0.22));
    ctx.fillStyle = grad;
    ctx.fillRect(r.x + 2, Math.max(r.y, sy - 28), r.w - 4, Math.min(30, sy - r.y + 2));
    ctx.fillStyle = rgba(acc, 0.8);
    ctx.fillRect(r.x + 2, sy, r.w - 4, 1);

    // labels — clamped so they stay readable when the face fills the frame
    var W = this.ov.w, H = this.ov.h, pad = 14;
    var lx0 = clamp(r.x, pad, W - pad), lx1 = clamp(r.x + r.w, pad, W - pad);
    var topY = clamp(r.y - 6, W < H ? 132 : 24, H - 20), botY = r.y + r.h + 6;
    var conf = Math.round((f.confidence || 0) * 100);
    var tag = f.phase === 'locked' ? 'LOCKED' : f.phase === 'analyzing' ? 'ANALYZING' : 'ACQUIRING';
    ctx.font = '600 10px ' + FONT;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba(acc, 0.95);
    ctx.fillText('SUBJ-01 ▸ ' + tag, lx0, topY);
    ctx.textAlign = 'right';
    ctx.fillText('Q ' + conf + '%', lx1, topY);
    if (botY < H * 0.6) {
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(acc, 0.6);
      var wts = f.face && f.face.weights;
      ctx.fillText(wts
        ? 'ROI ▸ FHD ' + Math.round(wts[0] * 100) + ' · L ' + Math.round(wts[1] * 100) + ' · R ' + Math.round(wts[2] * 100) + '%'
        : 'ROI ▸ FHD · L-CHK · R-CHK', lx0, botY);
      ctx.textAlign = 'right';
      var res = f.result;
      ctx.fillText(res && res.bpm ? Math.round(res.bpm) + ' BPM' : '--- BPM', lx1, botY);
    }
  };

  HUDRenderer.prototype._drawRadarGuide = function (ctx, W, H, t) {
    var cx = W / 2, cy = H * 0.4;
    var rx = Math.min(W, H) * 0.3, ry = rx * 1.32;
    var amber = PALETTE.amber;

    // dashed oval
    ctx.save();
    ctx.setLineDash([6, 8]);
    ctx.lineDashOffset = -t * 20;
    ctx.strokeStyle = rgba(amber, 0.7);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // radar sweep wedge inside the oval
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    var a = t * 2.2, R = ry * 1.05;
    for (var i = 0; i < 6; i++) {
      ctx.fillStyle = rgba(amber, 0.1 - i * 0.015);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a - (i + 1) * 0.12, a - i * 0.12);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = rgba(amber, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
    // concentric range rings
    ctx.strokeStyle = rgba(amber, 0.15);
    ctx.lineWidth = 1;
    for (var k = 1; k <= 3; k++) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * k / 3, ry * k / 3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // crosshair
    ctx.strokeStyle = rgba(amber, 0.35);
    ctx.beginPath();
    ctx.moveTo(cx - rx - 14, cy); ctx.lineTo(cx - rx + 10, cy);
    ctx.moveTo(cx + rx - 10, cy); ctx.lineTo(cx + rx + 14, cy);
    ctx.moveTo(cx, cy - ry - 14); ctx.lineTo(cx, cy - ry + 10);
    ctx.moveTo(cx, cy + ry - 10); ctx.lineTo(cx, cy + ry + 14);
    ctx.stroke();

    ctx.font = '600 11px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var blink = (Math.floor(t * 2) % 2) === 0;
    ctx.fillStyle = rgba(amber, blink ? 0.95 : 0.55);
    ctx.fillText('[ ALIGN FACE WITHIN TARGET ]', cx, cy + ry + 20);
  };

  /* -------------------------------------------------------------------- *
   * Pulse waveform
   * -------------------------------------------------------------------- */
  HUDRenderer.prototype._buildWaveGrid = function () {
    var S = this.wv, dpr = S.dpr;
    var g = makeOffscreen(S.w * dpr, S.h * dpr), c = g.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = S.w, H = S.h, x, y;
    c.strokeStyle = 'rgba(0,240,255,0.06)';
    c.lineWidth = 1;
    c.beginPath();
    for (x = 0; x <= W; x += 10) { c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, H); }
    for (y = H / 2 % 10; y <= H; y += 10) { c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); }
    c.stroke();
    c.strokeStyle = 'rgba(0,240,255,0.14)';
    c.beginPath();
    for (x = 0; x <= W; x += 50) { c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, H); }
    for (y = H / 2 % 50; y <= H; y += 50) { c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); }
    c.stroke();
    c.strokeStyle = 'rgba(0,240,255,0.28)';
    c.setLineDash([2, 4]);
    c.beginPath();
    c.moveTo(0, Math.round(H / 2) + 0.5); c.lineTo(W, Math.round(H / 2) + 0.5);
    c.stroke();
    this.waveGrid = g;
  };

  HUDRenderer.prototype._drawWave = function (f, dt) {
    var S = this.wv, ctx = S.ctx, W = S.w, H = S.h;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.waveGrid, 0, 0, W, H);

    var acc = this.accent, res = f.result, mid = H / 2;
    var pulse = res && res.pulse, n = pulse ? pulse.length : 0;
    var nowSec = f.now / 1000, i;

    if (!n || f.phase === 'standby' || f.phase === 'searching' || f.phase === 'acquiring') {
      // idle trace: flat line with sensor noise shimmer
      ctx.strokeStyle = rgba(acc, 0.5);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var x = 0; x <= W; x += 4) {
        var y = mid + Math.sin(x * 0.21 + nowSec * 9) * 1.2 + Math.sin(x * 0.057 - nowSec * 3) * 1.5;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.font = '600 10px ' + FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = rgba(acc, 0.7);
      var label = f.phase === 'acquiring'
        ? 'BUFFERING ' + Math.round((res ? res.progress : 0) * 100) + '%'
        : 'NO SIGNAL';
      ctx.fillText(label, 6, 5);
      this.waveEnd = null;
      return;
    }

    var fs = res.fs, t0 = res.pulseT0, tData = t0 + (n - 1) / fs;
    // smooth scrolling display clock, softly pulled toward the newest data
    if (this.waveEnd === null || Math.abs(tData - this.waveEnd) > 1.5) this.waveEnd = tData;
    this.waveEnd += dt;
    this.waveEnd += (tData - this.waveEnd) * Math.min(1, dt * 3);
    var span = this.waveSeconds, tStart = this.waveEnd - span;

    var iStart = Math.max(0, Math.floor((tStart - t0) * fs));
    var iEnd = Math.min(n - 1, Math.ceil((this.waveEnd - t0) * fs));
    if (iEnd - iStart < 2) return;

    // live amplitude scaling (robust peak of visible segment)
    var peak = 0.5;
    for (i = iStart; i <= iEnd; i++) { var av = Math.abs(pulse[i]); if (av > peak) peak = av; }
    this.waveScale = lerp(this.waveScale, peak * 1.15, Math.min(1, dt * 2.5));
    var amp = (H * 0.42) / this.waveScale;
    var pxPerSec = W / span;

    ctx.beginPath();
    var lastX = 0, lastY = mid;
    for (i = iStart; i <= iEnd; i++) {
      var tx = (t0 + i / fs - tStart) * pxPerSec;
      var ty = mid - pulse[i] * amp;
      if (i === iStart) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
      lastX = tx; lastY = ty;
    }
    // glow underlay
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(acc, 0.12);
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = rgba(acc, 0.22);
    ctx.lineWidth = 3.5;
    ctx.stroke();
    // trailing fade core line
    var grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, rgba(acc, 0.05));
    grad.addColorStop(0.55, rgba(acc, 0.7));
    grad.addColorStop(1, rgba(PALETTE.white, 1));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // beat markers
    var peaks = res.peakTimes || [];
    ctx.fillStyle = rgba(acc, 0.85);
    ctx.strokeStyle = rgba(acc, 0.18);
    ctx.lineWidth = 1;
    for (i = 0; i < peaks.length; i++) {
      var px = (peaks[i] - tStart) * pxPerSec;
      if (px < 0 || px > W) continue;
      ctx.beginPath();
      ctx.moveTo(px, 10); ctx.lineTo(px, H - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px, 3); ctx.lineTo(px + 3.5, 7); ctx.lineTo(px, 11); ctx.lineTo(px - 3.5, 7);
      ctx.closePath();
      ctx.fill();
    }

    // leading head
    var rg = ctx.createRadialGradient(lastX, lastY, 0, lastX, lastY, 12);
    rg.addColorStop(0, rgba(PALETTE.white, 0.95));
    rg.addColorStop(0.3, rgba(acc, 0.6));
    rg.addColorStop(1, rgba(acc, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(lastX - 12, lastY - 12, 24, 24);

    // readouts
    ctx.font = '600 9px ' + FONT;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba(acc, 0.75);
    ctx.fillText((res.method || 'pos').toUpperCase() + (res.channel ? '·' + res.channel : '') + ' · 0.7–3.5 Hz', 4, H - 2);
    ctx.textAlign = 'right';
    ctx.fillText('×' + (1 / this.waveScale).toFixed(2) + ' · ' + span + 's', W - 4, H - 2);
  };

  /* -------------------------------------------------------------------- *
   * Signal-quality gauge (270° arc)
   * -------------------------------------------------------------------- */
  HUDRenderer.prototype._drawGauge = function (f, dt) {
    var target = clamp(f.phase === 'standby' || f.phase === 'searching' ? 0 : (f.confidence || 0), 0, 1);
    this.gaugeValue = lerp(this.gaugeValue, target, Math.min(1, dt * 5));
    var v = this.gaugeValue;
    var color = v < 0.35 ? PALETTE.red : v < 0.6 ? PALETTE.amber : (f.phase === 'locked' ? PALETTE.green : PALETTE.cyan);
    var key = color.join(',');
    if (Math.abs(v - this.gaugeDrawn) < 0.002 && key === this.gaugeAccentKey) return;
    this.gaugeDrawn = v;
    this.gaugeAccentKey = key;

    var S = this.gg, ctx = S.ctx, W = S.w, H = S.h;
    ctx.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H / 2 + 2;
    var R = Math.min(W, H) / 2 - 8;
    var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, av = a0 + (a1 - a0) * v;

    ctx.lineCap = 'butt';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,240,255,0.1)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a1);
    ctx.stroke();

    if (v > 0.003) {
      ctx.strokeStyle = rgba(color, 0.22);
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, av);
      ctx.stroke();
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, av);
      ctx.stroke();
    }

    // ticks
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,240,255,0.35)';
    ctx.beginPath();
    for (var i = 0; i <= 20; i++) {
      var a = a0 + (a1 - a0) * (i / 20);
      var r0 = R - 9, r1 = R - (i % 5 === 0 ? 15 : 12);
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    ctx.stroke();

    // needle dot
    ctx.fillStyle = rgba(PALETTE.white, 0.95);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(av) * R, cy + Math.sin(av) * R, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(color, 1);
    ctx.font = '700 ' + Math.round(R * 0.52) + 'px ' + FONT;
    ctx.fillText(String(Math.round(v * 100)), cx, cy - 2);
    ctx.font = '600 ' + Math.max(8, Math.round(R * 0.2)) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(160,230,240,0.7)';
    ctx.fillText('%', cx, cy + R * 0.42);
  };

  /* -------------------------------------------------------------------- *
   * Spectrum bars
   * -------------------------------------------------------------------- */
  HUDRenderer.prototype._drawSpectrum = function (f) {
    var res = f.result;
    var live = res && res.pulse && res.pulse.length && (f.phase === 'analyzing' || f.phase === 'locked');
    var ver = live ? res.version : -2;
    if (ver === this.spectrumVersion) return;
    this.spectrumVersion = ver;

    var S = this.sp, ctx = S.ctx, W = S.w, H = S.h;
    ctx.clearRect(0, 0, W, H);
    var spec = res ? res.spectrum : null, bins = spec ? spec.length : 0;
    var acc = this.accent;
    var baseY = H - 11;

    ctx.fillStyle = 'rgba(0,240,255,0.1)';
    ctx.fillRect(0, baseY, W, 1);

    if (live && bins) {
      var bw = W / bins, peakIdx = 0;
      for (var i = 1; i < bins; i++) if (spec[i] > spec[peakIdx]) peakIdx = i;
      for (i = 0; i < bins; i++) {
        var h = Math.max(1, spec[i] * (baseY - 2));
        ctx.fillStyle = i === peakIdx ? rgba(PALETTE.white, 0.95) : rgba(acc, 0.25 + 0.55 * spec[i]);
        ctx.fillRect(i * bw + 0.5, baseY - h, Math.max(1, bw - 1.5), h);
      }
    }
    ctx.font = '600 8px ' + FONT;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(160,230,240,0.55)';
    ctx.textAlign = 'left';
    ctx.fillText('42', 0, H);
    ctx.textAlign = 'center';
    ctx.fillText('FFT · BPM', W / 2, H);
    ctx.textAlign = 'right';
    ctx.fillText('210', W, H);
  };

  global.HUDRenderer = HUDRenderer;
  global.HUDPalette = PALETTE;
})(typeof window !== 'undefined' ? window : this);
