// ---------- কুরআন বাংলা — Service Worker ----------
// Strategy:
//  - App shell (html/css/js/icons)   -> cache-first, so the app opens instantly offline
//  - Quran text API (alquran.cloud)  -> network-first, falls back to cache when offline
//  - Reciter audio (islamic.network) -> cache-first; once an ayah is played it is
//                                       saved forever so it can be replayed with no data
//  - Google Fonts                    -> stale-while-revalidate
//
// WHY OFFLINE RELOADS USED TO FAIL (fixed below):
// A service worker's top-level script re-runs from scratch every time the
// browser (re)starts it, which happens on every navigation once it has sat
// idle for a while (browsers kill an idle worker after a short period of
// inactivity — well under a minute). If ANY top-level statement throws
// during that re-run, the whole file aborts right there, and everything
// below it — including the install/activate/fetch listeners that make the
// app work offline — never gets registered; the browser then falls through
// to a plain network request, which fails the instant you're offline.
// That is exactly what was happening: the Firebase Messaging import a few
// lines down reaches across the network to a third-party CDN (gstatic.com)
// on every single restart, offline or not. While the app was already open,
// the worker was still warm in memory from its last successful run, so its
// fetch handler kept serving cached content just fine — losing connectivity
// mid-session doesn't kill an already-running worker. But refreshing after
// being offline for a bit forced a cold start: the Firebase import failed
// with no network, the script aborted before ever reaching
// self.addEventListener('fetch', ...), and the cached shell never got a
// chance to answer. The Firebase section below is now wrapped in try/catch
// so a failure there — offline, gstatic.com blocked by an extension, a
// flaky connection, anything — can only ever cost that one run its push
// notifications, and can never again take down offline mode.
importScripts('./js/data.js');

// ---------- Prayer time push notifications (Firebase Cloud Messaging) ----------
// Handles notifications sent by the server-side script even when the app is
// closed. See the note above: this is deliberately isolated so it can never
// block the offline caching logic that follows it.
try {
  importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');
  importScripts('./js/firebase-config.js');

  firebase.initializeApp(FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'নামাজের সময়';
    const body = (payload.notification && payload.notification.body) || 'নামাজের জন্য প্রস্তুত হোন।';
    self.registration.showNotification(title, {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: (payload.data && payload.data.prayer) || 'prayer-notify'
    });
  });
} catch (err) {
  // Expected whenever this run happens offline — push notifications need a
  // live connection to mean anything anyway, so there's nothing lost here
  // beyond this one worker lifetime, and the next successful run picks
  // Firebase back up automatically. Logged only for debugging.
  console.warn('[sw] Firebase Messaging skipped this run (offline, or gstatic.com unreachable) — offline caching below is unaffected:', err);
}

const KNOWN_CACHES = [SHELL_CACHE_NAME, API_CACHE_NAME, AUDIO_CACHE_NAME, FONT_CACHE_NAME];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME)
      .then((cache) => precacheResilient(cache, APP_SHELL_CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
      // Deliberately AFTER clients.claim(), so it never delays the worker
      // taking control of already-open pages. Best-effort background pass
      // that finishes caching every remaining app file (not just the core
      // reading/listening path) within moments of the first successful
      // visit — see precacheDeferredInBackground() below.
      .then(() => precacheDeferredInBackground())
  );
});

// Allow the page to trigger an immediate activation after an update, and to
// ask the worker to pre-cache a batch of audio URLs (used by the "offline
// download" button so the whole surah gets saved, not just what's played).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CACHE_AUDIO' && Array.isArray(data.urls)) {
    event.waitUntil(cacheAudioBatch(data.urls, data.requestId));
  }
  // The Android app UI (./app/...) asks for its own files to be cached once it has started, so the app opens
  // offline from the next launch on. Same-origin files only.
  if (data.type === 'CACHE_ASSETS' && Array.isArray(data.urls)) {
    event.waitUntil(cacheShellAssets(data.urls));
  }
});

async function cacheShellAssets(urls) {
  try {
    const cache = await caches.open(SHELL_CACHE_NAME);
    for (const u of urls.slice(0, 80)) {
      try {
        const abs = new URL(String(u), self.location.href);
        if (abs.origin !== self.location.origin) continue;
        if (await cache.match(abs.href)) continue;
        const res = await fetch(abs.href, { cache: 'reload' });
        if (res && res.ok) await cache.put(abs.href, res.clone());
      } catch (e) { /* one unreachable file never blocks the rest */ }
    }
  } catch (e) { /* best effort */ }
}

async function cacheAudioBatch(urls, requestId) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  let done = 0;
  for (const url of urls) {
    try {
      const existing = await cache.match(url);
      if (!existing) {
        const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
        if (res) await cache.put(url, res.clone());
      }
    } catch (e) { /* skip failed ayah, continue with the rest */ }
    done++;
    broadcast({ type: 'CACHE_AUDIO_PROGRESS', requestId, done, total: urls.length });
  }
  broadcast({ type: 'CACHE_AUDIO_DONE', requestId, total: urls.length });
}

async function broadcast(msg) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach((c) => c.postMessage(msg));
}

// Caches each file one at a time instead of the atomic caches.addAll() the
// install step used before. addAll() is all-or-nothing — a single
// unreachable file (a transient blip on one CDN request, a renamed file
// that slipped out of sync with this list) used to silently fail the ENTIRE
// precache and leave the app with no offline shell at all, install after
// install. Now one miss is just skipped and logged; everything else still
// gets cached, and the fetch handler's own cache-first fallback picks up
// the missed file the first time it's actually requested.
async function precacheResilient(cache, files) {
  await Promise.all(files.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res && res.ok) await cache.put(url, res.clone());
    } catch (e) {
      console.warn('[sw] precache skipped, will cache on first use instead:', url, e);
    }
  }));
}

// Quietly finishes caching every APP_SHELL_DEFERRED file (auth, admin, AI
// তাফসীর, exam, MFA, Status, hadith, theme builder, and the rest) in the
// background, so the whole app is offline-ready within moments of the
// first successful visit — not just the core shell, and not just whatever
// screens happen to have been opened already. Mirrors how
// js/auto-offline.js already does this for surah audio. Never allowed to
// throw or block activation: any failure here (offline, one file
// unreachable) just means that file waits for the ordinary cache-first
// fetch handler to catch it on first real use instead, exactly as before
// this existed.
async function precacheDeferredInBackground() {
  try {
    const cache = await caches.open(SHELL_CACHE_NAME);
    for (const url of APP_SHELL_DEFERRED) {
      try {
        if (await cache.match(url)) continue;
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (e) { /* offline, or this one file is unreachable right now —
                       cache-first below will still catch it on first use */ }
    }
  } catch (e) { /* never let background pre-caching affect the worker */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Full-page navigations: try the network, otherwise serve the cached
  // shell so the app still opens (to the last-known UI) with zero
  // connectivity. ignoreSearch matters here: launching the installed app
  // from a manifest shortcut (see manifest.json — "./index.html?shortcut=
  // continue" etc.) is a different URL from the plain "./index.html" that
  // got precached, so without it a shortcut launch while offline would miss
  // the cache entirely and fail. Checking caches.match(req) first (also
  // ignoring the query string) means any more specific cached match still
  // wins; caches.match('./index.html') is the guaranteed-to-exist fallback
  // under that.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req, { ignoreSearch: true }).then((cached) =>
          cached || caches.match('./index.html', { ignoreSearch: true })
        )
      )
    );
    return;
  }


const isKnownAudioHost = url.href.startsWith(AUDIO_CDN) ||
    (typeof reciters !== 'undefined' && reciters.some(r => r.audioType === 'surah' && r.surahBase && url.href.startsWith(r.surahBase)));
  if (isKnownAudioHost) {
    event.respondWith(cacheFirstAudio(req));
    return;
  }

  if (url.href.startsWith(API)) {
    event.respondWith(networkFirst(req, API_CACHE_NAME));
    return;
  }

  if (url.href.startsWith(PRAYER_API)) {
    event.respondWith(networkFirst(req, API_CACHE_NAME));
    return;
  }

  if (url.href.startsWith(HADITH_API_BASE)) {
    event.respondWith(networkFirst(req, API_CACHE_NAME));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE_NAME));
    return;
  }

  // Third-party CDN scripts (font-awesome, the QR library, EmailJS, etc.)
  // — stale-while-revalidate so the first successful load is cached and
  // every later use (including fully offline) is instant, instead of only
  // covering cdnjs and leaving jsdelivr/unpkg to hit the network every time.
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com') ||
      url.hostname.endsWith('cdnjs.cloudflare.com') || url.hostname.endsWith('jsdelivr.net') ||
      url.hostname.endsWith('unpkg.com')) {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE_NAME));
    return;
  }
  // Anything else (unexpected third-party requests): just let it go to network.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return cached || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

// Audio is stored keyed by its plain URL (no Range header) so that any later
// Range request for the same ayah is served — and byte-range-sliced — straight
// from the single cached copy by the browser's own Cache Storage implementation.
async function cacheFirstAudio(req) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    // IMPORTANT: do NOT force mode:'cors' here. The reciter CDN does not
    // reliably send Access-Control-Allow-Origin, so a cors-mode fetch fails
    // for every single request (every surah, every reciter) and we'd fall
    // into the catch below every time, which is exactly why playback used
    // to just hang on "loading" forever. no-cors matches how an <audio>
    // element would fetch it directly and returns a playable opaque
    // response even without CORS headers.
    const res = await fetch(req.url, { mode: 'no-cors', credentials: 'omit' });
    // Opaque (no-cors) responses always report status 0 / ok:false, so we
    // can't check res.ok — just cache whatever we got back.
    if (res) cache.put(req.url, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'Offline - অডিও পাওয়া যায়নি' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await networkPromise) || Response.error();
}
