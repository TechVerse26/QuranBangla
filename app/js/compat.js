// ---------- Android app UI · compatibility layer ----------
// The app screens reuse the website's business logic AND a handful of website screens (planner, topics, hadith,
// statistics, exams, profile, prayer, qibla ...). Those website screens call a few global functions that assume
// the website's own shell (header, bottom navigation, #view-* sections, toast element, reader area ...).
// This module re-points exactly those calls at the app shell. It runs only in the Android app (never on the
// website) and only after the website's own scripts have initialised.
//
// Every patch keeps the original on `fn.__orig`, is idempotent, and is skipped (with a console warning) when the
// website function it targets does not exist, so a future change of the website can never break the app start.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native;
  var compat = QRApp.compat = { installed: false, patched: [], missing: [] };

  function R(){ return QRApp.reader; }

  // wrap(name, make): window[name] = make(original)
  function wrap(name, make){
    var orig = window[name];
    if(typeof orig !== 'function'){ compat.missing.push(name); QRApp.warn('compat: website function missing:', name); return false; }
    if(orig.__qaPatched) return true;
    var fn = make(orig);
    fn.__orig = orig;
    fn.__qaPatched = true;
    window[name] = fn;
    compat.patched.push(name);
    return true;
  }
  function viaReader(type){
    return function(num){ return Promise.resolve(R().open({ type: type, num: num })); };
  }

  // The website starts its first-visit welcome tour about 700 ms after its own init (initOnboarding -> onbStartTour('home')).
  // On a fresh install the website's one-time localStorage -> IndexedDB migration wipes the "tour seen" flags that
  // js/platform.js wrote a moment earlier, so the tour would also appear on top of the app UI. The tours point at
  // website-only elements, therefore they are switched off here, as early as possible (boot.js calls this right
  // after the website's init, long before that timer fires).
  // Every tour also counts as "already seen": on the first recitation js/player.js opens its full control panel for the
  // 'player' tour (onbHasSeen('player') is false on a fresh install), which would cover the reader with a panel meant
  // for the website. In the app the compact player stays compact.
  compat.suppressTours = function(){
    wrap('onbStartTour', function(){ return function(){}; });
    wrap('onbMaybeStart', function(){ return function(){}; });
    wrap('onbHasSeen', function(){ return function(){ return true; }; });
    try{ var r = document.getElementById('onbRoot'); if(r && r.parentNode) r.parentNode.removeChild(r); }catch(e){}
  };

  compat.install = function(){
    if(compat.installed) return compat;
    compat.installed = true;

    // 1) The website's #appToast is replaced by the app snackbar.
    wrap('showToast', function(orig){
      return function(msg, kind){
        if(msg == null || msg === '') return;
        try{ UI.snack(String(msg), kind === 'error' ? { duration: 4200 } : undefined); }
        catch(e){ return orig.apply(this, arguments); }
      };
    });

    // 2) Website "views" -> app navigation. Home and Saved are app tabs; planner / topics / hadith / stats / exam /
    //    profile are website screens that are hosted inside the app shell (nav.js 'legacy' route).
    wrap('goToView', function(orig){
      return function(view){
        var hosted = Nav.legacyViews || [];
        if(view === 'home'){ Nav.go('home'); return; }
        if(view === 'library'){ Nav.go('library'); return; }
        if(hosted.indexOf(view) > -1){
          var top = Nav.top();
          // already showing this website screen: just refresh it in place
          if(top && top.id === 'legacy' && top.params && top.params.view === view) return orig.call(this, view);
          Nav.openLegacy(view);
          return;
        }
        return orig.apply(this, arguments);
      };
    });

    // 3) Opening Quran text: the app reader replaces the website reader area.
    wrap('openSurah', function(){ return viaReader('surah'); });
    wrap('openJuz', function(){ return viaReader('juz'); });
    wrap('openPage', function(){ return viaReader('page'); });
    wrap('openHizb', function(){ return viaReader('hizb'); });
    wrap('openRuku', function(){ return viaReader('ruku'); });
    wrap('openSurahAndScrollTo', function(){
      return function(surah, ayah){ return Promise.resolve(R().open({ type: 'surah', num: surah, surah: surah, ayah: ayah })); };
    });
    wrap('openOfflineSurah', function(){
      return function(entry){
        entry = entry || {};
        // play with the reciter the audio was downloaded for (same rule as the website)
        if(entry.reciter && entry.reciter !== state.reciter){
          state.reciter = entry.reciter;
          try{ saveReciter(); }catch(e){}
          try{ if(typeof updateReciterLabels === 'function') updateReciterLabels(); }catch(e){}
        }
        return Promise.resolve(R().open({ type: 'surah', num: entry.surah }));
      };
    });
    wrap('reopenCurrentReaderView', function(){
      return function(){ try{ R().reload(); }catch(e){ QRApp.warn(e); } };
    });

    // 4) Settings live in the app's own Settings screen.
    wrap('openSettingsModal', function(){
      return function(){ Nav.push('settings'); };
    });

    // 5) Social sign-in (Google / Facebook / ...) cannot complete inside an embedded WebView
    //    (providers block it), so only e-mail + password is offered in the app.
    wrap('socialAuthButtonsHtml', function(){ return function(){ return ''; }; });

    // 6) No donation banner and no coach-mark tours inside the app.
    wrap('canShowDonationNow', function(){ return function(){ return false; }; });
    wrap('onbMaybeStart', function(){ return function(){}; });
    // The website's Ramadan "decoration layer" (starfield, purple header, glows) is not part of the app design.
    // The Taraweeh tracker and all data keep working; only the visual attribute stays off.
    wrap('applyRamadanVisual', function(){
      return function(){ try{ document.body.setAttribute('data-ramadan', 'off'); }catch(e){} };
    });
    try{ document.body.setAttribute('data-ramadan', 'off'); }catch(e){}
    // The website's "Status" row (short text / image / voice posts that signed-in people share with each other) is a
    // website-only social feature: the app has no screen for it, so the row is not rendered and the posts of other
    // people are not downloaded into a hidden page. Nothing is removed from the website.
    wrap('renderStatusRow', function(){ return function(){}; });

    // 7) The website keeps the prayer-push subscription (web push) up to date when the location / method changes;
    //    in the app the subscription is the native FCM token, handled by QRApp.notify.
    wrap('updatePushLocationIfSubscribed', function(orig){
      return function(){
        var N = QRApp.notify;
        if(N && typeof N.refreshSubscription === 'function') return N.refreshSubscription();
        return orig.apply(this, arguments);
      };
    });

    // 8) Tell the app screens when the signed-in user changed (the website calls this after state.user is set).
    wrap('refreshCurrentView', function(orig){
      return function(){
        var r;
        try{ r = orig.apply(this, arguments); }
        finally{ try{ QRApp.emit('auth'); }catch(e){} }
        return r;
      };
    });

    // 9) The website's "auto offline" engine (js/auto-offline.js, started by fetchSurahList and by the window 'online' event)
    //    is not used in the app: on every start it announces "full auto offline support is enabled" although its download
    //    step calls dlmCacheUrlsAwait(), a function that does not exist anywhere in the project (so it never stores
    //    anything), and if that ever gets fixed it would begin pulling about 0.9 GB of audio in the background without
    //    asking - mobile data included. The app has explicit, visible controls instead (Discover > Offline downloads,
    //    Settings > Audio, Library > Downloads). Both entry points call it through the global name, so replacing it here
    //    is enough; the website itself is untouched.
    wrap('initAutoOfflineCache', function(){ return function(){ return Promise.resolve(); }; });

    // 10) Offline audio is added / removed from inside website screens too (the download manager, the player's own
    //     "save offline" button, the service worker's progress messages). The app screens that list it (Saved > Offline,
    //     the Quran list's offline dots, Settings > Audio) listen for the app's 'downloads' event, so the website's
    //     bookkeeping functions announce every change.
    wrap('markSurahOffline', function(orig){
      return function(){ var r = orig.apply(this, arguments); try{ QRApp.emit('downloads'); }catch(e){} return r; };
    });
    wrap('removeSurahOffline', function(orig){
      return function(){
        return Promise.resolve(orig.apply(this, arguments)).then(function(v){ try{ QRApp.emit('downloads'); }catch(e){} return v; });
      };
    });

    installBrowserShims();
    return compat;
  };

  // ---------- browser API shims (so the website's own code uses the native pieces) ----------
  function installBrowserShims(){
    // Native share sheet for the website's `navigator.share(...)` calls (statistics, share app ...).
    // Android System WebView does not expose the Web Share API; the Capacitor Share plugin does the same job.
    try{
      var Share = NAT.plugin('Share');
      if(Share && typeof Share.share === 'function' && typeof navigator.share !== 'function'){
        navigator.share = function(data){
          data = data || {};
          return Share.share({ title: data.title || '', text: data.text || '', url: data.url || undefined, dialogTitle: data.title || '' })
            .then(function(){})
            .catch(function(e){
              var err = new Error((e && e.message) || 'share failed');
              err.name = /cancel|dismiss/i.test(String((e && e.message) || e || '')) ? 'AbortError' : 'NotAllowedError';
              throw err;
            });
        };
        navigator.share.__qaShim = true;      // native.js must not treat this as the browser's own Web Share API
        // the text share sheet cannot carry files: let callers take their own download fallback
        if(typeof navigator.canShare !== 'function'){
          navigator.canShare = function(d){ return !(d && d.files && d.files.length); };
        }
      }
    }catch(e){ QRApp.warn('share shim failed', e); }

    // window.open(...) of another site -> Chrome Custom Tab / system handler instead of an in-WebView popup.
    try{
      var origOpen = window.open;
      if(typeof origOpen === 'function' && !origOpen.__qaPatched){
        var patched = function(url){
          try{
            if(url){
              var u = new URL(String(url), location.href);
              if((u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== location.origin){ NAT.openExternal(u.href); return null; }
              if(u.protocol === 'mailto:' || u.protocol === 'tel:'){ location.href = u.href; return null; }
            }
          }catch(e){}
          return origOpen.apply(window, arguments);
        };
        patched.__qaPatched = true; patched.__orig = origOpen;
        window.open = patched;
      }
    }catch(e){ QRApp.warn('window.open shim failed', e); }
  }
})();
