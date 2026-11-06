// ---------- Android app UI · Discover ----------
// Everything beyond plain reading, in one place: prayer times, Qibla, planner, topics, hadith, AI tafsir,
// dictionary, statistics, exams, Ramadan / Taraweeh and the popular surahs. The feature screens that
// already exist on the website (planner, topics, hadith, statistics, exams, prayer, qibla ...) are opened
// inside the app shell with the app's top bar and back behaviour - the data and logic are the website's own.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, Nav = QRApp.nav, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;

  function call(name){
    var fn = window[name];
    if(typeof fn !== 'function'){ UI.snack(T('এই ফিচারটি এখন খোলা যাচ্ছে না', 'This feature is not available right now')); return; }
    var args = Array.prototype.slice.call(arguments, 1);
    try{ fn.apply(window, args); }catch(e){ QRApp.warn('feature failed', name, e); UI.snack(T('কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন', 'Something went wrong, please try again')); }
  }

  // ---------- registry ----------
  var FEATURES = [
    { id: 'prayer', group: 'daily', icon: 'clock', label: ['নামাজের সময়', 'Prayer times'], sub: ['আপনার এলাকার ওয়াক্ত ও কাউন্টডাউন', 'Times and countdown for your place'], open: function(){ call('openPrayerModal'); } },
    { id: 'qibla', group: 'daily', icon: 'explore', label: ['কিবলা', 'Qibla'], sub: ['কিবলার দিক দেখুন', 'Find the direction of the Kaaba'], open: function(){ call('openQiblaModal'); } },
    { id: 'planner', group: 'daily', icon: 'calendar', label: ['প্ল্যানার', 'Planner'], sub: ['কুরআন খতমের পরিকল্পনা', 'Plan your khatam'], open: function(){ Nav.openLegacy('planner'); } },
    { id: 'stats', group: 'daily', icon: 'chart', label: ['পরিসংখ্যান', 'Statistics'], sub: ['স্ট্রিক, ব্যাজ ও অগ্রগতি', 'Streak, badges and progress'], open: function(){ Nav.openLegacy('stats'); } },
    { id: 'topics', group: 'learn', icon: 'grid', label: ['বিষয়ভিত্তিক', 'Topics'], sub: ['বিষয় ধরে আয়াত পড়ুন', 'Read ayahs by topic'], open: function(){ Nav.openLegacy('topics'); } },
    { id: 'hadith', group: 'learn', icon: 'book', label: ['হাদিস', 'Hadith'], sub: ['হাদিস গ্রন্থ থেকে পড়ুন', 'Read from the hadith books'], open: function(){ Nav.openLegacy('hadith'); } },
    { id: 'tafsir', group: 'learn', icon: 'sparkle', label: ['AI তাফসীর', 'AI tafsir'], sub: ['আয়াতের ব্যাখ্যা জানুন', 'Understand an ayah'], open: function(){ call('openAiTafsirModal', null); } },
    { id: 'dictionary', group: 'learn', icon: 'translate', label: ['ইসলামি অভিধান', 'Dictionary'], sub: ['ইসলামি শব্দের অর্থ', 'Meaning of Islamic terms'], open: function(){ call('openDictionaryModal'); } },
    { id: 'exam', group: 'learn', icon: 'exam', label: ['পরীক্ষা', 'Exams'], sub: ['নিজেকে যাচাই করুন', 'Test yourself'], open: function(){ Nav.openLegacy('exam'); } },
    { id: 'taraweeh', group: 'daily', icon: 'star', label: ['রমজান ও তারাবিহ', 'Ramadan & Taraweeh'], sub: ['তারাবিহ ট্র্যাকার', 'Taraweeh tracker'], open: function(){ call('openTaraweehModal'); } },
    { id: 'downloads', group: 'audio', icon: 'cloudDownload', label: ['অফলাইন ডাউনলোড', 'Offline downloads'], sub: ['সূরার অডিও ডাউনলোড ও মুছুন', 'Download or remove surah audio'], open: function(){ call('openDownloadManager'); } }
  ];
  var byId = {};
  FEATURES.forEach(function(f){ byId[f.id] = f; });

  var F = QRApp.features = {
    list: function(){ return FEATURES.slice(); },
    get: function(id){ return byId[id] || null; },
    open: function(id){
      var f = byId[id];
      if(!f) return;
      F.touch(id);
      f.open();
    },
    touch: function(id){
      var r = QRApp.prefs.get('recent_features', []);
      r = (Array.isArray(r) ? r : []).filter(function(x){ return x !== id; });
      r.unshift(id);
      QRApp.prefs.set('recent_features', r.slice(0, 8));
    },
    recent: function(n){
      var r = QRApp.prefs.get('recent_features', []);
      return (Array.isArray(r) ? r : []).map(function(id){ return byId[id]; }).filter(Boolean).slice(0, n || 4);
    }
  };

  // ---------- popular surahs / shortcuts into the text ----------
  function popular(){
    return [
      { n: 36, tag: T('ইয়াসিন', 'Ya-Sin') }, { n: 67, tag: T('আল-মুলক', 'Al-Mulk') },
      { n: 18, tag: T('আল-কাহফ', 'Al-Kahf') }, { n: 55, tag: T('আর-রাহমান', 'Ar-Rahman') },
      { n: 56, tag: T('আল-ওয়াকিয়া', 'Al-Waqi\'ah') }, { n: 32, tag: T('আস-সাজদাহ', 'As-Sajdah') },
      { n: 112, tag: T('আল-ইখলাস', 'Al-Ikhlas') }, { n: 113, tag: T('আল-ফালাক', 'Al-Falaq') }, { n: 114, tag: T('আন-নাস', 'An-Nas') }
    ];
  }

  function tile(f){
    var b = h('button', { class: 'qa-tile', type: 'button' });
    b.appendChild(h('span', { class: 'qa-tile-ic', html: icon(f.icon) }));
    b.appendChild(h('span', { class: 'qa-tile-title' }, T(f.label[0], f.label[1])));
    b.appendChild(h('span', { class: 'qa-tile-sub' }, T(f.sub[0], f.sub[1])));
    b.addEventListener('click', function(){ F.open(f.id); });
    return b;
  }
  function grid(ids){
    var g = h('div', { class: 'qa-tiles' });
    ids.forEach(function(id){ if(byId[id]) g.appendChild(tile(byId[id])); });
    return g;
  }

  var root = null;
  function render(){
    if(!root) return;
    root.innerHTML = '';
    root.appendChild(UI.section(T('প্রতিদিনের ইবাদতে', 'Daily practice')));
    root.appendChild(grid(['prayer', 'qibla', 'planner', 'taraweeh']));
    root.appendChild(UI.section(T('শিখুন ও জানুন', 'Learn')));
    root.appendChild(grid(['topics', 'hadith', 'tafsir', 'dictionary', 'exam']));
    root.appendChild(UI.section(T('জনপ্রিয় সূরা', 'Popular surahs')));
    var chips = h('div', { class: 'qa-chips qa-wrap' });
    popular().forEach(function(p){ chips.appendChild(UI.chip(p.tag, function(){ QRApp.reader.open({ type: 'surah', num: p.n }); })); });
    chips.appendChild(UI.chip(T('আম্মা পারা (৩০)', 'Juz Amma (30)'), function(){ QRApp.reader.open({ type: 'juz', num: 30 }); }));
    root.appendChild(chips);
    root.appendChild(UI.section(T('তিলাওয়াত ও অফলাইন', 'Audio & offline')));
    var rows = [
      UI.row({ icon: 'mic', title: T('ক্বারী', 'Reciter'), value: QRApp.pick.reciterLabel(), onClick: function(ev, row){ QRApp.pick.reciter().then(function(){ row.setValue(QRApp.pick.reciterLabel()); }); } }),
      UI.row({ icon: 'cloudDownload', title: T('অফলাইন ডাউনলোড', 'Offline downloads'), sub: T('সূরার অডিও ডাউনলোড ও মুছুন', 'Download or remove surah audio'), onClick: function(){ F.open('downloads'); } }),
      UI.row({ icon: 'chart', title: T('পরিসংখ্যান ও ব্যাজ', 'Statistics & badges'), sub: T('স্ট্রিক, পড়ার সময় ও অগ্রগতি', 'Streak, reading time and progress'), onClick: function(){ F.open('stats'); } })
    ];
    root.appendChild(UI.group(rows));
  }

  Nav.register('discover', {
    tab: true, order: 3, icon: 'explore', label: ['আবিষ্কার', 'Discover'],
    mount: function(el){
      root = h('div', { class: 'qa-discover' });
      el.appendChild(root);
      render();
    },
    unmount: function(){ root = null; },
    topbar: function(){
      return { title: T('আবিষ্কার', 'Discover'), actions: [{ icon: 'search', label: T('খুঁজুন', 'Search'), onClick: function(){ QRApp.search.open(); } }] };
    }
  });
})();
