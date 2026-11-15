// ---------- Android app UI · Lottie launch splash ----------
// The animated launch screen of the Android app. This file is the ONLY place that knows about the animation; the rest of
// the app talks to it through window.QR_PLATFORM.splash (created by js/platform.js).
//
//   Website (normal browser) -> this file is never requested: js/platform.js stops before it gets here.
//   Android app              -> js/platform.js injects this script at the very start of a launch (NOT through APP_SCRIPTS,
//                               which only run after DOMContentLoaded) and keeps the native splash screen on until the
//                               first Lottie frame is painted.
//
// Sequence
//   1. a full-screen white overlay (#qa-splash) is created; the Lottie runtime and the animation JSON load in parallel
//   2. lottie-web (SVG renderer) renders frame 0 into the overlay
//   3. once that first frame is on screen, the native splash is released (SplashScreen.hide, through platform.js) and the
//      animation plays ONCE at 1x, from frame 0 (it starts after the native fade, so no frame is hidden under it)
//   4. the overlay fades out only when BOTH conditions are met: the animation has finished AND the app UI is ready
//      (QR_PLATFORM.ready / "qr:app-ready") - whichever comes last. The app UI under it is already painted by then.
//
// When anything goes wrong (runtime or JSON missing, init error, no first frame in time, slow connection) the splash switches
// to a static brand splash (icons/icon-512.png on white) that also waits for the app UI - or is skipped when the app UI is
// already up. Timers guarantee that the overlay can never stay on screen for good; platform.js has a last-resort timer of
// its own in case this file misbehaves.
//
// Nothing here touches Firebase, storage, the network layer of the app or the app's own CSS: the overlay lives directly
// under <html> with an id selector, and is removed (with its <style>) when it is done.
(function(){
  'use strict';
  var w = window, d = document, root = d.documentElement;
  var P = w.QR_PLATFORM;
  var S = P && P.splash;
  // Only in the app, only once per document, and never after platform.js has given up waiting for this script.
  if(!P || !P.isApp || !S || S.started || S.gaveUp) return;
  S.started = true;

  var FILES = S.files || {};
  var RUNTIME_URL = FILES.runtime || 'assets/vendor/lottie/lottie_svg.min.js';
  var DATA_URL = FILES.data || 'assets/animations/quran-bangla-splash.json';
  var FALLBACK_URL = FILES.fallback || 'icons/icon-512.png';

  // All times in ms.
  var T = {
    assets: 4500,      // the runtime + the JSON must be in by then (slow connection -> static splash instead)
    firstFrame: 2500,  // lottie-web must have the first frame in the DOM this long after it was started
    nativeFade: 240,   // the native splash fades out in 180 ms (platform.js hideSplash); the animation starts after it
    animGrace: 2500,   // beyond the animation's own length, after this the animation counts as finished anyway
    fallbackMin: 800,  // the static splash stays at least this long (no flash)
    imgWait: 1500,     // the static splash image must be painted within this time
    leave: 240,        // fade-out of the overlay (also the CSS transition)
    hardCap: 14000     // the overlay is removed after this, whatever happened (platform.js reloads at 12 s if the app never starts)
  };

  var WHITE = '#FFFFFF';
  var CSS =
    '#qa-splash{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;box-sizing:border-box;margin:0;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);' +
    'display:flex;align-items:center;justify-content:center;overflow:hidden;background:' + WHITE + ';visibility:visible;opacity:1;' +
    'touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;' +
    'transition:opacity ' + T.leave + 'ms ease-out;}' +
    '#qa-splash.qa-splash--leaving{opacity:0;pointer-events:none;}' +
    '#qa-splash .qa-splash__stage{display:flex;align-items:center;justify-content:center;width:100%;height:100%;}' +
    '#qa-splash .qa-splash__stage>svg{display:block;width:100%;height:100%;}' +
    '#qa-splash .qa-splash__fallback{display:block;width:40vmin;max-width:240px;height:auto;pointer-events:none;-webkit-user-drag:none;}';

  var el = null, stage = null, styleEl = null, anim = null;
  var durationMs = 3200;                 // replaced by the real length (frames / frame rate) once the JSON is in
  var phase = 'loading';                 // loading -> ready -> playing -> held | fallback -> leaving -> done
  var appReady = !!P.ready, animDone = false, finished = false, fellBack = false, nativeReleased = false, barsHeld = false;
  var timers = {};
  var t0 = now();
  var info = S.info = { startMs: Math.round(t0), mode: 'lottie' };

  function now(){ return (w.performance && w.performance.now) ? w.performance.now() : Date.now(); }
  function elapsed(){ return Math.round(now() - t0); }
  function warn(){ try{ console.warn.apply(console, ['[splash]'].concat([].slice.call(arguments))); }catch(e){} }
  function setPhase(p){ phase = p; S.phase = p; }
  function later(name, fn, ms){ clearTimeout(timers[name]); timers[name] = setTimeout(function(){ timers[name] = 0; fn(); }, ms); }
  function cancel(name){ clearTimeout(timers[name]); timers[name] = 0; }
  function cancelAll(){ Object.keys(timers).forEach(cancel); }

  // ---------- system bars ----------
  // The native bars are painted with the app colour; during the (white) splash they are made white too, and the app colour is
  // applied again when the splash leaves. app/js/native.js does not touch the bars while barsHeld is set (it remembers the
  // wanted scheme in S.pendingScheme). Same plugins and values as QRApp.native.setSystemBars; every call is best effort.
  function plugin(name){
    try{
      var c = w.Capacitor;
      if(!c || !c.Plugins) return null;
      if(typeof c.isPluginAvailable === 'function' && !c.isPluginAvailable(name)) return null;
      return c.Plugins[name] || null;
    }catch(e){ return null; }
  }
  function call(p, fn, arg){
    try{ var r = (p && typeof p[fn] === 'function') ? p[fn](arg) : null; if(r && typeof r.catch === 'function') r.catch(function(){}); }catch(e){}
  }
  function paintBars(bg, style){   // style: 'LIGHT' = dark icons for a light surface, 'DARK' = light icons for a dark surface
    call(plugin('SystemBars'), 'setStyle', { style: style });
    call(plugin('EdgeToEdge'), 'setBackgroundColor', { color: bg });
    var st = plugin('StatusBar');
    call(st, 'setStyle', { style: style });
    call(st, 'setBackgroundColor', { color: bg });
  }
  function holdBars(){
    if(barsHeld || !P.isNative) return;
    barsHeld = S.barsHeld = true;
    paintBars(WHITE, 'LIGHT');
  }
  function restoreBars(){
    if(!barsHeld) return;
    barsHeld = S.barsHeld = false;
    var scheme = S.pendingScheme || root.getAttribute('data-qa-scheme') || 'light';
    S.pendingScheme = null;
    var N = w.QRApp && w.QRApp.native;
    if(N && typeof N.setSystemBars === 'function') N.setSystemBars(scheme);
    else paintBars(scheme === 'dark' ? '#0B1513' : '#F6F4EE', scheme === 'dark' ? 'DARK' : 'LIGHT');
  }

  // ---------- native splash ----------
  // Released exactly once, and only when something is painted on top of it (the first Lottie frame, or the static splash).
  function releaseNative(){
    if(nativeReleased) return;
    nativeReleased = true;
    holdBars();                       // white bars first, so nothing flips while the native splash fades
    S.holdsNative = false;            // platform.js markReady() may release it from now on as well
    try{ if(typeof P.hideSplash === 'function') P.hideSplash(); }catch(e){}
  }

  // ---------- overlay ----------
  function build(){
    var stale = d.getElementById('qa-splash');            // never two overlays
    if(stale && stale.parentNode) stale.parentNode.removeChild(stale);
    styleEl = d.createElement('style');
    styleEl.id = 'qa-splash-style';
    styleEl.textContent = CSS;
    (d.head || root).appendChild(styleEl);
    el = d.createElement('div');
    el.id = 'qa-splash';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Quran Bangla');
    stage = d.createElement('div');
    stage.className = 'qa-splash__stage';
    el.appendChild(stage);
    // Directly under <html>, not <body>: the page hides <body> until the app UI is ready (platform.js), and <html> exists
    // from the very first script on.
    root.appendChild(el);
  }

  function teardown(){
    cancelAll();
    w.removeEventListener('qr:app-ready', onAppReady);
    try{ if(anim) anim.destroy(); }catch(e){}
    anim = null;
    if(el && el.parentNode) el.parentNode.removeChild(el);
    if(styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    el = stage = styleEl = null;
    restoreBars();
  }
  function announce(){
    try{ w.dispatchEvent(new CustomEvent('qr:splash-done', { detail: info })); }catch(e){}
  }

  // Leaves immediately (nothing, or nothing worth fading, is on screen).
  function abort(why){
    if(finished) return;
    finished = true;
    info.mode = info.mode === 'lottie' ? 'skipped' : info.mode;
    info.reason = info.reason || String(why);
    S.holdsNative = false;
    teardown();
    setPhase('done');
    try{ if(P.ready && typeof P.hideSplash === 'function') P.hideSplash(); }catch(e){}   // otherwise markReady() releases it
    announce();
  }

  // Leaves with a fade; the app UI (already painted) shows through.
  function leave(){
    if(finished) return;
    finished = true;
    cancelAll();
    setPhase('leaving');
    info.leaveMs = elapsed();
    releaseNative();                  // no-op normally; makes sure the native splash can never outlive the overlay
    restoreBars();
    if(!el){ setPhase('done'); announce(); return; }
    var removed = false;
    function remove(){
      if(removed) return;
      removed = true;
      teardown();
      setPhase('done');
      announce();
    }
    el.addEventListener('transitionend', function(ev){ if(ev.target === el) remove(); });
    later('remove', remove, T.leave + 150);      // transitionend does not fire when animations are switched off: never rely on it alone
    el.classList.add('qa-splash--leaving');
  }

  // The one rule of the whole feature: leave only when the animation is over AND the app UI is ready.
  function maybeFinish(){
    if(finished || !animDone || !appReady) return;
    leave();
  }
  function onAppReady(){ appReady = true; maybeFinish(); }

  // ---------- animation ----------
  function afterPaint(fn){
    var done = false;
    function go(){ if(done) return; done = true; fn(); }
    try{ requestAnimationFrame(function(){ requestAnimationFrame(go); }); }catch(e){}
    setTimeout(go, 250);              // rAF does not run while the WebView is in the background: never wait for it forever
  }

  function init(data){
    if(finished || fellBack || phase !== 'loading') return;
    var lottie = w.lottie || w.bodymovin;
    if(!lottie || typeof lottie.loadAnimation !== 'function') throw new Error('lottie runtime missing');
    if(!data || !data.layers || !(data.w > 0) || !(data.h > 0) || !(data.fr > 0) || !(data.op > data.ip)) throw new Error('animation data invalid');
    durationMs = Math.round((data.op - data.ip) / data.fr * 1000);
    info.assetsMs = elapsed();
    anim = lottie.loadAnimation({
      container: stage,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      animationData: data,
      rendererSettings: { preserveAspectRatio: 'xMidYMid meet' }   // never stretched, always centred
    });
    anim.addEventListener('DOMLoaded', onDomLoaded);
    anim.addEventListener('complete', onComplete);
    anim.addEventListener('data_failed', function(){ fallback('animation data failed'); });
    anim.addEventListener('error', function(){ if(phase === 'playing') forceComplete('render error'); else if(phase === 'loading') fallback('render error'); });
    later('frame', function(){ fallback('no first frame in time'); }, T.firstFrame);
    if(anim.isLoaded) setTimeout(onDomLoaded, 0);   // already in the DOM: do not depend on an event that may have fired before the listener was attached (onDomLoaded runs once)
  }

  var firstFrameQueued = false;
  function onDomLoaded(){
    if(finished || phase !== 'loading' || firstFrameQueued) return;
    firstFrameQueued = true;
    cancel('frame');
    afterPaint(function(){
      if(finished || phase !== 'loading') return;
      setPhase('ready');
      info.firstFrameMs = elapsed();
      releaseNative();
      later('play', play, P.isNative ? T.nativeFade : 0);
    });
  }

  function play(){
    if(finished || phase !== 'ready' || !anim) return;
    setPhase('playing');
    info.playMs = elapsed();
    try{ anim.play(); }catch(e){ forceComplete('play failed'); return; }
    later('anim', function(){ forceComplete('animation did not report completion'); }, durationMs + T.animGrace);
  }

  function onComplete(){
    if(finished || phase !== 'playing') return;
    cancel('anim');
    setPhase('held');                 // the last frame (logo + wordmark) stays; the animation does not loop or replay
    animDone = true;
    info.completeMs = elapsed();
    maybeFinish();
  }

  function forceComplete(reason){
    if(finished || animDone) return;
    warn('animation finished by timer:', reason);
    try{ if(anim) anim.goToAndStop(anim.totalFrames > 1 ? anim.totalFrames - 1 : 0, true); }catch(e){}
    cancel('anim');
    setPhase('held');
    animDone = true;
    info.completeMs = elapsed();
    maybeFinish();
  }

  // ---------- static brand splash (the animation cannot be played) ----------
  function fallback(reason){
    if(finished || fellBack) return;
    fellBack = true;
    var why = String((reason && reason.message) || reason);
    warn('animation unavailable, static splash used:', why);
    info.mode = 'fallback';
    info.reason = why;
    ['assets', 'frame', 'play', 'anim'].forEach(cancel);
    try{ if(anim) anim.destroy(); }catch(e){}
    anim = null;
    var wasShowing = phase === 'ready' || phase === 'playing' || phase === 'held';   // native splash already released
    // Nothing has been shown yet and the app UI is already up: a static splash would only delay it.
    if(!wasShowing && appReady){ abort('static splash not needed, app ready'); return; }
    setPhase('fallback');
    if(stage) stage.textContent = '';
    var img = new Image();
    var settled = false;
    function shown(){
      if(settled || finished) return;
      settled = true; cancel('img');
      releaseNative();
      later('fbmin', function(){ animDone = true; maybeFinish(); }, T.fallbackMin);
    }
    function broken(){
      if(settled || finished) return;
      settled = true; cancel('img');
      if(wasShowing){ animDone = true; maybeFinish(); } else abort('static splash image unavailable');
    }
    img.className = 'qa-splash__fallback';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.onload = function(){ if(img.decode) img.decode().then(shown, shown); else shown(); };
    img.onerror = broken;
    later('img', broken, T.imgWait);
    if(stage) stage.appendChild(img);
    img.src = FALLBACK_URL;
  }

  // ---------- loading ----------
  function loadScript(url){
    return new Promise(function(resolve, reject){
      var s = d.createElement('script');
      s.src = url;
      s.async = true;
      s.setAttribute('data-qa-asset', '1');
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error('failed to load ' + url)); };
      (d.head || root).appendChild(s);
    });
  }
  function loadJson(url){
    return fetch(url, { credentials: 'same-origin' }).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }

  // ---------- offline starts ----------
  // The service worker keeps the splash files (script, runtime, animation) as soon as it is active - not only when the app has
  // been idle for a while (app/js/boot.js asks again then; the worker skips what it already has). So even a very short first
  // session is enough for the next start to work without any connection. Best effort, never blocks anything.
  function keepOffline(){
    try{
      if(!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready.then(function(reg){
        var worker = reg && (reg.active || navigator.serviceWorker.controller);
        if(worker) worker.postMessage({ type: 'CACHE_ASSETS', urls: [FILES.script || 'app/js/splash.js', RUNTIME_URL, DATA_URL] });
      }).catch(function(){});
    }catch(e){}
  }

  // ---------- go ----------
  try{
    w.addEventListener('qr:app-ready', onAppReady);
    if(P.ready) appReady = true;                       // markReady() may have run before this file did
    build();
    later('hard', function(){
      warn('hard time limit reached, splash removed');
      abort('hard time limit');                         // removes the overlay, restores the bars
      try{ if(typeof P.hideSplash === 'function') P.hideSplash(); }catch(e){}
    }, T.hardCap);
    later('assets', function(){ fallback('assets did not arrive in time'); }, T.assets);
    Promise.all([loadScript(RUNTIME_URL), loadJson(DATA_URL)]).then(function(r){
      cancel('assets');
      keepOffline();
      init(r[1]);
    }).catch(function(e){ fallback(e); });
  }catch(e){
    warn('could not start:', e);
    abort('start failed: ' + (e && e.message ? e.message : e));
  }
})();
