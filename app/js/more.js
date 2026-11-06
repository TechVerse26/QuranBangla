// ---------- Android app UI · More tab, Settings, Help, About ----------
//
//   More      account card · quick preferences · notifications · help · report a problem · share · about
//   Settings  appearance · reading · audio · prayer & reminders · storage & data · account
//   Help      FAQ (accordion)
//   About     version / build · update check · data sources · legal pages
//
// Everything here is a thin screen over things that already exist: the website's state + save*() helpers,
// QRApp.pick (shared pickers), QRApp.notify (push / reminders / inbox) and the website's own account flows
// (profile page, e-mail OTP + account deletion). Nothing in this file touches Quran text.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;

  // ---------- helpers ----------
  function safe(fn, dflt){ try{ return fn(); }catch(e){ QRApp.warn(e); return dflt; } }
  function NF(){ return QRApp.notify || null; }                 // notifications.js is loaded after this file
  function cfg(){ return window.QR_APP_CONFIG || {}; }          // app-config.js (support e-mail etc.)
  function siteBase(){
    try{ if(location.protocol === 'https:') return location.origin; }catch(e){}
    return cfg().siteUrl || 'https://quranbangla.vercel.app';
  }
  function pageUrl(name){ return siteBase().replace(/\/+$/, '') + '/' + name; }
  function openPage(name){ NAT.openExternal(pageUrl(name)); }
  function signedIn(){ try{ return !!(state.user && state.user.uid); }catch(e){ return false; } }
  function currentUser(){ try{ return signedIn() ? state.user : null; }catch(e){ return null; } }
  function pad2(n){ return (n < 10 ? '0' : '') + n; }
  function isOn(id){ var c = Nav.current(); return !!(c && c.id === id); }
  function appTitle(){ return T('কুরআন বাংলা', 'Quran Bangla'); }
  function chevron(){ return h('span', { class: 'qa-ic-wrap qa-muted', html: icon('chevronRight') }); }
  function httpsOnly(u){ return typeof u === 'string' && /^https:\/\//i.test(u); }
  function versionText(){
    var i = NAT.info || {};
    if(i.version) return i.version + (i.build ? ' (' + i.build + ')' : '');
    return T('ডেভেলপার প্রিভিউ', 'Developer preview');
  }
  function openMail(addr, subject){
    if(!addr) return;
    try{ window.location.href = 'mailto:' + addr + (subject ? '?subject=' + encodeURIComponent(subject) : ''); }
    catch(e){ NAT.copy(addr).then(function(){ UI.snack(T('ইমেইল ঠিকানা কপি হয়েছে', 'E-mail address copied')); }); }
  }

  // ---------- account actions (the website's own flows, reused) ----------
  function goProfile(){
    // The website's profile page (sign in / sign up / profile / security) is shown inside the app shell.
    if(typeof goToProfilePage === 'function'){ try{ goToProfilePage(signedIn() ? undefined : 'choice'); return; }catch(e){ QRApp.warn(e); } }
    Nav.openLegacy('profile');
  }
  function signOut(){
    UI.confirm({
      title: T('লগ আউট করবেন?', 'Sign out?'),
      text: T('এই ডিভাইসের ডেটা থাকবে, তবে আবার সাইন ইন না করা পর্যন্ত অ্যাকাউন্টের সাথে সিঙ্ক বন্ধ থাকবে।', 'Your data on this device stays, but syncing with your account stops until you sign in again.'),
      confirmLabel: T('লগ আউট', 'Sign out')
    }).then(function(ok){
      if(!ok) return;
      var p = (typeof fbAuth !== 'undefined' && fbAuth) ? fbAuth.signOut() : Promise.resolve();
      Promise.resolve(p).then(function(){ UI.snack(T('লগ আউট করা হয়েছে', 'Signed out')); renderAll(); })
        .catch(function(){ UI.snack(T('লগ আউট করা যায়নি, আবার চেষ্টা করুন', 'Could not sign out, please try again')); });
    });
  }
  function deleteAccount(){
    // confirmation -> e-mail code -> re-authentication if needed -> deletion (js/auth.js)
    if(typeof confirmDeleteAccount === 'function') confirmDeleteAccount();
    else openPage('account-deletion.html');
  }

  // ---------- erase everything on this device ----------
  function wipeStores(){
    var jobs = [];
    try{ localStorage.clear(); }catch(e){}
    try{
      sessionStorage.clear();
      if(window.QR_PLATFORM && window.QR_PLATFORM.preview) sessionStorage.setItem('qa_preview', '1');
    }catch(e){}
    if(window.caches && caches.keys){
      jobs.push(caches.keys().then(function(keys){ return Promise.all(keys.map(function(k){ return caches.delete(k); })); }).catch(function(){}));
    }
    if(navigator.serviceWorker && navigator.serviceWorker.getRegistrations){
      jobs.push(navigator.serviceWorker.getRegistrations().then(function(rs){ return Promise.all(rs.map(function(r){ return r.unregister(); })); }).catch(function(){}));
    }
    try{
      if(window.indexedDB && indexedDB.databases){
        jobs.push(indexedDB.databases().then(function(dbs){
          (dbs || []).forEach(function(d){ if(d && d.name){ try{ indexedDB.deleteDatabase(d.name); }catch(e){} } });
        }).catch(function(){}));
      } else if(window.indexedDB){
        ['quranBanglaDB', 'firebaseLocalStorageDb'].forEach(function(n){ try{ indexedDB.deleteDatabase(n); }catch(e){} });
      }
    }catch(e){}
    return Promise.all(jobs);
  }
  function eraseDevice(){
    UI.confirm({
      title: T('এই ডিভাইসের সব ডেটা মুছবেন?', 'Erase all data on this device?'),
      text: T('বুকমার্ক, নোট, ইতিহাস, সেটিংস, অফলাইন অডিও ও সাইন-ইন সেশন এই ফোন থেকে মুছে যাবে এবং অ্যাপ নতুনের মতো শুরু হবে (ইন্টারনেট লাগবে)। আপনার অনলাইন অ্যাকাউন্ট মুছবে না — অ্যাকাউন্ট মুছতে "অ্যাকাউন্ট মুছুন" ব্যবহার করুন।',
              'Bookmarks, notes, history, settings, offline audio and your sign-in session will be removed from this phone and the app starts fresh (internet needed). Your online account is not deleted — use "Delete account" for that.'),
      confirmLabel: T('সব মুছুন', 'Erase everything'), danger: true
    }).then(function(ok){
      if(!ok) return;
      var tasks = [];
      // things that live in the cloud for this device are switched off first (best effort, never blocks)
      var N = NF();
      if(N) tasks.push(Promise.resolve(safe(function(){ return N.disableReminder(); })).catch(function(){}));
      if(typeof disablePrayerPush === 'function') tasks.push(Promise.resolve(safe(function(){ return disablePrayerPush(); })).catch(function(){}));
      if(typeof fbAuth !== 'undefined' && fbAuth && fbAuth.currentUser) tasks.push(Promise.resolve(safe(function(){ return fbAuth.signOut(); })).catch(function(){}));
      UI.snack(T('মুছে ফেলা হচ্ছে…', 'Erasing…'), { duration: 6000 });
      Promise.race([Promise.all(tasks), QRApp.sleep(4000)]).then(wipeStores).then(function(){ return QRApp.sleep(150); }).then(function(){ location.reload(); });
    });
  }
  function clearTemp(){
    UI.confirm({
      title: T('সাময়িক ডেটা পরিষ্কার করবেন?', 'Clear temporary data?'),
      text: T('সাম্প্রতিক খোঁজ, সাম্প্রতিক ফিচার ও আয়াতের প্রিভিউ ক্যাশ মুছবে। বুকমার্ক, নোট ও অগ্রগতি মুছবে না।', 'Recent searches, recent features and the ayah preview cache will be cleared. Bookmarks, notes and progress are kept.'),
      confirmLabel: T('পরিষ্কার করুন', 'Clear')
    }).then(function(ok){
      if(!ok) return;
      ['ayah_cache', 'recent_searches', 'recent_features'].forEach(function(k){ QRApp.prefs.remove(k); });
      QRApp.emit('cache-cleared');
      UI.snack(T('সাময়িক ডেটা পরিষ্কার হয়েছে', 'Temporary data cleared'));
    });
  }

  // ---------- share ----------
  function shareApp(){
    NAT.share({
      title: appTitle(),
      text: T('কুরআন বাংলা — বাংলা অনুবাদ ও তিলাওয়াতসহ কুরআন পড়ুন ও শুনুন।', 'Quran Bangla — read and listen to the Quran with Bangla translation and recitation.'),
      url: siteBase()
    }).then(function(r){
      if(!r) return;
      if(r.ok && r.method === 'clipboard') UI.snack(T('লিংক কপি হয়েছে', 'Link copied'));
      else if(!r.ok && !r.cancelled) UI.snack(T('শেয়ার করা যায়নি', 'Could not share'));
    });
  }

  // ---------- report a problem -> system_errors (the admin panel's monitoring tab) ----------
  var lastReportAt = 0, reportCount = 0;
  function sendReport(kindId, kindLabel, text){
    if(typeof fbDb === 'undefined' || !fbDb || typeof firebase === 'undefined'){
      return Promise.reject(new Error('offline-backend'));
    }
    var i = NAT.info || {};
    var tech = [
      'user report · ' + kindId,
      'app ' + (i.version || 'dev') + (i.build ? ' (' + i.build + ')' : '') + ' · ui ' + QRApp.version + ' · ' + (NAT.platform || 'web'),
      'lang ' + (safe(function(){ return state.language; }, '') || '') + ' · online ' + (NAT.network && NAT.network.online ? 'yes' : 'no'),
      'screen ' + ((Nav.current() && Nav.current().id) || '')
    ].join('\n');
    // exactly the fields firestore.rules allows for system_errors (create-only for everyone)
    return fbDb.collection('system_errors').add({
      message: ('[' + kindLabel + '] ' + text).slice(0, 500),
      stack: tech.slice(0, 2000),
      severity: 'warning',
      page: 'app:' + ((Nav.current() && Nav.current().id) || ''),
      userAgent: navigator.userAgent,
      uid: signedIn() ? state.user.uid : null,
      resolved: false,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  function openReport(prefill){
    var kinds = [
      { id: 'bug', label: T('কিছু কাজ করছে না', 'Something is broken') },
      { id: 'content', label: T('লেখা বা অনুবাদে ভুল', 'Mistake in text') },
      { id: 'idea', label: T('পরামর্শ', 'Suggestion') }
    ];
    var kind = kinds[0];
    var chips = h('div', { class: 'qa-chips qa-wrap' });
    function drawChips(){
      chips.innerHTML = '';
      kinds.forEach(function(k){ chips.appendChild(UI.chip(k.label, function(){ kind = k; drawChips(); }, k.id === kind.id)); });
    }
    drawChips();
    var ta = h('textarea', { class: 'qa-input qa-textarea', rows: '5', maxlength: '420', placeholder: T('কী হয়েছে লিখুন — কোন স্ক্রিনে, কী করার সময়…', 'Tell us what happened — which screen, what you were doing…') });
    if(prefill) ta.value = prefill;
    var note = h('p', { class: 'qa-hint' }, T(
      'পাঠানো হবে: আপনার বার্তা, অ্যাপের সংস্করণ ও ডিভাইসের ব্রাউজার তথ্য' + (signedIn() ? ' এবং আপনার অ্যাকাউন্ট আইডি।' : '।') + ' এতে কোনো পাসওয়ার্ড বা অবস্থান থাকে না।',
      'Sent: your message, the app version and browser info of your device' + (signedIn() ? ' and your account ID.' : '.') + ' No password or location is included.'));
    var contact = null;
    if(cfg().supportEmail){
      contact = h('p', { class: 'qa-hint' }, T('ইমেইলেও লিখতে পারেন: ', 'You can also write to: '), h('button', { class: 'qa-link-inline', type: 'button', onClick: function(){ openMail(cfg().supportEmail, appTitle()); } }, cfg().supportEmail));
    }
    var body = h('div', { class: 'qa-stack', style: { gap: '12px' } }, chips, ta, note, contact);
    UI.sheet({
      title: T('সমস্যা জানান', 'Report a problem'), body: body,
      actions: [
        { label: T('বাতিল', 'Cancel'), kind: 'text' },
        { label: T('পাঠান', 'Send'), kind: 'filled', closes: false, onClick: function(api){
          var text = (ta.value || '').trim();
          if(text.length < 10){ UI.snack(T('একটু বিস্তারিত লিখুন (কমপক্ষে ১০ অক্ষর)', 'Please write a little more (at least 10 characters)')); return; }
          if(!NAT.network.online){ UI.snack(T('ইন্টারনেট সংযোগ নেই — সংযোগ ফিরলে আবার পাঠান', 'You are offline — try again when you are back online')); return; }
          if(Date.now() - lastReportAt < 30000 || reportCount >= 5){ UI.snack(T('কিছুক্ষণ পরে আবার পাঠান', 'Please wait a little before sending another report')); return; }
          lastReportAt = Date.now();
          sendReport(kind.id, kind.label, text).then(function(){
            reportCount++;
            api.close();
            UI.snack(T('ধন্যবাদ! আপনার বার্তা পাঠানো হয়েছে।', 'Thank you! Your message was sent.'));
          }).catch(function(e){
            lastReportAt = 0;
            QRApp.warn('report failed', e);
            UI.snack(T('পাঠানো যায়নি — একটু পরে আবার চেষ্টা করুন', 'Could not send — please try again in a moment'));
          });
        } }
      ]
    });
  }

  // ---------- small shared bits ----------
  function accountCard(){
    var u = currentUser();
    var card = h('section', { class: 'qa-card qa-account' });
    if(u){
      var name = u.name || (u.email ? String(u.email).split('@')[0] : T('ব্যবহারকারী', 'User'));
      var main = h('button', { class: 'qa-account-main', type: 'button', 'aria-label': T('প্রোফাইল খুলুন', 'Open profile') },
        UI.avatar(u, 56),
        h('span', { class: 'qa-grow qa-account-text' },
          h('span', { class: 'qa-account-name' }, name),
          u.email ? h('span', { class: 'qa-account-mail' }, u.email) : null),
        chevron());
      main.addEventListener('click', goProfile);
      card.appendChild(main);
    } else {
      card.appendChild(h('div', { class: 'qa-account-main qa-static' },
        UI.avatar(null, 56),
        h('span', { class: 'qa-grow qa-account-text' },
          h('span', { class: 'qa-account-name' }, T('অতিথি হিসেবে আছেন', 'You are using the app as a guest')),
          h('span', { class: 'qa-account-mail' }, T('সাইন ইন করলে প্রোফাইল ও পড়ার অগ্রগতি আপনার অ্যাকাউন্টে সংরক্ষিত থাকবে।', 'Sign in to keep your profile and reading progress with your account.')))));
      card.appendChild(UI.button(T('সাইন ইন / অ্যাকাউন্ট খুলুন', 'Sign in / Create account'), { kind: 'filled', icon: 'login', block: true, onClick: goProfile }));
    }
    return card;
  }

  // ======================================================================
  //  MORE (tab)
  // ======================================================================
  var more = { root: null };

  function renderMore(){
    var root = more.root;
    if(!root) return;
    root.innerHTML = '';
    root.appendChild(accountCard());

    // quick preferences
    var themeRow = UI.row({ icon: 'palette', title: T('থিম', 'Theme'), value: QRApp.pick.themeLabel(), onClick: function(){ QRApp.pick.theme().then(function(){ themeRow.setValue(QRApp.pick.themeLabel()); }); } });
    var langRow = UI.row({ icon: 'globe', title: T('অ্যাপের ভাষা', 'App language'), value: QRApp.pick.languageLabel(), onClick: function(){ QRApp.pick.language(); } });
    var recRow = UI.row({ icon: 'mic', title: T('ক্বারী', 'Reciter'), value: QRApp.pick.reciterLabel(), onClick: function(){ QRApp.pick.reciter().then(function(){ recRow.setValue(QRApp.pick.reciterLabel()); }); } });
    root.appendChild(UI.section(T('পছন্দ', 'Preferences')));
    root.appendChild(UI.group([
      themeRow, langRow, recRow,
      UI.row({ icon: 'settings', title: T('সেটিংস', 'Settings'), sub: T('পড়া, অডিও, নোটিফিকেশন ও ডেটা', 'Reading, audio, notifications and data'), onClick: function(){ Nav.push('settings'); } })
    ]));

    // notifications
    var N = NF();
    var unread = N ? N.unread() : 0;
    var trail = h('span', { class: 'qa-trail-group' });
    if(unread > 0) trail.appendChild(h('span', { class: 'qa-count-pill', 'aria-label': T(NUM(unread) + 'টি অপঠিত', unread + ' unread') }, unread > 99 ? '99+' : NUM(unread)));
    trail.appendChild(chevron());
    root.appendChild(UI.group([
      UI.row({ icon: 'bell', title: T('নোটিফিকেশন', 'Notifications'), sub: unread > 0 ? T(NUM(unread) + 'টি নতুন', unread + ' new') : T('নামাজ, ঘোষণা ও রিমাইন্ডারের ইতিহাস', 'History of prayer, announcements and reminders'), trail: trail, onClick: function(){ Nav.push('inbox'); } })
    ]));

    // help
    root.appendChild(UI.section(T('সহায়তা', 'Support')));
    root.appendChild(UI.group([
      UI.row({ icon: 'help', title: T('সহায়তা ও সাধারণ প্রশ্ন', 'Help & FAQ'), onClick: function(){ Nav.push('help'); } }),
      UI.row({ icon: 'bug', title: T('সমস্যা জানান', 'Report a problem'), sub: T('ভুল বা পরামর্শ আমাদের জানান', 'Tell us about a bug or an idea'), onClick: function(){ openReport(); } }),
      UI.row({ icon: 'share', title: T('অ্যাপটি শেয়ার করুন', 'Share the app'), onClick: shareApp }),
      UI.row({ icon: 'info', title: T('অ্যাপ সম্পর্কে', 'About'), value: NAT.info && NAT.info.version ? NAT.info.version : '', onClick: function(){ Nav.push('about'); } })
    ]));

    // account actions
    if(signedIn()){
      root.appendChild(UI.section(T('অ্যাকাউন্ট', 'Account')));
      root.appendChild(UI.group([
        UI.row({ icon: 'logout', title: T('লগ আউট', 'Sign out'), onClick: signOut }),
        UI.row({ icon: 'trash', title: T('অ্যাকাউন্ট মুছুন', 'Delete account'), danger: true, onClick: deleteAccount })
      ]));
    }
    root.appendChild(h('p', { class: 'qa-footer-note' }, appTitle() + ' · ' + versionText()));
  }

  Nav.register('more', {
    tab: true, order: 5, icon: 'moreH', label: ['আরও', 'More'],
    mount: function(el){ more.root = h('div', { class: 'qa-more' }); el.appendChild(more.root); renderMore(); },
    show: function(){ renderMore(); },
    unmount: function(){ more.root = null; },
    topbar: function(){ return { title: T('আরও', 'More') }; }
  });

  // ======================================================================
  //  SETTINGS
  // ======================================================================
  var S = { root: null, live: [], switches: [], accHost: null, permHost: null, remSwitch: null, timeRow: null, ticker: 0 };

  function locationLabel(){
    var l = safe(function(){ return state.prayerLocation; }, null);
    if(!l) return T('সেট করা নেই', 'Not set');
    return l.label || T('বর্তমান অবস্থান', 'Current location');
  }
  function offlineSummary(){
    var items = [];
    try{ items = (state.offlineSurahs || []).filter(function(o){ return o && o.surah >= 1 && o.surah <= 114; }); }catch(e){}
    if(!items.length) return T('কিছু নেই', 'None');
    var mb = 0;
    items.forEach(function(o){ try{ mb += dlmEstimateMB(o.ayahCount || 0); }catch(e){} });
    return T(NUM(items.length) + 'টি সূরা', items.length + (items.length === 1 ? ' surah' : ' surahs')) + (mb ? ' · ~' + QRApp.formatBytes(mb * 1048576) : '');
  }

  // type="time" in a dialog -> {h, m} | null
  function pickTime(hr, min){
    return new Promise(function(resolve){
      var input = h('input', { class: 'qa-input', type: 'time', value: pad2(hr) + ':' + pad2(min), 'aria-label': T('সময়', 'Time') });
      var val = null;
      UI.dialog({
        title: T('রিমাইন্ডারের সময়', 'Reminder time'),
        body: h('div', { style: { marginBottom: '16px' } }, input),
        actions: [
          { label: T('বাতিল', 'Cancel'), kind: 'text', value: null },
          { label: T('ঠিক আছে', 'OK'), kind: 'filled', value: 'ok', onClick: function(){
            var m = /^(\d{1,2}):(\d{2})/.exec(input.value || '');
            if(!m){ UI.snack(T('সময় বেছে নিন', 'Pick a time')); return false; }
            val = { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
            return true;
          } }
        ]
      }).then(function(v){ resolve(v === 'ok' ? val : null); });
    });
  }

  function syncReminderUi(){
    var N = NF();
    if(!N || !S.remSwitch || !S.timeRow) return;
    var r = N.reminder();
    S.remSwitch.input.checked = !!r.on;
    S.timeRow.setValue(N.reminderLabel());
    if(r.on) S.timeRow.removeAttribute('disabled'); else S.timeRow.setAttribute('disabled', '');
  }
  function updatePermBanner(){
    var N = NF();
    if(!N || !S.permHost) return;
    N.permission().then(function(p){
      if(!S.permHost) return;
      S.permHost.innerHTML = '';
      if(p === 'denied'){
        S.permHost.appendChild(UI.banner(T('ফোনের সেটিংসে এই অ্যাপের নোটিফিকেশন বন্ধ আছে। চালু করতে Settings > Apps > কুরআন বাংলা > Notifications দেখুন।', 'Notifications are turned off for this app in your phone settings. Turn them on in Settings > Apps > Quran Bangla > Notifications.'), 'bell', 'info'));
      }
    });
  }

  function refreshLive(){
    S.live.forEach(function(it){
      var v = ''; try{ v = it.get(); }catch(e){}
      if(v !== it.last){ it.last = v; it.row.setValue(v); }
    });
  }
  function refreshSettings(){
    refreshLive();
    S.switches.forEach(function(it){
      var v = !!safe(it.get, false);
      if(it.row.input.checked !== v) it.row.input.checked = v;
    });
    syncReminderUi();
    updatePermBanner();
    renderAccountSection();
  }
  function startTicker(){ stopTicker(); S.ticker = setInterval(refreshLive, 1200); }
  function stopTicker(){ if(S.ticker){ clearInterval(S.ticker); S.ticker = 0; } }

  function renderAccountSection(){
    if(!S.accHost) return;
    S.accHost.innerHTML = '';
    var u = currentUser();
    var rows = [];
    if(u){
      rows.push(UI.row({ icon: 'person', title: T('প্রোফাইল ও নিরাপত্তা', 'Profile & security'), sub: u.email || '', onClick: goProfile }));
      rows.push(UI.row({ icon: 'logout', title: T('লগ আউট', 'Sign out'), onClick: signOut }));
      rows.push(UI.row({ icon: 'trash', title: T('অ্যাকাউন্ট মুছুন', 'Delete account'), sub: T('অ্যাকাউন্ট ও ক্লাউডের অগ্রগতি স্থায়ীভাবে মুছে যায়', 'Permanently deletes your account and cloud progress'), danger: true, onClick: deleteAccount }));
    } else {
      rows.push(UI.row({ icon: 'login', title: T('সাইন ইন / অ্যাকাউন্ট খুলুন', 'Sign in / Create account'), onClick: goProfile }));
    }
    rows.push(UI.row({ icon: 'doc', title: T('অ্যাকাউন্ট ও ডেটা মুছে ফেলার নির্দেশনা', 'How to delete your account and data'), onClick: function(){ openPage('account-deletion.html'); } }));
    S.accHost.appendChild(UI.group(rows));
  }

  function buildSettings(el){
    S.live = []; S.switches = [];
    var root = h('div', { class: 'qa-settings' });
    S.root = root;

    function live(row, get){ S.live.push({ row: row, get: get, last: null }); return row; }
    function sw(row, get){ S.switches.push({ row: row, get: get }); return row; }
    function section(id, title, children, note){
      var s = h('section', { class: 'qa-set-section', 'data-section': id }, UI.section(title));
      children.forEach(function(c){ if(c) s.appendChild(c); });
      if(note) s.appendChild(h('p', { class: 'qa-hint' }, note));
      return s;
    }
    var pick = QRApp.pick;

    // ----- appearance -----
    var themeRow = live(UI.row({ icon: 'palette', title: T('থিম', 'Theme'), value: pick.themeLabel(), onClick: function(){ pick.theme().then(function(){ themeRow.setValue(pick.themeLabel()); }); } }), pick.themeLabel);
    var langRow = live(UI.row({ icon: 'globe', title: T('অ্যাপের ভাষা', 'App language'), value: pick.languageLabel(), onClick: function(){ pick.language(); } }), pick.languageLabel);
    var appearance = [
      themeRow, langRow,
      sw(UI.switchRow({ icon: 'tune', title: T('স্পর্শে কম্পন', 'Haptic feedback'), sub: T('বোতাম ও নির্বাচনে হালকা কম্পন', 'A light vibration on taps and selections'), checked: QRApp.prefs.get('haptics', true) !== false, onChange: function(v){ QRApp.prefs.set('haptics', !!v); if(v) NAT.haptic('light'); } }), function(){ return QRApp.prefs.get('haptics', true) !== false; })
    ];
    root.appendChild(section('appearance', T('চেহারা', 'Appearance'), [UI.group(appearance)]));

    // ----- reading -----
    var trRow = live(UI.row({ icon: 'translate', title: T('অনুবাদের ভাষা', 'Translation'), value: pick.translationLabel(), onClick: function(){ pick.translation().then(function(){ trRow.setValue(pick.translationLabel()); }); } }), pick.translationLabel);
    var cmpRow = live(UI.row({ icon: 'list', title: T('তুলনামূলক অনুবাদ', 'Compare translations'), value: pick.compareLabel(), onClick: function(){ pick.compare().then(function(){ cmpRow.setValue(pick.compareLabel()); }); } }), pick.compareLabel);
    var reading = [
      UI.row({ icon: 'textSize', title: T('পড়ার সেটিংস', 'Reading settings'), sub: T('লেখার আকার, উচ্চারণ, তাজবীদ রং, হাফেজ মোড', 'Text size, transliteration, tajweed colours, hafez mode'), onClick: function(){ QRApp.reader.openSettings(); } }),
      trRow, cmpRow
    ];
    if('wakeLock' in navigator){
      reading.push(sw(UI.switchRow({ icon: 'visibility', title: T('পড়ার সময় স্ক্রিন চালু রাখুন', 'Keep screen on while reading'), checked: !!QRApp.prefs.get('keep_awake', false), onChange: function(v){ QRApp.prefs.set('keep_awake', !!v); } }), function(){ return !!QRApp.prefs.get('keep_awake', false); }));
    }
    root.appendChild(section('reading', T('পড়া', 'Reading'), [UI.group(reading)],
      T('আরবি পাঠ ও অনুবাদ নির্ভরযোগ্য সূত্র থেকে যেমন আছে তেমন দেখানো হয় — অ্যাপ সেগুলো বদলায় না।', 'Arabic text and translations are shown exactly as provided by their sources — the app never changes them.')));

    // ----- audio -----
    var recRow = live(UI.row({ icon: 'mic', title: T('ক্বারী', 'Reciter'), value: pick.reciterLabel(), onClick: function(){ pick.reciter().then(function(){ recRow.setValue(pick.reciterLabel()); }); } }), pick.reciterLabel);
    var dlRow = live(UI.row({ icon: 'cloudDownload', title: T('অফলাইন ডাউনলোড', 'Offline downloads'), value: offlineSummary(), onClick: function(){ QRApp.features.open('downloads'); } }), offlineSummary);
    root.appendChild(section('audio', T('অডিও', 'Audio'), [UI.group([recRow, dlRow])]));

    // ----- prayer & reminders -----
    var locRow = live(UI.row({ icon: 'clock', title: T('নামাজের সময় ও অবস্থান', 'Prayer times & location'), value: locationLabel(), onClick: function(){ QRApp.features.open('prayer'); } }), locationLabel);
    var methodRow = live(UI.row({ icon: 'tune', title: T('গণনা পদ্ধতি', 'Calculation method'), value: pick.prayerMethodLabel(), onClick: function(){ pick.prayerMethod().then(function(){ methodRow.setValue(pick.prayerMethodLabel()); }); } }), pick.prayerMethodLabel);
    var prayerSwitch = sw(UI.switchRow({
      icon: 'bell', title: T('ওয়াক্তের নোটিফিকেশন', 'Prayer time notifications'), sub: T('প্রতি ওয়াক্ত শুরু হলে জানাবে', 'Tells you when each prayer time begins'),
      checked: !!(NF() && NF().prayerEnabled()),
      onChange: function(on){
        var N = NF(); if(!N) return false;
        return (on ? N.enablePrayer() : N.disablePrayer()).then(function(r){ updatePermBanner(); return on ? r : true; });
      }
    }), function(){ return !!(NF() && NF().prayerEnabled()); });
    var remSwitch = S.remSwitch = UI.switchRow({
      icon: 'history', title: T('প্রতিদিনের তিলাওয়াতের রিমাইন্ডার', 'Daily reading reminder'), sub: T('প্রতিদিন নির্দিষ্ট সময়ে মনে করিয়ে দেবে', 'A reminder at the same time every day'),
      checked: !!(NF() && NF().reminder().on),
      onChange: function(on){
        var N = NF(); if(!N) return false;
        if(on) return N.enableReminder().then(function(ok){ syncReminderUi(); updatePermBanner(); return ok; });
        return N.disableReminder().then(function(){ syncReminderUi(); return true; });
      }
    });
    var timeRow = S.timeRow = UI.row({
      icon: 'clock', title: T('রিমাইন্ডারের সময়', 'Reminder time'), value: NF() ? NF().reminderLabel() : '',
      onClick: function(){
        var N = NF(); if(!N) return;
        var r = N.reminder();
        pickTime(r.hour, r.minute).then(function(t){
          if(!t) return;
          N.enableReminder(t.h, t.m).then(function(ok){ syncReminderUi(); if(ok) UI.snack(T('রিমাইন্ডার সেট হয়েছে', 'Reminder set')); });
        });
      }
    });
    S.permHost = h('div', {});
    var inboxRow = UI.row({ icon: 'campaign', title: T('নোটিফিকেশনের ইতিহাস', 'Notification history'), onClick: function(){ Nav.push('inbox'); } });
    root.appendChild(section('notifications', T('নামাজ ও রিমাইন্ডার', 'Prayer & reminders'), [S.permHost, UI.group([locRow, methodRow, prayerSwitch, remSwitch, timeRow, inboxRow])],
      T('ওয়াক্তের নোটিফিকেশন চালু করলে আপনার বেছে নেওয়া অবস্থানের স্থানাঙ্ক, গণনা পদ্ধতি ও ডিভাইস টোকেন সময় হিসাব করার জন্য আমাদের সার্ভারে সংরক্ষিত হয়; বন্ধ করলে তা মুছে যায়। রিমাইন্ডার শুধু আপনার ফোনেই সেট থাকে।',
        'When prayer notifications are on, the coordinates of the location you chose, the calculation method and a device token are stored on our server to work out the times; turning them off removes them. The reading reminder lives on your phone only.')));
    syncReminderUi();

    // ----- storage & data -----
    root.appendChild(section('storage', T('স্টোরেজ ও ডেটা', 'Storage & data'), [UI.group([
      UI.row({ icon: 'storage', title: T('সাময়িক ডেটা পরিষ্কার করুন', 'Clear temporary data'), sub: T('সাম্প্রতিক খোঁজ ও প্রিভিউ ক্যাশ', 'Recent searches and preview cache'), onClick: clearTemp }),
      UI.row({ icon: 'trash', title: T('এই ডিভাইসের সব ডেটা মুছুন', 'Erase all data on this device'), sub: T('বুকমার্ক, নোট, সেটিংস, অফলাইন অডিও', 'Bookmarks, notes, settings, offline audio'), danger: true, onClick: eraseDevice })
    ])], T('বুকমার্ক, নোট, শোনার ইতিহাস ও শেষ পড়ার জায়গা শুধু এই ডিভাইসে থাকে। সাইন ইন করলে প্রোফাইল ও পড়ার অগ্রগতি (স্ট্রিক, পরিসংখ্যান) আপনার অ্যাকাউন্টে সংরক্ষিত হয়।',
           'Bookmarks, notes, listening history and your last reading position stay on this device only. When you sign in, your profile and reading progress (streak, statistics) are stored with your account.')));

    // ----- account -----
    S.accHost = h('div', {});
    root.appendChild(section('account', T('অ্যাকাউন্ট', 'Account'), [S.accHost]));
    renderAccountSection();

    el.appendChild(root);
  }

  function focusSection(id){
    if(!id || !S.root) return;
    setTimeout(function(){
      var target = S.root && S.root.querySelector('[data-section="' + id + '"]');
      if(target && target.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'auto' });
    }, 80);
  }

  Nav.register('settings', {
    singleton: true,
    mount: function(el){ buildSettings(el); },
    show: function(params){ refreshSettings(); startTicker(); if(params && params.focus) focusSection(params.focus); },
    hide: function(){ stopTicker(); },
    unmount: function(){ stopTicker(); S.root = null; S.accHost = null; S.permHost = null; S.remSwitch = null; S.timeRow = null; S.live = []; S.switches = []; },
    topbar: function(){ return { lead: 'back', title: T('সেটিংস', 'Settings') }; }
  });

  // ======================================================================
  //  HELP
  // ======================================================================
  function faq(){
    return [
      { q: T('শেষ যেখানে পড়ছিলাম সেখান থেকে কীভাবে শুরু করব?', 'How do I continue where I stopped?'),
        a: T('হোম স্ক্রিনের "পড়া চালিয়ে যান" কার্ডে ট্যাপ করুন। অ্যাপ আপনার শেষ পড়ার জায়গা এই ডিভাইসে মনে রাখে।', 'Tap the "Continue reading" card on Home. The app remembers your last reading position on this device.') },
      { q: T('আয়াত বুকমার্ক, কপি বা শেয়ার করব কীভাবে?', 'How do I bookmark, copy or share an ayah?'),
        a: T('প্রতিটি আয়াতের উপরের সারিতে শুনুন, বুকমার্ক, কপি ও শেয়ার বোতাম আছে। ⋮ বোতামে নোট লেখা, এই আয়াত থেকে শোনা ও AI তাফসীর পাবেন। বুকমার্ক করা আয়াত "সংরক্ষিত" ট্যাবে থাকে।', 'Each ayah has play, bookmark, copy and share buttons in its top row. The ⋮ button offers notes, "play from here" and AI tafsir. Bookmarked ayahs are kept in the "Saved" tab.') },
      { q: T('লেখার আকার, অনুবাদ বা উচ্চারণ কীভাবে বদলাব?', 'How do I change text size, translation or transliteration?'),
        a: T('আরও > সেটিংস > পড়া অথবা পড়ার পাতার মেনু থেকে "পড়ার সেটিংস" খুলুন। সেখানে আরবি ও অনুবাদের আকার, অনুবাদ দেখানো, উচ্চারণ, তাজবীদ রং ও হাফেজ মোড পাবেন।', 'Open More > Settings > Reading, or "Reading settings" from the reader menu: Arabic and translation size, show translation, transliteration, tajweed colours and hafez mode.') },
      { q: T('তিলাওয়াত শুনব কীভাবে? ক্বারী কীভাবে বদলাব?', 'How do I listen? How do I change the reciter?'),
        a: T('আয়াতের "শুনুন" বোতাম বা সূরার প্লে বোতাম চাপুন। ক্বারী বদলাতে আরও > ক্বারী (অথবা সেটিংস > অডিও) ব্যবহার করুন।', 'Tap the play button of an ayah or of the surah. Change the reciter from More > Reciter (or Settings > Audio).') },
      { q: T('ইন্টারনেট ছাড়া কীভাবে শুনব?', 'How do I listen without internet?'),
        a: T('আবিষ্কার > অফলাইন ডাউনলোড থেকে সূরার অডিও ডাউনলোড করুন। ডাউনলোড করা সূরা ইন্টারনেট ছাড়াই শোনা যায়। নতুন সূরার লেখা ও অনুবাদ লোড করতে ইন্টারনেট লাগতে পারে।', 'Download a surah\'s audio from Discover > Offline downloads. Downloaded surahs play without internet. Loading the text and translation of a new surah may need internet.'),
        action: { label: T('অফলাইন ডাউনলোড খুলুন', 'Open offline downloads'), run: function(){ QRApp.features.open('downloads'); } } },
      { q: T('নামাজের নোটিফিকেশন আসছে না', 'Prayer notifications do not arrive'),
        a: T('আরও > সেটিংস > নামাজ ও রিমাইন্ডার-এ অবস্থান ঠিক করে "ওয়াক্তের নোটিফিকেশন" চালু করুন এবং নোটিফিকেশনের অনুমতি দিন। ফোনের সেটিংসে অ্যাপের নোটিফিকেশন বন্ধ থাকলে বা ব্যাটারি সেভার কড়া হলে নোটিফিকেশন দেরিতে আসতে পারে।', 'In More > Settings > Prayer & reminders, set your location, turn on "Prayer time notifications" and allow notifications. If notifications are off for the app in your phone settings, or battery saver is strict, they may arrive late.'),
        action: { label: T('নোটিফিকেশন সেটিংস', 'Notification settings'), run: function(){ Nav.push('settings', { focus: 'notifications' }); } } },
      { q: T('আমার ডেটা কোথায় থাকে?', 'Where is my data stored?'),
        a: T('বুকমার্ক, নোট, শোনার ইতিহাস ও শেষ পড়ার জায়গা শুধু এই ফোনে থাকে। সাইন ইন করলে প্রোফাইল ও পড়ার অগ্রগতি (স্ট্রিক, পরিসংখ্যান) অ্যাকাউন্টে সংরক্ষিত হয়। এই ফোনের সব ডেটা মুছতে আরও > সেটিংস > স্টোরেজ ও ডেটা দেখুন।', 'Bookmarks, notes, listening history and your last reading position stay on this phone. When you sign in, your profile and reading progress (streak, statistics) are stored with your account. To erase everything on this phone see More > Settings > Storage & data.') },
      { q: T('থিম বা ভাষা কীভাবে বদলাব?', 'How do I change the theme or language?'),
        a: T('আরও ট্যাবে "থিম" ও "অ্যাপের ভাষা" আছে। থিম লাইট, ডার্ক বা ফোনের সেটিং অনুযায়ী হতে পারে।', 'The More tab has "Theme" and "App language". The theme can be light, dark or follow your phone.') },
      { q: T('অ্যাকাউন্ট মুছব কীভাবে?', 'How do I delete my account?'),
        a: T('সাইন ইন থাকলে আরও > অ্যাকাউন্ট মুছুন চাপুন; ইমেইলে পাঠানো কোড দিয়ে নিশ্চিত করলে অ্যাকাউন্ট ও ক্লাউডের অগ্রগতি স্থায়ীভাবে মুছে যায়। সাইন ইন করতে না পারলে নির্দেশনা পেজ দেখুন।', 'When signed in, tap More > Delete account; after you confirm with the code sent to your e-mail, your account and cloud progress are permanently deleted. If you cannot sign in, see the instructions page.'),
        action: { label: T('নির্দেশনা পেজ', 'Instructions page'), run: function(){ openPage('account-deletion.html'); } } },
      { q: T('কোনো ভুল বা সমস্যা পেয়েছি', 'I found a mistake or a problem'),
        a: T('আরও > সমস্যা জানান থেকে আমাদের লিখুন — কোন স্ক্রিনে কী হয়েছে জানালে সুবিধা হয়।', 'Write to us from More > Report a problem — tell us which screen and what happened.'),
        action: { label: T('সমস্যা জানান', 'Report a problem'), run: function(){ openReport(); } } }
    ];
  }
  function buildHelp(el){
    var root = h('div', { class: 'qa-help' });
    root.appendChild(h('p', { class: 'qa-hint qa-help-intro' }, T('সচরাচর প্রশ্নের উত্তর', 'Answers to common questions')));
    var list = h('div', { class: 'qa-group qa-faq' });
    faq().forEach(function(item){
      var wrap = h('div', { class: 'qa-faq-item' });
      var btn = h('button', { class: 'qa-faq-q', type: 'button', 'aria-expanded': 'false' },
        h('span', { class: 'qa-grow' }, item.q), h('span', { class: 'qa-faq-chev', html: icon('chevronDown') }));
      var ans = h('div', { class: 'qa-faq-a' }, h('p', {}, item.a));
      ans.hidden = true;
      if(item.action) ans.appendChild(UI.button(item.action.label, { kind: 'tonal', small: true, onClick: item.action.run }));
      btn.addEventListener('click', function(){
        var open = ans.hidden;
        ans.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        wrap.classList.toggle('qa-open', open);
      });
      wrap.appendChild(btn); wrap.appendChild(ans); list.appendChild(wrap);
    });
    root.appendChild(list);
    root.appendChild(h('div', { class: 'qa-card qa-card-tonal qa-help-foot' },
      h('div', { class: 'qa-hero-title' }, T('উত্তর পাননি?', 'Did not find an answer?')),
      h('div', { class: 'qa-hero-sub' }, T('আপনার সমস্যাটি আমাদের জানান।', 'Tell us about your problem.')),
      UI.button(T('সমস্যা জানান', 'Report a problem'), { kind: 'filled', icon: 'bug', small: true, onClick: function(){ openReport(); } })));
    el.appendChild(root);
  }
  Nav.register('help', {
    singleton: true,
    mount: function(el){ buildHelp(el); },
    topbar: function(){ return { lead: 'back', title: T('সহায়তা ও সাধারণ প্রশ্ন', 'Help & FAQ') }; }
  });

  // ======================================================================
  //  ABOUT (+ update check)
  // ======================================================================
  function playUpdateInfo(){
    var AU = NAT.plugin('AppUpdate');
    if(!AU || typeof AU.getAppUpdateInfo !== 'function') return Promise.resolve(null);
    return AU.getAppUpdateInfo().then(function(i){
      var avail = !!(i && (i.updateAvailability === 2 || i.updateAvailability === 'UPDATE_AVAILABLE'));
      return { available: avail, info: i || {} };
    }).catch(function(){ return null; });          // not installed from Google Play, or no Play services
  }
  function offerPlayUpdate(p){
    var AU = NAT.plugin('AppUpdate');
    UI.confirm({
      title: T('নতুন সংস্করণ পাওয়া যাচ্ছে', 'A new version is available'),
      text: T('Google Play থেকে অ্যাপটি আপডেট করুন।', 'Update the app from Google Play.'),
      confirmLabel: T('আপডেট করুন', 'Update')
    }).then(function(ok){
      if(!ok || !AU) return;
      var openStore = function(){ if(typeof AU.openAppStore === 'function') AU.openAppStore().catch(function(){}); };
      if(p.info && p.info.immediateUpdateAllowed && typeof AU.performImmediateUpdate === 'function') AU.performImmediateUpdate().catch(openStore);
      else openStore();
    });
  }
  function offerNoticeUpdate(u){
    var link = httpsOnly(u.link) ? u.link : '';
    UI.confirm({
      title: u.title || T('নতুন সংস্করণ পাওয়া যাচ্ছে', 'A new version is available'),
      text: (u.text || '') + (u.versionName ? ' (' + u.versionName + ')' : ''),
      confirmLabel: link ? (u.linkLabel || T('আপডেট করুন', 'Update')) : T('ঠিক আছে', 'OK')
    }).then(function(ok){ if(ok && link) NAT.openExternal(link); });
  }
  function checkUpdate(row){
    if(!NAT.network.online){ UI.snack(T('ইন্টারনেট সংযোগ নেই', 'You are offline')); return; }
    row.setSub(T('খোঁজা হচ্ছে…', 'Checking…'));
    var N = NF();
    var remote = N ? Promise.resolve(N.refreshAnnouncement(true)).catch(function(){}) : Promise.resolve();
    Promise.all([remote, playUpdateInfo()]).then(function(res){
      row.setSub('');
      var play = res[1], notice = N ? N.updateNotice() : null;
      if(play && play.available){ offerPlayUpdate(play); return; }
      if(notice){ offerNoticeUpdate(notice); return; }
      if(!(parseInt(NAT.info.build, 10) > 0)){ UI.snack(T('এই বিল্ডের সংস্করণ যাচাই করা যায়নি', 'The version of this build could not be checked')); return; }
      UI.snack(T('আপনি সর্বশেষ সংস্করণ ব্যবহার করছেন', 'You are on the latest version'));
    }).catch(function(){ row.setSub(''); UI.snack(T('যাচাই করা যায়নি, পরে আবার চেষ্টা করুন', 'Could not check, please try again later')); });
  }

  function infoRow(iconName, title, sub){
    var r = UI.row({ icon: iconName, title: title, sub: sub });
    r.classList.add('qa-static-row');
    return r;
  }
  function buildAbout(el){
    var i = NAT.info || {};
    var root = h('div', { class: 'qa-about' });
    root.appendChild(h('section', { class: 'qa-about-hero' },
      h('div', { class: 'qa-about-mark', lang: 'ar', 'aria-hidden': 'true' }, 'قرآن'),
      h('h2', { class: 'qa-about-name' }, appTitle()),
      h('p', { class: 'qa-about-ver' }, (i.version ? T('সংস্করণ ', 'Version ') : '') + versionText()),
      h('p', { class: 'qa-about-tag' }, T('বাংলা অনুবাদ ও তিলাওয়াতসহ কুরআন', 'The Quran with Bangla translation and recitation'))));

    var updRow = UI.row({ icon: 'refresh', title: T('আপডেট আছে কি দেখুন', 'Check for updates'), onClick: function(ev, row){ checkUpdate(row); } });
    var infoRows = [
      UI.row({ icon: 'info', title: T('সংস্করণ', 'Version'), value: i.version || '—' })
    ];
    if(i.build) infoRows.push(UI.row({ icon: 'list', title: T('বিল্ড নম্বর', 'Build number'), value: String(i.build) }));
    infoRows.push(UI.row({ icon: 'doc', title: T('অ্যাপ আইডি', 'Package'), value: i.id || '' }));
    infoRows.push(UI.row({ icon: 'palette', title: T('অ্যাপ UI সংস্করণ', 'App UI version'), value: QRApp.version }));
    infoRows.push(updRow);
    root.appendChild(UI.group(infoRows));

    root.appendChild(UI.section(T('তথ্যের সূত্র', 'Data sources')));
    root.appendChild(UI.group([
      infoRow('quran', T('কুরআনের আরবি পাঠ ও অনুবাদ', 'Quran text and translations'), 'AlQuran.cloud (api.alquran.cloud)'),
      infoRow('headphones', T('তিলাওয়াতের অডিও', 'Recitation audio'), 'Islamic Network CDN · mp3quran.net'),
      infoRow('clock', T('নামাজের সময়', 'Prayer times'), 'AlAdhan (api.aladhan.com)'),
      infoRow('book', T('হাদিস', 'Hadith'), 'fawazahmed0/hadith-api (jsDelivr)'),
      infoRow('sparkle', T('AI তাফসীর', 'AI tafsir'), T('AI-জেনারেটেড ব্যাখ্যা (Google Gemini) — আলেমের তাফসীরের বিকল্প নয়, গুরুত্বপূর্ণ সিদ্ধান্তের আগে নির্ভরযোগ্য আলেমের কাছে যাচাই করুন।', 'AI-generated explanations (Google Gemini) — not a substitute for scholars; verify important matters with a trusted scholar.'))
    ]));
    root.appendChild(h('p', { class: 'qa-hint' }, T('কুরআনের আরবি পাঠ ও অনুবাদ উপরের সূত্র থেকে যেমন আছে তেমন দেখানো হয়; অ্যাপ সেগুলো পরিবর্তন করে না। কোনো ভুল পেলে "সমস্যা জানান" ব্যবহার করুন।', 'The Arabic text and translations are shown exactly as provided by the sources above; the app does not alter them. If you spot a mistake, please use "Report a problem".')));

    root.appendChild(UI.section(T('আইনি তথ্য ও যোগাযোগ', 'Legal & contact')));
    var legal = [
      UI.row({ icon: 'shield', title: T('গোপনীয়তা নীতি', 'Privacy policy'), onClick: function(){ openPage('privacy.html'); } }),
      UI.row({ icon: 'doc', title: T('ব্যবহারের শর্তাবলি', 'Terms of use'), onClick: function(){ openPage('terms.html'); } }),
      UI.row({ icon: 'trash', title: T('অ্যাকাউন্ট ও ডেটা মুছে ফেলা', 'Account & data deletion'), onClick: function(){ openPage('account-deletion.html'); } }),
      UI.row({ icon: 'bug', title: T('সমস্যা জানান', 'Report a problem'), onClick: function(){ openReport(); } })
    ];
    if(cfg().supportEmail) legal.push(UI.row({ icon: 'chat', title: T('ইমেইলে যোগাযোগ', 'Contact by e-mail'), value: cfg().supportEmail, onClick: function(){ openMail(cfg().supportEmail, appTitle()); } }));
    root.appendChild(UI.group(legal));
    el.appendChild(root);
  }
  Nav.register('about', {
    singleton: true,
    mount: function(el){ buildAbout(el); },
    topbar: function(){ return { lead: 'back', title: T('অ্যাপ সম্পর্কে', 'About') }; }
  });

  // ---------- keep the visible screens in step with outside changes ----------
  function renderAll(){
    if(more.root && isOn('more')) renderMore();
    if(S.root) renderAccountSection();
  }
  QRApp.on('auth', renderAll);
  QRApp.on('inbox', function(){ if(more.root && isOn('more')) renderMore(); });
  QRApp.on('prayer-notify', function(){ var N = NF(); if(S.root && isOn('settings')) refreshSettings(); });
  // the person may have turned notifications on in the phone's own settings and come back to this screen
  NAT.onResume(function(){ if(S.root && isOn('settings')) updatePermBanner(); });

  QRApp.more = {
    openReport: openReport,
    shareApp: shareApp,
    openSettings: function(focus){ Nav.push('settings', focus ? { focus: focus } : {}); },
    versionText: versionText
  };
})();
