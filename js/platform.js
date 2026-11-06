// ---------- Platform detection + Android-app UI bootstrap ----------
//
// ONE codebase, TWO presentations:
//
//   * Website (any normal browser)      -> <html data-platform="web">
//       Nothing else happens here. The existing header / bottom-nav / drawer /
//       footer / routes / SEO / responsive layout are completely untouched.
//
//   * Android app (Capacitor native shell, GitHub-built APK / AAB)
//       -> <html data-platform="android-app">
//       The separate app UI layer in /app (own design system, own shell,
//       bottom navigation, toolbars, bottom sheets ...) is loaded on top of
//       the SAME business logic (js/*.js: auth, Firebase, Quran API, audio
//       player, storage, notifications logic ...). The website's own chrome is
//       hidden by the app stylesheet; nothing from /app is ever loaded in a
//       normal browser, so app-only CSS can never leak into the website.
//
// Detection is done through the Capacitor native-platform API
// (Capacitor.isNativePlatform() / getPlatform()), NOT by user-agent sniffing
// alone. Two secondary signals exist so detection is also reliable if the
// native bridge is injected a moment late:
//   - the APK appends the token "QuranBanglaApp/<version>" to the WebView
//     user-agent (android.appendUserAgent in capacitor.config.json), and
//   - "?qa_preview=1" (developer preview) lets the app UI be inspected in a
//     desktop browser / Chrome DevTools device mode. It is stored for the
//     tab session only and is never needed by real users.
//
// Safety net: if the app UI layer fails to start within a few seconds the
// page is reloaded once into the plain website UI for the rest of that app
// session, so a broken app layer can never leave the user with a blank screen.
(function(){
  'use strict';
  if(window.QR_PLATFORM) return;

  var w = window, d = document, root = d.documentElement;
  var APP_UI_VERSION = '1.0.0';
  var BOOT_TIMEOUT_MS = 12000;

  // Files of the Android UI layer. They are listed here (and ONLY here) so the
  // website never references them. Order matters for scripts.
  var APP_STYLES = [
    'app/css/tokens.css',
    'app/css/base.css',
    'app/css/components.css',
    'app/css/screens.css',
    'app/css/legacy.css'
  ];
  var APP_SCRIPTS = [
    'app-config.js',
    'app/js/core.js',
    'app/js/native.js',
    'app/js/ui.js',
    'app/js/data.js',
    'app/js/nav.js',
    'app/js/pickers.js',
    'app/js/reader.js',
    'app/js/search.js',
    'app/js/home.js',
    'app/js/quran.js',
    'app/js/discover.js',
    'app/js/library.js',
    'app/js/more.js',
    'app/js/notifications.js',
    'app/js/compat.js',
    'app/js/boot.js'
  ];

  // The website's coach-mark tours point at website-only elements (header
  // buttons, .bn-item ...) that do not exist in the app layout, so they are
  // marked as seen inside the app WebView (same flags js/onboarding.js uses).
  var WEB_TOURS = ['home','planner','topics','library','hadith','stats','drawer','reader','player',
                   'settings','prayer','qibla','dictionary','downloads','translationHelp','taraweeh'];

  var P = {
    isApp: false,        // true  -> Android app UI layer is used
    isNative: false,     // true  -> running inside the Capacitor native shell
    platform: 'web',     // 'android' | 'web'
    preview: false,      // true  -> app UI previewed in a normal browser (dev only)
    appUiVersion: APP_UI_VERSION,
    ready: false,        // app shell built and visible
    failed: false,
    styles: APP_STYLES.slice(),
    scripts: APP_SCRIPTS.slice()
  };
  w.QR_PLATFORM = P;

  // ---- detection ----
  function capacitorInfo(){
    try{
      var c = w.Capacitor;
      if(!c) return null;
      var plat = (typeof c.getPlatform === 'function') ? c.getPlatform() : null;
      var native = (typeof c.isNativePlatform === 'function') ? !!c.isNativePlatform() : !!(plat && plat !== 'web');
      return { native: native, platform: plat };
    }catch(e){ return null; }
  }
  function pluginAvailable(name){
    try{
      var c = w.Capacitor;
      return !!(c && typeof c.isPluginAvailable === 'function' && c.isPluginAvailable(name));
    }catch(e){ return false; }
  }
  // The APK keeps the native splash screen up while the page loads. It is
  // released from here - the one script that always runs first - as soon as the
  // app UI (or, on failure, the website UI) is on screen. The native side has
  // its own safety net (SplashScreen.launchShowDuration = 8 s, set in
  // android-build/apply-native-patches.mjs) plus the 12 s watchdog below, so a
  // splash can never get stuck.
  function hideSplash(){
    try{
      var c = w.Capacitor;
      if(c && c.Plugins && c.Plugins.SplashScreen && typeof c.Plugins.SplashScreen.hide === 'function'){
        c.Plugins.SplashScreen.hide({ fadeOutDuration: 180 });
      }
    }catch(e){}
  }
  function storageGet(store, key){ try{ return w[store].getItem(key); }catch(e){ return null; } }
  function storageSet(store, key, val){ try{ w[store].setItem(key, val); }catch(e){} }

  function detect(){
    var info = capacitorInfo();
    var hasShellToken = /QuranBanglaApp\//.test(w.navigator.userAgent || '');
    var nativeAndroid = !!((info && info.native && info.platform === 'android') || hasShellToken);
    if(nativeAndroid){ P.isNative = true; P.platform = 'android'; }

    // The app UI was disabled for this app session after a failed start.
    if(storageGet('sessionStorage', 'qa_disabled') === '1') return false;

    if(nativeAndroid){
      // The app UI relies on native plugins that only the current APK ships
      // (hardware back button, share sheet ...). A device that still runs an
      // older APK build keeps getting the normal website UI until it updates,
      // so nobody is ever left with a half-working app screen.
      if(pluginAvailable('App') || hasShellToken) return true;
      P.legacyShell = true;
      return false;
    }
    // Developer preview in a desktop browser (never used by real visitors).
    var wantsPreview = false;
    try{ wantsPreview = /(?:^|[?&])qa_preview=1(?:&|$)/.test(w.location.search); }catch(e){}
    if(wantsPreview) storageSet('sessionStorage', 'qa_preview', '1');
    if(wantsPreview || storageGet('sessionStorage', 'qa_preview') === '1'){
      P.preview = true; return true;
    }
    return false;
  }

  P.isApp = detect();
  root.setAttribute('data-platform', P.isApp ? 'android-app' : 'web');
  P.hideSplash = hideSplash;
  // Safety net for every native launch (app UI or website UI): never leave the
  // splash up more than a few seconds.
  if(P.isNative){
    setTimeout(hideSplash, 9000);
    if(!P.isApp) w.addEventListener('load', function(){ setTimeout(hideSplash, 150); });
  }

  var readyResolvers = [];
  P.whenReady = function(){
    if(P.ready || !P.isApp) return Promise.resolve(P);
    return new Promise(function(res){ readyResolvers.push(res); });
  };
  P.markReady = function(){
    if(P.ready) return;
    P.ready = true;
    root.classList.add('qa-ready');
    clearTimeout(watchdog);
    // let the first app frame paint, then release the native splash screen
    requestAnimationFrame(function(){ setTimeout(hideSplash, 60); });
    readyResolvers.splice(0).forEach(function(r){ r(P); });
    try{ w.dispatchEvent(new CustomEvent('qr:app-ready')); }catch(e){}
  };

  // ---- website: stop here ----
  if(!P.isApp) return;

  // ================= App mode only =================

  // 1) Resolve light/dark BEFORE first paint (no white flash), same rule the
  //    app theme module uses later: pref = system | light | dark.
  (function resolveScheme(){
    var pref = storageGet('localStorage', 'qa_scheme') || 'system';
    var dark = (pref === 'dark');
    if(pref === 'system'){
      try{ dark = !!(w.matchMedia && w.matchMedia('(prefers-color-scheme: dark)').matches); }catch(e){}
    }
    root.setAttribute('data-qa-scheme', dark ? 'dark' : 'light');
    var st = d.createElement('style');
    st.id = 'qa-boot-style';
    // Hide the (website) DOM until the app shell is ready; paint the window
    // background immediately so cold start shows a calm solid colour.
    st.textContent =
      'html[data-platform="android-app"]{background:' + (dark ? '#0B1513' : '#F6F4EE') + ';}' +
      'html[data-platform="android-app"]:not(.qa-ready) body{visibility:hidden;}';
    (d.head || root).appendChild(st);
  })();

  // 1b) The launch URL (e.g. ?shortcut=continue from a launcher shortcut) is captured here, because the
  //     website's own init() removes the query string from the address bar shortly after.
  try{
    var launchParams = new URLSearchParams(w.location.search);
    P.launch = { shortcut: launchParams.get('shortcut') || '', search: w.location.search || '' };
    // The website's own init() would act on ?shortcut= (opening website views / modals behind the app UI).
    // The app routes launch shortcuts itself (QRApp.deeplink), so the parameter is removed before that runs.
    if(P.launch.shortcut){
      launchParams.delete('shortcut');
      var rest = launchParams.toString();
      w.history.replaceState(w.history.state, '', w.location.pathname + (rest ? '?' + rest : '') + w.location.hash);
    }
  }catch(e){ P.launch = P.launch || { shortcut: '', search: '' }; }

  // 2) Website tours are not used in the app.
  WEB_TOURS.forEach(function(n){ storageSet('localStorage', 'qb_onb_seen_' + n, '1'); });

  // 3) Start fetching the app UI files right away (stylesheets + preloaded
  //    scripts); scripts are *executed* only after the website's own deferred
  //    scripts have run (DOMContentLoaded), because the app layer builds on
  //    their globals (state, openSurah, playAtIndex ...).
  var head = d.head || root;
  function addLink(attrs){
    var l = d.createElement('link');
    for(var k in attrs) l.setAttribute(k, attrs[k]);
    l.setAttribute('data-qa-asset', '1');
    head.appendChild(l);
    return l;
  }
  var stylePromises = APP_STYLES.map(function(href){
    return new Promise(function(resolve){
      var l = addLink({ rel: 'stylesheet', href: href });
      l.onload = function(){ resolve(true); };
      l.onerror = function(){ resolve(false); };
    });
  });
  APP_SCRIPTS.forEach(function(src){ addLink({ rel: 'preload', as: 'script', href: src }); });

  function loadScriptsInOrder(){
    return APP_SCRIPTS.reduce(function(chain, src){
      return chain.then(function(){
        return new Promise(function(resolve, reject){
          var s = d.createElement('script');
          s.src = src;
          s.async = false;
          s.setAttribute('data-qa-asset', '1');
          s.onload = function(){ resolve(); };
          s.onerror = function(){ reject(new Error('failed to load ' + src)); };
          (d.body || root).appendChild(s);
        });
      });
    }, Promise.resolve());
  }

  // 4) Failure handling: reload once into the website UI for this session.
  P.fail = function(reason){
    if(P.failed || P.ready) return;
    P.failed = true;
    try{ console.error('[platform] app UI failed to start:', reason); }catch(e){}
    storageSet('sessionStorage', 'qa_disabled', '1');
    hideSplash();
    try{ w.location.reload(); }catch(e){}
  };
  var watchdog = setTimeout(function(){ P.fail('timeout'); }, BOOT_TIMEOUT_MS);

  var started = false;
  function start(){
    if(started) return;
    started = true;
    Promise.all(stylePromises).then(function(results){
      if(results.some(function(ok){ return !ok; })) throw new Error('app stylesheet missing');
      return loadScriptsInOrder();
    }).then(function(){
      if(!w.QRApp || typeof w.QRApp.boot !== 'function') throw new Error('QRApp.boot missing');
      return w.QRApp.boot();
    }).catch(function(err){ P.fail(err && err.message ? err.message : err); });
  }

  if(d.readyState === 'complete' || d.readyState === 'interactive') start();
  else d.addEventListener('DOMContentLoaded', start);
})();
