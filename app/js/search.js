// ---------- Android app UI · search ----------
// One search box for everything the app can find:
//   - a surah by name (Bangla / English / Arabic) or number            -> instant, works offline
//   - an ayah reference such as 2:255 or ২:২৫৫                          -> instant, works offline
//   - a word or phrase inside the translation or the Arabic text         -> the Quran API, same call as the website
// Results open the reader at the exact ayah. Recent searches are kept on the device only.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native, D = QRApp.data, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N, esc = QRApp.esc;
  var Search = QRApp.search = {};

  var PAGE = 20;
  var MAX_RECENT = 8;
  var st = { q: '', matches: [], shown: 0, ar: false, seq: 0, status: 'idle' };   // status: idle | loading | done | error | offline
  var els = {};
  var timer = null;

  // ---------- helpers ----------
  function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function highlight(text, q){
    var words = String(q || '').trim().split(/\s+/).filter(function(w){ return w.length >= 2; }).map(escRe);
    if(!words.length) return esc(text);
    var re;
    try{ re = new RegExp('(' + words.join('|') + ')', 'gi'); }catch(e){ return esc(text); }
    var out = '', last = 0, m;
    while((m = re.exec(text))){
      if(m[0] === ''){ re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  // The same Arabic normalisation the website's search uses, so the same words match.
  function normalizeArabicQuery(str){
    try{ if(typeof normalizeArabic === 'function') return normalizeArabic(str); }catch(e){}
    return String(str || '').replace(/[ً-ٰٟۖ-ۭ]/g, '').replace(/ـ/g, '').trim();
  }
  function recents(){ var r = QRApp.prefs.get('recent_searches', []); return Array.isArray(r) ? r : []; }
  function saveRecent(q){
    q = String(q || '').trim();
    if(q.length < 2) return;
    var list = recents().filter(function(x){ return x !== q; });
    list.unshift(q);
    QRApp.prefs.set('recent_searches', list.slice(0, MAX_RECENT));
  }
  function topInput(){ return document.querySelector('.qa-topbar-search input'); }
  function setInputValue(v){
    var inp = topInput();
    if(inp){ inp.value = v; inp.dispatchEvent(new Event('input')); }
  }

  // ---------- matching surahs ----------
  function matchSurahs(q){
    var n = D.normalize(q);
    if(!n) return [];
    var out = [];
    D.surahs().forEach(function(s){
      var keys = [D.normalize(s.bn), D.normalize(s.en), D.normalize(s.ar), D.normalize(s.enMeaning)];
      var best = 0;
      keys.forEach(function(k){
        if(!k) return;
        if(k === n) best = Math.max(best, 3);
        else if(k.indexOf(n) === 0) best = Math.max(best, 2);
        else if(k.indexOf(n) > -1) best = Math.max(best, 1);
      });
      if(best) out.push({ s: s, score: best });
    });
    out.sort(function(a, b){ return b.score - a.score || a.s.number - b.s.number; });
    return out.slice(0, 8).map(function(x){ return x.s; });
  }

  // ---------- DOM ----------
  function build(el){
    els.root = h('div', { class: 'qa-search' });
    els.notice = h('div', { class: 'qa-search-notice' });
    els.jump = h('div', { class: 'qa-search-block' });
    els.surahs = h('div', { class: 'qa-search-block' });
    els.results = h('div', { class: 'qa-search-block' });
    els.idle = h('div', { class: 'qa-search-block' });
    [els.notice, els.idle, els.jump, els.surahs, els.results].forEach(function(n){ els.root.appendChild(n); });
    el.appendChild(els.root);
    el.classList.add('qa-search-screen');
  }

  function resultRow(o){
    var b = h('button', { class: 'qa-result', type: 'button' });
    b.appendChild(h('div', { class: 'qa-result-ref' },
      h('span', { class: 'qa-result-badge' }, o.badge),
      h('span', { class: 'qa-result-title' }, o.title)));
    if(o.text){
      var t = h('div', { class: 'qa-result-text' + (o.ar ? ' qa-ar' : '') });
      if(o.ar){ t.setAttribute('dir', 'rtl'); t.setAttribute('lang', 'ar'); }
      t.innerHTML = o.html;
      b.appendChild(t);
    }
    b.addEventListener('click', o.onClick);
    return b;
  }
  function jumpRow(ic, title, sub, onClick){
    return UI.row({ icon: ic, title: title, sub: sub, onClick: onClick });
  }

  function openAndRemember(opts){
    saveRecent(st.q);
    Reader().open(opts);
  }
  function Reader(){ return QRApp.reader; }

  // ---------- idle state: recent searches + shortcuts ----------
  function renderIdle(){
    els.idle.innerHTML = '';
    els.jump.innerHTML = ''; els.surahs.innerHTML = ''; els.results.innerHTML = '';
    var list = recents();
    if(list.length){
      els.idle.appendChild(UI.section(T('সাম্প্রতিক খোঁজ', 'Recent searches'), UI.linkButton(T('মুছুন', 'Clear'), function(){
        QRApp.prefs.set('recent_searches', []); renderIdle();
      })));
      var g = h('div', { class: 'qa-group' });
      list.forEach(function(q){
        var row = UI.row({ icon: 'history', title: q, chevron: false, onClick: function(){ setInputValue(q); onSubmit(q); } });
        var rm = h('button', { class: 'qa-iconbtn qa-sm', type: 'button', 'aria-label': T('সরান', 'Remove') });
        rm.innerHTML = icon('close');
        rm.addEventListener('click', function(ev){
          ev.stopPropagation();
          QRApp.prefs.set('recent_searches', recents().filter(function(x){ return x !== q; }));
          renderIdle();
        });
        row.querySelector('.qa-row-trail') ? row.querySelector('.qa-row-trail').appendChild(rm) : row.appendChild(h('span', { class: 'qa-row-trail' }, rm));
        g.appendChild(row);
      });
      els.idle.appendChild(g);
    }
    els.idle.appendChild(UI.section(T('দ্রুত যান', 'Quick links')));
    var chips = h('div', { class: 'qa-chips qa-wrap' });
    [
      [T('আয়াতুল কুরসি', 'Ayat al-Kursi'), { surah: 2, ayah: 255 }],
      [T('সূরা ইয়াসিন', 'Surah Ya-Sin'), { surah: 36 }],
      [T('সূরা আর-রাহমান', 'Surah Ar-Rahman'), { surah: 55 }],
      [T('সূরা আল-মুলক', 'Surah Al-Mulk'), { surah: 67 }],
      [T('সূরা আল-কাহফ', 'Surah Al-Kahf'), { surah: 18 }],
      [T('সূরা আল-ওয়াকিয়া', 'Surah Al-Waqi\'ah'), { surah: 56 }]
    ].forEach(function(c){
      chips.appendChild(UI.chip(c[0], function(){
        Reader().open({ type: 'surah', num: c[1].surah, ayah: c[1].ayah, surah: c[1].surah });
      }));
    });
    els.idle.appendChild(chips);
    els.idle.appendChild(h('p', { class: 'qa-hint' },
      T('টিপস: "২:২৫৫" লিখে সরাসরি আয়াতে যান, সূরার নাম লিখে সূরা খুলুন, অথবা যেকোনো শব্দ লিখে অনুবাদ ও আরবি টেক্সটে খুঁজুন।',
        'Tip: type "2:255" to jump to an ayah, a surah name to open it, or any word to search the translation and the Arabic text.')));
  }

  // ---------- result rendering ----------
  function renderQuick(q){
    els.jump.innerHTML = ''; els.surahs.innerHTML = '';
    var ascii = D.asciiDigits(q).trim();
    var rows = [];
    var ref = D.parseRef(q);
    if(ref){
      rows.push(jumpRow('quran', QRApp.surahName(ref.surah) + ' ' + NUM(ref.surah) + ':' + NUM(ref.ayah),
        T('আয়াত ' + NUM(ref.ayah) + ' খুলুন', 'Open ayah ' + ref.ayah),
        function(){ openAndRemember({ type: 'surah', num: ref.surah, ayah: ref.ayah, surah: ref.surah }); }));
    } else if(/^\d{1,3}$/.test(ascii)){
      var n = parseInt(ascii, 10);
      if(n >= 1 && n <= 114) rows.push(jumpRow('quran', QRApp.surahName(n), T('সূরা নম্বর ' + NUM(n), 'Surah ' + n), function(){ openAndRemember({ type: 'surah', num: n }); }));
      if(n >= 1 && n <= 30) rows.push(jumpRow('book', T('পারা ' + NUM(n), 'Juz ' + n), D.JUZ_NAMES[n - 1], function(){ openAndRemember({ type: 'juz', num: n }); }));
      if(n >= 1 && n <= 604) rows.push(jumpRow('doc', T('পৃষ্ঠা ' + NUM(n), 'Page ' + n), T('মুসহাফের পৃষ্ঠা', 'Mushaf page'), function(){ openAndRemember({ type: 'page', num: n }); }));
    }
    if(rows.length){
      els.jump.appendChild(UI.section(T('সরাসরি যান', 'Go to')));
      els.jump.appendChild(UI.group(rows));
    }
    var surahs = ref ? [] : matchSurahs(q);
    if(surahs.length){
      els.surahs.appendChild(UI.section(T('সূরা', 'Surahs')));
      var g = h('div', { class: 'qa-list' });
      surahs.forEach(function(s){
        var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
          h('div', { class: 'qa-num' }, NUM(s.number)),
          h('div', { class: 'qa-list-main' },
            h('div', { class: 'qa-list-title' }, s.bn),
            h('div', { class: 'qa-list-sub' }, [s.en, T(NUM(s.ayahs) + ' আয়াত', s.ayahs + ' ayahs')].filter(Boolean).join(' · '))),
          h('div', { class: 'qa-list-trail' }, h('div', { class: 'qa-list-ar', lang: 'ar' }, s.ar)));
        item.addEventListener('click', function(){ openAndRemember({ type: 'surah', num: s.number }); });
        g.appendChild(item);
      });
      els.surahs.appendChild(g);
    }
  }

  function renderResults(){
    els.results.innerHTML = '';
    if(st.status === 'loading'){
      els.results.appendChild(UI.section(T('আয়াতে খোঁজা হচ্ছে…', 'Searching the Quran…')));
      els.results.appendChild(UI.skeletonList(4, false));
      return;
    }
    if(st.status === 'offline'){
      els.results.appendChild(UI.errorState({
        title: T('অফলাইনে শব্দ খোঁজা যায় না', 'Word search needs internet'),
        text: T('সূরার নাম ও আয়াত নম্বর দিয়ে খোঁজা অফলাইনেও চলে। শব্দ খুঁজতে ইন্টারনেট সংযোগ দিন।', 'Surah names and ayah numbers work offline. Connect to the internet to search words.'),
        onRetry: function(){ run(st.q); }
      }));
      return;
    }
    if(st.status === 'error'){
      els.results.appendChild(UI.errorState({ title: T('খোঁজা যায়নি', 'Search failed'), onRetry: function(){ run(st.q); } }));
      return;
    }
    if(st.status !== 'done') return;
    if(!st.matches.length){
      var quickShown = els.jump.childNodes.length || els.surahs.childNodes.length;
      if(!quickShown){
        els.results.appendChild(UI.empty({
          icon: 'search', title: T('কোনো ফলাফল পাওয়া যায়নি', 'No results found'),
          text: T('অন্য শব্দ দিয়ে চেষ্টা করুন, অথবা বানান বদলে দেখুন।', 'Try another word or a different spelling.')
        }));
      }
      return;
    }
    els.results.appendChild(UI.section(T('আয়াতে পাওয়া গেছে (' + NUM(st.matches.length) + ')', 'Found in ayahs (' + st.matches.length + ')'),
      h('span', { class: 'qa-caption' }, st.ar ? T('আরবি টেক্সট', 'Arabic text') : (QRApp.pick ? QRApp.pick.translationLabel() : ''))));
    var list = h('div', { class: 'qa-results' });
    els.list = list;
    els.results.appendChild(list);
    appendPage();
  }

  function appendPage(){
    var more = els.results.querySelector('.qa-load-more');
    if(more) more.remove();
    var batch = st.matches.slice(st.shown, st.shown + PAGE);
    batch.forEach(function(m){
      var s = m.surah.number, a = m.numberInSurah;
      els.list.appendChild(resultRow({
        badge: NUM(s) + ':' + NUM(a),
        title: QRApp.surahName(s) + ' · ' + T('আয়াত ' + NUM(a), 'Ayah ' + a),
        text: m.text, html: highlight(m.text, st.ar ? '' : st.q), ar: st.ar,
        onClick: function(){ openAndRemember({ type: 'surah', num: s, ayah: a, surah: s }); }
      }));
    });
    st.shown += batch.length;
    if(st.shown < st.matches.length){
      var btn = UI.button(T('আরও দেখান (' + NUM(st.matches.length - st.shown) + 'টি বাকি)', 'Show more (' + (st.matches.length - st.shown) + ' left)'), { kind: 'tonal', block: true, cls: 'qa-load-more', onClick: appendPage });
      els.results.appendChild(btn);
    }
  }

  // ---------- running a search ----------
  function renderNotice(){
    els.notice.innerHTML = '';
    if(!NAT.network.online) els.notice.appendChild(UI.banner(T('অফলাইন — শুধু সূরার নাম ও আয়াত নম্বর দিয়ে খোঁজা যাবে', 'Offline — only surah names and ayah numbers can be searched'), 'cloudOff'));
  }

  function run(q){
    q = String(q || '').trim();
    var my = ++st.seq;
    st.q = q;
    renderNotice();
    if(!q){
      st.status = 'idle'; st.matches = []; st.shown = 0;
      renderIdle();
      return;
    }
    els.idle.innerHTML = '';
    renderQuick(q);
    var ar = /[؀-ۿ]/.test(q);
    st.ar = ar;
    // Single characters would match half the Quran; words need at least two.
    if(q.length < 2 || D.parseRef(q) || /^\d+$/.test(D.asciiDigits(q).trim())){
      st.status = 'done'; st.matches = []; st.shown = 0; renderResults();
      return;
    }
    if(!NAT.network.online){ st.status = 'offline'; st.matches = []; renderResults(); return; }
    st.status = 'loading'; renderResults();
    var edition = ar ? 'quran-simple-clean' : state.translationEdition;
    var apiQuery = ar ? normalizeArabicQuery(q) : q;
    try{ incrementSearchCount(); }catch(e){}
    fetch(API + '/search/' + encodeURIComponent(apiQuery) + '/all/' + edition)
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(my !== st.seq) return;
        st.matches = (j && j.data && j.data.matches) || [];
        st.shown = 0; st.status = 'done';
        renderResults();
      })
      .catch(function(){
        if(my !== st.seq) return;
        st.status = NAT.network.online ? 'error' : 'offline'; st.matches = []; renderResults();
      });
  }

  function onInput(v){
    clearTimeout(timer);
    var q = String(v || '').trim();
    // instant (offline) parts update on every keystroke; the network search waits for a pause
    if(!q){ run(''); return; }
    st.q = q;
    els.idle.innerHTML = '';
    renderQuick(q);
    timer = setTimeout(function(){ run(q); }, 420);
  }
  function onSubmit(v){
    clearTimeout(timer);
    var q = String(v || '').trim();
    run(q);
    if(q.length >= 2) saveRecent(q);
  }

  // ---------- public ----------
  // Search.open() - start a fresh search. Search.open('2:255') - start with a query.
  Search.open = function(q){
    return Nav.push('search', { fresh: true, q: q || '' });
  };

  Nav.register('search', {
    singleton: true,
    mount: function(el){ build(el); },
    show: function(params){
      params = params || {};
      if(params.fresh){
        params.fresh = false;
        st.q = params.q || ''; st.status = 'idle'; st.matches = []; st.shown = 0; ++st.seq;
        if(st.q) run(st.q); else { renderNotice(); renderIdle(); }
      } else {
        renderNotice();
      }
    },
    hide: function(){ clearTimeout(timer); },
    topbar: function(){
      return {
        lead: 'back',
        search: { placeholder: T('সূরা, আয়াত বা শব্দ খুঁজুন', 'Search surah, ayah or word'), value: st.q, autofocus: !st.q, onInput: onInput, onSubmit: onSubmit }
      };
    },
    relocalize: function(){ if(els.root){ if(st.q) run(st.q); else { renderNotice(); renderIdle(); } } }
  });
  NAT.network.onChange(function(){ if(els.notice && Nav.top() && Nav.top().id === 'search'){ renderNotice(); if(st.q && st.status === 'offline') run(st.q); } });
})();
