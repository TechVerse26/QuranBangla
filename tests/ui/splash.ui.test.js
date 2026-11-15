'use strict';
// Browser tests of the Android launch splash.
//
//   node --test tests/ui/splash.ui.test.js     (needs `playwright` + a Chromium build; PLAYWRIGHT_MODULE=/path/to/playwright if it is global)
//
// What runs: the REAL app (index.html -> js/platform.js -> app/js/*, incl. the app's own boot) in headless Chromium, with the
// Capacitor native shell simulated (Capacitor.getPlatform() = 'android', plugin calls recorded) and app/js/splash.js driving a
// STAND-IN for lottie-web (tests/helpers/lottie-runtime-stub.js). So these tests prove the start-up choreography: what the splash
// waits for, when the native splash is released, how it reacts to failures, that the website is untouched.
//
// What is NOT covered here: the real lottie-web rendering the real animation - that is tests/ui/splash.real.ui.test.js, which runs
// the same app with the vendored runtime (and which the "Vendor Lottie runtime" workflow runs for you) - and Android itself
// (a real device / WebView). External hosts (Firebase, CDNs) are blocked, so the app runs offline.
const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../helpers/splash-harness');
const { pw, SKIP, RUNTIME, DATA, ANDROID_UA, DESKTOP_UA } = H;

let browser = null;
test.before(async () => {
  if (!pw) return;
  try { browser = await pw.chromium.launch(); } catch (e) { browser = null; }
});
test.after(async () => { if (browser) await browser.close(); });

const launch = (o) => H.launch(browser, o);
const at = (st, name) => { const e = st.events.find((x) => x.name === name); return e ? e.t : undefined; };
const mark = (st, name) => { const m = st.tl.find((x) => x[0] === name); return m ? m[1] : undefined; };
const count = (st, name) => st.events.filter((e) => e.name === name).length;
const guard = (t) => { if (!browser) { t.skip('Chromium could not be launched'); return false; } return true; };
const opts = (extra) => Object.assign({ skip: SKIP, timeout: 90000 }, extra);

test('plays once; the native splash is released after the first frame; the overlay waits for the animation when the app is ready first', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { duration: 2200 } });
  try {
    await L.open(); await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'lottie');
    assert.equal(st.hide.length >= 1, true, 'the native splash was released');
    assert.ok(st.hide[0].t >= at(st, 'DOMLoaded'), 'not before the first Lottie frame is rendered');
    assert.ok(at(st, 'play') - st.hide[0].t >= 200, 'the animation starts after the native fade-out, so no frame is hidden under it');
    assert.ok(mark(st, 'app-ready') < at(st, 'complete'), 'precondition: the app UI was ready before the animation finished');
    assert.ok(mark(st, 'splash-done') >= at(st, 'complete'), 'the overlay stayed until the animation finished');
    assert.equal(count(st, 'loadAnimation'), 1, 'initialised once');
    assert.equal(count(st, 'play'), 1, 'played once');
    assert.equal(count(st, 'destroy'), 1, 'destroyed when done');
    assert.deepEqual(st.calls[0], { renderer: 'svg', loop: false, autoplay: false, container: true, w: 1080, h: 1920, fr: 30, ip: 0, op: 96, layers: 4, preserveAspectRatio: 'xMidYMid meet' });
    assert.equal(st.overlay, false); assert.equal(st.style, false);
    assert.equal(st.body, 'visible', 'the app UI is there');
    assert.equal(st.holds, false);
    assert.equal(L.errors.length, 0, 'no page errors: ' + L.errors.join(' | '));
  } finally { await L.close(); }
});

test('system bars: white while the splash is up, the app colour right after; the app cannot flip them in between', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { duration: 2200 } });
  try {
    await L.open(); await L.done();
    const st = await L.state();
    const e2e = st.bars.filter((b) => b.p === 'EdgeToEdge.setBackgroundColor');
    const white = e2e.findIndex((b) => b.o.color === '#FFFFFF');
    assert.ok(white >= 0, 'bars were made white');
    assert.ok(white <= e2e.length - 2, 'and set back afterwards');
    assert.notEqual(e2e[e2e.length - 1].o.color, '#FFFFFF', 'the last word is the app colour');
    assert.ok(e2e[white + 1].t >= at(st, 'complete') - 60, 'nothing touched the bars while the splash was playing');
    assert.ok(st.bars.find((b) => b.p === 'SystemBars.setStyle' && b.o.style === 'LIGHT'), 'dark icons on the white splash');
  } finally { await L.close(); }
});

test('when the animation is faster than the app, the overlay stays until the app UI is ready', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { duration: 300 }, server: { delay: { '/app/js/boot.js': 3500 } } });
  try {
    await L.open(); await L.phase('held');
    await L.page.waitForTimeout(700);
    const mid = await L.state();
    assert.equal(mid.overlay, true, 'still on screen: the app is not ready');
    assert.equal(mid.appReady, false);
    assert.equal(mid.phase, 'held');
    await L.done();
    const st = await L.state();
    assert.ok(at(st, 'complete') < mark(st, 'app-ready'), 'precondition: animation finished first');
    assert.ok(mark(st, 'splash-done') >= mark(st, 'app-ready'), 'left only after the app UI was ready');
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});

for (const [name, server, stub, why] of [
  ['the lottie runtime is missing', { missing: [RUNTIME] }, {}, /failed to load/],
  ['the animation JSON is missing', { missing: [DATA] }, {}, /HTTP 404/],
  ['lottie throws while loading the animation', {}, { mode: 'throw' }, /loadAnimation failed/],
  ['lottie never renders a first frame', {}, { mode: 'neverLoaded' }, /no first frame/]
]) {
  test('fallback: ' + name + ' -> static brand splash, the app still starts', opts(), async (t) => {
    if (!guard(t)) return;
    const L = await launch({ server, stub });
    try {
      await L.open();
      await L.page.waitForSelector('#qa-splash .qa-splash__fallback', { state: 'attached', timeout: 12000 }).catch(() => null);
      const img = await L.page.evaluate(() => { const i = document.querySelector('#qa-splash .qa-splash__fallback'); return i ? { src: i.getAttribute('src'), w: i.naturalWidth } : null; });
      await L.done();
      const st = await L.state();
      assert.equal(st.info.mode, 'fallback');
      assert.match(st.info.reason, why);
      if (img) { assert.equal(img.src, 'icons/icon-512.png'); assert.ok(img.w > 0, 'the brand image really loaded'); }
      assert.ok(st.hide.length >= 1, 'the native splash was released');
      assert.equal(st.overlay, false);
      assert.equal(st.body, 'visible', 'the app UI is reachable');
      assert.equal(st.holds, false);
    } finally { await L.close(); }
  });
}

test('fallback: a slow connection (runtime arrives too late) -> the app is not held up for good, and the late runtime is ignored', opts({ timeout: 60000 }), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ server: { delay: { [RUNTIME]: 6500 } } });
  try {
    await L.open(); await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'fallback');
    assert.match(st.info.reason, /did not arrive in time/);
    assert.ok(st.hide[0].t >= 4400, 'the native splash covered the wait (first release at ' + st.hide[0].t + ' ms)');
    assert.equal(st.body, 'visible');
    await L.page.waitForTimeout(2500);                       // the runtime arrives now
    const late = await L.state();
    assert.equal(late.calls.length, 0, 'a late runtime does not start an animation any more');
    assert.equal(late.overlay, false);
  } finally { await L.close(); }
});

test('an animation that never reports completion is finished by the timer on its last frame', opts({ timeout: 60000 }), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { mode: 'noComplete' } });
  try {
    await L.open(); await L.done(40000);
    const st = await L.state();
    const jump = st.events.find((e) => e.name === 'goToAndStop');
    assert.ok(jump && jump.extra.v === 95 && jump.extra.isFrame === true, 'shows the final frame (logo + wordmark)');
    assert.ok(st.info.completeMs - st.info.playMs >= 5600, 'after the animation length (3.2 s) + grace');
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});

test('a render error while playing ends on the last frame instead of hanging', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { mode: 'renderError' } });
  try {
    await L.open(); await L.done();
    const st = await L.state();
    const jump = st.events.find((e) => e.name === 'goToAndStop');
    assert.ok(jump && jump.extra.v === 95);
    assert.equal(st.body, 'visible');
    assert.equal(st.overlay, false);
  } finally { await L.close(); }
});

test('website: no Lottie code is requested, nothing is created, nothing changes', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ capacitor: false, userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 } });
  try {
    await L.open();
    await L.page.waitForTimeout(2500);
    const st = await L.state();
    assert.equal(st.dataPlatform, 'web');
    assert.equal(st.isApp, false);
    assert.equal(st.hasSplash, false, 'QR_PLATFORM.splash does not exist');
    assert.equal(st.overlay, false); assert.equal(st.style, false);
    const bad = L.srv.hits.filter((h) => /splash|lottie|assets\//i.test(h));
    assert.deepEqual(bad, [], 'no request for the animation, the runtime or the splash script');
    const dom = await L.page.evaluate(() => document.documentElement.outerHTML);
    assert.doesNotMatch(dom, /lottie|qa-splash|quran-bangla-splash/i);
  } finally { await L.close(); }
});

test('the app UI disabled for the session (existing recovery flag) -> no splash either', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ init: "try{sessionStorage.setItem('qa_disabled','1')}catch(e){}" });
  try {
    await L.open();
    await L.page.waitForTimeout(2000);
    const st = await L.state();
    assert.equal(st.isApp, false);
    assert.equal(st.overlay, false);
    assert.deepEqual(L.srv.hits.filter((h) => /splash|lottie|assets\//i.test(h)), []);
    assert.ok(st.hide.length >= 1, 'the native splash is still released by the existing website path');
  } finally { await L.close(); }
});

test('returning from the background does not replay the animation or create a second overlay', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { duration: 400 } });
  try {
    await L.open(); await L.done();
    await L.page.evaluate(() => {
      ['visibilitychange', 'pageshow', 'focus', 'online', 'resume'].forEach((n) => { try { document.dispatchEvent(new Event(n)); window.dispatchEvent(new Event(n)); } catch (e) {} });
    });
    await L.page.waitForTimeout(900);
    const st = await L.state();
    assert.equal(count(st, 'loadAnimation'), 1);
    assert.equal(st.overlay, false);
    assert.equal(L.srv.hits.filter((h) => h === '/app/js/splash.js').length, 1);
  } finally { await L.close(); }
});

test('every fresh application start plays the splash exactly once', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { duration: 300 } });
  try {
    for (let i = 0; i < 3; i++) {
      await L.open(); await L.done();
      const st = await L.state();
      assert.equal(st.info.mode, 'lottie', 'start #' + (i + 1));
      assert.equal(count(st, 'loadAnimation'), 1, 'start #' + (i + 1) + ': one animation');
      assert.equal(count(st, 'play'), 1);
    }
  } finally { await L.close(); }
});

for (const [w, h, name] of [[360, 640, 'small phone'], [412, 915, 'tall phone'], [768, 1024, 'tablet portrait'], [1024, 600, 'landscape']]) {
  test('layout on a ' + name + ' (' + w + 'x' + h + '): full screen, centred, never stretched', opts(), async (t) => {
    if (!guard(t)) return;
    const L = await launch({ viewport: { width: w, height: h }, stub: { duration: 200 }, server: { delay: { '/app/js/boot.js': 6000 } } });
    try {
      await L.open(); await L.phase('held');
      const m = await L.page.evaluate(() => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const ov = document.getElementById('qa-splash'), svg = ov.querySelector('svg');
        return { vp: { w: innerWidth, h: innerHeight }, ov: r(ov), svg: r(svg), box: r(svg.querySelector('#stub-bounds')), par: svg.getAttribute('preserveAspectRatio'), bg: getComputedStyle(ov).backgroundColor, z: getComputedStyle(ov).zIndex, pos: getComputedStyle(ov).position };
      });
      assert.deepEqual([m.ov.x, m.ov.y, m.ov.w, m.ov.h], [0, 0, m.vp.w, m.vp.h], 'covers the whole viewport');
      assert.equal(m.bg, 'rgb(255, 255, 255)');
      assert.equal(m.pos, 'fixed');
      assert.equal(m.par, 'xMidYMid meet');
      const k = Math.min(m.vp.w / 1080, m.vp.h / 1920);        // "meet": one scale for both axes = no distortion
      const near = (a, b) => Math.abs(a - b) <= 1.5;
      assert.ok(near(m.box.w, 1072 * k) && near(m.box.h, 1912 * k), `aspect ratio kept (${m.box.w.toFixed(1)}x${m.box.h.toFixed(1)} vs ${(1072 * k).toFixed(1)}x${(1912 * k).toFixed(1)})`);
      assert.ok(near(m.box.x + m.box.w / 2, m.vp.w / 2) && near(m.box.y + m.box.h / 2, m.vp.h / 2), 'centred');
    } finally { await L.close(); }
  });
}

test('existing recovery still works: when the app UI never starts, the 12 s watchdog reloads into the website UI and the splash is gone', opts({ timeout: 80000 }), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ stub: { duration: 300 }, server: { delay: { '/app/js/boot.js': 40000 } } });
  try {
    await L.open();
    await L.page.waitForFunction(() => { try { return sessionStorage.getItem('qa_disabled') === '1' && window.QR_PLATFORM && window.QR_PLATFORM.isApp === false; } catch (e) { return false; } }, null, { timeout: 40000 });
    await L.page.waitForFunction(() => window.__native && window.__native.splashHide.length >= 1, null, { timeout: 8000 });
    const st = await L.state();
    assert.equal(st.dataPlatform, 'web', 'the plain website UI');
    assert.equal(st.overlay, false, 'no splash left on screen');
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});

test('first launch: the splash files reach the service worker as soon as it is active, long before the app is idle', opts({ timeout: 90000 }), async (t) => {
  if (!guard(t)) return;
  // boot.js is held back, so the app's own "idle" precache cannot be what caches the files; the page is not controlled by a
  // service worker yet (first launch), so its own requests did not go through one either
  const L = await launch({ serviceWorkers: 'allow', stub: { duration: 300 }, server: { delay: { '/app/js/boot.js': 12000 } } });
  try {
    await L.open(); await L.phase('held');
    const none = await L.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    assert.equal(none, 0, 'precondition: no service worker yet');
    // the website registers sw.js once it has loaded; here Firebase is blocked, which cuts that start-up short
    await L.page.evaluate(() => navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => true));
    let missing = ['(not checked yet)'];
    for (let i = 0; i < 30 && missing.length; i++) {
      missing = await L.page.evaluate(async () => {
        const out = [];
        for (const u of ['app/js/splash.js', 'assets/vendor/lottie/lottie_svg.min.js', 'assets/animations/quran-bangla-splash.json']) if (!(await caches.match(u))) out.push(u);
        return out;
      });
      if (missing.length) await L.page.waitForTimeout(400);
    }
    assert.deepEqual(missing, [], 'cached by the service worker');
    const st = await L.state();
    assert.equal(st.appReady, false, 'and the app was still not ready - boot.js idle precache did not do it');
  } finally { await L.close(); }
});

test('cached / offline start: the second launch plays the animation from the service-worker cache', opts({ timeout: 120000 }), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ serviceWorkers: 'allow', stub: { duration: 400 } });
  try {
    await L.open(); await L.done();
    // The website registers sw.js when it has loaded (js/app.js). Here Firebase is blocked, which cuts that start-up short,
    // so the registration is done by hand - exactly what the site does. Everything after that is the real service worker.
    await L.page.evaluate(() => navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => true));
    // boot.js has been waiting for an active service worker to hand it the app UI files and the splash files (CACHE_ASSETS):
    // wait until every one of them is in the cache
    let missing = ['(not checked yet)'];
    for (let i = 0; i < 120 && missing.length; i++) {          // polled from here: Playwright does not await an async page predicate
      missing = await L.page.evaluate(async () => {
        const P = window.QR_PLATFORM;
        const urls = [].concat(P.styles, P.scripts, [P.splash.files.script, P.splash.files.runtime, P.splash.files.data]);
        const out = [];
        for (const u of urls) if (!(await caches.match(u))) out.push(u);
        return out;
      });
      if (missing.length) await L.page.waitForTimeout(500);
    }
    assert.deepEqual(missing, [], 'the service worker cached the app UI files and the splash files');
    await L.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await L.ctx.setOffline(true);                      // from here on nothing can reach the server: what plays comes from the cache
    await L.page.reload({ waitUntil: 'commit' });
    await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'lottie', 'the animation played without any connection');
    assert.equal(st.calls.length, 1);
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});
