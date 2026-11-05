/*!
 * Bio-Radar rPPG — history.js
 * On-device session log (IndexedDB, localStorage fallback), automatic session recording,
 * the history / trends / accuracy sheet, CSV export and the reference-reading dialog
 * ("check against your watch"). Nothing ever leaves the device unless the user exports it.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'bioradar';
  var DB_VERSION = 1;
  var LS_KEY = 'bioradar.store.v1';
  var FONT = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v, d) { if (v === null || v === undefined || !isFinite(v)) return null; var m = Math.pow(10, d || 0); return Math.round(v * m) / m; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDur(sec) {
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ':' + pad2(sec % 60);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fitCanvas(canvas) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* ==================================================================== *
   * SessionStore
   * ==================================================================== */
  function SessionStore() {
    var self = this;
    this.mode = 'idb';
    this.ready = new Promise(function (resolve) {
      if (!global.indexedDB) { self.mode = 'ls'; resolve(); return; }
      var req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { self.mode = 'ls'; resolve(); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('references')) db.createObjectStore('references', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { self.db = req.result; resolve(); };
      req.onerror = function () { self.mode = 'ls'; resolve(); };
      req.onblocked = function () { self.mode = 'ls'; resolve(); };
    });
  }

  SessionStore.prototype._ls = function () {
    try { return JSON.parse(global.localStorage.getItem(LS_KEY)) || { sessions: [], references: [], nextId: 1 }; }
    catch (e) { return { sessions: [], references: [], nextId: 1 }; }
  };
  SessionStore.prototype._lsSave = function (data) {
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* quota / private mode */ }
  };

  SessionStore.prototype._tx = function (storeName, mode, fn) {
    var self = this;
    return this.ready.then(function () {
      if (self.mode === 'ls') {
        var data = self._ls();
        var out = fn(null, data);
        if (mode === 'readwrite') self._lsSave(data);
        return out;
      }
      return new Promise(function (resolve, reject) {
        var tx = self.db.transaction(storeName, mode);
        var st = tx.objectStore(storeName);
        var result;
        var r = fn(st, null);
        if (r && typeof r.onsuccess !== 'undefined') r.onsuccess = function () { result = r.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  };

  SessionStore.prototype._add = function (name, rec) {
    return this._tx(name, 'readwrite', function (st, data) {
      if (data) { rec.id = data.nextId++; data[name].push(rec); return rec.id; }
      return st.add(rec);
    });
  };
  SessionStore.prototype._list = function (name) {
    return this._tx(name, 'readonly', function (st, data) {
      if (data) return data[name].slice();
      return st.getAll();
    }).then(function (list) {
      return (list || []).sort(function (a, b) { return (b.start || b.time) - (a.start || a.time); });
    });
  };
  SessionStore.prototype._delete = function (name, id) {
    return this._tx(name, 'readwrite', function (st, data) {
      if (data) { data[name] = data[name].filter(function (r) { return r.id !== id; }); return; }
      return st.delete(id);
    });
  };
  SessionStore.prototype._clear = function (name) {
    return this._tx(name, 'readwrite', function (st, data) {
      if (data) { data[name] = []; return; }
      return st.clear();
    });
  };

  SessionStore.prototype.addSession = function (s) { return this._add('sessions', s); };
  SessionStore.prototype.listSessions = function () { return this._list('sessions'); };
  SessionStore.prototype.deleteSession = function (id) { return this._delete('sessions', id); };
  SessionStore.prototype.addReference = function (r) { return this._add('references', r); };
  SessionStore.prototype.listReferences = function () { return this._list('references'); };
  SessionStore.prototype.deleteReference = function (id) { return this._delete('references', id); };
  SessionStore.prototype.clearAll = function () {
    var self = this;
    return this._clear('sessions').then(function () { return self._clear('references'); });
  };

  /* ==================================================================== *
   * SessionRecorder — samples readings every 2 s while quality is decent,
   * then stores a summary when the session ends.
   * ==================================================================== */
  function SessionRecorder(store, onSaved) {
    this.store = store;
    this.onSaved = onSaved || function () {};
    this.active = null;
  }

  SessionRecorder.prototype.begin = function (mode, nowMs) {
    if (this.active && this.active.mode === mode) return;
    this.finish();
    this.active = { mode: mode, start: Date.now(), t0: nowMs, lastSample: -Infinity, samples: [], extra: {} };
  };

  SessionRecorder.prototype.isActive = function () { return !!this.active; };

  SessionRecorder.prototype.setExtra = function (key, value) {
    if (this.active) this.active.extra[key] = value;
  };

  /** d: {bpm, conf, resp, respConf, stress, stressLabel, rmssd, sdnn, blink, tension} */
  SessionRecorder.prototype.sample = function (nowMs, d) {
    var a = this.active;
    if (!a || nowMs - a.lastSample < 2000) return;
    if (!(d.bpm > 0) || d.conf < 0.4) return;
    a.lastSample = nowMs;
    a.samples.push({
      dt: (nowMs - a.t0) / 1000, bpm: d.bpm, conf: d.conf,
      resp: d.respConf >= 0.3 ? d.resp : null,
      stress: d.stress, stressLabel: d.stressLabel, rmssd: d.rmssd, sdnn: d.sdnn,
      blink: d.blink, tension: d.tension
    });
  };

  SessionRecorder.prototype.finish = function () {
    var a = this.active;
    this.active = null;
    if (!a || a.samples.length < 6) return Promise.resolve(null);
    var S = a.samples, i;
    var wsum = 0, bsum = 0, csum = 0, minB = Infinity, maxB = -Infinity;
    var resp = [], blink = [], tension = [], lastStress = null, lastLabel = null, lastRmssd = null, lastSdnn = null;
    for (i = 0; i < S.length; i++) {
      var s = S[i];
      wsum += s.conf; bsum += s.bpm * s.conf; csum += s.conf;
      if (s.bpm < minB) minB = s.bpm; if (s.bpm > maxB) maxB = s.bpm;
      if (s.resp !== null) resp.push(s.resp);
      if (s.blink !== null && s.blink !== undefined) blink.push(s.blink);
      if (s.tension !== null && s.tension !== undefined) tension.push(s.tension);
      if (s.stress !== null && s.stress !== undefined) { lastStress = s.stress; lastLabel = s.stressLabel; }
      if (s.rmssd) lastRmssd = s.rmssd;
      if (s.sdnn) lastSdnn = s.sdnn;
    }
    function mean(arr) { if (!arr.length) return null; var t = 0; for (var k = 0; k < arr.length; k++) t += arr[k]; return t / arr.length; }
    var session = {
      start: a.start,
      duration: round(S[S.length - 1].dt - S[0].dt + 2, 0),
      mode: a.mode,
      avgBpm: round(bsum / wsum, 1),
      minBpm: round(minB, 0),
      maxBpm: round(maxB, 0),
      avgConf: round(csum / S.length, 2),
      resp: round(mean(resp), 1),
      stress: round(lastStress, 0),
      stressLabel: lastLabel,
      rmssd: round(lastRmssd, 0),
      sdnn: round(lastSdnn, 0),
      blink: round(mean(blink), 1),
      tension: round(mean(tension), 0),
      coach: a.extra.coach || null,
      samples: S.map(function (s) { return [round(s.dt, 0), round(s.bpm, 1), round(s.conf, 2), round(s.resp, 1), round(s.stress, 0)]; })
    };
    var self = this;
    return this.store.addSession(session).then(function (id) {
      session.id = id;
      self.onSaved(session);
      return session;
    }).catch(function (err) { console.warn('Session save failed', err); return null; });
  };

  /* ==================================================================== *
   * CSV export
   * ==================================================================== */
  var CSV_COLUMNS = ['record_type', 'timestamp', 'duration_s', 'mode', 'avg_bpm', 'min_bpm', 'max_bpm', 'avg_confidence',
    'resp_rate_bpm', 'stress_index', 'stress_label', 'rmssd_ms', 'sdnn_ms', 'blink_rate_min', 'tension_index',
    'coach_pace_min', 'coach_sync_pct', 'coach_swing_bpm', 'ref_bpm', 'ref_source', 'app_bpm', 'app_confidence'];

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(sessions, refs) {
    var rows = [CSV_COLUMNS.join(',')];
    sessions.slice().reverse().forEach(function (s) {
      var c = s.coach || {};
      rows.push([
        'session', new Date(s.start).toISOString(), s.duration, s.mode, s.avgBpm, s.minBpm, s.maxBpm, s.avgConf,
        s.resp, s.stress, s.stressLabel, s.rmssd, s.sdnn, s.blink, s.tension,
        c.pace, c.sync, c.swing, '', '', '', ''
      ].map(csvCell).join(','));
    });
    refs.slice().reverse().forEach(function (r) {
      rows.push([
        'reference', new Date(r.time).toISOString(), '', r.mode, '', '', '', '', '', '', '', '', '', '', '',
        '', '', '', r.refBpm, r.source, r.appBpm, r.appConf
      ].map(csvCell).join(','));
    });
    return rows.join('\n') + '\n';
  }

  function exportCsv(store) {
    return Promise.all([store.listSessions(), store.listReferences()]).then(function (res) {
      var csv = buildCsv(res[0], res[1]);
      var d = new Date();
      var name = 'bio-radar-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.csv';
      var blob = new Blob([csv], { type: 'text/csv' });
      var file = null;
      try { file = new File([blob], name, { type: 'text/csv' }); } catch (e) { file = null; }
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        return navigator.share({ files: [file], title: 'Bio-Radar export' }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          downloadBlob(blob, name);
        });
      }
      downloadBlob(blob, name);
    });
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* ==================================================================== *
   * Accuracy statistics (app vs. reference)
   * ==================================================================== */
  function accuracyStats(refs) {
    var valid = refs.filter(function (r) { return r.appBpm > 0 && r.refBpm > 0; });
    if (!valid.length) return null;
    var abs = 0, bias = 0, within = 0;
    valid.forEach(function (r) {
      var e = r.appBpm - r.refBpm;
      abs += Math.abs(e); bias += e;
      if (Math.abs(e) <= 5) within++;
    });
    return { n: valid.length, mae: abs / valid.length, bias: bias / valid.length, within5: within / valid.length };
  }

  /* ==================================================================== *
   * HistoryView
   * ==================================================================== */
  function HistoryView(els, store) {
    this.els = els;
    this.store = store;
    this.tab = 'sessions';
    var self = this;
    Array.prototype.forEach.call(els.tabs, function (btn) {
      btn.addEventListener('click', function () { self.setTab(btn.getAttribute('data-tab')); });
    });
    els.list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-del'));
      if (btn.classList.contains('confirm')) {
        store.deleteSession(id).then(function () { self.refresh(); });
      } else {
        btn.classList.add('confirm');
        btn.textContent = 'CONFIRM';
        setTimeout(function () { btn.classList.remove('confirm'); btn.textContent = 'DEL'; }, 2500);
      }
    });
    els.exportBtn.addEventListener('click', function () {
      exportCsv(store).catch(function (err) { console.warn(err); });
    });
    els.clearBtn.addEventListener('click', function () {
      if (els.clearBtn.classList.contains('confirm')) {
        els.clearBtn.classList.remove('confirm');
        els.clearBtn.textContent = 'CLEAR ALL';
        store.clearAll().then(function () { self.refresh(); });
      } else {
        els.clearBtn.classList.add('confirm');
        els.clearBtn.textContent = 'TAP AGAIN TO ERASE';
        setTimeout(function () { els.clearBtn.classList.remove('confirm'); els.clearBtn.textContent = 'CLEAR ALL'; }, 3000);
      }
    });
  }

  HistoryView.prototype.setTab = function (tab) {
    this.tab = tab;
    var els = this.els;
    Array.prototype.forEach.call(els.tabs, function (b) { b.classList.toggle('is-active', b.getAttribute('data-tab') === tab); });
    els.paneSessions.hidden = tab !== 'sessions';
    els.paneTrends.hidden = tab !== 'trends';
    els.paneAccuracy.hidden = tab !== 'accuracy';
    this._draw();
  };

  HistoryView.prototype.refresh = function () {
    var self = this;
    return Promise.all([this.store.listSessions(), this.store.listReferences()]).then(function (res) {
      self.sessions = res[0];
      self.refs = res[1];
      self._renderList();
      self._draw();
    });
  };

  HistoryView.prototype._renderList = function () {
    var els = this.els, list = this.sessions || [];
    els.empty.hidden = list.length > 0;
    els.count.textContent = list.length + (list.length === 1 ? ' SESSION' : ' SESSIONS');
    els.list.innerHTML = list.map(function (s) {
      var badge = s.mode === 'coach' ? 'BREATHE' : s.mode === 'finger' ? 'FINGER' : 'FACE';
      var metrics = [
        '<span><b>' + esc(s.avgBpm) + '</b> BPM</span>',
        s.resp !== null ? '<span><b>' + esc(s.resp) + '</b> BR/MIN</span>' : '',
        s.stress !== null ? '<span>STRESS <b>' + esc(s.stress) + '</b></span>' : '',
        s.coach ? '<span>SYNC <b>' + esc(s.coach.sync) + '%</b></span>' : '',
        s.blink !== null ? '<span>BLINK <b>' + esc(s.blink) + '</b></span>' : ''
      ].join('');
      return '<li class="hist-item">' +
        '<div class="hist-row"><span class="hist-date">' + esc(fmtDate(s.start)) + '</span>' +
        '<span class="hist-badge mode-' + esc(s.mode) + '">' + badge + '</span>' +
        '<span class="hist-dur">' + esc(fmtDur(s.duration)) + '</span>' +
        '<button class="hist-del" type="button" data-del="' + esc(s.id) + '">DEL</button></div>' +
        '<div class="hist-metrics">' + metrics + '</div>' +
        '<div class="hist-sub">RANGE ' + esc(s.minBpm) + '–' + esc(s.maxBpm) + ' · QUALITY ' + esc(Math.round((s.avgConf || 0) * 100)) + '%' +
        (s.rmssd ? ' · RMSSD ' + esc(s.rmssd) + 'ms' : '') + (s.tension !== null ? ' · TENSION ' + esc(s.tension) : '') + '</div>' +
        '</li>';
    }).join('');
  };

  HistoryView.prototype._draw = function () {
    if (this.tab === 'trends') this._drawTrends();
    if (this.tab === 'accuracy') this._drawAccuracy();
  };

  HistoryView.prototype._drawTrends = function () {
    var list = (this.sessions || []).slice(0, 40).reverse();
    drawTrend(this.els.trendHr, list.map(function (s) { return { x: s.start, y: s.avgBpm }; }), { label: 'AVG HEART RATE', unit: 'BPM', color: [0, 240, 255] });
    drawTrend(this.els.trendResp, list.filter(function (s) { return s.resp !== null; }).map(function (s) { return { x: s.start, y: s.resp }; }), { label: 'BREATHING RATE', unit: '/MIN', color: [61, 255, 168] });
    drawTrend(this.els.trendStress, list.filter(function (s) { return s.stress !== null; }).map(function (s) { return { x: s.start, y: s.stress }; }), { label: 'STRESS INDEX', unit: '', color: [255, 176, 0], yMin: 0, yMax: 100 });
  };

  HistoryView.prototype._drawAccuracy = function () {
    var refs = this.refs || [], els = this.els;
    var st = accuracyStats(refs);
    if (!st) {
      els.accStats.innerHTML = '<p class="hist-note">No reference readings yet. While scanning, tap <b>REF</b> and enter the heart rate shown on your watch (or counted at your wrist) to measure how accurate the scanner is for you.</p>';
    } else {
      els.accStats.innerHTML =
        '<div class="acc-grid">' +
        '<div><span>READINGS</span><b>' + st.n + '</b></div>' +
        '<div><span>AVG ERROR</span><b>' + st.mae.toFixed(1) + '</b><i>BPM</i></div>' +
        '<div><span>BIAS</span><b>' + (st.bias >= 0 ? '+' : '') + st.bias.toFixed(1) + '</b><i>BPM</i></div>' +
        '<div><span>WITHIN ±5</span><b>' + Math.round(st.within5 * 100) + '</b><i>%</i></div>' +
        '</div>';
    }
    els.accList.innerHTML = refs.slice(0, 30).map(function (r) {
      var e = r.appBpm > 0 ? r.appBpm - r.refBpm : null;
      return '<li><span>' + esc(fmtDate(r.time)) + '</span><span>' + esc(String(r.source).toUpperCase()) + '</span>' +
        '<span>REF <b>' + esc(r.refBpm) + '</b></span><span>APP <b>' + (r.appBpm > 0 ? esc(Math.round(r.appBpm)) : '--') + '</b></span>' +
        '<span class="' + (e !== null && Math.abs(e) > 5 ? 'bad' : 'good') + '">' + (e === null ? '--' : (e >= 0 ? '+' : '') + e.toFixed(1)) + '</span></li>';
    }).join('');
    drawScatter(els.accPlot, refs.filter(function (r) { return r.appBpm > 0; }));
  };

  /* ---- charts ---------------------------------------------------------- */
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  function drawTrend(canvas, pts, opt) {
    var S = fitCanvas(canvas), ctx = S.ctx, W = S.w, H = S.h, c = opt.color;
    ctx.clearRect(0, 0, W, H);
    var padL = 30, padR = 8, padT = 18, padB = 14;
    ctx.font = '600 9px ' + FONT;
    ctx.fillStyle = rgba(c, 0.9);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(opt.label, 0, 0);
    if (!pts.length) {
      ctx.fillStyle = 'rgba(170,225,235,0.5)';
      ctx.textAlign = 'center';
      ctx.fillText('NO DATA YET', W / 2, H / 2);
      return;
    }
    var ys = pts.map(function (p) { return p.y; });
    var yMin = opt.yMin !== undefined ? opt.yMin : Math.floor(Math.min.apply(null, ys) - 3);
    var yMax = opt.yMax !== undefined ? opt.yMax : Math.ceil(Math.max.apply(null, ys) + 3);
    if (yMax - yMin < 4) { yMax += 2; yMin -= 2; }
    var last = pts[pts.length - 1];
    ctx.textAlign = 'right';
    ctx.fillText(last.y + (opt.unit ? ' ' + opt.unit : ''), W, 0);
    var x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
    function X(i) { return pts.length === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (pts.length - 1); }
    function Y(v) { return y0 - (y0 - y1) * (v - yMin) / (yMax - yMin); }
    ctx.strokeStyle = 'rgba(0,240,255,0.1)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(170,225,235,0.5)';
    ctx.textBaseline = 'middle';
    for (var g = 0; g <= 2; g++) {
      var v = yMin + (yMax - yMin) * g / 2, gy = Y(v);
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
      ctx.fillText(String(Math.round(v)), x0 - 4, gy);
    }
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(X(i), Y(p.y)); else ctx.lineTo(X(i), Y(p.y)); });
    ctx.strokeStyle = rgba(c, 0.25); ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = rgba(c, 0.95); ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = rgba(c, 1);
    pts.forEach(function (p, i) { ctx.beginPath(); ctx.arc(X(i), Y(p.y), 2.2, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = 'rgba(170,225,235,0.5)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDate(pts[0].x).slice(5, 10), x0, H);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDate(last.x).slice(5, 10), x1, H);
  }

  function drawScatter(canvas, refs) {
    var S = fitCanvas(canvas), ctx = S.ctx, W = S.w, H = S.h;
    ctx.clearRect(0, 0, W, H);
    var lo = 40, hi = 140;
    refs.forEach(function (r) { lo = Math.min(lo, r.refBpm - 5, r.appBpm - 5); hi = Math.max(hi, r.refBpm + 5, r.appBpm + 5); });
    var pad = 26;
    function P(v, axis) { return axis === 'x' ? pad + (W - pad - 6) * (v - lo) / (hi - lo) : H - pad - (H - pad - 6) * (v - lo) / (hi - lo); }
    ctx.font = '600 9px ' + FONT;
    // ±5 BPM band
    ctx.fillStyle = 'rgba(61,255,168,0.08)';
    ctx.beginPath();
    ctx.moveTo(P(lo, 'x'), P(lo + 5, 'y')); ctx.lineTo(P(hi - 5, 'x'), P(hi, 'y'));
    ctx.lineTo(P(hi, 'x'), P(hi - 5, 'y')); ctx.lineTo(P(lo + 5, 'x'), P(lo, 'y'));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(61,255,168,0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(P(lo, 'x'), P(lo, 'y')); ctx.lineTo(P(hi, 'x'), P(hi, 'y')); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,240,255,0.25)';
    ctx.beginPath(); ctx.moveTo(pad, 6); ctx.lineTo(pad, H - pad); ctx.lineTo(W - 6, H - pad); ctx.stroke();
    ctx.fillStyle = 'rgba(170,225,235,0.6)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('REFERENCE BPM', (W + pad) / 2, H - 2);
    ctx.save(); ctx.translate(9, (H - pad) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle';
    ctx.fillText('APP BPM', 0, 0); ctx.restore();
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillText(String(Math.round(lo)), pad + 2, H - pad + 2);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(hi)), W - 6, H - pad + 2);
    refs.forEach(function (r) {
      var bad = Math.abs(r.appBpm - r.refBpm) > 5;
      ctx.fillStyle = bad ? 'rgba(255,59,92,0.9)' : 'rgba(0,240,255,0.95)';
      ctx.beginPath(); ctx.arc(P(r.refBpm, 'x'), P(r.appBpm, 'y'), 3, 0, Math.PI * 2); ctx.fill();
    });
    if (!refs.length) {
      ctx.fillStyle = 'rgba(170,225,235,0.5)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('NO REFERENCE READINGS', (W + pad) / 2, (H - pad) / 2);
    }
  }

  /* ==================================================================== *
   * ReferenceDialog — "check against your watch"
   * ==================================================================== */
  function ReferenceDialog(els, store, getSnapshot, onSaved) {
    this.els = els;
    this.store = store;
    this.getSnapshot = getSnapshot;
    this.onSaved = onSaved || function () {};
    this.snapshot = null;
    this.timer = null;
    var self = this;
    els.save.addEventListener('click', function () { self._save(); });
    els.timerBtn.addEventListener('click', function () { self._toggleTimer(); });
    els.count.addEventListener('input', function () {
      var c = Number(els.count.value);
      if (c > 0) els.input.value = String(c * 2);
    });
  }

  ReferenceDialog.prototype.open = function () {
    var s = this.snapshot = this.getSnapshot();
    var els = this.els;
    els.msg.textContent = '';
    els.msg.className = 'ref-msg';
    els.input.value = '';
    els.count.value = '';
    els.countRow.hidden = true;
    this._stopTimer();
    els.app.innerHTML = s.bpm > 0
      ? '<b>' + Math.round(s.bpm) + '</b> BPM <i>· QUALITY ' + Math.round(s.conf * 100) + '% · ' + esc(s.mode.toUpperCase()) + '</i>'
      : '<b>--</b> <i>NO READING YET — WAIT FOR A LOCK FIRST</i>';
    this._renderStats();
  };

  ReferenceDialog.prototype.close = function () { this._stopTimer(); };

  ReferenceDialog.prototype._toggleTimer = function () {
    if (this.timer) { this._stopTimer(); return; }
    var els = this.els, self = this, end = Date.now() + 30000;
    els.countRow.hidden = true;
    els.timerBtn.textContent = 'CANCEL';
    els.timerBtn.classList.add('is-active');
    var tick = function () {
      var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      els.timer.textContent = left + 's — COUNT EACH BEAT';
      if (left <= 0) {
        self._stopTimer();
        els.timer.textContent = 'TIME! HOW MANY BEATS?';
        els.countRow.hidden = false;
        els.count.focus();
      }
    };
    tick();
    this.timer = setInterval(tick, 250);
  };

  ReferenceDialog.prototype._stopTimer = function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.els.timerBtn.textContent = 'START 30 s PULSE TIMER';
    this.els.timerBtn.classList.remove('is-active');
    this.els.timer.textContent = '';
  };

  ReferenceDialog.prototype._save = function () {
    var els = this.els, self = this;
    var ref = Number(els.input.value);
    if (!(ref >= 30 && ref <= 220)) {
      els.msg.textContent = 'Enter a reference heart rate between 30 and 220 BPM.';
      els.msg.className = 'ref-msg bad';
      return;
    }
    var s = this.snapshot || this.getSnapshot();
    var rec = {
      time: Date.now(), refBpm: Math.round(ref), source: els.source.value,
      appBpm: s.bpm > 0 ? Math.round(s.bpm * 10) / 10 : 0, appConf: Math.round((s.conf || 0) * 100) / 100, mode: s.mode
    };
    this.store.addReference(rec).then(function () {
      var e = rec.appBpm > 0 ? rec.appBpm - rec.refBpm : null;
      els.msg.textContent = e === null ? 'Saved (no app reading to compare).' : 'Saved · app was ' + (e >= 0 ? '+' : '') + e.toFixed(1) + ' BPM vs reference.';
      els.msg.className = 'ref-msg ' + (e !== null && Math.abs(e) > 5 ? 'bad' : 'good');
      els.input.value = '';
      self._renderStats();
      self.onSaved(rec);
    });
  };

  ReferenceDialog.prototype._renderStats = function () {
    var els = this.els;
    this.store.listReferences().then(function (refs) {
      var st = accuracyStats(refs);
      els.stats.textContent = st
        ? st.n + ' READINGS · AVG ERROR ' + st.mae.toFixed(1) + ' BPM · ' + Math.round(st.within5 * 100) + '% WITHIN ±5'
        : 'NO READINGS YET';
    });
  };

  global.BioHistory = {
    SessionStore: SessionStore,
    SessionRecorder: SessionRecorder,
    HistoryView: HistoryView,
    ReferenceDialog: ReferenceDialog,
    buildCsv: buildCsv,
    accuracyStats: accuracyStats
  };
})(typeof window !== 'undefined' ? window : this);
