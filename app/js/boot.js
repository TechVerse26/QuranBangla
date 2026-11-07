// ---------- Android app UI · boot ----------
// Called once by js/platform.js after every app file has loaded. Order matters:
//   1. wait until the website's own init() has finished (it owns state, storage, Firebase, the audio player),
//      then switch off the website's welcome tours before their timer fires
//   2. theme (light / dark / system) + system bars
//   3. app / build info from the native shell
//   4. compatibility layer (website calls -> app shell)
//   5. build the shell (top bar, bottom navigation, tab screens)
//   6. notifications / announcements / deep-link listeners
//   7. show the first screen (a link the app was opened with, else the reading position of a very recent
//      session, else Home) and release the native splash screen
// A failure in a step that is essential rejects boot(), and platform.js then reloads into the normal website
// UI for that session. Non-essential steps only log a warning.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var NAT = QRApp.native, Nav = QRApp.nav;
  var P = window.QR_PLATFORM || {};
  var RESUME_WINDOW_MS = 30 * 60 * 1000;

  function step(name, fn, essential){
    var p;
    try{ p = Promise.resolve(fn()); }
    catch(e){ p = Promise.reject(e); }
    return p.catch(function(e){
      if(essential){ e = e || new Error('boot step failed'); try{ e.message = name + ': ' + e.message; }catch(x){} throw e; }
      QRApp.warn('boot step failed (continuing):', name, e);
    });
  }
  function withTimeout(promise, ms){
    return Promise.race([Promise.resolve(promise), QRApp.sleep(ms).then(function(){ return undefined; })]);
  }

  // The website's init() is an async IIFE: it awaits IDBKV.init() and then runs all of its set-up synchronously.
  // A reaction registered on the same promise runs after that synchronous part, so state / storage / Firebase /
  // the audio player exist once this resolves.
  function siteReady(){
    var ready = (typeof IDBKV !== 'undefined' && IDBKV && typeof IDBKV.init === 'function') ? IDBKV.init() : Promise.resolve();
    return Promise.resolve(ready).then(function(){ return QRApp.sleep(0); });
  }

  // ---------- reading position of a very recent session ----------
  // Android may end the process of a background app. If the app was in the reader when it was last put in the
  // background (and that was recently), the reader is reopened at the same place; after a normal exit it is not.
  function saveResume(){
    try{
      var top = Nav.top();
      QRApp.prefs.set('resume', { reader: !!(top && top.id === 'reader'), ts: Date.now() });
    }catch(e){}
  }
  function maybeResume(){
    var r = QRApp.prefs.get('resume', null);
    QRApp.prefs.remove('resume');
    if(!r || !r.reader || !(Date.now() - r.ts < RESUME_WINDOW_MS)) return false;
    var pos = QRApp.prefs.get('reader_pos', null);
    if(!pos || !pos.type || !(pos.num >= 1)) return false;
    QRApp.reader.open({ type: pos.type, num: pos.num, surah: pos.surah, ayah: pos.ayah });
    return true;
  }

  // ---------- offline start ----------
  // The website's service worker keeps the website files. The app UI files (and the public policy pages) are asked
  // for once the app has started and is idle, so that the next cold start works without a connection as well.
  // Best effort only: a missing service worker (or an unreachable file) never affects the running app.
  function precacheAppFiles(){
    try{
      if(!('serviceWorker' in navigator)) return;
      var urls = (P.styles || []).concat(P.scripts || [], ['privacy.html', 'terms.html', 'account-deletion.html', 'css/legal.css', 'js/legal.js']);
      navigator.serviceWorker.ready.then(function(reg){
        var worker = (reg && reg.active) || navigator.serviceWorker.controller;
        if(worker) worker.postMessage({ type: 'CACHE_ASSETS', urls: urls });
      }).catch(function(){});
    }catch(e){}
  }

  function wireLifecycle(){
    NAT.onPause(saveResume);
    NAT.onResume(function(){ QRApp.emit('resume'); });
    // leaving the app on purpose (double back at Home) forgets the resume point
    var origExit = NAT.exit;
    NAT.exit = function(){ QRApp.prefs.remove('resume'); return origExit.apply(NAT, arguments); };
  }

  QRApp.boot = function(){
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    document.documentElement.dir = 'ltr';       // the app is left-to-right (Arabic text itself stays right-to-left)

    return siteReady()
      .then(function(){ return step('tours', function(){ QRApp.compat.suppressTours(); }); })
      .then(function(){ return step('theme', function(){ QRApp.theme.init(); }, true); })
      .then(function(){ return step('app info', function(){ return withTimeout(NAT.loadInfo(), 1500); }); })
      .then(function(){ return step('compat', function(){ QRApp.compat.install(); }, true); })
      .then(function(){ return step('shell', function(){ Nav.build(); }, true); })
      .then(function(){ return step('notifications', function(){ QRApp.notify.init(); }); })
      .then(function(){ return step('start', function(){ Nav.start(); }, true); })
      .then(function(){ return step('lifecycle', wireLifecycle); })
      .then(function(){
        return step('launch link', function(){ return withTimeout(QRApp.notify.handleLaunch(), 1500); });
      })
      .then(function(handled){
        if(handled) return;
        return step('resume', maybeResume);
      })
      .then(function(){
        QRApp.ready = true;
        var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        QRApp.bootMs = Math.round(t1 - t0);
        QRApp.log('app UI ready in ' + QRApp.bootMs + ' ms (' + (NAT.info.version || 'dev') + ')');
        QRApp.emit('ready');
        if(P.markReady) P.markReady();
        setTimeout(precacheAppFiles, 4000);
      });
  };
})();
