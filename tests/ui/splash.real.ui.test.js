'use strict';
// REAL lottie-web verification of the Android launch splash.
//
//   node --test tests/ui/splash.real.ui.test.js     (needs `playwright` + Chromium, and the vendored runtime)
//
// tests/ui/splash.ui.test.js proves the start-up choreography against a stand-in for lottie-web. THIS file runs the same real
// app with the REAL vendored runtime (assets/vendor/lottie/lottie_svg.min.js, put there by android-build/vendor-lottie.mjs or the
// "Vendor Lottie runtime" workflow) and checks what the user actually sees: that the supplied animation is rendered, plays once
// at 1x, draws the logo, fills it, reveals the wordmark, keeps its colours and position, and is not distorted - by reading the
// rendered SVG back pixel by pixel. It skips itself while the runtime is not vendored.
//
//   SPLASH_FRAMES_DIR=/some/dir   keeps PNG screenshots of the frames (the workflow uploads them as an artifact)
//   SPLASH_REAL_RUNTIME_FILE=...  use another runtime file (used to dry-run this file against a stand-in)
//
// Pixel regions are in composition pixels (1080 x 1920) and come from the geometry of the supplied animation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../helpers/splash-harness');
const { pw, SKIP, ROOT } = H;

const RUNTIME_FILE = process.env.SPLASH_REAL_RUNTIME_FILE || path.join(ROOT, 'assets', 'vendor', 'lottie', 'lottie_svg.min.js');
const HAS_RUNTIME = fs.existsSync(RUNTIME_FILE);
const SKIP_ALL = SKIP || (HAS_RUNTIME ? false : 'the real lottie-web runtime is not vendored yet (run the "Vendor Lottie runtime" workflow or node android-build/vendor-lottie.mjs)');
const FRAMES_DIR = process.env.SPLASH_FRAMES_DIR || '';
const ANIMATION = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'animations', 'quran-bangla-splash.json'), 'utf8'));

const LOGO = [190, 600, 890, 1200];     // composition px: the logo block
const WORD = [280, 1250, 800, 1360];    // composition px: the "Quran Bangla" wordmark

let browser = null;
test.before(async () => {
  if (!pw || SKIP_ALL) return;
  try { browser = await pw.chromium.launch(); } catch (e) { browser = null; }
});
test.after(async () => { if (browser) await browser.close(); });

const opts = (extra) => Object.assign({ skip: SKIP_ALL, timeout: 90000 }, extra);
const guard = (t) => { if (!browser) { t.skip('Chromium could not be launched'); return false; } return true; };
// the app UI is held back, so the overlay (and the last animation frame) stays on screen after the animation has finished
const HOLD = { runtime: 'real', delay: { '/app/js/boot.js': 12000 } };
// samples what the runtime reports on every animation frame, from the very start of the page
const SAMPLER = `window.__samples = [];
(function tick(){
  var l = window.lottie, items = (l && l.getRegisteredAnimations) ? l.getRegisteredAnimations() : [];
  if(items.length) window.__samples.push([Math.round(performance.now()), items[0].currentFrame, items[0].isPaused ? 1 : 0, items.length]);
  var S = window.QR_PLATFORM && window.QR_PLATFORM.splash;
  if(!(S && S.phase === 'done')) requestAnimationFrame(tick);
})();`;
// reads the overlay's SVG back as pixels (1/4 scale) and counts the non-white / green pixels in each region
const RASTER = `async function(regions){
  var svg = document.querySelector('#qa-splash svg');
  var items = window.lottie.getRegisteredAnimations ? window.lottie.getRegisteredAnimations() : [];
  var before = items.length ? items[0].currentFrame : null;
  var clone = svg.cloneNode(true);
  clone.removeAttribute('style'); clone.setAttribute('width', 1080); clone.setAttribute('height', 1920);
  if(!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  var img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  await img.decode();
  var W = 270, Hh = 480, c = document.createElement('canvas'); c.width = W; c.height = Hh;
  var g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, Hh); g.drawImage(img, 0, 0, W, Hh);
  var d = g.getImageData(0, 0, W, Hh).data, out = { frame: before, frameAfter: items.length ? items[0].currentFrame : null, regions: {} };
  var minx = W, maxx = -1, miny = Hh, maxy = -1;
  for(var y = 0; y < Hh; y++) for(var x = 0; x < W; x++){ var i = (y * W + x) * 4; if(d[i] < 235 || d[i+1] < 235 || d[i+2] < 235){ if(x < minx) minx = x; if(x > maxx) maxx = x; if(y < miny) miny = y; if(y > maxy) maxy = y; } }
  out.bbox = maxx < 0 ? null : [minx * 4, miny * 4, (maxx + 1) * 4, (maxy + 1) * 4];
  Object.keys(regions).forEach(function(k){
    var r = regions[k], n = 0, green = 0;
    for(var y = Math.floor(r[1] / 4); y < Math.ceil(r[3] / 4); y++) for(var x = Math.floor(r[0] / 4); x < Math.ceil(r[2] / 4); x++){
      var i = (y * W + x) * 4, R = d[i], G = d[i+1], B = d[i+2];
      if(R < 235 || G < 235 || B < 235){ n++; if(G > R + 40) green++; }
    }
    out.regions[k] = { nonWhite: n, green: green };
  });
  return out;
}`;
const raster = (L) => L.page.evaluate(`(${RASTER})(${JSON.stringify({ logo: LOGO, word: WORD })})`);
const frameAtLeast = (L, n) => L.page.waitForFunction((f) => { const a = window.lottie.getRegisteredAnimations()[0]; return !!a && a.currentFrame >= f; }, n, { polling: 'raf', timeout: 20000 });
const shot = async (L, name) => { if (FRAMES_DIR) { fs.mkdirSync(FRAMES_DIR, { recursive: true }); await L.page.screenshot({ path: path.join(FRAMES_DIR, name + '.png') }); } };

test('the real runtime plays the supplied animation: once, at 1x, from frame 0 to the end, and the splash uses it', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await H.launch(browser, { server: { runtime: 'real' }, init: SAMPLER });
  try {
    await L.open(); await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'lottie', 'the animation played (not the static fallback): ' + (st.info.reason || ''));
    assert.ok(st.info.completeMs - st.info.playMs >= 2900 && st.info.completeMs - st.info.playMs <= 4500, `the animation took ${st.info.completeMs - st.info.playMs} ms (3.2 s expected)`);
    t.diagnostic(`runtime ${fs.statSync(RUNTIME_FILE).size} bytes; splash start ${st.info.startMs} ms, assets ${st.info.assetsMs}, first frame ${st.info.firstFrameMs}, play ${st.info.playMs}, complete ${st.info.completeMs}, leave ${st.info.leaveMs}`);
    const samples = await L.page.evaluate(() => window.__samples);
    if (!samples.length) return t.diagnostic('lottie.getRegisteredAnimations() is not available - frame sampling skipped');
    assert.equal(Math.max(...samples.map((s) => s[3])), 1, 'one animation instance only');
    const frames = samples.map((s) => s[1]);
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i] >= frames[i - 1], 'the frame number never goes backwards - no replay, no loop');
    assert.ok(frames[0] <= 1, 'starts at frame 0 (first sample ' + frames[0] + ')');
    assert.ok(Math.max(...frames) >= ANIMATION.op - 2, 'reaches the last frame (' + Math.max(...frames) + ' of ' + (ANIMATION.op - 1) + ')');
    const run = samples.filter((s) => s[2] === 0 && s[1] >= 10 && s[1] <= 90);                 // playing, away from the ends
    assert.ok(run.length > 10, 'enough samples while playing');
    const fps = (run[run.length - 1][1] - run[0][1]) / ((run[run.length - 1][0] - run[0][0]) / 1000);
    assert.ok(fps > 27 && fps < 33, `plays at 1x speed: ${fps.toFixed(1)} frames/s (30 expected)`);
  } finally { await L.close(); }
});

test('the real runtime is initialised as intended: svg renderer, no loop, no autoplay, aspect ratio kept, runtime version = pinned version', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await H.launch(browser, { server: HOLD });
  try {
    await L.open(); await L.phase('ready');
    const m = await L.page.evaluate(() => {
      const svg = document.querySelector('#qa-splash svg'), a = window.lottie.getRegisteredAnimations ? window.lottie.getRegisteredAnimations()[0] : null;
      return {
        version: window.lottie.version, viewBox: svg.getAttribute('viewBox'), par: svg.getAttribute('preserveAspectRatio'),
        item: a ? { loop: a.loop, playSpeed: a.playSpeed, totalFrames: a.totalFrames, frameRate: a.frameRate, renderer: a.animType || a.renderer && a.renderer.rendererType } : null
      };
    });
    assert.equal(m.viewBox, '0 0 1080 1920');
    assert.equal(m.par, 'xMidYMid meet');
    if (fs.existsSync(path.join(ROOT, 'assets/vendor/lottie/VERSION.json')) && m.version) assert.equal(m.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/vendor/lottie/VERSION.json'), 'utf8')).version);
    if (m.item) {
      assert.equal(m.item.loop, false);
      assert.equal(m.item.playSpeed, 1);
      assert.equal(m.item.totalFrames, ANIMATION.op - ANIMATION.ip);
      assert.equal(m.item.frameRate, ANIMATION.fr);
      assert.equal(m.item.renderer, 'svg');
    }
  } finally { await L.close(); }
});

test('the frames look like the design: blank start, logo drawn, logo filled, wordmark revealed, final frame held', opts({ timeout: 120000 }), async (t) => {
  if (!guard(t)) return;
  const L = await H.launch(browser, { server: HOLD, viewport: { width: 412, height: 915 } });
  try {
    await L.open(); await L.phase('ready');
    const first = await raster(L);
    await shot(L, 'frame-00-first');
    assert.ok(first.regions.logo.nonWhite <= 600 && first.regions.word.nonWhite <= 20, `the first frame is (almost) blank white: ${JSON.stringify(first.regions)}`);

    await frameAtLeast(L, 36);
    const drawn = await raster(L);
    await shot(L, 'frame-36-logo-drawn');
    assert.ok(drawn.regions.logo.nonWhite >= 3000, `the logo has been drawn: ${JSON.stringify(drawn.regions)}`);
    if (drawn.frameAfter === null || drawn.frameAfter < 46) assert.ok(drawn.regions.word.nonWhite <= 100, 'the wordmark has not appeared yet: ' + JSON.stringify(drawn.regions));

    await frameAtLeast(L, 64);
    const wordmark = await raster(L);
    await shot(L, 'frame-64-wordmark');
    assert.ok(wordmark.regions.word.nonWhite >= 300, 'the wordmark is revealed: ' + JSON.stringify(wordmark.regions));

    await L.phase('held');
    await L.page.waitForTimeout(200);
    const last = await raster(L);
    await shot(L, 'frame-final');
    t.diagnostic('final frame: ' + JSON.stringify(last.regions) + ' bbox ' + JSON.stringify(last.bbox));
    assert.ok(last.regions.logo.nonWhite >= 8000, 'the logo is filled: ' + JSON.stringify(last.regions));
    assert.ok(last.regions.word.nonWhite >= 500, 'the wordmark is complete: ' + JSON.stringify(last.regions));
    assert.ok(last.regions.logo.green / last.regions.logo.nonWhite >= 0.9, 'the logo is green');
    assert.ok(last.regions.word.green / last.regions.word.nonWhite >= 0.6, 'the wordmark is green');
    // position and proportions: everything inside the logo + wordmark block, centred on the composition's vertical axis
    const [x0, y0, x1, y1] = last.bbox;
    assert.ok(Math.abs(x0 - 200) <= 16 && Math.abs(x1 - 880) <= 16, `horizontal extent ${x0}..${x1} (200..880 expected)`);
    assert.ok(Math.abs(y0 - 608) <= 16 && Math.abs(y1 - 1340) <= 20, `vertical extent ${y0}..${y1} (608..1340 expected)`);
    assert.ok(Math.abs((x0 + x1) / 2 - 540) <= 10, 'centred horizontally');
    const still = await raster(L);
    assert.deepEqual(still.regions, last.regions, 'the final frame stays as it is (no loop, no replay)');
  } finally { await L.close(); }
});

test('the colours are the original ones, and there are no gradients, glows, shadows, images or text', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await H.launch(browser, { server: HOLD });
  try {
    await L.open(); await L.phase('held');
    const dom = await L.page.evaluate(() => {
      const svg = document.querySelector('#qa-splash svg'), colors = new Set();
      svg.querySelectorAll('*').forEach((e) => ['fill', 'stroke'].forEach((a) => { const v = e.getAttribute(a); if (v && v !== 'none') colors.add(v.replace(/\s+/g, '').toLowerCase()); }));
      return { colors: [...colors], extras: svg.querySelectorAll('linearGradient, radialGradient, filter, feGaussianBlur, feDropShadow, feColorMatrix, image, text, foreignObject, animate, animateTransform').length };
    });
    const expected = new Set();
    const walk = (list) => (list || []).forEach((it) => {
      if ((it.ty === 'fl' || it.ty === 'st') && it.c && Array.isArray(it.c.k) && typeof it.c.k[0] === 'number') expected.add('rgb(' + it.c.k.slice(0, 3).map((v) => Math.round(v * 255)).join(',') + ')');
      if (it.it) walk(it.it);
    });
    ANIMATION.layers.forEach((l) => { walk(l.shapes); if (l.ty === 1) expected.add(String(l.sc).toLowerCase()); });
    const near = (a, b) => { const pa = /rgb\((\d+),(\d+),(\d+)\)/.exec(a), pb = /rgb\((\d+),(\d+),(\d+)\)/.exec(b); return pa && pb ? [1, 2, 3].every((i) => Math.abs(pa[i] - pb[i]) <= 1) : a === b; };
    for (const c of dom.colors) assert.ok([...expected].some((e) => near(c, e)), `unexpected colour ${c} (the animation has ${[...expected].join(' ')})`);
    for (const e of expected) assert.ok(dom.colors.some((c) => near(c, e)) || e === '#ffffff', `the original colour ${e} is missing`);
    assert.equal(dom.extras, 0, 'no gradient / filter / image / text / animation elements in the SVG');
  } finally { await L.close(); }
});

test('the splash with the real runtime also starts without any connection (service-worker cache)', opts({ timeout: 150000 }), async (t) => {
  if (!guard(t)) return;
  const L = await H.launch(browser, { serviceWorkers: 'allow', server: { runtime: 'real' } });
  try {
    await L.open(); await L.done();
    await L.page.evaluate(() => navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => true));
    let missing = ['(not checked yet)'];
    for (let i = 0; i < 120 && missing.length; i++) {
      missing = await L.page.evaluate(async () => {
        const P = window.QR_PLATFORM, out = [];
        for (const u of [].concat(P.styles, P.scripts, [P.splash.files.script, P.splash.files.runtime, P.splash.files.data])) if (!(await caches.match(u))) out.push(u);
        return out;
      });
      if (missing.length) await L.page.waitForTimeout(500);
    }
    assert.deepEqual(missing, []);
    await L.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await L.ctx.setOffline(true);                      // from here on nothing can reach the server: what plays comes from the cache
    await L.page.reload({ waitUntil: 'commit' });
    await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'lottie', 'the real animation played offline');
  } finally { await L.close(); }
});
