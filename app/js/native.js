// ---------- Android app UI · native bridge ----------
// One thin adapter over the Capacitor plugins the app uses (App, Share,
// Clipboard, Network, Haptics, Browser, SystemBars / EdgeToEdge, PushNotifications,
// LocalNotifications ...). Every function degrades to a standard web API (or does
// nothing) when a plugin is not present, so the same UI code also runs in the
// developer preview and in a build that was made without a given plugin.
//
// Rule of the project: a feature is only called "native" when it really goes
// through one of these plugins. Everything else is plain web behaviour.
(function(){
  'use strict';
  var QRApp = window.QRApp = window.QRApp || {};
  var N = QRApp.native = {};
  var P = window.QR_PLATFORM || {};
  var root = document.documentElement;

  function noop(){}
  function swallow(p){ if(p && typeof p.catch === 'function') p.catch(noop); return p; }

  N.isNative = !!P.isNative;
  N.platform = P.platform || 'web';

  // ---------- plugin lookup ----------
  function plugin(name){
    try{
      var c = window.Capacitor;
      if(!c || !c.Plugins) return null;
      if(typeof c.isPluginAvailable === 'function' && !c.isPluginAvailable(name)) return null;
      return c.Plugins[name] || null;
    }catch(e){ return null; }
  }
  N.plugin = plugin;
  N.has = function(name){ return !!plugin(name); };

  // ---------- app / build info ----------
  var info = { name: 'Quran Bangla', id: 'com.techverse.quranbangla', version: '', build: '', source: 'web' };
  // Capabilities of THIS APK build, written by the build (android-build/apply-native-patches.mjs) into the user-agent
  // token "QuranBanglaApp/<version> (<code>; flag flag)":
  //   fcm  Firebase is configured (google-services.json was installed). Without it PushNotifications.register() would
  //        crash the native app, so push registration is never attempted.
  var features = N.features = { fcm: false };
  (function readTokenFromUA(){
    var m = /QuranBanglaApp\/([0-9A-Za-z._-]+)(?:\s*\((\d+)(?:;\s*([^)]*))?\))?/.exec(navigator.userAgent || '');
    if(m){
      info.version = m[1]; if(m[2]) info.build = m[2]; info.source = 'ua';
      features.fcm = /(?:^|\s)fcm(?:\s|$)/.test(m[3] || '');
    }
  })();
  N.info = info;
  N.loadInfo = function(){
    var App = plugin('App');
    if(!App || typeof App.getInfo !== 'function') return Promise.resolve(info);
    return App.getInfo().then(function(r){
      if(r){
        info.name = r.name || info.name;
        info.id = r.id || info.id;
        info.version = r.version || info.version;
        info.build = r.build || info.build;
        info.source = 'native';
      }
      return info;
    }).catch(function(){ return info; });
  };

  // ---------- lifecycle ----------
  var backHandlers = [];
  N.onBack = function(fn){
    var App = plugin('App');
    if(!App || typeof App.addListener !== 'function') return false;
    try{ swallow(App.addListener('backButton', function(ev){ fn(ev || {}); })); return true; }catch(e){ return false; }
  };
  N.onResume = function(fn){
    var App = plugin('App');
    if(App && typeof App.addListener === 'function'){
      swallow(App.addListener('appStateChange', function(s){ if(s && s.isActive) fn(); }));
    }
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible') fn(); });
  };
  N.onPause = function(fn){
    var App = plugin('App');
    if(App && typeof App.addListener === 'function'){
      swallow(App.addListener('appStateChange', function(s){ if(s && !s.isActive) fn(); }));
    }
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'hidden') fn(); });
    window.addEventListener('pagehide', fn);
  };
  N.onUrlOpen = function(fn){
    var App = plugin('App');
    if(!App || typeof App.addListener !== 'function') return;
    swallow(App.addListener('appUrlOpen', function(ev){ if(ev && ev.url) fn(ev.url); }));
  };
  N.getLaunchUrl = function(){
    var App = plugin('App');
    if(!App || typeof App.getLaunchUrl !== 'function') return Promise.resolve(null);
    return App.getLaunchUrl().then(function(r){ return (r && r.url) || null; }).catch(function(){ return null; });
  };
  N.exit = function(){
    var App = plugin('App');
    if(App && typeof App.exitApp === 'function') return swallow(App.exitApp());
    return Promise.resolve();
  };
  N.minimize = function(){
    var App = plugin('App');
    if(App && typeof App.minimizeApp === 'function') return swallow(App.minimizeApp());
    return N.exit();
  };

  // ---------- sharing / clipboard ----------
  // share({title, text, url}) -> Promise<{ok:boolean, method:'native'|'web'|'clipboard'|'none'}>
  N.share = function(opts){
    opts = opts || {};
    var Share = plugin('Share');
    var payload = { title: opts.title || '', text: opts.text || '', url: opts.url || undefined, dialogTitle: opts.dialogTitle || opts.title || '' };
    function viaWeb(){
      // (compat.js installs a navigator.share that forwards to the Share plugin: it is not a second route)
      if(navigator.share && !navigator.share.__qaShim){
        var d = { title: payload.title, text: payload.text };
        if(payload.url) d.url = payload.url;
        return navigator.share(d).then(function(){ return { ok: true, method: 'web' }; })
          .catch(function(e){ return { ok: false, method: 'web', cancelled: !!(e && e.name === 'AbortError') }; });
      }
      var all = [payload.text, payload.url].filter(Boolean).join('\n');
      return N.copy(all).then(function(ok){ return { ok: ok, method: ok ? 'clipboard' : 'none' }; });
    }
    if(Share && typeof Share.share === 'function'){
      return Share.share(payload).then(function(){ return { ok: true, method: 'native' }; })
        .catch(function(e){
          var msg = String((e && e.message) || e || '');
          // the user simply dismissed the sheet
          if(/cancel|dismiss/i.test(msg)) return { ok: false, method: 'native', cancelled: true };
          return viaWeb();
        });
    }
    return viaWeb();
  };
  N.copy = function(text){
    text = String(text == null ? '' : text);
    var Clip = plugin('Clipboard');
    function viaWeb(){
      if(navigator.clipboard && navigator.clipboard.writeText){
        return navigator.clipboard.writeText(text).then(function(){ return true; }).catch(legacy);
      }
      return Promise.resolve(legacy());
    }
    function legacy(){
      try{
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand && document.execCommand('copy');
        ta.remove();
        return !!ok;
      }catch(e){ return false; }
    }
    if(Clip && typeof Clip.write === 'function'){
      return Clip.write({ string: text }).then(function(){ return true; }).catch(viaWeb);
    }
    return viaWeb();
  };

  // ---------- haptics ----------
  var lastHaptic = 0;
  N.haptic = function(kind){
    try{
      if(QRApp.prefs && QRApp.prefs.get('haptics', true) === false) return;
      var now = Date.now(); if(now - lastHaptic < 40) return; lastHaptic = now;
      var H = plugin('Haptics');
      if(H){
        if(kind === 'success' && H.notification) return swallow(H.notification({ type: 'SUCCESS' }));
        if(kind === 'warning' && H.notification) return swallow(H.notification({ type: 'WARNING' }));
        if(H.impact) return swallow(H.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' }));
      }
    }catch(e){}
  };

  // ---------- external links (Chrome Custom Tab) ----------
  N.openExternal = function(url){
    var B = plugin('Browser');
    if(B && typeof B.open === 'function') return swallow(B.open({ url: url }));
    try{ window.open(url, '_blank', 'noopener'); }catch(e){ location.href = url; }
    return Promise.resolve();
  };

  // ---------- system bars (status bar / navigation bar) ----------
  N.setSystemBars = function(scheme){
    var bg = scheme === 'dark' ? '#0B1513' : '#F6F4EE';
    var style = scheme === 'dark' ? 'DARK' : 'LIGHT'; // DARK = light icons for a dark surface
    var SB = plugin('SystemBars');
    if(SB && typeof SB.setStyle === 'function') swallow(SB.setStyle({ style: style }));
    var EE = plugin('EdgeToEdge');
    if(EE && typeof EE.setBackgroundColor === 'function') swallow(EE.setBackgroundColor({ color: bg }));
    var ST = plugin('StatusBar');
    if(ST){
      if(typeof ST.setStyle === 'function') swallow(ST.setStyle({ style: style }));
      if(typeof ST.setBackgroundColor === 'function') swallow(ST.setBackgroundColor({ color: bg }));
    }
  };

  // ---------- network ----------
  var net = N.network = { online: navigator.onLine !== false, type: 'unknown', listeners: [] };
  function setOnline(v, type){
    var changed = net.online !== v;
    net.online = v; if(type) net.type = type;
    root.classList.toggle('qa-offline', !v);
    if(changed) net.listeners.slice().forEach(function(fn){ try{ fn(v); }catch(e){} });
  }
  net.onChange = function(fn){ net.listeners.push(fn); return function(){ net.listeners = net.listeners.filter(function(f){ return f !== fn; }); }; };
  (function initNetwork(){
    root.classList.toggle('qa-offline', !net.online);
    window.addEventListener('online', function(){ setOnline(true); });
    window.addEventListener('offline', function(){ setOnline(false); });
    var Net = plugin('Network');
    if(Net){
      try{
        if(typeof Net.getStatus === 'function') Net.getStatus().then(function(s){ if(s) setOnline(!!s.connected, s.connectionType); }).catch(noop);
        if(typeof Net.addListener === 'function') swallow(Net.addListener('networkStatusChange', function(s){ if(s) setOnline(!!s.connected, s.connectionType); }));
      }catch(e){}
    }
  })();

  // ---------- on-screen keyboard ----------
  // Detected from the viewport so it works with or without the Keyboard plugin.
  N.keyboardOpen = false;
  (function watchKeyboard(){
    var vv = window.visualViewport;
    var maxH = window.innerHeight, wasLandscape = window.innerWidth > window.innerHeight;
    function check(){
      var landscape = window.innerWidth > window.innerHeight;
      if(landscape !== wasLandscape){ wasLandscape = landscape; maxH = window.innerHeight; }
      if(window.innerHeight > maxH) maxH = window.innerHeight;
      var h = Math.min(window.innerHeight, vv ? vv.height : window.innerHeight);
      var open = (maxH - h) > Math.max(120, maxH * 0.15);
      if(open !== N.keyboardOpen){
        N.keyboardOpen = open;
        root.classList.toggle('qa-kbd-open', open);
        if(QRApp.emit) QRApp.emit('keyboard', open);
      }
    }
    window.addEventListener('resize', check);
    if(vv) vv.addEventListener('resize', check);
  })();

  // ---------- push + local notification plugin handles (used by notifications.js) ----------
  N.push = function(){ return plugin('PushNotifications'); };
  N.local = function(){ return plugin('LocalNotifications'); };
})();
