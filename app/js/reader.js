// ---------- Android app UI · reader ----------
// The distraction-free reading screen for a surah / juz / page / hizb / ruku.
// It uses the website's own data layer unchanged (fetchAyahsWithTranslations,
// state.bookmarks / notes / lastRead, playAtIndex ...): the Arabic text, the
// translations and the audio come from exactly the same sources as on the
// website - only the screen is different.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NATIVE = QRApp.native, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N, esc = QRApp.esc;
  var Reader = QRApp.reader = {};

  // Shown above every surah except Al-Fatiha (where it is verse 1) and At-Tawbah. Same text as the website.
  var BISMILLAH = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';
  var AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  function arNum(n){ return String(n).replace(/[0-9]/g, function(d){ return AR_DIGITS[+d]; }); }

  var LIMITS = { surah: 114, juz: 30, page: 604, hizb: 60, ruku: 556 };

  var cur = null;          // { type, num, ayahs, header, showBismillah, surahInfo, surahBenefits, edition }
  var screen = null;       // navigation entry while the reader is open
  var seq = 0;             // guards against out-of-order loads
  var els = {};            // DOM references of the open reader
  var playlistKey = '';    // which view state.playlist currently belongs to
  var flashTimer = null;
  var scrollOff = null;
  var hafezTest = false;
  var wakeLock = null;
  var posSaveTimer = null;
  var readObserver = null;
  var renderToken = 0;

  // ---------- preferences ----------
  function getPrefs(){
    return {
      ar: QRApp.prefs.get('ar_size', 30),
      tr: QRApp.prefs.get('tr_size', 17),
      showTr: QRApp.prefs.get('show_tr', true),
      keepAwake: QRApp.prefs.get('keep_awake', false)
    };
  }
  function applySizes(){
    if(!els.wrap) return;
    var p = getPrefs();
    els.wrap.style.setProperty('--qa-ar-size', p.ar + 'px');
    els.wrap.style.setProperty('--qa-tr-size', p.tr + 'px');
    els.wrap.classList.toggle('qa-no-tr', !p.showTr);
  }

  // ---------- text helpers ----------
  function normAr(s){
    return String(s || '')
      .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
      .replace(/[ٱآأإ]/g, 'ا')
      .replace(/ى/g, 'ي');
  }
  var BISM_WORDS = normAr(BISMILLAH).split(/\s+/);
  // Some data sources prefix verse 1 of every surah with the Bismillah, which this screen already shows
  // once as a heading. Remove it from the *display* only when the text really starts with those four words.
  function stripLeadingBismillah(text){
    var words = String(text || '').trim().split(/\s+/);
    if(words.length <= 4) return text;
    for(var i = 0; i < 4; i++){ if(normAr(words[i]) !== BISM_WORDS[i]) return text; }
    return words.slice(4).join(' ');
  }
  function arabicFor(a){
    var t = a.arabic;
    if(a.numberInSurah === 1 && a.surah !== 1 && a.surah !== 9) t = stripLeadingBismillah(t);
    return t;
  }
  function wrapWords(text){
    return String(text || '').trim().split(/\s+/).map(function(w, i){
      return '<span class="qw" data-widx="' + i + '">' + esc(w) + '</span>';
    }).join(' ');
  }
  function arabicHtml(a){
    var html = wrapWords(arabicFor(a));
    try{ if(typeof tajweedHighlight === 'function') html = tajweedHighlight(html); }catch(e){}
    return html;
  }
  function surahLabel(num){ return QRApp.surahName(num); }
  function keyOf(a){ return a.surah + ':' + a.numberInSurah; }

  // ---------- view metadata ----------
  function viewTitle(type, num){
    if(type === 'surah') return surahLabel(num);
    if(type === 'juz') return T('পারা ' + NUM(num), 'Juz ' + num);
    if(type === 'page') return T('পৃষ্ঠা ' + NUM(num), 'Page ' + num);
    if(type === 'hizb') return T('হিজব ' + NUM(num), 'Hizb ' + num);
    return T('রুকু ' + NUM(num), 'Ruku ' + num);
  }
  function arabicTitle(type, num, arData){
    if(type === 'surah') return (arData && arData.name) || '';
    if(type === 'juz') return 'الجزء ' + arNum(num);
    if(type === 'page') return 'صفحة ' + arNum(num);
    if(type === 'hizb') return 'حزب ' + arNum(num);
    return 'ركوع ' + arNum(num);
  }
  function viewMeta(type, num, arData, count){
    var n = count;
    if(type === 'surah' && arData){
      var rev = arData.revelationType === 'Meccan' ? T('মাক্কী', 'Meccan') : T('মাদানী', 'Medinan');
      return rev + ' · ' + T(NUM(arData.numberOfAyahs || n) + ' আয়াত', (arData.numberOfAyahs || n) + ' ayahs');
    }
    return T(NUM(n) + ' আয়াত', n + ' ayahs');
  }

  // ---------- data ----------
  function fetchView(type, num){
    function surahOf(a){ return a.surah.number; }
    if(type === 'surah'){
      return fetchAyahsWithTranslations('surah/' + num, function(){ return num; });
    }
    if(type === 'hizb'){
      // A hizb is four quarters (rub' al-hizb); the data source lists quarters 1..240.
      var qs = [4 * num - 3, 4 * num - 2, 4 * num - 1, 4 * num];
      return Promise.all(qs.map(function(q){ return fetchAyahsWithTranslations('hizbQuarter/' + q, surahOf); })).then(function(parts){
        var ayahs = [];
        parts.forEach(function(p){ ayahs = ayahs.concat(p.ayahs); });
        return { arData: parts[0].arData, ayahs: ayahs };
      });
    }
    return fetchAyahsWithTranslations(type + '/' + num, surahOf);
  }

  // ---------- screen shell ----------
  // The navigation shell (nav.js) creates the <section> and calls mount(); the reader fills it.
  function buildScreen(host){
    els = {};
    els.wrap = h('div', { class: 'qa-reader', 'data-qa-reader': '' });
    els.progress = h('div', { class: 'qa-reader-progress', 'aria-hidden': 'true' }, h('span'));
    els.body = h('div', { class: 'qa-reader-body' });
    els.wrap.appendChild(els.body);
    host.classList.add('qa-reader-screen');
    host.setAttribute('aria-label', T('পাঠ', 'Reader'));
    host.appendChild(els.wrap);
    host.appendChild(els.progress);
    els.screen = host;
    els.wrap.addEventListener('click', onCardClick);
    applySizes();
    return host;
  }

  function topbarConfig(){
    var title = cur ? viewTitle(cur.type, cur.num) : '';
    var sub = cur && cur.ayahs ? viewMeta(cur.type, cur.num, cur.arData, cur.ayahs.length) : '';
    return {
      lead: 'back', title: title, sub: sub, elevated: false,
      actions: [
        { icon: 'play', label: T('সম্পূর্ণ শুনুন', 'Play all'), onClick: function(){ Reader.playAll(); } },
        { icon: 'tune', label: T('পড়ার সেটিংস', 'Reading settings'), onClick: Reader.openSettings },
        { icon: 'moreV', label: T('আরও', 'More'), onClick: Reader.openMore }
      ]
    };
  }

  function showSkeleton(){
    els.body.innerHTML = '';
    var sk = h('div', { class: 'qa-reader-skel' });
    sk.appendChild(UI.skeletonBlock(120));
    for(var i = 0; i < 3; i++){
      var b = UI.skeletonBlock(150); b.style.marginTop = '12px'; sk.appendChild(b);
    }
    els.body.appendChild(sk);
  }

  function showError(retry){
    els.body.innerHTML = '';
    var offlineMsg = !NATIVE.network.online;
    els.body.appendChild(UI.errorState({
      title: offlineMsg ? T('এই অংশটি অফলাইনে নেই', 'Not available offline') : T('লোড করা যায়নি', 'Could not load'),
      text: offlineMsg
        ? T('এটি আগে খোলা বা সংরক্ষণ করা হয়নি। ইন্টারনেট সংযোগ পেলে আবার চেষ্টা করুন।', 'This part was not opened or saved before. Try again when you are online.')
        : T('ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।', 'Check your connection and try again.'),
      onRetry: retry
    }));
  }

  // ---------- open ----------
  // Reader.open({ type, num, ayah, surah, autoplay, keepPosition }) -> Promise
  Reader.open = function(o){
    o = o || {};
    var type = LIMITS[o.type] ? o.type : 'surah';
    var num = parseInt(o.num, 10);
    if(!(num >= 1 && num <= LIMITS[type])){ UI.snack(T('সঠিক সংখ্যা দিন', 'Enter a valid number')); return Promise.resolve(false); }
    var mySeq = ++seq;

    // make sure there is exactly one reader screen, and it is on top
    var existing = Nav.find('reader');
    if(existing && Nav.top() !== existing) Nav.popTo('reader');
    if(!screen || !Nav.find('reader')){
      screen = Nav.push('reader', {});
      if(!screen) return Promise.resolve(false);
      attachScroll(); updateWakeLock();
    } else {
      window.scrollTo(0, 0);
    }
    cur = { type: type, num: num, ayahs: null, loading: true };
    state.currentReaderView = { type: type, num: num };
    Nav.refreshTopbar();
    showSkeleton();
    applySizes();
    var prevTarget = { surah: o.surah, ayah: o.ayah };

    return fetchView(type, num).then(function(res){
      if(mySeq !== seq || !screen) return false;
      var ayahs = res.ayahs || [];
      if(!ayahs.length) throw new Error('empty');
      cur = {
        type: type, num: num, ayahs: ayahs, arData: res.arData, loading: false,
        showBismillah: type === 'surah' && num !== 1 && num !== 9,
        surahInfo: (typeof surahInfoBn !== 'undefined') ? surahInfoBn[num] : null,
        surahBenefits: (typeof surahBenefitsBn !== 'undefined') ? surahBenefitsBn[num] : null,
        edition: (typeof activeTranslationEditions === 'function') ? activeTranslationEditions().join(',') : state.translationEdition
      };
      renderAll();
      Nav.refreshTopbar();
      // last-read bookkeeping (kept compatible with the website: state.lastRead + activity)
      var first = ayahs[0];
      if(type === 'surah'){
        if(!(state.lastRead && state.lastRead.surah === num)){ state.lastRead = { surah: num, ayah: first.numberInSurah }; saveLastRead(); }
      }
      try{ if(typeof recordActivityToday === 'function') recordActivityToday(); }catch(e){}
      QRApp.prefs.set('reader_pos', { type: type, num: num, surah: first.surah, ayah: first.numberInSurah, ts: Date.now() });
      QRApp.emit('reader-open', { type: type, num: num });
      // jump to a requested ayah, then optionally start the recitation from it
      var targetAyah = prevTarget.ayah;
      var targetSurah = prevTarget.surah || (type === 'surah' ? num : first.surah);
      if(targetAyah){
        // let the first paint finish so the position is exact
        requestAnimationFrame(function(){ requestAnimationFrame(function(){
          Reader.scrollToAyah(targetSurah, targetAyah, { flash: true });
          if(o.autoplay) Reader.playFrom(targetSurah, targetAyah);
        }); });
      } else if(o.autoplay){
        Reader.playAll();
      }
      return true;
    }).catch(function(e){
      if(mySeq !== seq || !screen) return false;
      QRApp.warn('reader load failed', e);
      cur = { type: type, num: num, ayahs: null, loading: false };
      showError(function(){ Reader.open({ type: type, num: num, ayah: o.ayah, surah: o.surah, autoplay: o.autoplay }); });
      return false;
    });
  };

  Reader.continueReading = function(){
    var lr = state.lastRead;
    if(lr && lr.surah >= 1 && lr.surah <= 114) return Reader.open({ type: 'surah', num: lr.surah, ayah: lr.ayah || 1 });
    return Reader.open({ type: 'surah', num: 1 });
  };

  // Re-fetch the same passage (translation language / compare editions changed) and keep the reading position.
  Reader.reload = function(){
    if(!screen || !cur) return Promise.resolve();
    var top = topVisible();
    return Reader.open({ type: cur.type, num: cur.num, surah: top && top.surah, ayah: top && top.ayah });
  };
  // Re-draw from the already loaded data (tajweed / transliteration / hafez / sizes) - no network.
  Reader.rerender = function(){
    if(!screen || !cur || !cur.ayahs) return;
    var top = topVisible();
    renderAll();
    if(top) Reader.scrollToAyah(top.surah, top.ayah, { instant: true });
  };
  Reader.current = function(){ return cur; };
  Reader.isOpen = function(){ return !!screen; };

  // ---------- rendering ----------
  function renderAll(){
    if(!els.body || !cur || !cur.ayahs) return;
    var token = ++renderToken;
    els.body.innerHTML = '';
    var hafez = !!state.hafezMode;
    els.wrap.classList.toggle('qa-hafez', hafez);
    els.wrap.classList.toggle('qa-hafez-test', hafez && hafezTest);
    els.wrap.classList.toggle('qa-translit-on', !!state.transliterationMode);
    applySizes();

    els.body.appendChild(buildHeader());
    var list = h('div', { class: 'qa-ayahs', role: 'list' });
    els.list = list;
    els.body.appendChild(list);
    var ayahs = cur.ayahs;
    var total = ayahs.length;
    var firstChunk = Math.min(total, 40);
    var singleSurah = cur.type === 'surah';
    function renderRange(from, to){
      var frag = document.createDocumentFragment();
      for(var i = from; i < to; i++){
        var a = ayahs[i];
        if(!singleSurah && a.numberInSurah === 1) frag.appendChild(surahDivider(a.surah));
        frag.appendChild(buildCard(a, i, singleSurah));
      }
      list.appendChild(frag);
    }
    renderRange(0, firstChunk);
    var rendered = firstChunk;
    els.ensureRendered = function(idx){
      if(rendered > idx) return;
      renderRange(rendered, total); rendered = total; finalizeRender();
    };
    function finalizeRender(){
      if(token !== renderToken) return;
      observeCards();
      Reader.syncPlaying();
    }
    if(total > firstChunk){
      (function pump(){
        if(token !== renderToken || rendered >= total) return;
        var next = Math.min(total, rendered + 60);
        renderRange(rendered, next); rendered = next;
        if(rendered < total){ (window.requestIdleCallback || function(f){ setTimeout(f, 16); })(pump); }
        else finalizeRender();
      })();
    } else finalizeRender();
    els.body.appendChild(buildFooter());
    observeCards();
    updateProgress();
  }

  function buildHeader(){
    // <div>, not <header>: the website's CSS styles every bare <header> element as its fixed top bar (css/header.css)
    var box = h('div', { class: 'qa-reader-head' });
    var info = cur;
    box.appendChild(h('div', { class: 'qa-reader-ar', lang: 'ar', dir: 'rtl' }, arabicTitle(info.type, info.num, info.arData)));
    box.appendChild(h('h1', { class: 'qa-reader-name' }, viewTitle(info.type, info.num)));
    box.appendChild(h('div', { class: 'qa-reader-meta' }, viewMeta(info.type, info.num, info.arData, info.ayahs.length)));
    var row = h('div', { class: 'qa-reader-actions' });
    row.appendChild(UI.button(info.type === 'surah' ? T('সম্পূর্ণ সূরা শুনুন', 'Listen to the surah') : T('সম্পূর্ণ শুনুন', 'Listen to all'), { icon: 'play', kind: 'filled', onClick: function(){ Reader.playAll(); } }));
    if(info.type === 'surah'){
      els.offlineBtn = offlineButton();
      row.appendChild(els.offlineBtn);
    }
    box.appendChild(row);
    if(info.type === 'surah' && (info.surahInfo || info.surahBenefits)){
      var infoRow = UI.row({ icon: 'book', title: T('সূরার পরিচিতি ও শানে নুযুল', 'About this surah'), sub: T('অবতীর্ণের প্রেক্ষাপট ও ফজিলত', 'Context of revelation and virtues'), onClick: Reader.openSurahInfo });
      var g = UI.group([infoRow]);
      g.style.marginTop = '14px';
      box.appendChild(g);
    }
    if(info.showBismillah) box.appendChild(h('div', { class: 'qa-bismillah', lang: 'ar', dir: 'rtl' }, BISMILLAH));
    return box;
  }

  function offlineButton(){
    var num = cur.num;
    var saved = isSurahOffline(num);
    var b = h('button', { class: 'qa-btn qa-btn-tonal', type: 'button' });
    function label(done){
      b.innerHTML = icon(done ? 'checkCircle' : 'cloudDownload');
      b.appendChild(document.createTextNode(done ? T('অফলাইনে সংরক্ষিত', 'Saved offline') : T('অফলাইনে সংরক্ষণ', 'Save offline')));
      b.classList.toggle('qa-on', !!done);
    }
    label(saved);
    b.addEventListener('click', function(){
      if(isSurahOffline(num)){
        UI.confirm({
          title: T('অফলাইন থেকে সরাবেন?', 'Remove from offline?'),
          text: T('এই সূরার ডাউনলোড করা অডিও মুছে যাবে।', 'The downloaded audio of this surah will be deleted.'),
          confirmLabel: T('সরান', 'Remove'), danger: true
        }).then(function(ok){
          if(!ok) return;
          removeSurahOffline(num).then(function(){ label(false); UI.snack(T('অফলাইন অডিও সরানো হয়েছে', 'Offline audio removed')); QRApp.emit('downloads'); });
        });
        return;
      }
      if(!NATIVE.network.online){ UI.snack(T('ডাউনলোড করতে ইন্টারনেট দরকার', 'You need to be online to download')); return; }
      ensurePlaylist();
      b.disabled = true;
      // the website's downloader reports progress by rewriting the button text
      var mo = new MutationObserver(function(){
        if(b.classList.contains('downloaded')){
          mo.disconnect(); b.disabled = false; label(true);
          UI.snack(T('অফলাইনে সংরক্ষণ হয়েছে', 'Saved for offline use')); QRApp.emit('downloads');
        }
      });
      mo.observe(b, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      try{ downloadCurrentAudioForOffline(b); }catch(e){ mo.disconnect(); b.disabled = false; label(false); UI.snack(T('ডাউনলোড শুরু করা যায়নি', 'Could not start the download')); }
    });
    return b;
  }

  function surahDivider(num){
    var d = h('div', { class: 'qa-surah-divider' }, h('span', {}, surahLabel(num)));
    if(num !== 1 && num !== 9) d.appendChild(h('div', { class: 'qa-bismillah qa-bismillah-sm', lang: 'ar', dir: 'rtl' }, BISMILLAH));
    return d;
  }

  function buildCard(a, idx, singleSurah){
    var key = keyOf(a);
    var bookmarked = !!state.bookmarks[key];
    var card = h('article', {
      class: 'qa-ayah' + (bookmarked ? ' qa-bookmarked' : ''), id: 'ayah-' + a.surah + '-' + a.numberInSurah,
      'data-key': key, 'data-surah': a.surah, 'data-ayah': a.numberInSurah, 'data-idx': idx, role: 'listitem'
    });
    var head = h('div', { class: 'qa-ayah-head' });
    head.appendChild(h('span', { class: 'qa-ayah-num', 'aria-label': T('আয়াত ' + NUM(a.numberInSurah), 'Ayah ' + a.numberInSurah) }, NUM(a.numberInSurah)));
    if(!singleSurah) head.appendChild(h('span', { class: 'qa-ayah-ref' }, surahLabel(a.surah)));
    head.appendChild(h('span', { class: 'qa-grow' }));
    head.appendChild(actBtn('play', 'play', T('শুনুন', 'Play')));
    head.appendChild(actBtn('bookmark', bookmarked ? 'bookmark' : 'bookmarkOutline', T('বুকমার্ক', 'Bookmark'), bookmarked));
    head.appendChild(actBtn('copy', 'copy', T('কপি', 'Copy')));
    head.appendChild(actBtn('share', 'share', T('শেয়ার', 'Share')));
    head.appendChild(actBtn('more', 'moreV', T('আরও', 'More')));
    card.appendChild(head);

    var ar = h('div', { class: 'qa-ar ar-text', lang: 'ar', dir: 'rtl', html: arabicHtml(a) });
    card.appendChild(ar);
    if(state.hafezMode){
      ar.appendChild(h('span', { class: 'qa-endmark', 'aria-hidden': 'true' }, '۝' + arNum(a.numberInSurah)));
    }
    if(state.transliterationMode && typeof transliterateArabic === 'function'){
      var tl = ''; try{ tl = transliterateArabic(a.arabic); }catch(e){}
      if(tl) card.appendChild(h('div', { class: 'qa-translit', text: tl }));
    }
    var trs = a.translations && a.translations.length ? a.translations : [];
    var compare = trs.length > 1;
    trs.forEach(function(t){
      if(!t || !t.text) return;
      var d = h('div', { class: 'qa-tr' + (compare ? ' qa-tr-compare' : ''), dir: t.dir === 'rtl' ? 'rtl' : 'ltr' });
      if(compare) d.appendChild(h('div', { class: 'qa-tr-label' }, t.label || ''));
      d.appendChild(h('div', { text: t.text }));
      card.appendChild(d);
    });
    var note = getNote(a.surah, a.numberInSurah);
    if(note) card.appendChild(noteLine(note));
    return card;
  }
  function noteLine(text){
    var n = h('div', { class: 'qa-note-line', 'data-act': 'note' });
    n.insertAdjacentHTML('beforeend', icon('edit', 'qa-ic-sm'));
    n.appendChild(h('span', { text: text }));
    return n;
  }
  function actBtn(act, ic, label, on){
    var b = h('button', { class: 'qa-iconbtn qa-sm' + (on ? ' qa-on' : ''), type: 'button', 'data-act': act, 'aria-label': label, title: label });
    b.innerHTML = icon(ic);
    return b;
  }

  function buildFooter(){
    var f = h('nav', { class: 'qa-reader-foot', 'aria-label': T('পরের / আগের', 'Previous / next') });
    var t = cur.type, n = cur.num, max = LIMITS[t];
    function nb(delta, lbl){
      var target = n + delta;
      var b = h('button', { class: 'qa-btn qa-btn-tonal', type: 'button' });
      var name = viewTitle(t, target);
      b.innerHTML = delta < 0 ? icon('chevronLeft') : '';
      b.appendChild(h('span', { class: 'qa-foot-label' }, h('small', {}, lbl), h('span', {}, name)));
      if(delta > 0) b.insertAdjacentHTML('beforeend', icon('chevronRight'));
      b.addEventListener('click', function(){ Reader.open({ type: t, num: target }); });
      return b;
    }
    if(n > 1) f.appendChild(nb(-1, T('আগের', 'Previous'))); else f.appendChild(h('span'));
    if(n < max) f.appendChild(nb(1, T('পরের', 'Next'))); else f.appendChild(h('span'));
    return f;
  }

  // ---------- card actions ----------
  function ayahFromCard(card){
    if(!card || !cur || !cur.ayahs) return null;
    var idx = parseInt(card.getAttribute('data-idx'), 10);
    return cur.ayahs[idx] || null;
  }
  function onCardClick(ev){
    var btn = ev.target.closest('[data-act]');
    var card = ev.target.closest('.qa-ayah');
    if(!card){ return; }
    var a = ayahFromCard(card);
    if(!a) return;
    var act = btn && btn.getAttribute('data-act');
    if(!act){
      if(state.hafezMode && hafezTest) card.classList.toggle('qa-revealed');
      return;
    }
    switch(act){
      case 'play': Reader.togglePlay(a, parseInt(card.getAttribute('data-idx'), 10)); break;
      case 'bookmark': toggleBookmarkFor(a, card, btn); break;
      case 'copy': copyAyah(a); break;
      case 'share': shareAyah(a); break;
      case 'more': openAyahMenu(a, card); break;
      case 'note': openNoteSheet(a, card); break;
    }
  }

  function displayAyahText(a){
    var parts = [arabicFor(a)];
    (a.translations || []).forEach(function(t){
      if(t && t.text) parts.push((a.translations.length > 1 && t.label ? '[' + t.label + '] ' : '') + t.text);
    });
    return parts.join('\n\n') + '\n\n— ' + surahLabel(a.surah) + ' (' + a.surah + ':' + a.numberInSurah + ')';
  }
  function copyAyah(a){
    NATIVE.haptic('light');
    NATIVE.copy(displayAyahText(a)).then(function(ok){ UI.snack(ok ? T('আয়াত কপি হয়েছে', 'Ayah copied') : T('কপি করা যায়নি', 'Could not copy')); });
  }
  function shareAyah(a){
    NATIVE.haptic('light');
    NATIVE.share({
      title: surahLabel(a.surah) + ' ' + a.surah + ':' + a.numberInSurah,
      text: displayAyahText(a) + '\n\n' + T('কুরআন বাংলা অ্যাপ থেকে', 'From the Quran Bangla app'),
      url: location.origin + '/'
    }).then(function(r){
      if(r && r.ok){ try{ if(typeof incrementShareCount === 'function') incrementShareCount(); }catch(e){} }
      if(r && r.method === 'clipboard') UI.snack(T('শেয়ার সম্ভব হয়নি — আয়াত কপি করা হয়েছে', 'Sharing is unavailable — ayah copied'));
      else if(r && !r.ok && !r.cancelled) UI.snack(T('শেয়ার করা যায়নি', 'Could not share'));
    });
  }
  function toggleBookmarkFor(a, card, btn){
    var key = keyOf(a);
    var on;
    if(state.bookmarks[key]){ delete state.bookmarks[key]; on = false; }
    else { state.bookmarks[key] = true; on = true; }
    saveBookmarks();
    NATIVE.haptic(on ? 'success' : 'light');
    card.classList.toggle('qa-bookmarked', on);
    btn.classList.toggle('qa-on', on);
    btn.innerHTML = icon(on ? 'bookmark' : 'bookmarkOutline');
    QRApp.emit('bookmarks');
    UI.snack(on ? T('বুকমার্কে যোগ হয়েছে', 'Bookmarked') : T('বুকমার্ক সরানো হয়েছে', 'Bookmark removed'), {
      action: { label: T('পূর্বাবস্থায়', 'Undo'), onClick: function(){
        if(on) delete state.bookmarks[key]; else state.bookmarks[key] = true;
        saveBookmarks();
        var nowOn = !!state.bookmarks[key];
        card.classList.toggle('qa-bookmarked', nowOn);
        btn.classList.toggle('qa-on', nowOn);
        btn.innerHTML = icon(nowOn ? 'bookmark' : 'bookmarkOutline');
        QRApp.emit('bookmarks');
      } }
    });
  }
  function openAyahMenu(a, card){
    var hasNote = !!getNote(a.surah, a.numberInSurah);
    var actions = [
      { icon: 'play', label: T('এই আয়াত থেকে শুনুন', 'Play from this ayah'), onClick: function(){ Reader.playFrom(a.surah, a.numberInSurah); } },
      { icon: 'edit', label: hasNote ? T('নোট দেখুন / সম্পাদনা', 'View / edit note') : T('নোট লিখুন', 'Add a note'), onClick: function(){ openNoteSheet(a, card); } }
    ];
    if(typeof openAiTafsirModal === 'function'){
      actions.push({ icon: 'sparkle', label: T('AI তাফসীর', 'AI tafsir'), onClick: function(){
        var tr = (a.translations && a.translations[0]) ? a.translations[0].text : '';
        openAiTafsirModal({ surahBn: surahLabel(a.surah), ayahNum: a.numberInSurah, arabic: a.arabic, translation: tr });
      } });
    }
    UI.actionSheet({ title: surahLabel(a.surah) + ' · ' + T('আয়াত ' + NUM(a.numberInSurah), 'Ayah ' + a.numberInSurah), actions: actions });
  }
  function openNoteSheet(a, card, done){
    var current = getNote(a.surah, a.numberInSurah);
    var ta = h('textarea', { class: 'qa-input qa-textarea', rows: '5', placeholder: T('এই আয়াত সম্পর্কে আপনার নোট…', 'Your note about this ayah…'), maxlength: '2000' });
    ta.value = current;
    var actions = [];
    function after(){ if(card) refreshNote(a, card); QRApp.emit('notes'); if(typeof done === 'function'){ try{ done(); }catch(e){} } }
    if(current) actions.push({ label: T('মুছুন', 'Delete'), kind: 'text', onClick: function(){
      deleteNote(a.surah, a.numberInSurah); after(); UI.snack(T('নোট মুছে ফেলা হয়েছে', 'Note deleted'));
    } });
    actions.push({ label: T('সংরক্ষণ', 'Save'), kind: 'filled', onClick: function(){
      saveNote(a.surah, a.numberInSurah, ta.value); after();
      UI.snack(ta.value.trim() ? T('নোট সংরক্ষিত', 'Note saved') : T('নোট মুছে ফেলা হয়েছে', 'Note deleted'));
    } });
    UI.sheet({ title: T('নোট', 'Note') + ' · ' + surahLabel(a.surah) + ' ' + a.surah + ':' + a.numberInSurah, body: ta, actions: actions });
    setTimeout(function(){ try{ ta.focus(); }catch(e){} }, 280);
  }
  function refreshNote(a, card){
    var old = card.querySelector('.qa-note-line');
    if(old) old.remove();
    var text = getNote(a.surah, a.numberInSurah);
    if(text) card.appendChild(noteLine(text));
  }
  // Edit the note of any ayah from outside the reader (Bookmarks > Notes).
  Reader.editNote = function(surah, ayah, done){ openNoteSheet({ surah: surah, numberInSurah: ayah }, null, done); };

  // ---------- audio ----------
  function ensurePlaylist(){
    if(!cur || !cur.ayahs) return;
    var k = cur.type + ':' + cur.num + ':' + cur.edition;
    if(playlistKey === k && state.playlist.length === cur.ayahs.length && state.playlist[0] && state.playlist[0].key === keyOf(cur.ayahs[0])) return;
    state.playlist = cur.ayahs.map(function(a){
      return { key: keyOf(a), globalNumber: a.number, surah: a.surah, numberInSurah: a.numberInSurah, title: (typeof surahNamesBn !== 'undefined' && surahNamesBn[a.surah - 1]) || ('সূরা ' + a.surah) };
    });
    playlistKey = k;
  }
  Reader.playAll = function(){
    if(!cur || !cur.ayahs) return;
    ensurePlaylist();
    playAtIndex(0, true);
  };
  Reader.playFrom = function(surah, ayah){
    if(!cur || !cur.ayahs) return;
    ensurePlaylist();
    var idx = cur.ayahs.findIndex(function(a){ return a.surah === surah && a.numberInSurah === ayah; });
    playAtIndex(idx < 0 ? 0 : idx, true);
  };
  Reader.togglePlay = function(a, idx){
    ensurePlaylist();
    var it = state.playlist[state.playIndex];
    if(state.isPlaying && it && it.key === keyOf(a)) pausePlayback();
    else playAtIndex(idx, true);
  };
  var lastPlayingCard = null;
  Reader.syncPlaying = function(){
    if(!els.list) return;
    var it = state.playIndex >= 0 ? state.playlist[state.playIndex] : null;
    var prev = lastPlayingCard;
    if(prev && prev.isConnected){
      prev.classList.remove('qa-playing');
      var pb = prev.querySelector('[data-act="play"]'); if(pb) pb.innerHTML = icon('play');
    }
    lastPlayingCard = null;
    if(!it) return;
    var card = document.getElementById('ayah-' + it.surah + '-' + it.numberInSurah);
    if(!card || !els.list.contains(card)) return;
    lastPlayingCard = card;
    card.classList.toggle('qa-playing', true);
    var b = card.querySelector('[data-act="play"]');
    if(b){ b.innerHTML = icon(state.isPlaying ? 'pause' : 'play'); b.classList.toggle('qa-on', !!state.isPlaying); }
    if(!state.isPlaying) card.classList.remove('qa-playing');
  };

  // ---------- position tracking ----------
  function cards(){ return els.list ? els.list.getElementsByClassName('qa-ayah') : []; }
  function topVisible(){
    var cs = cards();
    if(!cs.length) return null;
    var limit = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 56) + 8;
    var lo = 0, hi = cs.length - 1, ans = 0;
    while(lo <= hi){
      var mid = (lo + hi) >> 1;
      var r = cs[mid].getBoundingClientRect();
      if(r.bottom > limit){ ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    var c = cs[ans];
    return { surah: parseInt(c.getAttribute('data-surah'), 10), ayah: parseInt(c.getAttribute('data-ayah'), 10), idx: ans, total: cs.length };
  }
  function updateProgress(){
    if(!els.progress || !cur || !cur.ayahs) return;
    var t = topVisible();
    if(!t) return;
    var frac = (t.idx + 1) / Math.max(cur.ayahs.length, 1);
    els.progress.firstChild.style.width = (frac * 100).toFixed(1) + '%';
    els.progress.classList.toggle('qa-on', cur.ayahs.length > 1);
  }
  function onScroll(){
    if(!screen || Nav.top() !== screen) return;
    updateProgress();
    var t = topVisible();
    if(!t || !cur) return;
    clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(function(){
      if(!screen || !cur) return;
      var s = topVisible(); if(!s) return;
      if(!(state.lastRead && state.lastRead.surah === s.surah && state.lastRead.ayah === s.ayah)){
        state.lastRead = { surah: s.surah, ayah: s.ayah }; saveLastRead(); QRApp.emit('lastread');
      }
      QRApp.prefs.set('reader_pos', { type: cur.type, num: cur.num, surah: s.surah, ayah: s.ayah, ts: Date.now() });
    }, 700);
  }
  var throttledScroll = null;
  function attachScroll(){
    if(scrollOff) return;
    throttledScroll = QRApp.throttleRaf(onScroll);
    window.addEventListener('scroll', throttledScroll, { passive: true });
    scrollOff = function(){ window.removeEventListener('scroll', throttledScroll); scrollOff = null; };
  }
  function detachScroll(){
    if(scrollOff) scrollOff();
    // flush the position that was reached
    if(cur && cur.ayahs && els.list){
      var s = topVisible();
      if(s){ state.lastRead = { surah: s.surah, ayah: s.ayah }; saveLastRead(); QRApp.prefs.set('reader_pos', { type: cur.type, num: cur.num, surah: s.surah, ayah: s.ayah, ts: Date.now() }); QRApp.emit('lastread'); }
    }
    clearTimeout(posSaveTimer);
  }
  // count an ayah as read once it has stayed on screen for a moment (same rule as the website)
  function observeCards(){
    if(!('IntersectionObserver' in window) || !els.list) return;
    if(readObserver) readObserver.disconnect();
    var timers = new Map();
    readObserver = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        var key = en.target.getAttribute('data-key');
        if(!key) return;
        if(en.isIntersecting){
          if(timers.has(key) || state.ayahsRead[key]) return;
          timers.set(key, setTimeout(function(){ try{ markAyahRead(key); }catch(e){} timers.delete(key); }, 1500));
        } else {
          var t = timers.get(key);
          if(t){ clearTimeout(t); timers.delete(key); }
        }
      });
    }, { threshold: 0.6 });
    Array.prototype.forEach.call(cards(), function(c){ readObserver.observe(c); });
  }

  Reader.scrollToAyah = function(surah, ayah, opts){
    opts = opts || {};
    if(!cur || !cur.ayahs) return false;
    var idx = cur.ayahs.findIndex(function(a){ return a.surah === surah && a.numberInSurah === ayah; });
    if(idx < 0) return false;
    if(els.ensureRendered) els.ensureRendered(idx);
    var el = document.getElementById('ayah-' + surah + '-' + ayah);
    if(!el) return false;
    var headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 56;
    var y = el.getBoundingClientRect().top + window.scrollY - headerH - 12;
    window.scrollTo(0, Math.max(0, y));
    if(opts.flash){
      el.classList.add('qa-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(function(){ el.classList.remove('qa-flash'); }, 1800);
    }
    updateProgress();
    return true;
  };

  // ---------- keep the screen on while reading (web Wake Lock API, only if the user enables it) ----------
  function updateWakeLock(){
    var want = getPrefs().keepAwake && !!screen && Nav.top() === screen;
    if(!want){ releaseWakeLock(); return; }
    if(!('wakeLock' in navigator) || wakeLock) return;
    try{
      navigator.wakeLock.request('screen').then(function(l){
        wakeLock = l; l.addEventListener('release', function(){ wakeLock = null; });
      }).catch(function(){});
    }catch(e){}
  }
  function releaseWakeLock(){ if(wakeLock){ try{ wakeLock.release(); }catch(e){} wakeLock = null; } }
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible') updateWakeLock(); });

  function teardown(){
    detachScroll(); releaseWakeLock();
    if(readObserver){ readObserver.disconnect(); readObserver = null; }
    renderToken++; seq++;
    screen = null; cur = null; els = {}; lastPlayingCard = null; hafezTest = false;
  }

  // ---------- registration with the navigation shell ----------
  Nav.register('reader', {
    mount: function(el){
      buildScreen(el);
      if(cur && cur.ayahs) renderAll(); else if(cur && cur.loading) showSkeleton();
    },
    show: function(){ attachScroll(); updateWakeLock(); Reader.syncPlaying(); },
    hide: function(){ detachScroll(); releaseWakeLock(); },
    unmount: function(){ teardown(); },
    // interface language changed: redraw the loaded passage in place (position and audio are kept)
    relocalize: function(){ if(!cur) return; Nav.refreshTopbar(); if(cur.ayahs) Reader.rerender(); },
    topbar: topbarConfig
  });

  // ---------- more menu / go to ayah ----------
  Reader.openMore = function(){
    if(!cur || !cur.ayahs) return;
    var actions = [];
    actions.push({ icon: 'search', label: T('নির্দিষ্ট আয়াতে যান', 'Go to ayah'), onClick: Reader.goToAyahPrompt });
    if(cur.type === 'surah' && (cur.surahInfo || cur.surahBenefits)) actions.push({ icon: 'book', label: T('সূরার পরিচিতি', 'About this surah'), onClick: Reader.openSurahInfo });
    if(state.hafezMode){
      actions.push({ icon: hafezTest ? 'visibility' : 'visibility', label: hafezTest ? T('মুখস্থ যাচাই বন্ধ করুন', 'Stop memorisation test') : T('মুখস্থ যাচাই চালু করুন', 'Start memorisation test'), onClick: function(){
        hafezTest = !hafezTest;
        els.wrap.classList.toggle('qa-hafez-test', hafezTest);
        Array.prototype.forEach.call(cards(), function(c){ c.classList.remove('qa-revealed'); });
        UI.snack(hafezTest ? T('যেকোনো আয়াতে ট্যাপ করলে তা দেখা যাবে', 'Tap an ayah to reveal it') : T('মুখস্থ যাচাই বন্ধ', 'Test off'));
      } });
      if(cur.type === 'surah') actions.push({ icon: 'checkCircle', label: T('আজকের হিফজ রিভিউ সম্পন্ন', 'Mark today\'s hifz review done'), onClick: function(){
        try{ var days = logHifzReview(cur.num); UI.snack(T('রিভিউ সম্পন্ন! পরবর্তী রিভিউ ' + NUM(days) + ' দিন পর।', 'Review done! Next review in ' + days + ' day(s).')); }catch(e){}
      } });
    }
    actions.push({ icon: 'tune', label: T('পড়ার সেটিংস', 'Reading settings'), onClick: Reader.openSettings });
    UI.actionSheet({ title: viewTitle(cur.type, cur.num), actions: actions });
  };
  Reader.goToAyahPrompt = function(){
    if(!cur || !cur.ayahs) return;
    var single = cur.type === 'surah';
    var max = single ? cur.ayahs.length : 0;
    UI.prompt({
      title: T('আয়াতে যান', 'Go to ayah'),
      text: single ? T('১ থেকে ' + NUM(max) + ' এর মধ্যে আয়াত নম্বর দিন', 'Enter an ayah number from 1 to ' + max) : T('সূরা:আয়াত লিখুন, যেমন ২:২৫৫', 'Enter surah:ayah, for example 2:255'),
      type: single ? 'number' : 'text', placeholder: single ? '1' : '2:255',
      validate: function(v){
        if(single){ var n = parseInt(v, 10); return (n >= 1 && n <= max) ? '' : T('সঠিক আয়াত নম্বর দিন', 'Enter a valid ayah number'); }
        return /^\d+\s*:\s*\d+$/.test(v) ? '' : T('সূরা:আয়াত ফরম্যাটে লিখুন', 'Use the surah:ayah format');
      }
    }).then(function(v){
      if(!v) return;
      var s, a;
      if(single){ s = cur.num; a = parseInt(v, 10); }
      else { var p = v.split(':'); s = parseInt(p[0], 10); a = parseInt(p[1], 10); }
      if(!Reader.scrollToAyah(s, a, { flash: true })) UI.snack(T('এই অংশে ওই আয়াত নেই', 'That ayah is not in this part'));
    });
  };

  Reader.openSurahInfo = function(){
    if(!cur || cur.type !== 'surah') return;
    var wrap = h('div', { class: 'qa-info-body' });
    function hl(text){ try{ return typeof highlightSurahInfoText === 'function' ? highlightSurahInfoText(text) : esc(text); }catch(e){ return esc(text); } }
    if(cur.surahInfo){
      wrap.appendChild(h('h3', { class: 'qa-info-h' }, T('পরিচিতি ও শানে নুযুল', 'Introduction and context')));
      wrap.appendChild(h('p', { class: 'qa-info-p qa-selectable', html: hl(cur.surahInfo) }));
    }
    var b = cur.surahBenefits;
    if(b && b.usage){
      wrap.appendChild(h('h3', { class: 'qa-info-h' }, T('কোন কাজে ও কখন পড়া উত্তম', 'When it is recommended to recite')));
      wrap.appendChild(h('p', { class: 'qa-info-p qa-selectable', html: hl(b.usage) }));
    }
    if(b && b.ailment){
      wrap.appendChild(h('h3', { class: 'qa-info-h' }, T('রোগমুক্তি ও সুরক্ষার জন্য প্রচলিত আমল', 'Traditional practice for protection and relief')));
      wrap.appendChild(h('p', { class: 'qa-info-p qa-selectable', html: hl(b.ailment) }));
      wrap.appendChild(h('p', { class: 'qa-info-note' }, T('এটি ইসলামি ঐতিহ্যে বর্ণিত আধ্যাত্মিক ফজিলতের পরিচিতি মাত্র — চিকিৎসকের পরামর্শ ও প্রয়োজনীয় চিকিৎসার বিকল্প নয়।', 'This describes a spiritual tradition only — it is not a substitute for medical advice or treatment.')));
    }
    UI.sheet({ title: viewTitle(cur.type, cur.num), sub: T('সূরার পরিচিতি', 'About this surah'), body: wrap });
  };

  // ---------- reading settings ----------
  Reader.openSettings = function(){
    var p = getPrefs();
    var body = h('div', { class: 'qa-stack', style: { gap: '18px' } });

    function sliderRow(label, key, min, max, value, previewCls){
      var out = h('span', { class: 'qa-val' }, String(value));
      var input = h('input', { type: 'range', class: 'qa-range', min: String(min), max: String(max), step: '1', value: String(value), 'aria-label': label });
      input.addEventListener('input', function(){
        out.textContent = input.value;
        QRApp.prefs.set(key, parseInt(input.value, 10));
        applySizes();
      });
      return h('div', {}, h('div', { class: 'qa-row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('span', { class: 'qa-row-title' }, label), out), input);
    }
    var preview = h('div', { class: 'qa-settings-preview' },
      h('div', { class: 'qa-ar', lang: 'ar', dir: 'rtl', style: { fontSize: 'var(--qa-ar-size,30px)' } }, 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَالَمِينَ'),
      h('div', { class: 'qa-tr', style: { fontSize: 'var(--qa-tr-size,17px)' } }, T('সমস্ত প্রশংসা আল্লাহর, যিনি সকল সৃষ্টির প্রতিপালক।', 'All praise is for Allah, Lord of all worlds.'))
    );
    preview.style.setProperty('--qa-ar-size', p.ar + 'px');
    preview.style.setProperty('--qa-tr-size', p.tr + 'px');
    body.appendChild(preview);
    var arRow = sliderRow(T('আরবি লেখার আকার', 'Arabic text size'), 'ar_size', 22, 48, p.ar);
    var trRow = sliderRow(T('অনুবাদের আকার', 'Translation size'), 'tr_size', 13, 28, p.tr);
    function syncPreview(){
      var q = getPrefs();
      preview.style.setProperty('--qa-ar-size', q.ar + 'px'); preview.style.setProperty('--qa-tr-size', q.tr + 'px');
    }
    arRow.querySelector('input').addEventListener('input', syncPreview);
    trRow.querySelector('input').addEventListener('input', syncPreview);
    body.appendChild(arRow); body.appendChild(trRow);

    var rows = [];
    rows.push(UI.switchRow({ icon: 'translate', title: T('অনুবাদ দেখান', 'Show translation'), checked: p.showTr, onChange: function(v){ QRApp.prefs.set('show_tr', v); applySizes(); } }));
    rows.push(UI.switchRow({ icon: 'textSize', title: T('উচ্চারণ (বাংলা হরফে)', 'Transliteration'), sub: T('আরবি উচ্চারণের আনুমানিক বাংলা রূপ', 'Approximate pronunciation'), checked: !!state.transliterationMode, onChange: function(v){
      state.transliterationMode = v; try{ saveTransliterationMode(); if(v) markTransliterationUsed(); }catch(e){} Reader.rerender();
    } }));
    rows.push(UI.switchRow({ icon: 'palette', title: T('তাজবীদ রং', 'Tajweed colours'), sub: T('সাধারণ নিয়মভিত্তিক আনুমানিক রং — শিক্ষার সহায়ক মাত্র', 'Approximate rule-based colours — a learning aid only'), checked: !!state.tajweedMode, onChange: function(v){
      state.tajweedMode = v; try{ saveTajweedMode(); if(v) markTajweedUsed(); }catch(e){} Reader.rerender();
    } }));
    rows.push(UI.switchRow({ icon: 'book', title: T('হাফেজ মোড', 'Hafez mode'), sub: T('শুধু আরবি, মুসহাফের মতো একটানা', 'Arabic only, mushaf-style continuous text'), checked: !!state.hafezMode, onChange: function(v){
      state.hafezMode = v; try{ saveHafezMode(); if(v) markHafezUsed(); }catch(e){} if(!v) hafezTest = false; Reader.rerender();
    } }));
    if('wakeLock' in navigator){
      rows.push(UI.switchRow({ icon: 'visibility', title: T('পড়ার সময় স্ক্রিন চালু রাখুন', 'Keep screen on while reading'), checked: p.keepAwake, onChange: function(v){ QRApp.prefs.set('keep_awake', v); updateWakeLock(); } }));
    }
    body.appendChild(UI.group(rows));

    var pickRows = [
      UI.row({ icon: 'globe', title: T('অনুবাদের ভাষা', 'Translation'), value: QRApp.pick.translationLabel(), onClick: function(ev, row){ QRApp.pick.translation().then(function(){ row.setValue(QRApp.pick.translationLabel()); }); } }),
      UI.row({ icon: 'list', title: T('তুলনামূলক অনুবাদ', 'Compare translations'), value: QRApp.pick.compareLabel(), onClick: function(ev, row){ QRApp.pick.compare().then(function(){ row.setValue(QRApp.pick.compareLabel()); }); } }),
      UI.row({ icon: 'mic', title: T('ক্বারী', 'Reciter'), value: QRApp.pick.reciterLabel(), onClick: function(ev, row){ QRApp.pick.reciter().then(function(){ row.setValue(QRApp.pick.reciterLabel()); }); } })
    ];
    body.appendChild(UI.group(pickRows));
    UI.sheet({ title: T('পড়ার সেটিংস', 'Reading settings'), body: body });
  };

  // The website's own player marks the playing ayah through syncPlayingUI(); mirror that on the app cards.
  (function(){
    var origSync = window.syncPlayingUI;
    if(typeof origSync === 'function'){
      window.syncPlayingUI = function(){
        try{ origSync.apply(this, arguments); }catch(e){}
        try{ Reader.syncPlaying(); }catch(e){}
        QRApp.emit('playstate');
      };
    }
  })();
})();
