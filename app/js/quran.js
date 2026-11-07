// ---------- Android app UI · Quran tab ----------
// The index of the Quran: 114 surahs (with Arabic name, place of revelation, ayah count and an
// offline marker), 30 juz, and numbered pages / hizb / ruku. Everything except the Arabic names and
// the place of revelation is built in (data.js), so the list is complete even on the first offline launch.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, D = QRApp.data, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;

  var mode = 'surah';
  var filterText = '';
  var els = {};

  function R(){ return QRApp.reader; }
  function savedMode(){
    var m = QRApp.prefs.get('quran_mode', 'surah');
    return D.LIMITS[m] ? m : 'surah';
  }
  function modeItems(){
    return [
      { id: 'surah', label: T('সূরা', 'Surah') },
      { id: 'juz', label: T('পারা', 'Juz') },
      { id: 'page', label: T('পৃষ্ঠা', 'Page') },
      { id: 'hizb', label: T('হিজব', 'Hizb') },
      { id: 'ruku', label: T('রুকু', 'Ruku') }
    ];
  }

  // ---------- shell ----------
  function build(el){
    mode = savedMode();
    els.root = h('div', { class: 'qa-quran' });
    els.head = h('div', { class: 'qa-quran-head' });
    els.seg = UI.seg(modeItems(), mode, function(id){
      mode = id; QRApp.prefs.set('quran_mode', id); filterText = '';
      renderBody(); window.scrollTo(0, 0);
    });
    els.head.appendChild(els.seg);
    els.body = h('div', { class: 'qa-quran-body' });
    els.root.appendChild(els.head);
    els.root.appendChild(els.body);
    el.appendChild(els.root);
    renderBody();
    if(!(state.surahList && state.surahList.length)) D.loadSurahList();
  }

  // ---------- surah list ----------
  function lastReadRow(){
    var lr = state.lastRead;
    if(!lr || !(lr.surah >= 1 && lr.surah <= 114)) return null;
    var card = h('button', { class: 'qa-continue qa-continue-sm', type: 'button' },
      h('span', { class: 'qa-continue-ic', html: icon('history') }),
      h('span', { class: 'qa-continue-main' },
        h('span', { class: 'qa-continue-kicker' }, T('শেষ পড়া', 'Last read')),
        h('span', { class: 'qa-continue-title' }, QRApp.surahName(lr.surah) + ' · ' + T('আয়াত ' + NUM(lr.ayah || 1), 'Ayah ' + (lr.ayah || 1)))),
      h('span', { class: 'qa-continue-go', html: icon('chevronRight') }));
    card.addEventListener('click', function(){ R().continueReading(); });
    return card;
  }

  function surahRow(s, isLast){
    var sub = [D.revelation(s.type), T(NUM(s.ayahs) + ' আয়াত', s.ayahs + ' ayahs')].filter(Boolean);
    var title = h('div', { class: 'qa-list-title' }, QRApp.surahName(s.number));
    if(typeof isSurahOffline === 'function' && isSurahOffline(s.number)){
      title.appendChild(h('span', { class: 'qa-dot-offline', title: T('অফলাইনে সংরক্ষিত', 'Saved offline') }));
    }
    var trail = h('div', { class: 'qa-list-trail' }, h('div', { class: 'qa-list-ar', lang: 'ar' }, s.ar || ''));
    if(isLast) trail.appendChild(h('div', { class: 'qa-list-meta qa-last-chip' }, T('শেষ পড়া', 'Last read')));
    var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0', 'data-surah': s.number },
      h('div', { class: 'qa-num' }, NUM(s.number)),
      h('div', { class: 'qa-list-main' }, title, h('div', { class: 'qa-list-sub' }, sub.join(' · '))),
      trail);
    item.addEventListener('click', function(){ R().open({ type: 'surah', num: s.number }); });
    return item;
  }

  function renderSurahs(){
    var wrap = h('div', { class: 'qa-stack' });
    var input = h('input', { class: 'qa-searchfield', type: 'search', placeholder: T('সূরার নাম বা নম্বর', 'Surah name or number'), autocomplete: 'off', 'aria-label': T('সূরা ফিল্টার', 'Filter surahs') });
    input.value = filterText;
    var listHost = h('div');
    function draw(){
      listHost.innerHTML = '';
      var q = D.normalize(D.asciiDigits(filterText));
      var raw = D.asciiDigits(filterText).trim();
      var lastN = state.lastRead && state.lastRead.surah;
      var list = D.surahs().filter(function(s){
        if(!q) return true;
        if(/^\d+$/.test(raw)) return String(s.number) === raw || String(s.number).indexOf(raw) === 0;
        return [s.bn, s.en, s.ar, s.enMeaning].some(function(k){ return D.normalize(k).indexOf(q) > -1; });
      });
      if(!list.length){
        listHost.appendChild(UI.empty({ icon: 'search', title: T('কোনো সূরা পাওয়া যায়নি', 'No surah found'), text: T('নাম বা নম্বর বদলে আবার চেষ্টা করুন।', 'Try a different name or number.') }));
        return;
      }
      var box = h('div', { class: 'qa-list' });
      var frag = document.createDocumentFragment();
      list.forEach(function(s){ frag.appendChild(surahRow(s, !filterText && s.number === lastN)); });
      box.appendChild(frag);
      listHost.appendChild(box);
    }
    input.addEventListener('input', QRApp.debounce(function(){ filterText = input.value; draw(); }, 120));
    var lr = lastReadRow();
    if(lr) wrap.appendChild(lr);
    wrap.appendChild(input);
    wrap.appendChild(listHost);
    draw();
    return wrap;
  }

  // ---------- juz ----------
  function renderJuz(){
    var box = h('div', { class: 'qa-list' });
    for(var i = 1; i <= 30; i++){
      (function(n){
        var st = D.JUZ_START[n - 1];
        var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
          h('div', { class: 'qa-num' }, NUM(n)),
          h('div', { class: 'qa-list-main' },
            h('div', { class: 'qa-list-title' }, T('পারা ' + NUM(n), 'Juz ' + n)),
            h('div', { class: 'qa-list-sub' }, T('শুরু: ', 'Starts: ') + QRApp.surahName(st[0]) + ' ' + NUM(st[0]) + ':' + NUM(st[1]))),
          h('div', { class: 'qa-list-trail' }, h('div', { class: 'qa-list-ar', lang: 'ar' }, D.JUZ_NAMES[n - 1])));
        item.addEventListener('click', function(){ R().open({ type: 'juz', num: n }); });
        box.appendChild(item);
      })(i);
    }
    return box;
  }

  // ---------- numbered grids: page / hizb / ruku ----------
  function renderNumbers(type){
    var max = D.LIMITS[type];
    var labels = {
      page: [T('পৃষ্ঠা', 'Page'), T('মুসহাফের পৃষ্ঠা নম্বর', 'Mushaf page number')],
      hizb: [T('হিজব', 'Hizb'), T('হিজব নম্বর', 'Hizb number')],
      ruku: [T('রুকু', 'Ruku'), T('রুকু নম্বর', 'Ruku number')]
    }[type];
    var wrap = h('div', { class: 'qa-stack' });
    var input = h('input', { class: 'qa-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: labels[1] + ' (১–' + NUM(max) + ')', 'aria-label': labels[1], autocomplete: 'off' });
    function go(){
      var n = parseInt(D.asciiDigits(input.value), 10);
      if(!(n >= 1 && n <= max)){ UI.snack(T('১ থেকে ' + NUM(max) + ' এর মধ্যে একটি সংখ্যা দিন', 'Enter a number from 1 to ' + max)); return; }
      input.blur();
      R().open({ type: type, num: n });
    }
    input.addEventListener('keydown', function(e){ if(e.key === 'Enter') go(); });
    var row = h('div', { class: 'qa-gonum' }, input, UI.button(T('যান', 'Go'), { kind: 'filled', onClick: go }));
    wrap.appendChild(row);
    var grid = h('div', { class: 'qa-numgrid' });
    var frag = document.createDocumentFragment();
    for(var n = 1; n <= max; n++){
      (function(k){
        var b = h('button', { class: 'qa-numcell', type: 'button', 'aria-label': labels[0] + ' ' + k }, NUM(k));
        b.addEventListener('click', function(){ R().open({ type: type, num: k }); });
        frag.appendChild(b);
      })(n);
    }
    grid.appendChild(frag);
    wrap.appendChild(grid);
    return wrap;
  }

  function renderBody(){
    if(!els.body) return;
    els.body.innerHTML = '';
    if(mode === 'surah') els.body.appendChild(renderSurahs());
    else if(mode === 'juz') els.body.appendChild(renderJuz());
    else els.body.appendChild(renderNumbers(mode));
  }

  Nav.register('quran', {
    tab: true, order: 2, icon: 'quran', label: ['কুরআন', 'Quran'],
    mount: function(el){ build(el); },
    show: function(){
      // cheap refresh of the parts that can change while the reader / downloads were used
      if(els.body && mode === 'surah' && !filterText) renderBody();
    },
    unmount: function(){ els = {}; },
    topbar: function(){
      return { title: T('কুরআন', 'Quran'), actions: [{ icon: 'search', label: T('খুঁজুন', 'Search'), onClick: function(){ QRApp.search.open(); } }] };
    }
  });
  function refresh(){ if(els.body) renderBody(); }
  QRApp.on('surahlist', refresh);
  QRApp.on('downloads', refresh);
})();
