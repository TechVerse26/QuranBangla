// ---------- Android app UI · notifications, announcements, deep links ----------
//
//   * Push (Firebase Cloud Messaging) through the Capacitor PushNotifications plugin. The device token is saved
//     in the SAME Firestore document the website's prayer push uses (push_subscriptions/{deviceId}, fields
//     token / lat / lon / method / updatedAt only), so scripts/send-prayer-notifications.js serves the website
//     and the app from one list and the security rules stay exactly as they are.
//   * Android notification channels are the user-visible categories: prayer times, announcements, reading
//     reminders (each can also be switched off in Android's own settings).
//   * A daily reading reminder through LocalNotifications (on the device, no server involved, no exact alarms).
//   * The notification inbox (history) and the announcement published by the admin (Firestore siteConfig/*,
//     which the security rules already expose read-only to everyone).
//   * Deep links: launcher shortcuts, https links to the website's host and notification taps all go through
//     QRApp.deeplink.handle().
// Nothing here asks for the notification permission at start-up - only when the user switches a feature on.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;
  var notify = QRApp.notify = {};

  var MAX_INBOX = 60;
  var REMINDER_ID = 1001;
  var inbox = [];
  var announce = null;           // the active announcement object (or null)
  var updateNotice = null;       // newer-version notice from siteConfig/appConfig
  var nativeToken = '';
  var tokenWaiters = [];
  var listenersAttached = false;
  var lastAnnounceFetch = 0;

  function safe(fn, dflt){ try{ return fn(); }catch(e){ QRApp.warn(e); return dflt; } }
  function PN(){ return NAT.push(); }
  function LN(){ return NAT.local(); }
  // Push needs the plugin AND a Firebase configuration inside this APK (flag "fcm" from the build, see native.js):
  // PushNotifications.register() on an app without Firebase crashes the native process, so it is never called then.
  function pushReady(){ return !!(PN() && NAT.features && NAT.features.fcm); }

  // ---------- channels (Android 8+: these are the notification categories) ----------
  function channels(){
    return [
      { id: 'prayer', name: T('নামাজের সময়', 'Prayer times'), description: T('ওয়াক্ত হলে স্মরণ করিয়ে দেয়', 'Reminds you when a prayer time begins'), importance: 4, visibility: 1, vibration: true },
      { id: 'announcements', name: T('ঘোষণা ও আপডেট', 'Announcements & updates'), description: T('অ্যাপের নতুন খবর ও গুরুত্বপূর্ণ জানানি', 'News and important notices about the app'), importance: 3, visibility: 1 },
      { id: 'reminders', name: T('তিলাওয়াতের রিমাইন্ডার', 'Reading reminders'), description: T('প্রতিদিন কুরআন পড়ার মনে করিয়ে দেওয়া', 'Your daily Quran reading reminder'), importance: 3, visibility: 1 }
    ];
  }
  function ensureChannels(){
    var list = channels();
    [PN(), LN()].forEach(function(p){
      if(!p || typeof p.createChannel !== 'function') return;
      list.forEach(function(c){ try{ var r = p.createChannel(c); if(r && r.catch) r.catch(function(){}); }catch(e){} });
    });
  }

  // ---------- permission ----------
  // -> 'granted' | 'denied' | 'prompt' | 'unsupported'
  notify.permission = function(){
    var p = PN() || LN();
    if(!p || typeof p.checkPermissions !== 'function') return Promise.resolve('unsupported');
    return p.checkPermissions().then(function(r){
      var v = (r && (r.receive || r.display)) || 'prompt';
      return v === 'prompt-with-rationale' ? 'prompt' : v;
    }).catch(function(){ return 'unsupported'; });
  };
  function requestPermission(){
    var p = PN() || LN();
    if(!p || typeof p.requestPermissions !== 'function') return Promise.resolve(false);
    return notify.permission().then(function(cur){
      if(cur === 'granted') return true;
      return p.requestPermissions().then(function(r){ return ((r && (r.receive || r.display)) || '') === 'granted'; });
    }).catch(function(){ return false; });
  }
  function explainBlocked(){
    return UI.alert(T('নোটিফিকেশন বন্ধ আছে', 'Notifications are off'),
      T('ফোনের Settings > Apps > কুরআন বাংলা > Notifications থেকে নোটিফিকেশন চালু করুন, তারপর আবার চেষ্টা করুন।', 'Open your phone\'s Settings > Apps > Quran Bangla > Notifications, turn notifications on, then try again.'));
  }

  // ---------- push registration ----------
  function attachListeners(){
    if(listenersAttached) return; listenersAttached = true;
    var P = PN();
    if(P && typeof P.addListener === 'function'){
      function on(name, fn){ try{ var r = P.addListener(name, fn); if(r && r.catch) r.catch(function(){}); }catch(e){} }
      on('registration', function(t){
        nativeToken = (t && t.value) || '';
        tokenWaiters.splice(0).forEach(function(w){ w(nativeToken); });
        if(nativeToken && state.prayerNotify) safe(function(){ saveSubscription(nativeToken); });
      });
      on('registrationError', function(){ tokenWaiters.splice(0).forEach(function(w){ w(''); }); });
      // app is open: FCM does not draw a system notification, so it becomes an in-app message + inbox entry
      on('pushNotificationReceived', function(n){
        var item = addToInbox(fromPayload(n));
        UI.snack((item.title ? item.title + ' — ' : '') + (item.body || ''), { duration: 4500, action: { label: T('দেখুন', 'View'), onClick: function(){ Nav.push('inbox'); } } });
      });
      on('pushNotificationActionPerformed', function(ev){
        var n = ev && ev.notification; if(!n) return;
        var item = addToInbox(fromPayload(n)); item.read = true; saveInbox();
        QRApp.deeplink.handle(n.data || {});
      });
    }
    var L = LN();
    if(L && typeof L.addListener === 'function'){
      try{
        var r = L.addListener('localNotificationActionPerformed', function(ev){
          var n = ev && ev.notification; if(!n) return;
          var extra = n.extra || {};
          QRApp.deeplink.handle(extra.link ? { link: extra.link } : { screen: extra.screen || 'continue' });
        });
        if(r && r.catch) r.catch(function(){});
      }catch(e){}
    }
  }
  function waitForToken(ms){
    return new Promise(function(resolve){
      if(!pushReady()){ resolve(''); return; }
      var done = false;
      function fin(t){ if(done) return; done = true; resolve(t || ''); }
      tokenWaiters.push(fin);
      setTimeout(function(){ fin(nativeToken); }, ms || 9000);
      var P = PN();
      try{ var r = P.register(); if(r && r.catch) r.catch(function(){ fin(''); }); }catch(e){ fin(''); }
    });
  }

  // The document shape is fixed by firestore.rules: token / lat / lon / method / updatedAt.
  function saveSubscription(token){
    if(!token || !state.prayerLocation || typeof fbDb === 'undefined' || !fbDb) return Promise.resolve(false);
    return fbDb.collection('push_subscriptions').doc(getDeviceId()).set({
      token: token,
      lat: state.prayerLocation.lat,
      lon: state.prayerLocation.lon,
      method: state.prayerMethod,
      updatedAt: new Date().toISOString()
    }, { merge: true }).then(function(){ return true; }).catch(function(e){ QRApp.warn('push subscription save failed', e); return false; });
  }
  notify.hasNativeToken = function(){ return !!nativeToken; };
  // Called when the prayer location / method changes (website's updatePushLocationIfSubscribed is routed here).
  notify.refreshSubscription = function(){
    if(!state.prayerNotify || !nativeToken) return Promise.resolve(false);
    return saveSubscription(nativeToken);
  };

  notify.prayerEnabled = function(){ return !!state.prayerNotify; };
  // Switch prayer-time notifications on. Resolves true when the device is subscribed.
  notify.enablePrayer = function(){
    if(!PN()){
      UI.snack(NAT.isNative ? T('এই অ্যাপ সংস্করণে নোটিফিকেশন সমর্থিত নয় — অ্যাপ আপডেট করুন', 'This app build does not support notifications — please update the app')
                            : T('নোটিফিকেশন শুধু Android অ্যাপে চালু করা যায়', 'Notifications can only be turned on in the Android app'));
      return Promise.resolve(false);
    }
    if(!pushReady()){
      UI.snack(T('এই সংস্করণে ওয়াক্তের নোটিফিকেশন এখনো চালু নেই', 'Prayer notifications are not available in this version yet'));
      return Promise.resolve(false);
    }
    if(!state.prayerLocation){
      return UI.confirm({
        title: T('আগে অবস্থান বেছে নিন', 'Choose your location first'),
        text: T('ওয়াক্তের নোটিফিকেশন পাঠাতে আপনার এলাকা জানা দরকার। এখনই নামাজের সময় খুলে অবস্থান ঠিক করবেন?', 'Prayer notifications need your location. Open prayer times to set it now?'),
        confirmLabel: T('অবস্থান ঠিক করুন', 'Set location')
      }).then(function(ok){ if(ok) QRApp.features.open('prayer'); return false; });
    }
    return requestPermission().then(function(ok){
      if(!ok){ explainBlocked(); return false; }
      ensureChannels(); attachListeners();
      return waitForToken(9000).then(function(token){
        if(!token){ UI.snack(T('নোটিফিকেশন চালু করা যায়নি — ইন্টারনেট দেখে আবার চেষ্টা করুন', 'Could not turn notifications on — check your connection and try again')); return false; }
        return saveSubscription(token).then(function(saved){
          if(!saved){ UI.snack(T('সংরক্ষণ করা যায়নি — ইন্টারনেট দেখে আবার চেষ্টা করুন', 'Could not save — check your connection and try again')); return false; }
          state.prayerNotify = true;
          safe(savePrayerNotify); safe(markPrayerNotifyEverEnabled);
          QRApp.emit('prayer-notify', true);
          return true;
        });
      });
    });
  };
  notify.disablePrayer = function(){
    return Promise.resolve(safe(function(){ return disablePrayerPush(); })).then(function(){
      state.prayerNotify = false; safe(savePrayerNotify);
      QRApp.emit('prayer-notify', false);
      return true;
    });
  };

  // ---------- daily reading reminder (local, on the device) ----------
  function reminderPrefs(){ return QRApp.prefs.get('reminder', { on: false, h: 20, m: 0 }); }
  notify.reminder = function(){ var r = reminderPrefs(); return { on: !!r.on, hour: r.h, minute: r.m }; };
  notify.reminderLabel = function(){
    var r = reminderPrefs();
    var d = new Date(); d.setHours(r.h, r.m, 0, 0);
    try{ return new Intl.DateTimeFormat(QRApp.isBn() ? 'bn-BD' : 'en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d); }catch(e){ return r.h + ':' + (r.m < 10 ? '0' : '') + r.m; }
  };
  function schedule(hr, min){
    var L = LN();
    if(!L || typeof L.schedule !== 'function') return Promise.resolve(false);
    ensureChannels();
    var cancel = (typeof L.cancel === 'function') ? Promise.resolve(L.cancel({ notifications: [{ id: REMINDER_ID }] })).catch(function(){}) : Promise.resolve();
    return cancel.then(function(){
      return L.schedule({ notifications: [{
        id: REMINDER_ID,
        title: T('কুরআন বাংলা', 'Quran Bangla'),
        body: T('আজকের তিলাওয়াতের সময় — কয়েকটি আয়াত পড়ে নিন।', 'Time for today\'s reading — read a few ayahs.'),
        channelId: 'reminders',
        schedule: { on: { hour: hr, minute: min }, repeats: true, allowWhileIdle: true },
        extra: { screen: 'continue' }
      }] });
    }).then(function(){ return true; }).catch(function(e){ QRApp.warn('reminder schedule failed', e); return false; });
  }
  notify.enableReminder = function(hr, min){
    var L = LN();
    if(!L){
      UI.snack(NAT.isNative ? T('এই অ্যাপ সংস্করণে রিমাইন্ডার সমর্থিত নয় — অ্যাপ আপডেট করুন', 'This app build does not support reminders — please update the app')
                            : T('রিমাইন্ডার শুধু Android অ্যাপে চালু করা যায়', 'Reminders can only be turned on in the Android app'));
      return Promise.resolve(false);
    }
    var cur = reminderPrefs();
    hr = (hr == null) ? cur.h : hr; min = (min == null) ? cur.m : min;
    return requestPermission().then(function(ok){
      if(!ok){ explainBlocked(); return false; }
      attachListeners();
      return schedule(hr, min).then(function(done){
        if(!done){ UI.snack(T('রিমাইন্ডার সেট করা যায়নি', 'Could not set the reminder')); return false; }
        QRApp.prefs.set('reminder', { on: true, h: hr, m: min });
        return true;
      });
    });
  };
  notify.disableReminder = function(){
    var L = LN();
    QRApp.prefs.set('reminder', { on: false, h: reminderPrefs().h, m: reminderPrefs().m });
    if(L && typeof L.cancel === 'function') return Promise.resolve(L.cancel({ notifications: [{ id: REMINDER_ID }] })).then(function(){ return true; }).catch(function(){ return true; });
    return Promise.resolve(true);
  };

  // ---------- inbox ----------
  function loadInbox(){ var v = QRApp.prefs.get('inbox', []); inbox = Array.isArray(v) ? v : []; }
  function saveInbox(){ QRApp.prefs.set('inbox', inbox.slice(0, MAX_INBOX)); QRApp.emit('inbox'); }
  function categoryOf(data, channelId){
    var c = (data && (data.category || data.type)) || channelId || '';
    if(/prayer|salah|namaz/i.test(c)) return 'prayer';
    if(/remind/i.test(c)) return 'reminder';
    if(/announce|update|news/i.test(c)) return 'announcement';
    return 'general';
  }
  function fromPayload(n){
    var data = n.data || {};
    return {
      id: 'p:' + (n.id || '') + ':' + (n.title || data.title || '') + ':' + (n.body || data.body || ''),
      ts: Date.now(),
      title: n.title || data.title || '',
      body: n.body || data.body || '',
      cat: categoryOf(data, n.channelId),
      link: data.link || data.url || '',
      screen: data.screen || '',
      read: false
    };
  }
  function addToInbox(item){
    var dup = inbox.filter(function(x){ return x.id === item.id; })[0];
    if(dup) return dup;
    inbox.unshift(item);
    if(inbox.length > MAX_INBOX) inbox.length = MAX_INBOX;
    saveInbox();
    return item;
  }
  notify.inbox = function(){ return inbox.slice(); };
  notify.unread = function(){ return inbox.filter(function(x){ return !x.read; }).length; };
  notify.markAllRead = function(){ var ch = false; inbox.forEach(function(x){ if(!x.read){ x.read = true; ch = true; } }); if(ch) saveInbox(); };
  notify.clearInbox = function(){ inbox = []; saveInbox(); };
  // Notifications that arrived while the app was closed are still in the system tray - bring them into the inbox.
  function importDelivered(){
    var P = PN();
    if(!P || typeof P.getDeliveredNotifications !== 'function') return;
    P.getDeliveredNotifications().then(function(r){
      var list = (r && r.notifications) || [];
      var added = false;
      list.forEach(function(n){
        var item = fromPayload(n);
        if(!inbox.some(function(x){ return x.id === item.id; })){ inbox.unshift(item); added = true; }
      });
      if(added){ if(inbox.length > MAX_INBOX) inbox.length = MAX_INBOX; saveInbox(); }
    }).catch(function(){});
  }

  // ---------- announcement (admin) + new-version notice ----------
  function toMillis(v){
    if(!v) return 0;
    if(typeof v === 'number') return v;
    if(typeof v.toMillis === 'function') return v.toMillis();
    if(typeof v === 'object' && v.seconds != null) return (Number(v.seconds) * 1000) + Math.floor((Number(v.nanoseconds) || 0) / 1e6);
    var t = Date.parse(v); return isNaN(t) ? 0 : t;
  }
  function activeAnnouncement(a){
    if(!a || a.active === false || !(a.title || a.text)) return null;
    var now = Date.now();
    var s = toMillis(a.startsAt), e = toMillis(a.endsAt);
    if(s && now < s) return null;
    if(e && now > e) return null;
    if(a.audience && a.audience !== 'all' && a.audience !== 'android') return null;
    return { id: String(a.id || a.title || ''), title: a.title || '', text: a.text || '', link: a.link || '', linkLabel: a.linkLabel || '' };
  }
  function installedBuild(){ var b = parseInt(NAT.info.build, 10); return isNaN(b) ? 0 : b; }
  function computeUpdateNotice(cfg){
    if(!cfg) return null;
    var latest = parseInt(cfg.latestVersionCode, 10);
    if(!(latest > 0) || !(installedBuild() > 0) || latest <= installedBuild()) return null;
    return { id: 'update-' + latest, title: T('নতুন সংস্করণ পাওয়া যাচ্ছে', 'A new version is available'), text: cfg.updateMessage || T('সেরা অভিজ্ঞতার জন্য অ্যাপটি আপডেট করুন।', 'Update the app for the best experience.'), link: cfg.updateUrl || '', linkLabel: T('আপডেট করুন', 'Update'), isUpdate: true, versionName: cfg.latestVersionName || '' };
  }
  // Every notice the person has closed is remembered by its id (an announcement and an update notice can both exist,
  // so one remembered id would make them take turns coming back). Older versions stored a single id as a string.
  function dismissedList(){
    var d = QRApp.prefs.get('announce_dismissed', []);
    if(typeof d === 'string') d = d ? [d] : [];
    return Array.isArray(d) ? d : [];
  }
  notify.announcement = function(){
    var d = dismissedList();
    if(announce && d.indexOf(announce.id) < 0) return announce;
    if(updateNotice && d.indexOf(updateNotice.id) < 0) return updateNotice;
    return null;
  };
  notify.updateNotice = function(){ return updateNotice; };
  notify.dismissAnnouncement = function(){
    var a = notify.announcement();
    if(!a) return;
    var d = dismissedList().filter(function(x){ return x !== a.id; });
    d.push(a.id);
    QRApp.prefs.set('announce_dismissed', d.slice(-20));
  };
  function loadCachedAnnouncement(){
    var c = QRApp.prefs.get('announce_cache', null);
    if(c){ announce = activeAnnouncement(c.a); updateNotice = computeUpdateNotice(c.cfg); }
  }
  // siteConfig/announcement  { active, id, title, text, link, linkLabel, startsAt, endsAt, audience }
  // siteConfig/appConfig     { latestVersionCode, latestVersionName, updateMessage, updateUrl }
  notify.refreshAnnouncement = function(force){
    if(!NAT.network.online || typeof fbDb === 'undefined' || !fbDb) return Promise.resolve(false);
    if(!force && Date.now() - lastAnnounceFetch < 10 * 60 * 1000) return Promise.resolve(false);
    lastAnnounceFetch = Date.now();
    function get(id){ return fbDb.collection('siteConfig').doc(id).get().then(function(d){ return d.exists ? d.data() : null; }).catch(function(){ return undefined; }); }
    return Promise.all([get('announcement'), get('appConfig')]).then(function(res){
      var a = res[0], cfg = res[1];
      if(a === undefined && cfg === undefined) return false;      // both reads failed: keep what we have
      var cache = QRApp.prefs.get('announce_cache', { a: null, cfg: null });
      if(a !== undefined) cache.a = a ? JSON.parse(JSON.stringify(a, function(k, v){ return (v && typeof v.toMillis === 'function') ? v.toMillis() : v; })) : null;
      if(cfg !== undefined) cache.cfg = cfg || null;
      QRApp.prefs.set('announce_cache', cache);
      announce = activeAnnouncement(cache.a); updateNotice = computeUpdateNotice(cache.cfg);
      QRApp.emit('announcement');
      return true;
    });
  };

  // ---------- deep links ----------
  var DL = QRApp.deeplink = {};
  var OPEN = {
    home: function(){ Nav.go('home'); },
    quran: function(){ Nav.go('quran'); },
    discover: function(){ Nav.go('discover'); },
    library: function(){ Nav.go('library'); }, bookmarks: function(){ Nav.go('library'); },
    more: function(){ Nav.go('more'); },
    inbox: function(){ Nav.push('inbox'); },
    settings: function(){ Nav.push('settings'); },
    search: function(){ QRApp.search.open(); },
    continue: function(){ QRApp.reader.continueReading(); },
    prayer: function(){ QRApp.features.open('prayer'); },
    qibla: function(){ QRApp.features.open('qibla'); },
    planner: function(){ QRApp.features.open('planner'); },
    stats: function(){ QRApp.features.open('stats'); },
    topics: function(){ QRApp.features.open('topics'); },
    hadith: function(){ QRApp.features.open('hadith'); },
    tafsir: function(){ QRApp.features.open('tafsir'); },
    downloads: function(){ QRApp.features.open('downloads'); }
  };
  // own properties only: 'constructor', 'toString', '__proto__' ... are not screen names
  function isScreen(k){ return typeof k === 'string' && Object.prototype.hasOwnProperty.call(OPEN, k); }
  function ownHost(host){
    host = String(host || '').toLowerCase();
    try{ if(host === location.host.toLowerCase()) return true; }catch(e){}
    return host === 'quranbangla.vercel.app';
  }
  // Links in the website's own e-mails (reset your password / sign out everywhere) are finished by the website's
  // flows, which read the query string when the page loads: the page is reloaded once with the same query.
  function isWebsiteEmailAction(q){
    return q.get('action') === 'logoutAllDevices' || (q.get('mode') === 'resetPassword' && !!q.get('oobCode'));
  }
  // handle('https://quranbangla.vercel.app/?surah=18&ayah=10') | handle({ screen:'prayer' }) | handle({ surah:36 }) | handle('continue')
  DL.handle = function(input){
    var p = {};
    try{
      if(typeof input === 'string'){
        if(isScreen(input)){ p = { screen: input }; }
        else{
          var u = new URL(input, location.origin);
          var scheme = u.protocol.replace(':', '');
          var okScheme = scheme === 'quranbangla' || ((scheme === 'https' || scheme === 'http') && ownHost(u.host));
          if(!okScheme) return false;
          if(scheme !== 'quranbangla' && isWebsiteEmailAction(u.searchParams)){
            if(location.search !== u.search) window.location.assign(location.origin + location.pathname + u.search);
            return true;
          }
          u.searchParams.forEach(function(v, k){ p[k] = v; });
          if(scheme === 'quranbangla' && u.host && !p.screen && isScreen(u.host.toLowerCase())) p.screen = u.host.toLowerCase();
        }
      } else if(input && typeof input === 'object'){
        if(input.link || input.url){ return DL.handle(String(input.link || input.url)) || (input.screen || input.surah ? DL.handle({ screen: input.screen, surah: input.surah, ayah: input.ayah }) : false); }
        p = input;
      } else return false;
    }catch(e){ return false; }
    // plain whole numbers only ("2abc", "1e3", "-1" are not numbers), and only values that exist in the Quran
    function num(v){ var s = (typeof v === 'number') ? String(v) : (typeof v === 'string' ? v : ''); return /^\d{1,4}$/.test(s) ? parseInt(s, 10) : 0; }
    var LIMITS = { surah: 114, juz: 30, page: 604, hizb: 60, ruku: 556 };      // same ranges as the reader
    var R = QRApp.reader;
    try{
      if(num(p.surah) >= 1 && num(p.surah) <= LIMITS.surah){ R.open({ type: 'surah', num: num(p.surah), ayah: num(p.ayah) || undefined, surah: num(p.surah) }); return true; }
      var types = ['juz', 'page', 'hizb', 'ruku'];
      for(var i = 0; i < types.length; i++){ if(num(p[types[i]]) >= 1 && num(p[types[i]]) <= LIMITS[types[i]]){ R.open({ type: types[i], num: num(p[types[i]]) }); return true; } }
      var key = p.screen || p.shortcut || p.open;
      if(isScreen(key)){ OPEN[key](); return true; }
    }catch(e){ QRApp.warn('deep link failed', e); }
    return false;
  };

  // ---------- inbox screen ----------
  var inboxEls = {};
  var CAT_ICON = { prayer: 'clock', reminder: 'bell', announcement: 'campaign', general: 'bell' };
  function renderInbox(){
    if(!inboxEls.root) return;
    inboxEls.root.innerHTML = '';
    if(!inbox.length){
      inboxEls.root.appendChild(UI.empty({
        icon: 'bell', title: T('কোনো নোটিফিকেশন নেই', 'No notifications'),
        text: T('নামাজের ওয়াক্ত, ঘোষণা ও রিমাইন্ডার এখানে জমা থাকবে। সেটিংস থেকে চালু করুন।', 'Prayer times, announcements and reminders will be kept here. Turn them on in Settings.'),
        actionLabel: T('নোটিফিকেশন সেটিংস', 'Notification settings'), onAction: function(){ Nav.push('settings', { focus: 'notifications' }); }
      }));
      return;
    }
    var list = h('div', { class: 'qa-list' });
    inbox.forEach(function(it){
      var ic = h('span', { class: 'qa-inbox-ic qa-cat-' + it.cat, html: icon(CAT_ICON[it.cat] || 'bell') });
      var main = h('div', { class: 'qa-list-main' },
        h('div', { class: 'qa-list-title' }, it.title || T('নোটিফিকেশন', 'Notification')),
        it.body ? h('div', { class: 'qa-list-sub qa-clamp' }, it.body) : null,
        h('div', { class: 'qa-caption' }, QRApp.timeAgo(it.ts)));
      var row = h('div', { class: 'qa-list-item qa-inbox-item' + (it.read ? '' : ' qa-unread'), role: 'button', tabindex: '0' }, ic, main);
      if(!it.read) row.appendChild(h('span', { class: 'qa-unread-dot', 'aria-label': T('অপঠিত', 'Unread') }));
      row.addEventListener('click', function(){
        if(!it.read){ it.read = true; saveInbox(); }
        var handled = QRApp.deeplink.handle({ link: it.link, screen: it.screen });
        if(!handled && it.link && /^https:\/\//i.test(it.link)) NAT.openExternal(it.link);
        else if(!handled) renderInbox();
      });
      list.appendChild(row);
    });
    inboxEls.root.appendChild(list);
  }
  Nav.register('inbox', {
    singleton: true,
    mount: function(el){ inboxEls.root = h('div', { class: 'qa-inbox' }); el.appendChild(inboxEls.root); },
    show: function(){ renderInbox(); },
    hide: function(){ notify.markAllRead(); },
    unmount: function(){ inboxEls = {}; },
    relocalize: function(el){ renderInbox(); },
    topbar: function(){
      return {
        lead: 'back', title: T('নোটিফিকেশন', 'Notifications'),
        actions: inbox.length ? [
          { icon: 'checkCircle', label: T('সব পঠিত', 'Mark all read'), onClick: function(){ notify.markAllRead(); renderInbox(); } },
          { icon: 'trash', label: T('সব মুছুন', 'Clear all'), onClick: function(){
            UI.confirm({ title: T('সব নোটিফিকেশন মুছবেন?', 'Clear all notifications?'), confirmLabel: T('মুছুন', 'Clear'), danger: true }).then(function(ok){ if(ok){ notify.clearInbox(); renderInbox(); Nav.refreshTopbar(); } });
          } }
        ] : []
      };
    }
  });
  QRApp.on('inbox', function(){ if(inboxEls.root && Nav.current() && Nav.current().id === 'inbox') renderInbox(); });

  // ---------- start ----------
  notify.init = function(){
    loadInbox();
    loadCachedAnnouncement();
    ensureChannels();
    attachListeners();
    // keep the token fresh for people who already turned prayer notifications on
    if(state.prayerNotify && pushReady()){
      notify.permission().then(function(p){ if(p === 'granted') waitForToken(9000); });
    }
    // re-assert the reminder (cheap and idempotent)
    var rp = reminderPrefs();
    if(rp.on && LN()) notify.permission().then(function(p){ if(p === 'granted') schedule(rp.h, rp.m); });
    importDelivered();
    notify.refreshAnnouncement(true);
    NAT.onResume(function(){ importDelivered(); notify.refreshAnnouncement(false); });
    NAT.onUrlOpen(function(url){ DL.handle(url); });
    QRApp.on('language', function(){ ensureChannels(); });
  };
  // links the app was started with (launcher shortcut / link opened from outside)
  // The native launch URL stays the same while the process lives, even when the page reloads (service-worker update,
  // e-mail link flow ...), so each launch link is acted on only once per app session.
  function launchSeen(url){ try{ return window.sessionStorage.getItem('qa_launch_seen') === url; }catch(e){ return false; } }
  function markLaunchSeen(url){ try{ window.sessionStorage.setItem('qa_launch_seen', url); }catch(e){} }
  notify.handleLaunch = function(){
    var P = window.QR_PLATFORM || {};
    if(P.launch && P.launch.shortcut) return Promise.resolve(DL.handle({ shortcut: P.launch.shortcut }));
    return NAT.getLaunchUrl().then(function(url){
      if(!url || launchSeen(url)) return false;
      markLaunchSeen(url);
      return DL.handle(url);
    });
  };
})();
