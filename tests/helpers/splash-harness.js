'use strict';
// Shared harness of the browser tests of the Android launch splash (tests/ui/splash.ui.test.js, tests/ui/splash.real.ui.test.js):
// a static server for the repository, the Capacitor native shell simulated, and launch() which opens the REAL app in headless
// Chromium as the Android app. External hosts (Firebase, CDNs) are blocked, so the app runs offline.
//
// The lottie runtime served at /assets/vendor/lottie/lottie_svg.min.js is, by default, the stand-in tests/helpers/lottie-runtime-stub.js;
// with { server: { runtime: 'real' } } it is the real vendored lottie-web (or the file named by SPLASH_REAL_RUNTIME_FILE).
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch (e) { /* optional */ }
const SKIP = pw ? false : 'Playwright is not installed (set PLAYWRIGHT_MODULE or run npm i --no-save playwright)';

const ROOT = path.resolve(__dirname, '..', '..');
const STUB = fs.readFileSync(path.join(ROOT, 'tests', 'helpers', 'lottie-runtime-stub.js'), 'utf8');
const RUNTIME = '/assets/vendor/lottie/lottie_svg.min.js';
const DATA = '/assets/animations/quran-bangla-splash.json';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml' };
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 QuranBanglaApp/1.0.0';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---- the Capacitor native shell, simulated: every plugin call succeeds, the ones the splash cares about are recorded ----
const CAPACITOR = `(function(){
  var rec = window.__native = { splashHide: [], bars: [] };
  var now = function(){ return Math.round(performance.now()); };
  var ok = function(v){ return Promise.resolve(v === undefined ? {} : v); };
  function plugin(name){
    var base = {};
    if(name === 'SplashScreen') base.hide = function(o){ rec.splashHide.push({ t: now(), o: o }); return ok(); };
    if(name === 'SystemBars') base.setStyle = function(o){ rec.bars.push({ t: now(), p: 'SystemBars.setStyle', o: o }); return ok(); };
    if(name === 'EdgeToEdge') base.setBackgroundColor = function(o){ rec.bars.push({ t: now(), p: 'EdgeToEdge.setBackgroundColor', o: o }); return ok(); };
    return new Proxy(base, { get: function(o, k){
      if(k in o) return o[k];
      if(k === 'then' || typeof k !== 'string') return undefined;
      if(k === 'addListener') return function(){ return ok({ remove: function(){ return ok(); } }); };
      return function(){ return ok(); };
    } });
  }
  var cache = {};
  var plugins = new Proxy({}, { get: function(_, n){ return typeof n === 'string' ? (cache[n] || (cache[n] = plugin(n))) : undefined; } });
  window.Capacitor = { getPlatform: function(){ return 'android'; }, isNativePlatform: function(){ return true; }, isPluginAvailable: function(){ return true; }, Plugins: plugins, convertFileSrc: function(u){ return u; } };
})();`;
const MARKS = `window.__tl = [];
window.__mark = function(n){ window.__tl.push([n, Math.round(performance.now())]); };
window.addEventListener('qr:app-ready', function(){ window.__mark('app-ready'); });
window.addEventListener('qr:splash-done', function(){ window.__mark('splash-done'); });`;

// ---- a static server for the repository; the lottie runtime is always the stand-in ----
function serve(opts) {
  opts = opts || {};
  const hits = [];
  const runtimeSource = () => (opts.runtime === 'real'
    ? fs.readFileSync(process.env.SPLASH_REAL_RUNTIME_FILE || path.join(ROOT, 'assets', 'vendor', 'lottie', 'lottie_svg.min.js'))
    : STUB);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    hits.push(p);
    const send = (code, body, type) => { res.writeHead(code, { 'content-type': type || 'text/plain', 'cache-control': 'no-store' }); res.end(body); };
    const go = () => {
      if ((opts.missing || []).includes(p)) return send(404, 'not found');
      if (p === RUNTIME) return send(200, runtimeSource(), 'application/javascript');
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, 'not found');
      send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
    };
    const wait = (opts.delay || {})[p];
    if (wait) setTimeout(go, wait); else go();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, hits, close: () => new Promise((r) => server.close(r))
  })));
}


async function launch(browser, o) {
  o = o || {};
  const srv = await serve(o.server);
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: o.userAgent || ANDROID_UA, serviceWorkers: o.serviceWorkers || 'block'
  });
  await ctx.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  if (o.capacitor !== false) await page.addInitScript(CAPACITOR);
  await page.addInitScript('window.__LOTTIE_STUB__ = ' + JSON.stringify(o.stub || {}) + ';');
  await page.addInitScript(MARKS);
  if (o.init) await page.addInitScript(o.init);
  const L = {
    page, ctx, srv, errors,
    open: (url) => page.goto('http://127.0.0.1:' + srv.port + (url || '/index.html'), { waitUntil: 'commit' }),
    done: (timeout) => page.waitForFunction(() => window.QR_PLATFORM && window.QR_PLATFORM.splash && window.QR_PLATFORM.splash.phase === 'done', null, { timeout: timeout || 25000 }),
    phase: (name, timeout) => page.waitForFunction((n) => window.QR_PLATFORM && window.QR_PLATFORM.splash && window.QR_PLATFORM.splash.phase === n, name, { timeout: timeout || 15000 }),
    state: () => page.evaluate(() => {
      const P = window.QR_PLATFORM, S = P && P.splash, nat = window.__native || { splashHide: [], bars: [] };
      return {
        isApp: P && P.isApp, dataPlatform: document.documentElement.getAttribute('data-platform'),
        tl: window.__tl || [], hide: nat.splashHide, bars: nat.bars,
        calls: window.__lottie ? window.__lottie.calls : [], events: window.__lottie ? window.__lottie.events : [],
        info: S && S.info, phase: S && S.phase, holds: S && S.holdsNative, hasSplash: !!S,
        overlay: !!document.getElementById('qa-splash'), style: !!document.getElementById('qa-splash-style'),
        body: getComputedStyle(document.body).visibility, appReady: !!(P && P.ready)
      };
    }),
    close: async () => { await ctx.close(); await srv.close(); }
  };
  return L;
}

module.exports = { pw, SKIP, ROOT, RUNTIME, DATA, ANDROID_UA, DESKTOP_UA, serve, launch };
