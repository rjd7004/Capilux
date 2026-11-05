/*!
 * Bio-Radar rPPG — app.js
 * Application manager: DOM wiring, camera lifecycle (iOS-Safari safe), MediaPipe
 * FaceLandmarker, ROI colour extraction, frame scheduling and HUD state.
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
    minRoiPixels: 60,
    motionRef: 0.35           // face-widths / second regarded as "too much motion"
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
   * @returns {{r,g,b,count,luma,clipped}|null}
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

    var sr = 0, sg = 0, sb = 0, count = 0, clipped = 0, total = 0;
    for (i = 0; i < polys.length; i++) {
      var poly = polys[i], m = poly.length;
      if (m < 3) continue;
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
    if (!count) return { r: 0, g: 0, b: 0, count: 0, luma: 0, clipped: total ? clipped / total : 0 };
    var R = sr / count, G = sg / count, B = sb / count;
    return { r: R, g: G, b: B, count: count, luma: 0.299 * R + 0.587 * G + 0.114 * B, clipped: total ? clipped / total : 0 };
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
    this.el = {
      root: $('app'), video: $('video'), overlay: $('overlay'), wave: $('wave'), gauge: $('gauge'),
      spectrum: $('spectrum'), splash: $('splash'), startBtn: $('start-btn'), bootLog: $('boot-log'),
      error: $('error'), status: $('status'), statusText: $('status-text'),
      bpm: $('bpm-value'), bpmSub: $('bpm-sub'), heart: $('heart'),
      stressValue: $('stress-value'), stressLabel: $('stress-label'), stressFill: $('stress-fill'),
      stressSub: $('stress-sub'), telemetry: $('telemetry'), guidance: $('guidance'),
      guidanceText: $('guidance-text'), haltBtn: $('halt-btn'), resetBtn: $('reset-btn'),
      resume: $('resume'), resumeBtn: $('resume-btn'), qualityLabel: $('quality-label')
    };
    this.processor = new window.RPPG.RPPGProcessor({ method: 'pos' });
    this.hud = new window.HUDRenderer({
      overlay: this.el.overlay, wave: this.el.wave, gauge: this.el.gauge, spectrum: this.el.spectrum
    });
    this.sampler = new ROISampler(CONFIG.sampleMaxDim);
    this.prompts = new PromptController(this.el.guidance, this.el.guidanceText);

    this.landmarker = null;
    this.delegate = null;
    this.stream = null;
    this.running = false;      // user wants the scanner on
    this.cameraLive = false;
    this.booting = false;
    this.phase = 'standby';
    this.face = null;
    this.lastFaceMs = 0;
    this.faceLostHandled = true;
    this.lastDetectTs = 0;
    this.detectCost = 12;
    this.detectEvery = 1;
    this.frameIdx = 0;
    this.lastLandmarks = null;
    this.prevGeom = null;
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

    this._onFrame = this._onFrame.bind(this);
    this._renderLoop = this._renderLoop.bind(this);
    this._bind();
    this._checkEnvironment();
    this.rafHandle = requestAnimationFrame(this._renderLoop);
  }

  App.prototype._bind = function () {
    var self = this, el = this.el;
    el.startBtn.addEventListener('click', function () { self.start(); });
    el.resumeBtn.addEventListener('click', function () { self._resumeFromGesture(); });
    el.haltBtn.addEventListener('click', function () {
      if (self.running) self.halt(); else self.resume();
    });
    el.resetBtn.addEventListener('click', function () { self.recalibrate(); });

    document.addEventListener('visibilitychange', function () { self._onVisibility(); });
    window.addEventListener('pagehide', function () { self._stopCamera(); });
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
   * Boot sequence (explicit user gesture — WebKit requirement)
   * -------------------------------------------------------------------- */
  App.prototype.start = function () {
    if (this.booting) return;
    var self = this;
    this.booting = true;
    this._hideError();
    this.el.startBtn.disabled = true;
    this.el.startBtn.querySelector('.btn-label').textContent = 'BOOTING…';
    this.el.bootLog.innerHTML = '';
    this._setPhase('loading');

    // getUserMedia is invoked synchronously inside the click handler.
    var camLine = this._log('CAMERA UPLINK');
    var camPromise = this._startCamera().then(function () { self._logDone(camLine, 'OK'); });
    var meshLine = this._log('NEURAL FACE MESH');
    var meshPromise = this._loadLandmarker().then(function () { self._logDone(meshLine, self.delegate); });

    Promise.all([camPromise, meshPromise]).then(function () {
      self._logDone(self._log('rPPG DSP CORE'), 'POS');
      self.running = true;
      self.booting = false;
      self.processor.reset();
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
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable front-facing camera was found on this device.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is in use by another app or tab. Close it and retry.';
    if (err && err.isModelError) return 'Failed to load the face-mesh model. The first launch needs a network connection (assets are cached afterwards). ' + (err.message || '');
    return 'Initialization failed: ' + ((err && err.message) || String(err));
  };

  /* -------------------------------------------------------------------- *
   * Camera lifecycle
   * -------------------------------------------------------------------- */
  App.prototype._startCamera = function () {
    var self = this, video = this.el.video;
    this._stopCamera();
    var constraints = {
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      }
    };
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
          if (self.running && document.visibilityState === 'visible') self._rebindCamera();
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
      self.hud.setVideoSize(video.videoWidth, video.videoHeight, true);
    });
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

  /** Re-acquire the camera after tab switch / screen lock (iOS kills capture in background). */
  App.prototype._rebindCamera = function () {
    var self = this;
    if (this._rebinding) return this._rebinding;
    this.processor.reset();
    this.face = null;
    this.prevGeom = null;
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
      if (this.running) this._stopCamera();
      this._releaseWakeLock();
    } else if (this.running && !this.booting) {
      this._rebindCamera();
    }
  };

  App.prototype.halt = function () {
    this.running = false;
    this._stopCamera();
    this.processor.reset();
    this.face = null;
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
    this.processor.reset();
    this.prevGeom = null;
    if (this.running) this._setPhase(this.face ? 'acquiring' : 'searching');
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
    return getVisionModule().then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(CONFIG.wasmBase).then(function (fileset) {
        self.fileset = fileset;
        return self._createLandmarker(vision, fileset, 'GPU').catch(function (err) {
          console.warn('GPU delegate unavailable, falling back to CPU.', err);
          return self._createLandmarker(vision, fileset, 'CPU');
        });
      });
    }).catch(function (err) {
      var e = new Error(err && err.message ? err.message : String(err));
      e.isModelError = true;
      throw e;
    });
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
      outputFaceBlendshapes: false,
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
    if (!this.landmarker || video.readyState < 2 || !video.videoWidth) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (vw !== this.hud.videoW || vh !== this.hud.videoH) this.hud.setVideoSize(vw, vh, true);

    // FPS accounting
    this.camFrames++;
    if (now - this.fpsWindowStart >= 1000) {
      this.camFps = this.camFrames * 1000 / (now - this.fpsWindowStart);
      this.camFrames = 0;
      this.fpsWindowStart = now;
    }

    // Face mesh (adaptively decimated on slow devices; ROI sampling still runs every frame)
    this.frameIdx++;
    var landmarks = this.lastLandmarks;
    if (this.frameIdx % this.detectEvery === 0 || !landmarks) {
      var ts = Math.max(this.lastDetectTs + 1, Math.round(now));
      this.lastDetectTs = ts;
      var t1 = performance.now();
      try {
        var out = this.landmarker.detectForVideo(video, ts);
        landmarks = out && out.faceLandmarks && out.faceLandmarks.length ? out.faceLandmarks[0] : null;
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
      if (pts.length >= 3) rois.push(shrinkPolygon(convexHull(pts), ROI_SHRINK[key]));
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

    // Skin colour extraction
    var s = this.sampler.sample(video, rois);
    if (s) {
      this.light.luma += (s.luma - this.light.luma) * 0.1;
      this.light.clipped += (s.clipped - this.light.clipped) * 0.1;
      if (s.count >= CONFIG.minRoiPixels) this.processor.push(now / 1000, s.r, s.g, s.b, this.motion);
    }

    this.face = {
      bbox: bbox, rois: rois,
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
    var res = this.processor.update(now / 1000);
    var phase = this.phase;

    if (this.running && this.cameraLive) {
      if (!this.face) phase = 'searching';
      else if (res.state === 'idle' || res.state === 'acquiring') phase = 'acquiring';
      else phase = res.state; // analyzing | locked
      this._setPhase(phase);
    }

    // Heart-beat phase, phase-locked to the latest detected systolic peak
    var beat = 0;
    if ((phase === 'analyzing' || phase === 'locked') && res.bpm > 0 && res.lastPeakTime !== null) {
      var period = 60 / res.bpm;
      var ph = (((now / 1000 - res.lastPeakTime) % period) + period) % period / period;
      beat = Math.exp(-ph * 9) + 0.35 * Math.exp(-Math.pow((ph - 0.32) * 14, 2));
      beat = Math.min(1, beat);
    }

    this.hud.render({
      now: now,
      phase: this.running ? phase : 'standby',
      face: this.face,
      result: res,
      beat: beat,
      confidence: res.confidence
    });

    this._updateDom(now, phase, res, beat);
  };

  App.prototype._setPhase = function (phase) {
    if (phase === this.phase) return;
    this.phase = phase;
    this.el.root.dataset.phase = phase;
  };

  App.prototype._text = function (key, el, value) {
    if (this.uiCache[key] !== value) { this.uiCache[key] = value; el.textContent = value; }
  };

  App.prototype._updateDom = function (now, phase, res, beat) {
    var el = this.el;
    var STATUS = {
      standby: 'SYSTEM STANDBY',
      loading: 'LOADING NEURAL FACE MESH…',
      searching: 'SEARCHING FOR SUBJECT…',
      acquiring: 'ACQUIRING SIGNAL… ' + Math.round(res.progress * 100) + '%',
      analyzing: 'ANALYZING CAPILLARY REFLECTION…',
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

    var showBpm = (phase === 'analyzing' || phase === 'locked') && res.bpm > 0 && res.confidence >= 0.3;
    this._text('bpm', el.bpm, showBpm ? String(Math.round(res.bpm)) : '--');
    el.bpm.classList.toggle('is-dim', showBpm && phase !== 'locked');
    var sub = (phase === 'analyzing' || phase === 'locked') && isFinite(res.snr)
      ? 'SNR ' + (res.snr >= 0 ? '+' : '') + res.snr.toFixed(1) + ' dB'
      : 'SNR --.- dB';
    this._text('bpmSub', el.bpmSub, sub);

    var qLabel = res.confidence >= 0.6 ? 'STRONG' : res.confidence >= 0.35 ? 'FAIR' : (phase === 'analyzing' ? 'WEAK' : 'IDLE');
    this._text('q', el.qualityLabel, 'SIGNAL ' + qLabel);

    // Stress / HRV
    if (res.stress) {
      this._text('stressV', el.stressValue, String(Math.round(res.stress.index)));
      this._text('stressL', el.stressLabel, res.stress.label);
      this._text('stressS', el.stressSub, 'RMSSD ' + Math.round(res.hrv.rmssd) + 'ms');
      var w = res.stress.index.toFixed(1) + '%';
      if (this.uiCache.stressW !== w) { this.uiCache.stressW = w; el.stressFill.style.width = w; }
      el.root.dataset.stress = res.stress.label.toLowerCase();
    } else {
      this._text('stressV', el.stressValue, '--');
      this._text('stressL', el.stressLabel, phase === 'analyzing' || phase === 'locked' ? 'CALIBRATING' : 'STANDBY');
      var need = this.processor.opts.minIbisForStress;
      this._text('stressS', el.stressSub, 'BEATS ' + Math.min(res.hrv.count, need) + '/' + need);
      var pw = (res.stressProgress * 100).toFixed(1) + '%';
      if (this.uiCache.stressW !== pw) { this.uiCache.stressW = pw; el.stressFill.style.width = pw; }
      el.root.dataset.stress = 'none';
    }

    // Telemetry (4 Hz)
    if (now - this.lastTelemetryMs > 250) {
      this.lastTelemetryMs = now;
      var tel = this.cameraLive
        ? 'CAM ' + Math.round(this.camFps) + 'FPS · MESH ' + Math.round(this.detectCost) + 'ms' +
          (this.detectEvery > 1 ? '/' + this.detectEvery : '') + ' · ' + (this.delegate || '--') +
          ' · BUF ' + Math.min(res.bufferSeconds, 8.5).toFixed(1) + 's'
        : 'CAM OFFLINE';
      this._text('tel', el.telemetry, tel);
    }

    // Guidance
    if (!this.running || !this.cameraLive) { this.prompts.update('', 'info', now); return; }
    var msg = '', level = 'info', f = this.face;
    if (!f) { msg = 'CENTER FACE IN FRAME'; level = 'warn'; }
    else if (f.relW < 0.2) { msg = 'MOVE CLOSER TO CAMERA'; level = 'warn'; }
    else if (f.relW > 0.8) { msg = 'MOVE BACK SLIGHTLY'; level = 'warn'; }
    else if (Math.abs(f.relCx - 0.5) > 0.24 || Math.abs(f.relCy - 0.5) > 0.26) { msg = 'CENTER FACE IN FRAME'; level = 'warn'; }
    else if (this.light.luma < 55) { msg = 'INCREASE AMBIENT LIGHT'; level = 'warn'; }
    else if (this.light.clipped > 0.12 || this.light.luma > 220) { msg = 'REDUCE DIRECT GLARE'; level = 'warn'; }
    else if (this.motion > 1) { msg = 'STAY STILL'; level = 'alert'; }
    else if (phase === 'acquiring') { msg = 'HOLD STEADY · BREATHE NORMALLY'; }
    else if (phase === 'analyzing' && res.confidence < 0.35) { msg = 'STAY STILL'; level = 'info'; }
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
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function (err) {
        console.warn('Service worker registration failed', err);
      });
    });
  }

  registerServiceWorker();
  function boot() { window.bioRadar = new App(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
