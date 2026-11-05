/*!
 * Bio-Radar rPPG — app.js
 * Application manager: DOM wiring, camera lifecycle (iOS-Safari safe), sensor modes
 * (face via front camera · fingertip via rear camera + torch), MediaPipe FaceLandmarker,
 * ROI colour extraction, frame scheduling, HUD state, breathing coach, session log.
 */
(function () {
  'use strict';

  /* ==================================================================== *
   * Configuration
   * ==================================================================== */
  var MP_VERSION = '0.10.21';
  var CONFIG = {
    bundleUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VERSION + '/vision_bundle.mjs',
    wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VERSION + '/wasm',
    modelUrl: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sampleMaxDim: 220,        // ROI crop is down-scaled so its longest side ≤ this (px)
    faceLostResetMs: 1200,    // reset the signal buffer after this long without a face
    sessionGapMs: 8000,       // end the logged session after this long without signal
    minRoiPixels: 40,
    motionRef: 0.35           // face-widths / second regarded as "too much motion"
  };

  var CAMERA = {
    face: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    finger: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }
  };

  /* MediaPipe Face Mesh landmark indices (478-point topology). */
  var ROI_LANDMARKS = {
    forehead: [107, 66, 69, 109, 10, 338, 299, 296, 336, 9],
    leftCheek: [117, 118, 101, 36, 205, 187, 123, 50],
    rightCheek: [346, 347, 330, 266, 425, 411, 352, 280]
  };
  var ROI_SHRINK = { forehead: 0.84, leftCheek: 0.88, rightCheek: 0.88 };
  var ROI_ORDER = ['forehead', 'leftCheek', 'rightCheek'];

  /* ==================================================================== *
   * Geometry helpers
   * ==================================================================== */
  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

  /** Andrew's monotone chain convex hull. */
  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });
    if (pts.length < 3) return pts;
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function shrinkPolygon(poly, factor) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < poly.length; i++) { cx += poly[i].x; cy += poly[i].y; }
    cx /= poly.length; cy /= poly.length;
    var out = new Array(poly.length);
    for (i = 0; i < poly.length; i++) {
      out[i] = { x: cx + (poly[i].x - cx) * factor, y: cy + (poly[i].y - cy) * factor };
    }
    return out;
  }

  /* ==================================================================== *
   * ROI colour sampler — draws only the face crop into a small CPU canvas
   * and scan-converts each convex ROI polygon to average skin pixels.
   * ==================================================================== */
  function ROISampler(maxDim) {
    this.maxDim = maxDim;
    this.canvas = document.createElement('canvas');
    this.canvas.width = maxDim;
    this.canvas.height = maxDim;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    this.ctx.imageSmoothingEnabled = true;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {Array<Array<{x,y}>>} polys  convex polygons in video pixels
   * @returns {{rois:Array, r,g,b,count,luma,clipped}|null}  per-region and pooled averages
   */
  ROISampler.prototype.sample = function (video, polys) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i, j;
    for (i = 0; i < polys.length; i++) {
      for (j = 0; j < polys[i].length; j++) {
        var p = polys[i][j];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
    minX = Math.max(0, Math.floor(minX) - 2); minY = Math.max(0, Math.floor(minY) - 2);
    maxX = Math.min(vw, Math.ceil(maxX) + 2); maxY = Math.min(vh, Math.ceil(maxY) + 2);
    var bw = maxX - minX, bh = maxY - minY;
    if (bw < 4 || bh < 4) return null;
    var scale = Math.min(1, this.maxDim / Math.max(bw, bh));
    var dw = Math.max(2, Math.round(bw * scale)), dh = Math.max(2, Math.round(bh * scale));

    var ctx = this.ctx;
    ctx.drawImage(video, minX, minY, bw, bh, 0, 0, dw, dh);
    var data = ctx.getImageData(0, 0, dw, dh).data;

    var tr = 0, tg = 0, tb = 0, tcount = 0, clipped = 0, total = 0, rois = [];
    for (i = 0; i < polys.length; i++) {
      var poly = polys[i], m = poly.length;
      var sr = 0, sg = 0, sb = 0, count = 0;
      if (m >= 3) {
        var local = new Array(m), pyMin = Infinity, pyMax = -Infinity;
        for (j = 0; j < m; j++) {
          var lx = (poly[j].x - minX) * scale, ly = (poly[j].y - minY) * scale;
          local[j] = { x: lx, y: ly };
          if (ly < pyMin) pyMin = ly; if (ly > pyMax) pyMax = ly;
        }
        var y0 = Math.max(0, Math.ceil(pyMin - 0.5)), y1 = Math.min(dh - 1, Math.floor(pyMax - 0.5));
        for (var y = y0; y <= y1; y++) {
          var yc = y + 0.5, xl = Infinity, xr = -Infinity;
          for (j = 0; j < m; j++) {
            var a = local[j], b = local[(j + 1) % m];
            if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
              var xi = a.x + (yc - a.y) / (b.y - a.y) * (b.x - a.x);
              if (xi < xl) xl = xi; if (xi > xr) xr = xi;
            }
          }
          if (xl > xr) continue;
          var x0 = Math.max(0, Math.ceil(xl - 0.5)), x1 = Math.min(dw - 1, Math.floor(xr - 0.5));
          var idx = (y * dw + x0) * 4;
          for (var x = x0; x <= x1; x++, idx += 4) {
            var r = data[idx], g = data[idx + 1], bl = data[idx + 2];
            total++;
            // reject specular highlights / clipped and near-black pixels
            if (r >= 250 || g >= 250 || bl >= 250) { clipped++; continue; }
            if (r + g + bl < 45) continue;
            sr += r; sg += g; sb += bl; count++;
          }
        }
      }
      rois.push(count ? { r: sr / count, g: sg / count, b: sb / count, count: count } : null);
      tr += sr; tg += sg; tb += sb; tcount += count;
    }
    var clipFrac = total ? clipped / total : 0;
    if (!tcount) return { rois: rois, r: 0, g: 0, b: 0, count: 0, luma: 0, clipped: clipFrac };
    var R = tr / tcount, G = tg / tcount, B = tb / tcount;
    return { rois: rois, r: R, g: G, b: B, count: tcount, luma: 0.299 * R + 0.587 * G + 0.114 * B, clipped: clipFrac };
  };

  /* ==================================================================== *
   * Fingertip sampler — central crop of the rear-camera frame.
   * ==================================================================== */
  function FingerSampler() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 48;
    this.canvas.height = 36;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }

  FingerSampler.prototype.sample = function (video) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var sw = vw * 0.7, sh = vh * 0.7;
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
    var d = ctx.getImageData(0, 0, W, H).data;
    var n = W * H, sr = 0, sg = 0, sb = 0, red = 0, sat = 0, sl = 0, sl2 = 0;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      sr += r; sg += g; sb += b;
      if (r > 50 && r > g * 1.5 && r > b * 1.5) red++;
      if (r >= 250 && g >= 250) sat++;
      var l = 0.299 * r + 0.587 * g + 0.114 * b;
      sl += l; sl2 += l * l;
    }
    var R = sr / n, G = sg / n, B = sb / n, L = sl / n;
    var std = Math.sqrt(Math.max(0, sl2 / n - L * L));
    return { r: R, g: G, b: B, luma: L, redFrac: red / n, satFrac: sat / n, lumaStd: std };
  };

  /* ==================================================================== *
   * Debounced guidance prompts
   * ==================================================================== */
  function PromptController(el, textEl) {
    this.el = el; this.textEl = textEl;
    this.candidate = ''; this.candidateSince = 0;
    this.shown = ''; this.shownSince = 0;
  }
  PromptController.prototype.update = function (msg, level, now) {
    if (msg !== this.candidate) { this.candidate = msg; this.candidateSince = now; }
    var stable = now - this.candidateSince > (msg ? 350 : 600);
    var held = now - this.shownSince > 1100;
    if (stable && held && msg !== this.shown) {
      this.shown = msg; this.shownSince = now;
      if (msg) {
        this.textEl.textContent = msg;
        this.el.dataset.level = level || 'info';
        this.el.hidden = false;
        // restart entrance animation
        this.el.classList.remove('pop'); void this.el.offsetWidth; this.el.classList.add('pop');
      } else {
        this.el.hidden = true;
      }
    }
  };
  PromptController.prototype.clear = function () {
    this.candidate = this.shown = '';
    this.el.hidden = true;
  };

  /* ==================================================================== *
   * MediaPipe loader — prefers the module pre-loaded by index.html,
   * falls back to dynamic import().
   * ==================================================================== */
  function getVisionModule() {
    if (window.MediaPipeVision) return Promise.resolve(window.MediaPipeVision);
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish(mod) { if (!done) { done = true; resolve(mod); } }
      window.addEventListener('mediapipe-ready', function () { finish(window.MediaPipeVision); }, { once: true });
      setTimeout(function () {
        if (done) return;
        import(CONFIG.bundleUrl).then(function (mod) {
          window.MediaPipeVision = { FaceLandmarker: mod.FaceLandmarker, FilesetResolver: mod.FilesetResolver };
          finish(window.MediaPipeVision);
        }).catch(function (err) { if (!done) { done = true; reject(err); } });
      }, window.MediaPipeVisionFailed ? 0 : 2500);
    });
  }

  /* ==================================================================== *
   * App
   * ==================================================================== */
  function App() {
    var $ = function (id) { return document.getElementById(id); };
    var self = this;
    this.el = {
      root: $('app'), video: $('video'), overlay: $('overlay'), wave: $('wave'), gauge: $('gauge'),
      spectrum: $('spectrum'), splash: $('splash'), startBtn: $('start-btn'), startFingerBtn: $('start-finger-btn'),
      splashLogBtn: $('splash-log-btn'), bootLog: $('boot-log'),
      error: $('error'), status: $('status'), statusText: $('status-text'),
      bpm: $('bpm-value'), bpmSub: $('bpm-sub'), heart: $('heart'),
      stressValue: $('stress-value'), stressLabel: $('stress-label'), stressFill: $('stress-fill'),
      stressSub: $('stress-sub'), telemetry: $('telemetry'), guidance: $('guidance'),
      guidanceText: $('guidance-text'), haltBtn: $('halt-btn'), resetBtn: $('reset-btn'),
      resume: $('resume'), resumeBtn: $('resume-btn'), qualityLabel: $('quality-label'),
      respValue: $('resp-value'), blinkValue: $('blink-value'), tensionValue: $('tension-value'),
      eyesValue: $('eyes-value'), chipResp: $('chip-resp'), chipTension: $('chip-tension'), chipEyes: $('chip-eyes'),
      dockBreathe: $('dock-breathe'), dockMode: $('dock-mode'), dockModeLabel: $('dock-mode-label'),
      dockRef: $('dock-ref'), dockLog: $('dock-log'), toast: $('toast')
    };

    this.mode = 'face';
    this.processor = new window.RPPG.RPPGProcessor({ method: 'pos' });
    this.fusion = new window.RPPG.ROIFusion(ROI_ORDER.length);
    this.resp = new window.Respiration.RespirationEstimator();
    this.blink = new window.FaceMetrics.BlinkMonitor();
    this.tension = new window.FaceMetrics.TensionMonitor();
    this.hud = new window.HUDRenderer({
      overlay: this.el.overlay, wave: this.el.wave, gauge: this.el.gauge, spectrum: this.el.spectrum
    });
    this.sampler = new ROISampler(CONFIG.sampleMaxDim);
    this.fingerSampler = new FingerSampler();
    this.prompts = new PromptController(this.el.guidance, this.el.guidanceText);

    // Session log, reference comparisons, breathing coach
    var H = window.BioHistory;
    this.store = new H.SessionStore();
    this.recorder = new H.SessionRecorder(this.store, function (s) {
      self._toast('SESSION SAVED · ' + Math.round(s.avgBpm) + ' BPM' + (s.resp ? ' · ' + Math.round(s.resp) + ' BR/MIN' : ''));
    });
    this.historyView = new H.HistoryView({
      tabs: document.querySelectorAll('#sheet-history .tab'),
      paneSessions: $('hist-sessions'), paneTrends: $('hist-trends'), paneAccuracy: $('hist-accuracy'),
      list: $('hist-list'), empty: $('hist-empty'), count: $('hist-count'),
      trendHr: $('trend-hr'), trendResp: $('trend-resp'), trendStress: $('trend-stress'),
      accStats: $('acc-stats'), accPlot: $('acc-plot'), accList: $('acc-list'),
      exportBtn: $('hist-export'), clearBtn: $('hist-clear')
    }, this.store);
    this.refDialog = new H.ReferenceDialog({
      app: $('ref-app'), input: $('ref-input'), source: $('ref-source'), timerBtn: $('ref-timer-btn'),
      timer: $('ref-timer'), countRow: $('ref-count-row'), count: $('ref-count'), save: $('ref-save'),
      msg: $('ref-msg'), stats: $('ref-stats')
    }, this.store, function () {
      var r = self.processor.result;
      var live = (self.phase === 'analyzing' || self.phase === 'locked') && r.confidence >= 0.3;
      return { bpm: live ? r.bpm : 0, conf: r.confidence, mode: self.mode };
    });
    this.coach = new window.BreathingCoach({
      paceBtns: document.querySelectorAll('#coach-pace-seg button'),
      durBtns: document.querySelectorAll('#coach-dur-seg button'),
      sound: $('coach-sound'), startBtn: $('coach-start'), setupMsg: $('coach-setup-msg'),
      card: $('coach-card'), title: $('coach-title'), time: $('coach-time'), stats: $('coach-stats'),
      sync: $('coach-sync'), swing: $('coach-swing'), pace: $('coach-pace'), canvas: $('coach-canvas'),
      summary: $('coach-summary'), stopBtn: $('coach-stop')
    }, {
      canStart: function () {
        return self.running && self.cameraLive ? null : 'Start (or resume) the scanner first.';
      },
      onStart: function () {
        self.recorder.finish();
        self.recorder.begin('coach', performance.now());
        self._closeSheet('sheet-coach');
        self.el.root.classList.add('is-coaching');
      },
      onFinish: function (summary) {
        self.recorder.setExtra('coach', {
          pace: summary.pace, sync: summary.sync, peakSync: summary.peakSync, swing: summary.swing, elapsed: summary.elapsed
        });
        self.recorder.finish();
        self.el.root.classList.remove('is-coaching');
      },
      onClose: function () { self.el.root.classList.remove('is-coaching'); }
    });

    this.landmarker = null;
    this.delegate = null;
    this.stream = null;
    this.running = false;      // user wants the scanner on
    this.cameraLive = false;
    this.booting = false;
    this.phase = 'standby';
    this.face = null;
    this.finger = { present: false, coverage: 0, saturated: false, dark: false, torch: false };
    this.torchOn = false;
    this.lastFaceMs = 0;
    this.lastFingerMs = 0;
    this.lastSignalMs = 0;
    this.faceLostHandled = true;
    this.lastDetectTs = 0;
    this.detectCost = 12;
    this.detectEvery = 1;
    this.frameIdx = 0;
    this.lastLandmarks = null;
    this.prevGeom = null;
    this.prevLuma = null;
    this.motion = 0;
    this.light = { luma: 128, clipped: 0 };
    this.detectErrors = 0;
    this.vfcHandle = null;
    this.rafHandle = null;
    this.lastVideoTime = -1;
    this.camFrames = 0;
    this.camFps = 0;
    this.fpsWindowStart = 0;
    this.wakeLock = null;
    this.uiCache = {};
    this.lastTelemetryMs = 0;
    this.fatigueNoticeUntil = 0;
    this.fatigueCooldownUntil = 0;
    this.toastTimer = null;

    this._onFrame = this._onFrame.bind(this);
    this._renderLoop = this._renderLoop.bind(this);
    this._bind();
    this._checkEnvironment();
    this.rafHandle = requestAnimationFrame(this._renderLoop);
  }

  App.prototype._bind = function () {
    var self = this, el = this.el;
    el.startBtn.addEventListener('click', function () { self.start('face'); });
    el.startFingerBtn.addEventListener('click', function () { self.start('finger'); });
    el.splashLogBtn.addEventListener('click', function () { self._openSheet('sheet-history'); });
    el.resumeBtn.addEventListener('click', function () { self._resumeFromGesture(); });
    el.haltBtn.addEventListener('click', function () {
      if (self.running) self.halt(); else self.resume();
    });
    el.resetBtn.addEventListener('click', function () { self.recalibrate(); });
    el.dockBreathe.addEventListener('click', function () {
      if (self.coach.isRunning()) return;
      self._openSheet('sheet-coach');
    });
    el.dockMode.addEventListener('click', function () { self.setMode(self.mode === 'face' ? 'finger' : 'face'); });
    el.dockRef.addEventListener('click', function () { self._openSheet('sheet-ref'); });
    el.dockLog.addEventListener('click', function () { self._openSheet('sheet-history'); });

    // generic sheet close: ✕ button or tap on the backdrop
    Array.prototype.forEach.call(document.querySelectorAll('.sheet'), function (sheet) {
      sheet.addEventListener('click', function (e) {
        if (e.target === sheet || e.target.closest('[data-close]')) self._closeSheet(sheet.id);
      });
    });

    document.addEventListener('visibilitychange', function () { self._onVisibility(); });
    window.addEventListener('pagehide', function () {
      self.coach.abort(performance.now());
      self.recorder.finish();
      self._stopCamera();
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && self.running && document.visibilityState === 'visible') self._rebindCamera();
    });

    var resizeTimer = null;
    var onResize = function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { self.hud.resize(); }, 80);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  };

  App.prototype._checkEnvironment = function () {
    if (!window.isSecureContext) {
      this._showError('Camera access requires a secure (HTTPS) origin. Deploy to GitHub Pages or open via https:// or localhost.');
    } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._showError('This browser does not expose the camera API (navigator.mediaDevices). Use Safari on iOS 15+ or a current Chromium/Firefox.');
    }
  };

  /* -------------------------------------------------------------------- *
   * Sheets & toast
   * -------------------------------------------------------------------- */
  App.prototype._openSheet = function (id) {
    var sheet = document.getElementById(id);
    if (!sheet) return;
    sheet.hidden = false;
    if (id === 'sheet-history') this.historyView.refresh();
    if (id === 'sheet-ref') this.refDialog.open();
  };
  App.prototype._closeSheet = function (id) {
    var sheet = document.getElementById(id);
    if (!sheet) return;
    sheet.hidden = true;
    if (id === 'sheet-ref') this.refDialog.close();
  };
  App.prototype._toast = function (msg) {
    var t = this.el.toast;
    t.textContent = msg;
    t.hidden = false;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  };

  /* -------------------------------------------------------------------- *
   * Boot sequence (explicit user gesture — WebKit requirement)
   * -------------------------------------------------------------------- */
  App.prototype.start = function (mode) {
    if (this.booting) return;
    var self = this;
    this.booting = true;
    this._applyMode(mode || 'face');
    this._hideError();
    this.el.startBtn.disabled = true;
    this.el.startFingerBtn.disabled = true;
    this.el.startBtn.querySelector('.btn-label').textContent = 'BOOTING…';
    this.el.bootLog.innerHTML = '';
    this._setPhase('loading');

    // getUserMedia is invoked synchronously inside the click handler.
    var camLine = this._log(this.mode === 'finger' ? 'REAR CAMERA UPLINK' : 'CAMERA UPLINK');
    var camPromise = this._startCamera().then(function () {
      self._logDone(camLine, self.mode === 'finger' ? (self.torchOn ? 'TORCH' : 'NO TORCH') : 'OK');
    });
    var tasks = [camPromise];
    if (this.mode === 'face') {
      var meshLine = this._log('NEURAL FACE MESH');
      tasks.push(this._loadLandmarker().then(function () { self._logDone(meshLine, self.delegate); }));
    }

    Promise.all(tasks).then(function () {
      self._logDone(self._log('rPPG DSP CORE'), self.mode === 'finger' ? 'CONTACT' : 'POS');
      self.running = true;
      self.booting = false;
      self._resetSignal();
      self._setPhase('searching');
      self._requestWakeLock();
      self.el.root.classList.add('is-running');
      setTimeout(function () { self.el.splash.classList.add('is-hidden'); }, 350);
      self._scheduleFrame();
    }).catch(function (err) {
      self.booting = false;
      self._stopCamera();
      self._setPhase('standby');
      self.el.startBtn.disabled = false;
      self.el.startFingerBtn.disabled = false;
      self.el.startBtn.querySelector('.btn-label').textContent = 'RETRY INITIALIZATION';
      self._showError(self._describeError(err));
      console.error(err);
    });
  };

  App.prototype._log = function (label) {
    var li = document.createElement('li');
    li.innerHTML = '<span class="log-state">[ .. ]</span> ' + label;
    this.el.bootLog.appendChild(li);
    return li;
  };
  App.prototype._logDone = function (li, tag) {
    li.classList.add('ok');
    li.querySelector('.log-state').textContent = '[ OK ]';
    if (tag) {
      var s = document.createElement('span');
      s.className = 'log-tag';
      s.textContent = tag;
      li.appendChild(s);
    }
  };

  App.prototype._describeError = function (err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera permission denied. On iPhone: Settings › Safari › Camera › Allow (or tap “aA” › Website Settings), then retry.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable camera was found for this mode on this device.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is in use by another app or tab. Close it and retry.';
    if (err && err.isModelError) return 'Failed to load the face-mesh model. The first launch needs a network connection (assets are cached afterwards). ' + (err.message || '');
    return 'Initialization failed: ' + ((err && err.message) || String(err));
  };

  /* -------------------------------------------------------------------- *
   * Sensor modes
   * -------------------------------------------------------------------- */
  App.prototype._applyMode = function (mode) {
    this.mode = mode;
    this.el.root.dataset.mode = mode;
    this.el.dockModeLabel.textContent = mode === 'face' ? 'FINGER' : 'FACE';
    this.processor.opts.method = mode === 'finger' ? 'contact' : 'pos';
    this.hud.setVideoSize(this.hud.videoW, this.hud.videoH, mode === 'face');
  };

  App.prototype.setMode = function (mode) {
    if (this.booting || this._switching || mode === this.mode) return;
    var self = this, now = performance.now();
    this.coach.abort(now);
    this.recorder.finish();
    this._applyMode(mode);
    this._resetSignal();
    this.prompts.clear();
    this._switching = true;
    var ready = Promise.resolve();
    if (mode === 'face' && !this.landmarker) {
      this._setPhase('loading');
      ready = this._loadLandmarker();
    }
    ready.then(function () {
      self.running = true;
      self.el.haltBtn.querySelector('.btn-label').textContent = 'HALT';
      self.el.haltBtn.classList.remove('is-active');
      return self._rebindCamera();
    }).catch(function (err) {
      console.error(err);
      self._toast('FACE MESH UNAVAILABLE — STAYING IN FINGER MODE');
      self._applyMode('finger');
      return self._rebindCamera();
    }).then(function () {
      self._switching = false;
      self._toast(self.mode === 'finger'
        ? 'FINGERTIP MODE · ' + (self.torchOn ? 'TORCH ON' : 'NO TORCH — USE BRIGHT LIGHT')
        : 'FACE MODE');
    });
  };

  App.prototype._resetSignal = function () {
    this.processor.reset();
    this.fusion.reset();
    this.resp.reset();
    this.blink.reset();
    this.tension.reset();
    this.prevGeom = null;
    this.prevLuma = null;
    this.face = null;
    this.lastLandmarks = null;
    this.finger = { present: false, coverage: 0, saturated: false, dark: false, torch: this.torchOn };
  };

  /* -------------------------------------------------------------------- *
   * Camera lifecycle
   * -------------------------------------------------------------------- */
  App.prototype._startCamera = function () {
    var self = this, video = this.el.video, mode = this.mode;
    this._stopCamera();
    var constraints = { audio: false, video: CAMERA[mode] };
    var gum;
    try {
      gum = navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      return Promise.reject(e);
    }
    return gum.then(function (stream) {
      self.stream = stream;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;
      stream.getVideoTracks().forEach(function (track) {
        track.addEventListener('ended', function () {
          if (self.running && document.visibilityState === 'visible' && self.stream === stream) self._rebindCamera();
        });
      });
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (!settled) { settled = true; reject(new Error('Camera stream did not start (timeout).')); }
        }, 8000);
        var ready = function () {
          if (settled || !video.videoWidth) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        video.addEventListener('loadedmetadata', ready, { once: true });
        video.addEventListener('playing', ready, { once: true });
        var p = video.play();
        if (p && p.catch) p.catch(function () { /* autoplay is permitted for muted inline video; retried on resume */ });
        if (video.readyState >= 1) ready();
      });
    }).then(function () {
      self.cameraLive = true;
      self.hud.setVideoSize(video.videoWidth, video.videoHeight, mode === 'face');
      return mode === 'finger' ? self._enableTorch() : null;
    });
  };

  /** Torch for fingertip mode. Not every browser exposes it (it's optional on iOS Safari). */
  App.prototype._enableTorch = function () {
    var self = this;
    this.torchOn = false;
    var track = this.stream && this.stream.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== 'function') return Promise.resolve(false);
    var caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
    if (!caps || !caps.torch) return Promise.resolve(false);
    return track.applyConstraints({ advanced: [{ torch: true }] }).then(function () {
      var st = typeof track.getSettings === 'function' ? track.getSettings() : {};
      self.torchOn = st.torch !== false;
      self.finger.torch = self.torchOn;
      return self.torchOn;
    }).catch(function () { return false; });
  };

  App.prototype._stopCamera = function () {
    this.cameraLive = false;
    this._cancelFrame();
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already stopped */ } });
      this.stream = null;
    }
    if (this.el.video.srcObject) this.el.video.srcObject = null;
  };

  /** Re-acquire the camera after tab switch / screen lock / mode change. */
  App.prototype._rebindCamera = function () {
    var self = this;
    if (this._rebinding) return this._rebinding;
    this._resetSignal();
    this._rebinding = this._startCamera().then(function () {
      self._rebinding = null;
      self.el.resume.hidden = true;
      self._setPhase('searching');
      self._requestWakeLock();
      self._scheduleFrame();
    }).catch(function (err) {
      self._rebinding = null;
      console.warn('Camera rebind failed; waiting for user gesture.', err);
      self.el.resume.hidden = false;
    });
    return this._rebinding;
  };

  App.prototype._resumeFromGesture = function () {
    this.el.resume.hidden = true;
    this.running = true;
    this._rebindCamera();
  };

  App.prototype._onVisibility = function () {
    if (document.visibilityState === 'hidden') {
      this.coach.abort(performance.now());
      this.recorder.finish();
      if (this.running) this._stopCamera();
      this._releaseWakeLock();
    } else if (this.running && !this.booting) {
      this._rebindCamera();
    }
  };

  App.prototype.halt = function () {
    this.coach.abort(performance.now());
    this.recorder.finish();
    this.running = false;
    this._stopCamera();
    this._resetSignal();
    this.prompts.clear();
    this._setPhase('halted');
    this._releaseWakeLock();
    this.el.haltBtn.querySelector('.btn-label').textContent = 'RESUME';
    this.el.haltBtn.classList.add('is-active');
  };

  App.prototype.resume = function () {
    this.running = true;
    this.el.haltBtn.querySelector('.btn-label').textContent = 'HALT';
    this.el.haltBtn.classList.remove('is-active');
    this._rebindCamera();
  };

  App.prototype.recalibrate = function () {
    this.recorder.finish();
    this.processor.reset();
    this.fusion.reset();
    this.resp.reset();
    this.prevGeom = null;
    if (this.running) this._setPhase('acquiring');
  };

  /* -------------------------------------------------------------------- *
   * Screen wake lock (iOS 16.4+)
   * -------------------------------------------------------------------- */
  App.prototype._requestWakeLock = function () {
    var self = this;
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      self.wakeLock = lock;
      lock.addEventListener('release', function () { self.wakeLock = null; });
    }).catch(function () { /* not granted — harmless */ });
  };
  App.prototype._releaseWakeLock = function () {
    if (this.wakeLock) { try { this.wakeLock.release(); } catch (e) { /* ignore */ } this.wakeLock = null; }
  };

  /* -------------------------------------------------------------------- *
   * MediaPipe FaceLandmarker
   * -------------------------------------------------------------------- */
  App.prototype._loadLandmarker = function () {
    var self = this;
    if (this.landmarker) return Promise.resolve(this.landmarker);
    if (this._landmarkerPromise) return this._landmarkerPromise;
    this._landmarkerPromise = getVisionModule().then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(CONFIG.wasmBase).then(function (fileset) {
        self.fileset = fileset;
        return self._createLandmarker(vision, fileset, 'GPU').catch(function (err) {
          console.warn('GPU delegate unavailable, falling back to CPU.', err);
          return self._createLandmarker(vision, fileset, 'CPU');
        });
      });
    }).catch(function (err) {
      self._landmarkerPromise = null;
      var e = new Error(err && err.message ? err.message : String(err));
      e.isModelError = true;
      throw e;
    });
    return this._landmarkerPromise;
  };

  App.prototype._createLandmarker = function (vision, fileset, delegate) {
    var self = this;
    return vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CONFIG.modelUrl, delegate: delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true,               // blinks + facial tension
      outputFacialTransformationMatrixes: false
    }).then(function (lm) {
      self.vision = vision;
      self.landmarker = lm;
      self.delegate = delegate;
      self.detectErrors = 0;
      return lm;
    });
  };

  /* -------------------------------------------------------------------- *
   * Frame scheduling: requestVideoFrameCallback (Safari 15.4+) with an
   * rAF + currentTime fallback. Rendering always runs on rAF.
   * -------------------------------------------------------------------- */
  App.prototype._scheduleFrame = function () {
    var v = this.el.video;
    this._cancelFrame();
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.vfcHandle = v.requestVideoFrameCallback(this._onFrame);
    }
  };
  App.prototype._cancelFrame = function () {
    var v = this.el.video;
    if (this.vfcHandle !== null && typeof v.cancelVideoFrameCallback === 'function') {
      v.cancelVideoFrameCallback(this.vfcHandle);
    }
    this.vfcHandle = null;
  };
  App.prototype._onFrame = function (now) {
    this.vfcHandle = null;
    if (!this.running || !this.cameraLive) return;
    this._processFrame(now);
    this.vfcHandle = this.el.video.requestVideoFrameCallback(this._onFrame);
  };

  App.prototype._renderLoop = function (now) {
    this.rafHandle = requestAnimationFrame(this._renderLoop);
    var v = this.el.video;
    if (this.running && this.cameraLive && typeof v.requestVideoFrameCallback !== 'function') {
      if (v.currentTime !== this.lastVideoTime && v.readyState >= 2) {
        this.lastVideoTime = v.currentTime;
        this._processFrame(now);
      }
    }
    this._render(now);
  };

  /* -------------------------------------------------------------------- *
   * Per-camera-frame processing
   * -------------------------------------------------------------------- */
  App.prototype._processFrame = function (now) {
    var video = this.el.video;
    if (video.readyState < 2 || !video.videoWidth) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (vw !== this.hud.videoW || vh !== this.hud.videoH) this.hud.setVideoSize(vw, vh, this.mode === 'face');

    // FPS accounting
    this.camFrames++;
    if (now - this.fpsWindowStart >= 1000) {
      this.camFps = this.camFrames * 1000 / (now - this.fpsWindowStart);
      this.camFrames = 0;
      this.fpsWindowStart = now;
    }

    if (this.mode === 'finger') this._processFinger(video, now);
    else if (this.landmarker) this._processFace(video, now, vw, vh);
  };

  App.prototype._processFinger = function (video, now) {
    var t = now / 1000;
    var s = this.fingerSampler.sample(video);
    var present = s.redFrac > 0.8 && s.lumaStd < 32 && s.r > 40;
    if (this.prevLuma !== null && s.luma > 0) {
      var m = Math.min(4, Math.abs(s.luma - this.prevLuma) / s.luma * 15);
      this.motion += (m - this.motion) * 0.15;
    }
    this.prevLuma = s.luma;
    this.finger = {
      present: present,
      coverage: Math.min(1, s.redFrac / 0.8),
      saturated: s.satFrac > 0.5,
      dark: s.luma < 25,
      torch: this.torchOn
    };
    if (present) {
      this.processor.push(t, s.r, s.g, s.b, this.motion);
      this.resp.pushFrame(t, s.g >= 20 && s.g <= 235 ? s.g : s.r, null);
      this.lastFingerMs = now;
      this.faceLostHandled = false;
    } else if (!this.faceLostHandled && now - this.lastFingerMs > CONFIG.faceLostResetMs) {
      this.processor.reset();
      this.resp.reset();
      this.faceLostHandled = true;
    }
  };

  App.prototype._processFace = function (video, now, vw, vh) {
    var t = now / 1000;

    // Face mesh (adaptively decimated on slow devices; ROI sampling still runs every frame)
    this.frameIdx++;
    var landmarks = this.lastLandmarks, blendshapes = null;
    if (this.frameIdx % this.detectEvery === 0 || !landmarks) {
      var ts = Math.max(this.lastDetectTs + 1, Math.round(now));
      this.lastDetectTs = ts;
      var t1 = performance.now();
      try {
        var out = this.landmarker.detectForVideo(video, ts);
        landmarks = out && out.faceLandmarks && out.faceLandmarks.length ? out.faceLandmarks[0] : null;
        if (landmarks && out.faceBlendshapes && out.faceBlendshapes.length) {
          blendshapes = window.FaceMetrics.blendshapeMap(out.faceBlendshapes[0].categories);
        }
        this.detectErrors = 0;
      } catch (err) {
        this.detectErrors++;
        landmarks = null;
        if (this.detectErrors === 30 && this.delegate === 'GPU') this._fallbackToCpu();
      }
      var cost = performance.now() - t1;
      this.detectCost += (cost - this.detectCost) * 0.1;
      this.detectEvery = this.detectCost > 40 ? 3 : this.detectCost > 22 ? 2 : 1;
      this.lastLandmarks = landmarks;
    }

    if (!landmarks) {
      this.face = null;
      if (!this.faceLostHandled && now - this.lastFaceMs > CONFIG.faceLostResetMs) {
        this.processor.reset();
        this.fusion.reset();
        this.resp.reset();
        this.prevGeom = null;
        this.faceLostHandled = true;
      }
      return;
    }

    // Face geometry in video pixels
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i;
    for (i = 0; i < landmarks.length; i++) {
      var lx = landmarks[i].x * vw, ly = landmarks[i].y * vh;
      if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
      if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
    }
    var bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

    var rois = [];
    for (i = 0; i < ROI_ORDER.length; i++) {
      var key = ROI_ORDER[i], idxs = ROI_LANDMARKS[key], pts = [];
      for (var j = 0; j < idxs.length; j++) {
        var lm = landmarks[idxs[j]];
        if (lm) pts.push({ x: lm.x * vw, y: lm.y * vh });
      }
      rois.push(pts.length >= 3 ? shrinkPolygon(convexHull(pts), ROI_SHRINK[key]) : []);
    }

    // Head-motion estimate: centre translation + scale change, in face-widths per second
    var cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
    if (this.prevGeom) {
      var dts = Math.max(0.008, (now - this.prevGeom.t) / 1000);
      var fw = Math.max(1, bbox.w);
      var speed = (Math.hypot(cx - this.prevGeom.cx, cy - this.prevGeom.cy) + Math.abs(bbox.w - this.prevGeom.w)) / fw / dts;
      var m = Math.min(4, speed / CONFIG.motionRef);
      this.motion += (m - this.motion) * Math.min(1, dts / 0.3);
    }
    this.prevGeom = { cx: cx, cy: cy, w: bbox.w, t: now };

    // Skin colour extraction → per-region fusion → rPPG core
    var s = this.sampler.sample(video, rois);
    if (s) {
      this.light.luma += (s.luma - this.light.luma) * 0.1;
      this.light.clipped += (s.clipped - this.light.clipped) * 0.1;
      var fused = this.fusion.push(t, s.rois, this.motion);
      if (fused) this.processor.push(t, fused.r, fused.g, fused.b, this.motion);
      if (s.count >= CONFIG.minRoiPixels) this.resp.pushFrame(t, s.g, bbox.h > 0 ? cy / bbox.h : null);
    }

    // Eyes & expression
    if (blendshapes) {
      this.blink.push(t, ((blendshapes.eyeBlinkLeft || 0) + (blendshapes.eyeBlinkRight || 0)) / 2);
      this.tension.push(t, blendshapes);
    }

    this.face = {
      bbox: bbox, rois: rois, weights: this.fusion.weights.slice(),
      relW: bbox.w / vw, relCx: cx / vw, relCy: cy / vh
    };
    this.lastFaceMs = now;
    this.faceLostHandled = false;
  };

  App.prototype._fallbackToCpu = function () {
    var self = this;
    if (!this.vision || !this.fileset) return;
    var old = this.landmarker;
    this.landmarker = null;
    this._createLandmarker(this.vision, this.fileset, 'CPU').then(function () {
      try { old && old.close(); } catch (e) { /* ignore */ }
    }).catch(function (err) {
      console.error('CPU fallback failed', err);
      self.landmarker = old;
    });
  };

  /* -------------------------------------------------------------------- *
   * Per-display-frame rendering + DOM state
   * -------------------------------------------------------------------- */
  App.prototype._render = function (now) {
    var tSec = now / 1000;
    var res = this.processor.update(tSec);
    var rr = this.resp.update(tSec, this.processor.beatLog, this.processor.ibis);
    var phase = this.phase;

    if (this.running && this.cameraLive) {
      var hasSignal = this.mode === 'finger' ? this.finger.present : !!this.face;
      if (!hasSignal) phase = 'searching';
      else if (res.state === 'idle' || res.state === 'acquiring') phase = 'acquiring';
      else phase = res.state; // analyzing | locked
      this._setPhase(phase);
    }

    // Session recording
    var live = phase === 'analyzing' || phase === 'locked';
    if (this.running && this.cameraLive) {
      if (live) {
        this.lastSignalMs = now;
        this.recorder.begin(this.coach.isRunning() ? 'coach' : this.mode, now);
      } else if (this.recorder.isActive() && now - this.lastSignalMs > CONFIG.sessionGapMs) {
        this.recorder.finish();
      }
    }
    var bm = this.mode === 'face' ? this.blink.metrics(tSec) : null;
    var tm = this.mode === 'face' ? this.tension.metrics() : null;
    if (live) {
      this.recorder.sample(now, {
        bpm: res.bpm, conf: res.confidence, resp: rr.rate, respConf: rr.confidence,
        stress: res.stress ? res.stress.index : null, stressLabel: res.stress ? res.stress.label : null,
        rmssd: res.hrv.rmssd, sdnn: res.hrv.sdnn,
        blink: bm && bm.rate !== null ? bm.rate : null, tension: tm && tm.index !== null ? tm.index : null
      });
    }

    // Breathing coach
    var pacer = this.coach.pacer(now);
    this.coach.update(now, this.processor);

    // Heart-beat phase, phase-locked to the latest detected systolic peak
    var beat = 0;
    if (live && res.bpm > 0 && res.lastPeakTime !== null) {
      var period = 60 / res.bpm;
      var ph = (((tSec - res.lastPeakTime) % period) + period) % period / period;
      beat = Math.exp(-ph * 9) + 0.35 * Math.exp(-Math.pow((ph - 0.32) * 14, 2));
      beat = Math.min(1, beat);
    }

    this.hud.render({
      now: now,
      mode: this.mode,
      phase: this.running ? phase : 'standby',
      face: this.face,
      finger: this.finger,
      pacer: pacer,
      result: res,
      beat: beat,
      confidence: res.confidence
    });

    this._updateDom(now, phase, res, rr, bm, tm, beat);
  };

  App.prototype._setPhase = function (phase) {
    if (phase === this.phase) return;
    this.phase = phase;
    this.el.root.dataset.phase = phase;
  };

  App.prototype._text = function (key, el, value) {
    if (this.uiCache[key] !== value) { this.uiCache[key] = value; el.textContent = value; }
  };
  App.prototype._attr = function (key, el, name, value) {
    if (this.uiCache[key] !== value) { this.uiCache[key] = value; el.setAttribute(name, value); }
  };

  App.prototype._updateDom = function (now, phase, res, rr, bm, tm, beat) {
    var el = this.el, finger = this.mode === 'finger';
    var live = phase === 'analyzing' || phase === 'locked';
    var STATUS = {
      standby: 'SYSTEM STANDBY',
      loading: 'LOADING NEURAL FACE MESH…',
      searching: finger ? 'AWAITING FINGERTIP CONTACT…' : 'SEARCHING FOR SUBJECT…',
      acquiring: 'ACQUIRING SIGNAL… ' + Math.round(res.progress * 100) + '%',
      analyzing: finger ? 'ANALYZING CAPILLARY PULSE…' : 'ANALYZING CAPILLARY REFLECTION…',
      locked: 'LOCK ESTABLISHED',
      halted: 'SCANNER HALTED'
    };
    this._text('status', el.statusText, STATUS[phase] || phase.toUpperCase());

    // Heart icon
    var hs = 1 + 0.22 * beat;
    if (this.uiCache.heart !== hs.toFixed(3)) {
      this.uiCache.heart = hs.toFixed(3);
      el.heart.style.transform = 'scale(' + hs.toFixed(3) + ')';
      el.heart.style.opacity = (0.55 + 0.45 * beat).toFixed(2);
    }

    var showBpm = live && res.bpm > 0 && res.confidence >= 0.3;
    this._text('bpm', el.bpm, showBpm ? String(Math.round(res.bpm)) : '--');
    el.bpm.classList.toggle('is-dim', showBpm && phase !== 'locked');
    var sub = live && isFinite(res.snr)
      ? 'SNR ' + (res.snr >= 0 ? '+' : '') + res.snr.toFixed(1) + ' dB'
      : 'SNR --.- dB';
    this._text('bpmSub', el.bpmSub, sub);

    var qLabel = res.confidence >= 0.6 ? 'STRONG' : res.confidence >= 0.35 ? 'FAIR' : (phase === 'analyzing' ? 'WEAK' : 'IDLE');
    this._text('q', el.qualityLabel, qLabel);

    // Stress / HRV
    if (res.stress) {
      this._text('stressV', el.stressValue, String(Math.round(res.stress.index)));
      this._text('stressL', el.stressLabel, res.stress.label);
      this._text('stressS', el.stressSub, 'RMSSD ' + Math.round(res.hrv.rmssd) + 'ms');
      var w = res.stress.index.toFixed(1) + '%';
      if (this.uiCache.stressW !== w) { this.uiCache.stressW = w; el.stressFill.style.width = w; }
      this._attr('stressD', el.root, 'data-stress', res.stress.label.toLowerCase());
    } else {
      this._text('stressV', el.stressValue, '--');
      this._text('stressL', el.stressLabel, live ? 'CALIBRATING' : 'STANDBY');
      var need = this.processor.opts.minIbisForStress;
      this._text('stressS', el.stressSub, 'BEATS ' + Math.min(res.hrv.count, need) + '/' + need);
      var pw = (res.stressProgress * 100).toFixed(1) + '%';
      if (this.uiCache.stressW !== pw) { this.uiCache.stressW = pw; el.stressFill.style.width = pw; }
      this._attr('stressD', el.root, 'data-stress', 'none');
    }

    // Secondary metric chips
    var respShown = live && rr.rate > 0 && rr.confidence >= 0.3;
    this._text('resp', el.respValue, respShown ? String(Math.round(rr.rate)) : '--');
    this._attr('respDim', el.chipResp, 'data-dim', respShown && rr.state !== 'locked' ? '1' : '0');
    if (finger) {
      this._text('blink', el.blinkValue, 'N/A');
      this._text('tension', el.tensionValue, 'N/A');
      this._text('eyes', el.eyesValue, 'N/A');
      this._attr('eyesL', el.chipEyes, 'data-level', 'none');
      this._attr('tensL', el.chipTension, 'data-level', 'none');
    } else {
      this._text('blink', el.blinkValue, bm && bm.rate !== null && this.face ? String(Math.round(bm.rate)) : '--');
      this._text('tension', el.tensionValue, tm && tm.index !== null && this.face ? String(Math.round(tm.index)) : '--');
      this._attr('tensL', el.chipTension, 'data-level', tm && tm.index !== null ? tm.label.toLowerCase() : 'none');
      var EYES = { ok: 'OK', fatigue: 'TIRED', drowsy: 'DROWSY', calibrating: '···' };
      var eyeLevel = this.face && bm ? bm.level : 'none';
      this._text('eyes', el.eyesValue, EYES[eyeLevel] || '--');
      this._attr('eyesL', el.chipEyes, 'data-level', eyeLevel);
    }

    // Telemetry (4 Hz)
    if (now - this.lastTelemetryMs > 250) {
      this.lastTelemetryMs = now;
      var tel;
      if (!this.cameraLive) tel = 'CAM OFFLINE';
      else if (finger) {
        tel = 'REAR CAM ' + Math.round(this.camFps) + 'FPS · CONTACT' + (res.channel ? '·' + res.channel : '') +
          ' · ' + (this.torchOn ? 'TORCH ON' : 'NO TORCH') + ' · BUF ' + Math.min(res.bufferSeconds, 8.5).toFixed(1) + 's';
      } else {
        tel = 'CAM ' + Math.round(this.camFps) + 'FPS · MESH ' + Math.round(this.detectCost) + 'ms' +
          (this.detectEvery > 1 ? '/' + this.detectEvery : '') + ' · ' + (this.delegate || '--') +
          ' · BUF ' + Math.min(res.bufferSeconds, 8.5).toFixed(1) + 's';
      }
      this._text('tel', el.telemetry, tel);
    }

    this._updateGuidance(now, phase, res, bm);
  };

  App.prototype._updateGuidance = function (now, phase, res, bm) {
    if (!this.running || !this.cameraLive) { this.prompts.update('', 'info', now); return; }
    var msg = '', level = 'info', coaching = this.coach.isRunning();

    if (this.mode === 'finger') {
      var fi = this.finger;
      if (!fi.present) { msg = fi.dark ? 'COVER CAMERA · MOVE TO BRIGHT LIGHT' : 'COVER REAR CAMERA & FLASH WITH FINGERTIP'; level = 'warn'; }
      else if (fi.saturated) { msg = 'PRESS MORE GENTLY'; level = 'warn'; }
      else if (this.motion > 1) { msg = 'HOLD FINGER STILL'; level = 'alert'; }
      else if (phase === 'acquiring' && !coaching) { msg = 'HOLD STILL · LIGHT, STEADY PRESSURE'; }
      this.prompts.update(msg, level, now);
      return;
    }

    var f = this.face;
    if (!f) { msg = 'CENTER FACE IN FRAME'; level = 'warn'; }
    else if (f.relW < 0.2) { msg = 'MOVE CLOSER TO CAMERA'; level = 'warn'; }
    else if (f.relW > 0.8) { msg = 'MOVE BACK SLIGHTLY'; level = 'warn'; }
    else if (Math.abs(f.relCx - 0.5) > 0.24 || Math.abs(f.relCy - 0.5) > 0.26) { msg = 'CENTER FACE IN FRAME'; level = 'warn'; }
    else if (bm && bm.level === 'drowsy' && !coaching) { msg = 'DROWSINESS DETECTED · TAKE A BREAK'; level = 'alert'; }
    else if (this.light.luma < 55) { msg = 'INCREASE AMBIENT LIGHT'; level = 'warn'; }
    else if (this.light.clipped > 0.12 || this.light.luma > 220) { msg = 'REDUCE DIRECT GLARE'; level = 'warn'; }
    else if (this.motion > 1) { msg = 'STAY STILL'; level = 'alert'; }
    else if (coaching) { msg = ''; }
    else if (phase === 'acquiring') { msg = 'HOLD STEADY · BREATHE NORMALLY'; }
    else if (phase === 'analyzing' && res.confidence < 0.35) { msg = 'STAY STILL'; level = 'info'; }
    else if (bm && bm.level === 'fatigue') {
      // screen-stare reminder: show for 5 s, then stay quiet for a minute
      if (now > this.fatigueCooldownUntil) { this.fatigueNoticeUntil = now + 5000; this.fatigueCooldownUntil = now + 65000; }
      if (now < this.fatigueNoticeUntil) msg = 'LOW BLINK RATE · REST YOUR EYES';
    }
    this.prompts.update(msg, level, now);
  };

  App.prototype._showError = function (msg) {
    this.el.error.textContent = msg;
    this.el.error.hidden = false;
  };
  App.prototype._hideError = function () { this.el.error.hidden = true; };

  /* ==================================================================== *
   * Service worker
   * ==================================================================== */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    // A new deployment took control: reload straight away unless a scan is in progress,
    // in which case offer it via a toast (the next launch picks it up regardless).
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) { hadController = true; return; }
      var app = window.bioRadar;
      if (app && app.running) {
        app._toast('UPDATE READY · RELOAD TO APPLY');
      } else {
        reloading = true;
        window.location.reload();
      }
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(function (reg) {
        // check for a newer deployment whenever the app comes back to the foreground
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function (err) {
        console.warn('Service worker registration failed', err);
      });
    });
  }

  registerServiceWorker();
  function boot() { window.bioRadar = new App(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
