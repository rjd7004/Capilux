/*!
 * Bio-Radar rPPG — sw.js
 * Offline-capable service worker.
 *   • App shell: pre-cached, served stale-while-revalidate (navigations: network-first).
 *     Shell fetches bypass the HTTP cache (GitHub Pages sends max-age=600), so a new
 *     deployment is never pre-cached from stale copies.
 *   • MediaPipe runtime (jsDelivr) + face-landmarker model (Google Storage): version-pinned
 *     URLs → cache-first, so after the first successful launch the scanner works offline.
 */
'use strict';

var VERSION = 'v1.1.1';
var SHELL_CACHE = 'bioradar-shell-' + VERSION;
var RUNTIME_CACHE = 'bioradar-runtime-v1'; // immutable CDN assets survive app updates

var SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './rppg-processor.js',
  './respiration.js',
  './face-metrics.js',
  './hud-renderer.js',
  './history.js',
  './coach.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

var CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) {
        return cache.addAll(SHELL_ASSETS.map(function (url) { return new Request(url, { cache: 'reload' }); }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== RUNTIME_CACHE && key.indexOf('bioradar-') === 0) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isCacheable(response) {
  return response && (response.ok || response.type === 'opaque');
}

function cacheFirst(request) {
  return caches.open(RUNTIME_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (isCacheable(response)) cache.put(request, response.clone());
        return response;
      });
    });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      var network = fetch(request, { cache: 'no-cache' }).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(function () { return hit || Response.error(); });
      return hit || network;
    });
  });
}

function networkFirstNavigation(request) {
  return fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function (cache) { cache.put('./index.html', copy); });
    }
    return response;
  }).catch(function () {
    return caches.match('./index.html', { ignoreSearch: true }).then(function (hit) {
      return hit || caches.match('./');
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
