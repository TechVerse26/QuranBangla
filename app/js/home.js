// ---------- Android app UI · Home ----------
// A calm starting point built only from real data on the device / from the same sources as the website:
// greeting, continue reading (last read position), search, continue listening (listening history),
// ayah of the day, next prayer (when a location is saved), reading progress, recent bookmarks,
// recently used features and the announcement published by the admin.
// A section that has no data simply does not appear - nothing here is a placeholder.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native, D = QRApp.data, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;

  var els = {};
  var token = 0;
  var needsNet = false;      // something on Home could not be shown for lack of a connection: redraw when it returns
  var tickTimer = null;
  var prayerCtx = null;

  function R(){ return QRApp.reader; }

  // ---------- greeting ----------
  function firstName(){
    try{
      var n = state.user && (state.user.name || '');
      n = String(n || '').trim();
      return n ? n.split(/\s+/)[0] : '';
    }catch(e){ return ''; }
  }
  function greeting(){
    var name = firstName();
    // <div>, not <header>: the website's CSS styles every bare <header> element as its fixed top bar (css/header.css)
    var box = h('div', { class: 'qa-greet' });
    box.appendChild(h('div', { class: 'qa-greet-hi' }, T('আসসালামু আলাইকুম', 'Assalamu alaikum') + (name ? ', ' + name : '')));
    box.appendChild(h('div', { class: 'qa-greet-date' }, QRApp.formatDate(new Date())));
    return box;
  }

  // ---------- announcement (published by the admin in Firestore: siteConfig/announcement) ----------
  function announcement(){
    var a = QRApp.notify && QRApp.notify.announcement && QRApp.notify.announcement();
    if(!a) return null;
    var card = h('section', { class: 'qa-announce', role: 'status' });
    card.appendChild(h('span', { class: 'qa-announce-ic', html: icon('campaign') }));
    var main = h('div', { class: 'qa-announce-main' });
    if(a.title) main.appendChild(h('div', { class: 'qa-announce-title' }, a.title));
    if(a.text) main.appendChild(h('div', { class: 'qa-announce-text' }, a.text));
    if(a.link && /^https:\/\//i.test(a.link)){
      main.appendChild(UI.linkButton(a.linkLabel || T('বিস্তারিত', 'Details'), function(){ NAT.openExternal(a.link); }));
    }
    card.appendChild(main);
    var x = UI.iconButton('close', T('বন্ধ করুন', 'Dismiss'), function(){ QRApp.notify.dismissAnnouncement(); card.remove(); }, 'qa-sm');
    card.appendChild(x);
    return card;
  }

  // ---------- continue reading ----------
  function continueCard(){
    var lr = state.lastRead;
    var has = !!(lr && lr.surah >= 1 && lr.surah <= 114);
    var card = h('section', { class: 'qa-card qa-card-tonal qa-hero' });
    if(has){
      var total = D.AYAH_COUNTS[lr.surah - 1];
      var ayah = Math.min(lr.ayah || 1, total);
      card.appendChild(h('div', { class: 'qa-hero-kicker' }, T('পড়া চালিয়ে যান', 'Continue reading')));
      card.appendChild(h('div', { class: 'qa-hero-title' }, QRApp.surahName(lr.surah)));
      card.appendChild(h('div', { class: 'qa-hero-sub' }, T('আয়াত ' + NUM(ayah) + ' / ' + NUM(total), 'Ayah ' + ayah + ' of ' + total)));
      card.appendChild(UI.progress(ayah / total));
      card.appendChild(UI.button(T('চালিয়ে যান', 'Continue'), { kind: 'filled', icon: 'play', cls: 'qa-hero-btn', onClick: function(){ R().continueReading(); } }));
    } else {
      card.appendChild(h('div', { class: 'qa-hero-kicker' }, T('শুরু করুন', 'Get started')));
      card.appendChild(h('div', { class: 'qa-hero-title' }, T('কুরআন পড়া শুরু করুন', 'Start reading the Quran')));
      card.appendChild(h('div', { class: 'qa-hero-sub' }, T('সূরা আল-ফাতিহা দিয়ে শুরু করতে পারেন', 'You can begin with Surah Al-Fatiha')));
      card.appendChild(UI.button(T('আল-ফাতিহা পড়ুন', 'Read Al-Fatiha'), { kind: 'filled', icon: 'quran', cls: 'qa-hero-btn', onClick: function(){ R().open({ type: 'surah', num: 1 }); } }));
    }
    return card;
  }

  function searchField(){
    var b = h('button', { class: 'qa-searchfield', type: 'button', 'aria-label': T('খুঁজুন', 'Search') });
    b.innerHTML = icon('search');
    b.appendChild(h('span', {}, T('সূরা, আয়াত বা শব্দ খুঁজুন', 'Search surah, ayah or word')));
    b.addEventListener('click', function(){ QRApp.search.open(); });
    return b;
  }

  // ---------- continue listening ----------
  function listenCard(){
    var hist = (state.history || [])[0];
    if(!hist || !(hist.surah >= 1 && hist.surah <= 114)) return null;
    var reciter = '';
    try{ reciter = QRApp.pick.reciterLabel(hist.reciter); }catch(e){}
    var card = h('section', { class: 'qa-card qa-listen qa-card-pressable', role: 'button', tabindex: '0' });
    var btn = h('span', { class: 'qa-listen-btn', html: icon('play') });
    card.appendChild(btn);
    card.appendChild(h('div', { class: 'qa-listen-main' },
      h('div', { class: 'qa-overline' }, T('আবার শুনুন', 'Listen again')),
      h('div', { class: 'qa-listen-title' }, QRApp.surahName(hist.surah) + ' · ' + T('আয়াত ' + NUM(hist.ayah || 1), 'Ayah ' + (hist.ayah || 1))),
      h('div', { class: 'qa-caption' }, [reciter, QRApp.timeAgo(hist.ts)].filter(Boolean).join(' · '))));
    card.addEventListener('click', function(){
      if(hist.reciter && hist.reciter !== state.reciter){
        state.reciter = hist.reciter; try{ saveReciter(); }catch(e){}
      }
      R().open({ type: 'surah', num: hist.surah, ayah: hist.ayah || 1, surah: hist.surah, autoplay: true });
    });
    return card;
  }

  // ---------- ayah of the day ----------
  function cachedDaily(s, a){
    try{
      var raw = IDBKV.get('qr_aod_cache');
      if(!raw) return null;
      var p = JSON.parse(raw);
      if(p && p.date === new Date().toDateString() && p.s === s && p.a === a && p.edition === state.translationEdition && p.arabic){
        return { arabic: p.arabic, translation: p.bengali || '', global: p.globalNumber || null };
      }
    }catch(e){}
    return null;
  }
  function dailyCard(myToken){
    var pick = ayahOfTheDay();
    var s = pick.s, a = pick.a;
    var card = h('section', { class: 'qa-card qa-daily' });
    var head = h('div', { class: 'qa-daily-head' },
      h('span', { class: 'qa-overline' }, T('আজকের আয়াত', 'Ayah of the day')),
      h('span', { class: 'qa-daily-ref' }, QRApp.surahName(s) + ' ' + NUM(s) + ':' + NUM(a)));
    card.appendChild(head);
    var body = h('div', { class: 'qa-daily-body' });
    card.appendChild(body);
    var actions = h('div', { class: 'qa-daily-actions' });
    card.appendChild(actions);

    function fill(data){
      if(myToken !== token) return;
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'qa-ar qa-daily-ar', lang: 'ar', dir: 'rtl' }, data.arabic));
      if(data.translation) body.appendChild(h('div', { class: 'qa-daily-tr' }, data.translation));
      actions.innerHTML = '';
      var marked = !!state.bookmarks[s + ':' + a];
      var bm = UI.iconButton(marked ? 'bookmark' : 'bookmarkOutline', T('বুকমার্ক', 'Bookmark'), function(){
        var key = s + ':' + a;
        if(state.bookmarks[key]) delete state.bookmarks[key]; else state.bookmarks[key] = true;
        saveBookmarks(); NAT.haptic('light');
        QRApp.emit('bookmarks');
        var on = !!state.bookmarks[key];
        bm.innerHTML = icon(on ? 'bookmark' : 'bookmarkOutline'); bm.classList.toggle('qa-on', on);
        UI.snack(on ? T('বুকমার্কে যোগ হয়েছে', 'Bookmarked') : T('বুকমার্ক সরানো হয়েছে', 'Bookmark removed'));
      }, marked ? 'qa-on' : '');
      var share = UI.iconButton('share', T('শেয়ার', 'Share'), function(){
        var text = data.arabic + (data.translation ? '\n\n' + data.translation : '') + '\n\n— ' + QRApp.surahName(s) + ' (' + s + ':' + a + ')\n' + T('কুরআন বাংলা অ্যাপ থেকে', 'From the Quran Bangla app');
        NAT.share({ title: T('আজকের আয়াত', 'Ayah of the day'), text: text, url: location.origin + '/' }).then(function(r){
          if(r && r.ok){ try{ incrementShareCount(); }catch(e){} }
          if(r && r.method === 'clipboard') UI.snack(T('আয়াত কপি করা হয়েছে', 'Ayah copied'));
          else if(r && !r.ok && !r.cancelled) UI.snack(T('শেয়ার করা যায়নি', 'Could not share'));
        });
      });
      var read = UI.button(T('সূরায় পড়ুন', 'Read in surah'), { kind: 'tonal', small: true, onClick: function(){ R().open({ type: 'surah', num: s, ayah: a, surah: s }); } });
      actions.appendChild(read);
      actions.appendChild(h('span', { class: 'qa-grow' }));
      if(data.global){
        actions.appendChild(UI.iconButton('play', T('শুনুন', 'Listen'), function(){
          state.playlist = [{ key: s + ':' + a, globalNumber: data.global, surah: s, numberInSurah: a, title: (typeof surahNamesBn !== 'undefined' && surahNamesBn[s - 1]) || ('সূরা ' + s) }];
          state.playIndex = 0;
          playAtIndex(0, true);
        }));
      }
      actions.appendChild(bm);
      actions.appendChild(share);
    }

    var hit = cachedDaily(s, a) || D.ayahPreviewCached(s, a);
    if(hit){ fill(hit); return card; }
    body.appendChild(UI.skeletonBlock(96));
    D.ayahPreview(s, a).then(fill).catch(function(){
      if(myToken !== token) return;
      needsNet = true;
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'qa-caption' }, NAT.network.online
        ? T('আজকের আয়াত লোড করা যায়নি।', 'Could not load today\'s ayah.')
        : T('ইন্টারনেট সংযোগ ফিরলে আজকের আয়াত দেখা যাবে।', 'Today\'s ayah will appear when you are back online.')));
      var readOnly = UI.button(T('সূরায় পড়ুন', 'Read in surah'), { kind: 'tonal', small: true, onClick: function(){ R().open({ type: 'surah', num: s, ayah: a, surah: s }); } });
      actions.innerHTML = ''; actions.appendChild(readOnly);
    });
    return card;
  }

  // ---------- next prayer (needs a saved location - the same one the website's prayer page uses) ----------
  function todayCache(){
    try{
      var c = readPrayerCache();
      if(c && c.data && c.data.timings && c.date === new Date().toDateString()) return c;
    }catch(e){}
    return null;
  }
  function computeNext(timings){
    var now = new Date();
    var list = PRAYER_ORDER.filter(function(p){ return !p.informational && timings[p.key]; }).map(function(p){
      var hm = String(timings[p.key]).split(' ')[0].split(':').map(Number);
      return { key: p.key, label: p.label, time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), hm[0], hm[1], 0), raw: timings[p.key] };
    });
    var next = list.filter(function(p){ return p.time > now; })[0];
    if(!next){ next = { key: list[0].key, label: list[0].label, time: new Date(list[0].time.getTime() + 86400000), raw: list[0].raw, tomorrow: true }; }
    return next;
  }
  function fmtLeft(ms){
    var totalMin = Math.max(0, Math.round(ms / 60000));
    var hh = Math.floor(totalMin / 60), mm = totalMin % 60;
    if(hh <= 0) return T(NUM(mm) + ' মিনিট বাকি', mm + ' min left');
    return T(NUM(hh) + ' ঘণ্টা ' + NUM(mm) + ' মিনিট বাকি', hh + ' h ' + mm + ' min left');
  }
  function prayerCard(myToken){
    var card = h('section', { class: 'qa-card qa-prayer' });
    var left = h('div', { class: 'qa-prayer-main' });
    var qibla = h('button', { class: 'qa-prayer-side', type: 'button', 'aria-label': T('কিবলা', 'Qibla') });
    qibla.innerHTML = icon('explore');
    qibla.appendChild(h('span', {}, T('কিবলা', 'Qibla')));
    qibla.addEventListener('click', function(){ QRApp.features.open('qibla'); });
    card.appendChild(left); card.appendChild(qibla);
    prayerCtx = { left: left, token: myToken };

    function openPrayer(){ QRApp.features.open('prayer'); }
    function drawEmpty(msg){
      left.innerHTML = '';
      left.appendChild(h('div', { class: 'qa-overline' }, T('নামাজের সময়', 'Prayer times')));
      left.appendChild(h('div', { class: 'qa-prayer-title' }, msg));
      left.appendChild(UI.linkButton(T('নামাজের সময় দেখুন', 'View prayer times'), openPrayer));
    }
    function draw(cacheObj){
      left.innerHTML = '';
      var n = computeNext(cacheObj.data.timings);
      var loc = cacheObj.label || (cacheObj.data.meta && cacheObj.data.meta.timezone) || '';
      left.appendChild(h('div', { class: 'qa-overline' }, T('পরবর্তী নামাজ', 'Next prayer')));
      left.appendChild(h('div', { class: 'qa-prayer-title' }, n.label + ' · ' + (typeof to12h === 'function' ? NUM(to12h(n.raw)) : n.raw)));
      left.appendChild(h('div', { class: 'qa-caption', 'data-prayer-left': '' }, fmtLeft(n.time - new Date()) + (loc ? ' · ' + loc : '')));
      prayerCtx.cache = cacheObj; prayerCtx.next = n; prayerCtx.loc = loc;
      left.onclick = openPrayer;
    }
    var c = todayCache();
    if(c){ draw(c); return card; }
    if(!state.prayerLocation){
      drawEmpty(T('অবস্থান যোগ করলে ওয়াক্ত ও কাউন্টডাউন দেখাবে', 'Add your location to see times and the countdown'));
      left.onclick = openPrayer;
      return card;
    }
    drawEmpty(T('সময়সূচি আনা হচ্ছে…', 'Loading times…'));
    if(NAT.network.online){
      var loc = state.prayerLocation;
      fetch(PRAYER_API + '/timings?latitude=' + loc.lat + '&longitude=' + loc.lon + '&method=' + state.prayerMethod)
        .then(function(r){ return r.json(); })
        .then(function(j){
          if(!j || !j.data || !j.data.timings) throw new Error('bad');
          try{ cachePrayerData(j.data, loc); }catch(e){}
          if(myToken === token) draw({ data: j.data, label: loc.label || null, date: new Date().toDateString() });
        }).catch(function(){ if(myToken === token) drawEmpty(T('সময়সূচি আনা যায়নি — ট্যাপ করে আবার চেষ্টা করুন', 'Could not load times — tap to try again')); });
    } else {
      needsNet = true;
      drawEmpty(T('অফলাইন — ইন্টারনেট পেলে সময় দেখাবে', 'Offline — times will show when you are online'));
    }
    left.onclick = openPrayer;
    return card;
  }
  function tickPrayer(){
    if(!prayerCtx || !prayerCtx.next || !prayerCtx.left || !prayerCtx.left.isConnected) return;
    if(prayerCtx.next.time <= new Date()){ render(); return; }
    var el = prayerCtx.left.querySelector('[data-prayer-left]');
    if(el) el.textContent = fmtLeft(prayerCtx.next.time - new Date()) + (prayerCtx.loc ? ' · ' + prayerCtx.loc : '');
  }

  // ---------- progress ----------
  function progressCard(){
    var read = D.ayahsRead();
    var streak = D.streak();
    var mins = Math.floor(D.todaySeconds() / 60);
    var card = h('section', { class: 'qa-card qa-progress-card qa-card-pressable', role: 'button', tabindex: '0' });
    card.appendChild(h('div', { class: 'qa-daily-head' },
      h('span', { class: 'qa-overline' }, T('আপনার অগ্রগতি', 'Your progress')),
      h('span', { class: 'qa-link-inline' }, T('বিস্তারিত', 'Details'))));
    var stats = h('div', { class: 'qa-stats' });
    function stat(ic, value, label){
      return h('div', { class: 'qa-stat' },
        h('span', { class: 'qa-stat-ic', html: icon(ic) }),
        h('div', { class: 'qa-stat-v' }, value),
        h('div', { class: 'qa-stat-l' }, label));
    }
    stats.appendChild(stat('fire', NUM(streak), T('দিনের ধারা', 'day streak')));
    stats.appendChild(stat('clock', NUM(mins), T('আজ মিনিট', 'min today')));
    stats.appendChild(stat('checkCircle', NUM(read), T('আয়াত পড়া', 'ayahs read')));
    card.appendChild(stats);
    var frac = D.readFraction();
    card.appendChild(UI.progress(frac, true));
    card.appendChild(h('div', { class: 'qa-caption', style: { marginTop: '8px' } },
      T('কুরআনের ' + NUM((frac * 100).toFixed(frac >= 0.1 ? 0 : 1)) + '% পড়া হয়েছে', (frac * 100).toFixed(frac >= 0.1 ? 0 : 1) + '% of the Quran read')));
    card.addEventListener('click', function(){ Nav.openLegacy('stats'); });
    return card;
  }

  // ---------- bookmarks ----------
  function bookmarksCard(myToken){
    var keys = Object.keys(state.bookmarks || {});
    if(!keys.length) return null;
    var recent = keys.slice(-3).reverse();
    var box = h('section', { class: 'qa-home-block' });
    box.appendChild(UI.section(T('সংরক্ষিত আয়াত', 'Saved ayahs'), UI.linkButton(T('সব দেখুন', 'See all'), function(){ Nav.go('library'); })));
    var list = h('div', { class: 'qa-list' });
    recent.forEach(function(key){
      var p = key.split(':').map(Number);
      var s = p[0], a = p[1];
      if(!(s >= 1 && s <= 114)) return;
      var sub = h('div', { class: 'qa-list-sub qa-clamp' });
      var cached = D.ayahPreviewCached(s, a);
      sub.textContent = cached ? (cached.translation || cached.arabic) : T('আয়াত ' + NUM(a), 'Ayah ' + a);
      var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
        h('div', { class: 'qa-num' }, NUM(s) + ':' + NUM(a)),
        h('div', { class: 'qa-list-main' }, h('div', { class: 'qa-list-title' }, QRApp.surahName(s) + ' · ' + T('আয়াত ' + NUM(a), 'Ayah ' + a)), sub));
      item.addEventListener('click', function(){ R().open({ type: 'surah', num: s, ayah: a, surah: s }); });
      list.appendChild(item);
      if(!cached && !NAT.network.online) needsNet = true;
      if(!cached && NAT.network.online){
        D.ayahPreview(s, a).then(function(d){ if(myToken === token && sub.isConnected) sub.textContent = d.translation || d.arabic; }).catch(function(){});
      }
    });
    box.appendChild(list);
    return box;
  }

  // ---------- recently used features ----------
  function recentFeatures(){
    var F = QRApp.features;
    if(!F) return null;
    var list = F.recent(4);
    if(!list.length) return null;
    var box = h('section', { class: 'qa-home-block' });
    box.appendChild(UI.section(T('সম্প্রতি ব্যবহৃত', 'Recently used'), UI.linkButton(T('সব ফিচার', 'All features'), function(){ Nav.go('discover'); })));
    var row = h('div', { class: 'qa-chips' });
    list.forEach(function(f){
      var c = h('button', { class: 'qa-chip', type: 'button' });
      c.innerHTML = icon(f.icon, 'qa-ic-sm');
      c.appendChild(document.createTextNode(T(f.label[0], f.label[1])));
      c.addEventListener('click', function(){ F.open(f.id); });
      row.appendChild(c);
    });
    box.appendChild(row);
    return box;
  }

  // ---------- render ----------
  function render(){
    if(!els.root) return;
    var my = ++token;
    needsNet = false;
    prayerCtx = null;
    els.root.innerHTML = '';
    var parts = [
      announcement(), greeting(), continueCard(), searchField(), dailyCard(my), prayerCard(my),
      listenCard(), progressCard(), bookmarksCard(my), recentFeatures()
    ];
    parts.forEach(function(p){ if(p) els.root.appendChild(p); });
  }

  Nav.register('home', {
    tab: true, order: 1, icon: 'home', label: ['হোম', 'Home'],
    mount: function(el){
      els.root = h('div', { class: 'qa-home qa-stack' });
      el.appendChild(els.root);
      render();
    },
    show: function(){
      render();
      clearInterval(tickTimer);
      tickTimer = setInterval(tickPrayer, 30000);
    },
    hide: function(){ clearInterval(tickTimer); tickTimer = null; },
    unmount: function(){ els = {}; clearInterval(tickTimer); },
    topbar: function(){
      var unread = QRApp.notify && QRApp.notify.unread ? QRApp.notify.unread() : 0;
      return {
        brand: true, title: T('কুরআন বাংলা', 'Quran Bangla'),
        actions: [
          { icon: 'search', label: T('খুঁজুন', 'Search'), onClick: function(){ QRApp.search.open(); } },
          { icon: 'bell', label: T('নোটিফিকেশন', 'Notifications'), badge: unread > 0, onClick: function(){ Nav.push('inbox'); } }
        ]
      };
    },
    onReselect: function(){ render(); }
  });

  // the connection came back: redraw Home if it was showing "offline" placeholders (today's ayah, prayer times, previews)
  NAT.network.onChange(function(online){ if(online && needsNet && Nav.isHomeRoot()) render(); });

  // keep the bell badge / announcement current while Home is showing
  QRApp.on('inbox', function(){ if(Nav.isHomeRoot()) Nav.refreshTopbar(); });
  QRApp.on('announcement', function(){ if(Nav.isHomeRoot()) render(); });
  QRApp.on('surahlist', function(){ if(Nav.isHomeRoot()) render(); });
})();
