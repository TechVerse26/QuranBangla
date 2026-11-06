// ---------- Android app UI · Bookmarks tab ----------
// Everything the reader saved on this device, in one place:
//   Saved ayahs (bookmarks) · Notes · Listening history · Offline audio
// The data is the website's own (state.bookmarks / state.notes / state.history / state.offlineSurahs), so
// whatever is saved here also shows on the website, and vice versa. Bookmarks, notes and history live on
// the device by design (they are not part of the account sync) - the screen says so.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native, D = QRApp.data, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;

  var TABS = ['bookmarks', 'notes', 'history', 'offline'];
  var tab = 'bookmarks';
  var els = {};
  var observer = null;
  var queue = [], running = 0;

  function R(){ return QRApp.reader; }
  function tabItems(){
    return [
      { id: 'bookmarks', label: T('বুকমার্ক', 'Saved') },
      { id: 'notes', label: T('নোট', 'Notes') },
      { id: 'history', label: T('শোনা', 'Listened') },
      { id: 'offline', label: T('অফলাইন', 'Offline') }
    ];
  }
  function isVisible(){ var c = Nav.current(); return !!(c && c.id === 'library' && els.body); }

  // ---------- lazy translation previews ----------
  // A bookmark only stores "surah:ayah". The text is fetched when the row scrolls into view (and cached by
  // data.js for offline use); at most two requests run at a time.
  function pump(){
    while(running < 2 && queue.length){
      var job = queue.shift();
      running++;
      D.ayahPreview(job.s, job.a).then(job.done).catch(function(){ job.fail && job.fail(); }).then(function(){ running--; pump(); });
    }
  }
  function lazyPreview(el, s, a){
    var cached = D.ayahPreviewCached(s, a);
    if(cached){ el.textContent = cached.translation || cached.arabic; return; }
    el.textContent = '';
    el._qa = { s: s, a: a };
    if(!observer){
      observer = new IntersectionObserver(function(entries){
        entries.forEach(function(en){
          if(!en.isIntersecting) return;
          var node = en.target; observer.unobserve(node);
          var p = node._qa; if(!p) return;
          if(!NAT.network.online){ node.textContent = T('ইন্টারনেট পেলে প্রিভিউ দেখা যাবে', 'Preview shows when you are online'); return; }
          queue.push({ s: p.s, a: p.a, done: function(d){ if(node.isConnected) node.textContent = d.translation || d.arabic; }, fail: function(){ node.textContent = ''; } });
          pump();
        });
      }, { rootMargin: '240px 0px' });
    }
    observer.observe(el);
  }

  function emptyFor(kind){
    var cfg = {
      bookmarks: { icon: 'bookmarkOutline', title: T('এখনও কোনো আয়াত সংরক্ষণ করা হয়নি', 'No saved ayahs yet'), text: T('পড়ার সময় আয়াতের বুকমার্ক আইকনে ট্যাপ করুন — এখানে জমা থাকবে।', 'Tap the bookmark icon on an ayah while reading — it will be kept here.'), actionLabel: T('কুরআন পড়ুন', 'Open the Quran'), onAction: function(){ Nav.go('quran'); } },
      notes: { icon: 'edit', title: T('এখনও কোনো নোট নেই', 'No notes yet'), text: T('আয়াতের মেনু থেকে "নোট লিখুন" বেছে নিজের কথা লিখে রাখুন।', 'Open an ayah\'s menu and choose "Add a note" to write your own thoughts.'), actionLabel: T('কুরআন পড়ুন', 'Open the Quran'), onAction: function(){ Nav.go('quran'); } },
      history: { icon: 'headphones', title: T('এখনও কিছু শোনা হয়নি', 'Nothing played yet'), text: T('কোনো সূরা বা আয়াত চালু করলে এখানে দেখা যাবে, যাতে সহজে আবার শুনতে পারেন।', 'Play a surah or an ayah and it will show up here so you can resume it quickly.'), actionLabel: T('সূরা বেছে নিন', 'Choose a surah'), onAction: function(){ Nav.go('quran'); } },
      offline: { icon: 'cloudDownload', title: T('কোনো সূরা অফলাইনে সংরক্ষিত নেই', 'No surah saved offline'), text: T('সূরার অডিও ডাউনলোড করলে ইন্টারনেট ছাড়াই শুনতে পারবেন।', 'Download a surah\'s audio to listen without internet.'), actionLabel: T('ডাউনলোড ম্যানেজার', 'Download manager'), onAction: function(){ QRApp.features.open('downloads'); } }
    }[kind];
    return UI.empty(cfg);
  }

  function ref(s, a){ return QRApp.surahName(s) + ' · ' + T('আয়াত ' + NUM(a), 'Ayah ' + a); }

  // ---------- saved ayahs ----------
  function sortMode(){ return QRApp.prefs.get('lib_sort', 'recent'); }
  function renderBookmarks(host){
    var keys = Object.keys(state.bookmarks || {}).filter(function(k){
      var p = k.split(':').map(Number); return p[0] >= 1 && p[0] <= 114 && p[1] >= 1;
    });
    if(!keys.length){ host.appendChild(emptyFor('bookmarks')); return; }
    var mode = sortMode();
    var ordered = keys.slice();
    if(mode === 'recent') ordered.reverse();
    else ordered.sort(function(x, y){ var a = x.split(':').map(Number), b = y.split(':').map(Number); return a[0] - b[0] || a[1] - b[1]; });

    var head = h('div', { class: 'qa-lib-head' });
    head.appendChild(h('div', { class: 'qa-caption' }, T(NUM(keys.length) + 'টি আয়াত সংরক্ষিত', keys.length + ' saved ayah' + (keys.length === 1 ? '' : 's'))));
    var chips = h('div', { class: 'qa-chips' });
    chips.appendChild(UI.chip(T('সাম্প্রতিক', 'Recent'), function(){ QRApp.prefs.set('lib_sort', 'recent'); renderBody(); }, mode === 'recent'));
    chips.appendChild(UI.chip(T('কুরআনের ক্রম', 'Quran order'), function(){ QRApp.prefs.set('lib_sort', 'order'); renderBody(); }, mode === 'order'));
    head.appendChild(chips);
    host.appendChild(head);

    var list = h('div', { class: 'qa-list' });
    var frag = document.createDocumentFragment();
    ordered.forEach(function(key){
      var p = key.split(':').map(Number), s = p[0], a = p[1];
      var sub = h('div', { class: 'qa-list-sub qa-clamp' });
      var rm = h('button', { class: 'qa-iconbtn qa-sm qa-on', type: 'button', 'aria-label': T('বুকমার্ক সরান', 'Remove bookmark') });
      rm.innerHTML = icon('bookmark');
      var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
        h('div', { class: 'qa-num qa-num-wide' }, NUM(s) + ':' + NUM(a)),
        h('div', { class: 'qa-list-main' }, h('div', { class: 'qa-list-title' }, ref(s, a)), sub),
        h('div', { class: 'qa-list-trail' }, rm));
      item.addEventListener('click', function(){ R().open({ type: 'surah', num: s, ayah: a, surah: s }); });
      rm.addEventListener('click', function(ev){
        ev.stopPropagation();
        delete state.bookmarks[key]; saveBookmarks(); NAT.haptic('light');
        QRApp.emit('bookmarks');
        UI.snack(T('বুকমার্ক সরানো হয়েছে', 'Bookmark removed'), { action: { label: T('পূর্বাবস্থায়', 'Undo'), onClick: function(){ state.bookmarks[key] = true; saveBookmarks(); QRApp.emit('bookmarks'); } } });
      });
      frag.appendChild(item);
      lazyPreview(sub, s, a);
    });
    list.appendChild(frag);
    host.appendChild(list);
  }

  // ---------- notes ----------
  function renderNotes(host){
    var entries = [];
    try{ entries = allNoteEntries(); }catch(e){}
    entries = entries.filter(function(n){ return n.surah >= 1 && n.surah <= 114 && n.text; }).sort(function(a, b){ return a.surah - b.surah || a.ayah - b.ayah; });
    if(!entries.length){ host.appendChild(emptyFor('notes')); return; }
    host.appendChild(h('div', { class: 'qa-lib-head' }, h('div', { class: 'qa-caption' }, T(NUM(entries.length) + 'টি নোট', entries.length + ' note' + (entries.length === 1 ? '' : 's')))));
    var list = h('div', { class: 'qa-list' });
    entries.forEach(function(n){
      var more = h('button', { class: 'qa-iconbtn qa-sm', type: 'button', 'aria-label': T('আরও', 'More') });
      more.innerHTML = icon('moreV');
      var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
        h('div', { class: 'qa-num qa-num-wide' }, NUM(n.surah) + ':' + NUM(n.ayah)),
        h('div', { class: 'qa-list-main' }, h('div', { class: 'qa-list-title' }, ref(n.surah, n.ayah)), h('div', { class: 'qa-list-sub qa-clamp qa-selectable' }, n.text)),
        h('div', { class: 'qa-list-trail' }, more));
      item.addEventListener('click', function(){ R().open({ type: 'surah', num: n.surah, ayah: n.ayah, surah: n.surah }); });
      more.addEventListener('click', function(ev){
        ev.stopPropagation();
        UI.actionSheet({
          title: ref(n.surah, n.ayah),
          actions: [
            { icon: 'edit', label: T('নোট সম্পাদনা', 'Edit note'), onClick: function(){ R().editNote(n.surah, n.ayah, renderBody); } },
            { icon: 'quran', label: T('আয়াতে যান', 'Open the ayah'), onClick: function(){ R().open({ type: 'surah', num: n.surah, ayah: n.ayah, surah: n.surah }); } },
            { icon: 'trash', label: T('নোট মুছুন', 'Delete note'), danger: true, onClick: function(){
              UI.confirm({ title: T('নোটটি মুছবেন?', 'Delete this note?'), text: T('এটি আর ফিরিয়ে আনা যাবে না।', 'This cannot be undone.'), confirmLabel: T('মুছুন', 'Delete'), danger: true }).then(function(ok){
                if(!ok) return;
                deleteNote(n.surah, n.ayah); QRApp.emit('notes'); renderBody(); UI.snack(T('নোট মুছে ফেলা হয়েছে', 'Note deleted'));
              });
            } }
          ]
        });
      });
      list.appendChild(item);
    });
    host.appendChild(list);
  }

  // ---------- listening history ----------
  function renderHistory(host){
    var items = (state.history || []).filter(function(x){ return x && x.surah >= 1 && x.surah <= 114; });
    if(!items.length){ host.appendChild(emptyFor('history')); return; }
    var head = h('div', { class: 'qa-lib-head' }, h('div', { class: 'qa-caption' }, T('সাম্প্রতিক ' + NUM(items.length) + 'টি তিলাওয়াত', 'Last ' + items.length + ' recitations')));
    head.appendChild(UI.linkButton(T('মুছুন', 'Clear'), function(){
      UI.confirm({ title: T('শোনার তালিকা মুছবেন?', 'Clear listening history?'), text: T('শুধু এই তালিকাটি মুছবে — বুকমার্ক, নোট ও অগ্রগতি অক্ষত থাকবে।', 'Only this list is cleared — bookmarks, notes and progress stay.'), confirmLabel: T('মুছুন', 'Clear'), danger: true }).then(function(ok){
        if(!ok) return;
        state.history = [];
        try{ IDBKV.set(LS_KEYS.history, '[]'); }catch(e){}
        QRApp.emit('history'); renderBody();
      });
    }));
    host.appendChild(head);
    var list = h('div', { class: 'qa-list' });
    items.forEach(function(x){
      var reciter = '';
      try{ reciter = QRApp.pick.reciterLabel(x.reciter); }catch(e){}
      var title = h('div', { class: 'qa-list-title' }, ref(x.surah, x.ayah || 1));
      if(typeof isSurahOffline === 'function' && isSurahOffline(x.surah)) title.appendChild(h('span', { class: 'qa-dot-offline', title: T('অফলাইনে সংরক্ষিত', 'Saved offline') }));
      var play = h('button', { class: 'qa-iconbtn qa-sm qa-tonal', type: 'button', 'aria-label': T('শুনুন', 'Play') });
      play.innerHTML = icon('play');
      var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
        h('div', { class: 'qa-num' }, NUM(x.surah)),
        h('div', { class: 'qa-list-main' }, title, h('div', { class: 'qa-list-sub' }, [reciter, QRApp.timeAgo(x.ts)].filter(Boolean).join(' · '))),
        h('div', { class: 'qa-list-trail' }, play));
      function go(auto){
        if(x.reciter && x.reciter !== state.reciter){ state.reciter = x.reciter; try{ saveReciter(); }catch(e){} }
        R().open({ type: 'surah', num: x.surah, ayah: x.ayah || 1, surah: x.surah, autoplay: !!auto });
      }
      item.addEventListener('click', function(){ go(false); });
      play.addEventListener('click', function(ev){ ev.stopPropagation(); go(true); });
      list.appendChild(item);
    });
    host.appendChild(list);
  }

  // ---------- offline audio ----------
  function mbOf(o){ try{ return dlmEstimateMB(o.ayahCount || 0); }catch(e){ return 0; } }
  function renderOffline(host){
    var items = (state.offlineSurahs || []).filter(function(o){ return o && o.surah >= 1 && o.surah <= 114; });
    if(!items.length){ host.appendChild(emptyFor('offline')); return; }
    var total = items.reduce(function(sum, o){ return sum + mbOf(o); }, 0);
    var sum = h('section', { class: 'qa-card qa-card-tonal qa-offline-sum' },
      h('div', { class: 'qa-overline' }, T('অফলাইনে সংরক্ষিত', 'Saved offline')),
      h('div', { class: 'qa-hero-title' }, T(NUM(items.length) + 'টি সূরা', items.length + ' surah' + (items.length === 1 ? '' : 's'))),
      h('div', { class: 'qa-hero-sub' }, T('আনুমানিক ' + QRApp.formatBytes(total * 1048576), 'About ' + QRApp.formatBytes(total * 1048576))));
    sum.appendChild(UI.button(T('ডাউনলোড ম্যানেজার', 'Download manager'), { kind: 'filled', icon: 'cloudDownload', small: true, onClick: function(){ QRApp.features.open('downloads'); } }));
    host.appendChild(sum);
    var list = h('div', { class: 'qa-list' });
    items.slice().sort(function(a, b){ return (b.ts || 0) - (a.ts || 0); }).forEach(function(o){
      var reciter = ''; try{ reciter = QRApp.pick.reciterLabel(o.reciter); }catch(e){}
      var rm = h('button', { class: 'qa-iconbtn qa-sm', type: 'button', 'aria-label': T('অফলাইন থেকে সরান', 'Remove from offline') });
      rm.innerHTML = icon('trash');
      var item = h('div', { class: 'qa-list-item', role: 'button', tabindex: '0' },
        h('div', { class: 'qa-num' }, NUM(o.surah)),
        h('div', { class: 'qa-list-main' },
          h('div', { class: 'qa-list-title' }, QRApp.surahName(o.surah)),
          h('div', { class: 'qa-list-sub' }, [reciter, '~' + QRApp.formatBytes(mbOf(o) * 1048576)].filter(Boolean).join(' · '))),
        h('div', { class: 'qa-list-trail' }, rm));
      item.addEventListener('click', function(){
        // play with the reciter the audio was downloaded for (same rule as the website)
        if(o.reciter && o.reciter !== state.reciter){ state.reciter = o.reciter; try{ saveReciter(); }catch(e){} }
        R().open({ type: 'surah', num: o.surah });
      });
      rm.addEventListener('click', function(ev){
        ev.stopPropagation();
        UI.confirm({ title: T('অফলাইন থেকে সরাবেন?', 'Remove from offline?'), text: T(QRApp.surahName(o.surah) + ' সূরার ডাউনলোড করা অডিও মুছে যাবে।', 'The downloaded audio of ' + QRApp.surahName(o.surah) + ' will be deleted.'), confirmLabel: T('সরান', 'Remove'), danger: true }).then(function(ok){
          if(!ok) return;
          removeSurahOffline(o.surah).then(function(){ QRApp.emit('downloads'); renderBody(); UI.snack(T('অফলাইন অডিও সরানো হয়েছে', 'Offline audio removed')); });
        });
      });
      list.appendChild(item);
    });
    host.appendChild(list);
  }

  // ---------- shell ----------
  function renderBody(){
    if(!els.body) return;
    if(observer){ observer.disconnect(); observer = null; }
    queue = [];
    els.body.innerHTML = '';
    var host = h('div', { class: 'qa-lib-body' });
    els.body.appendChild(host);
    if(tab === 'bookmarks') renderBookmarks(host);
    else if(tab === 'notes') renderNotes(host);
    else if(tab === 'history') renderHistory(host);
    else renderOffline(host);
  }
  function build(el){
    var saved = QRApp.prefs.get('lib_tab', 'bookmarks');
    tab = TABS.indexOf(saved) > -1 ? saved : 'bookmarks';
    els.root = h('div', { class: 'qa-library' });
    els.seg = UI.seg(tabItems(), tab, function(id){ tab = id; QRApp.prefs.set('lib_tab', id); renderBody(); window.scrollTo(0, 0); });
    els.root.appendChild(h('div', { class: 'qa-quran-head' }, els.seg));
    els.body = h('div');
    els.root.appendChild(els.body);
    els.root.appendChild(h('p', { class: 'qa-hint qa-lib-note' }, T('বুকমার্ক, নোট ও শোনার তালিকা শুধু এই ডিভাইসে থাকে — অ্যাকাউন্টে সিঙ্ক হয় না।', 'Bookmarks, notes and the listening list stay on this device — they are not synced to your account.')));
    el.appendChild(els.root);
    renderBody();
  }

  Nav.register('library', {
    tab: true, order: 4, icon: 'bookmark', label: ['সংরক্ষিত', 'Saved'],
    mount: function(el){ build(el); },
    show: function(){ renderBody(); },
    hide: function(){ if(observer){ observer.disconnect(); observer = null; } },
    unmount: function(){ if(observer){ observer.disconnect(); observer = null; } els = {}; },
    topbar: function(){
      return { title: T('সংরক্ষিত', 'Saved'), actions: [{ icon: 'search', label: T('খুঁজুন', 'Search'), onClick: function(){ QRApp.search.open(); } }] };
    }
  });

  var refresh = QRApp.debounce(function(){ if(isVisible()) renderBody(); }, 60);
  ['bookmarks', 'notes', 'downloads', 'history'].forEach(function(ev){ QRApp.on(ev, refresh); });
  QRApp.library = { refresh: refresh, setTab: function(t){ if(TABS.indexOf(t) > -1){ tab = t; QRApp.prefs.set('lib_tab', t); if(els.seg) els.seg.set(t); renderBody(); } } };
})();
