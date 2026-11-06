// ---------- Android app UI · Quran structure helpers ----------
// Static facts that never change (ayah count of each surah, where each juz starts) so the
// Quran screens work completely offline from the very first launch, plus small helpers that
// read the website's own data (state.surahList, the Quran API) without duplicating it.
// Quran TEXT is never stored here - it always comes from the same API the website uses.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var T = QRApp.T;
  var D = QRApp.data = {};

  // Number of ayahs in surahs 1..114 (sums to 6236, the standard Hafs count).
  var AYAH_COUNTS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];
  D.AYAH_COUNTS = AYAH_COUNTS;
  D.TOTAL_AYAHS = 6236;
  D.LIMITS = { surah: 114, juz: 30, page: 604, hizb: 60, ruku: 556 };

  // Surah:ayah where each of the 30 juz (para) begins.
  D.JUZ_START = [[1,1],[2,142],[2,253],[3,93],[4,24],[4,148],[5,82],[6,111],[7,88],[8,41],[9,93],[11,6],[12,53],[15,1],[17,1],[18,75],[21,1],[23,1],[25,21],[27,56],[29,46],[33,31],[36,28],[39,32],[41,47],[46,1],[51,31],[58,1],[67,1],[78,1]];
  // The traditional name of a juz is its opening words.
  D.JUZ_NAMES = ['الم','سيقول','تلك الرسل','لن تنالوا','والمحصنات','لا يحب الله','وإذا سمعوا','ولو أننا','قال الملأ','واعلموا','يعتذرون','وما من دابة','وما أبرئ','ربما','سبحان الذي','قال ألم','اقترب للناس','قد أفلح','وقال الذين','أمن خلق','اتل ما أوحي','ومن يقنت','وما لي','فمن أظلم','إليه يرد','حم','قال فما خطبكم','قد سمع الله','تبارك الذي','عم'];

  // ---------- digits ----------
  var BN = '০১২৩৪৫৬৭৮৯', AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';
  D.asciiDigits = function(s){
    return String(s == null ? '' : s).replace(/[০-৯٠-٩۰-۹]/g, function(c){
      var i = BN.indexOf(c); if(i < 0) i = AR.indexOf(c); if(i < 0) i = FA.indexOf(c);
      return String(i);
    });
  };

  // ---------- surah metadata ----------
  var byNumber = null, byNumberLen = -1;
  function index(){
    var list = (typeof state !== 'undefined' && state.surahList) || [];
    if(byNumber && byNumberLen === list.length) return byNumber;
    byNumber = {}; byNumberLen = list.length;
    list.forEach(function(s){ byNumber[s.number] = s; });
    return byNumber;
  }
  // { number, bn, en, ar, ayahs, type }
  D.meta = function(n){
    var s = index()[n];
    var bnName = (typeof surahNamesBn !== 'undefined' && surahNamesBn[n - 1]) || (T('সূরা ', 'Surah ') + n);
    return {
      number: n,
      bn: bnName,
      en: (s && s.englishName) || '',
      enMeaning: (s && s.englishNameTranslation) || '',
      ar: s ? D.shortArabic(s.name) : '',
      ayahs: (s && s.numberOfAyahs) || AYAH_COUNTS[n - 1],
      type: (s && s.revelationType) || ''
    };
  };
  // The API names every surah "سُورَةُ <name>"; lists look cleaner without the repeated word.
  D.shortArabic = function(name){
    return String(name || '').replace(/^\s*سُورَةُ\s*/, '').replace(/^\s*سورة\s*/, '').trim();
  };
  D.revelation = function(type){
    if(type === 'Meccan') return T('মাক্কী', 'Meccan');
    if(type === 'Medinan') return T('মাদানী', 'Medinan');
    return '';
  };
  D.surahs = function(){
    var out = [];
    for(var n = 1; n <= 114; n++) out.push(D.meta(n));
    return out;
  };

  // Loads state.surahList (Arabic names, revelation type) when the website's own loader has not yet.
  var pendingList = null;
  D.loadSurahList = function(){
    if(typeof state !== 'undefined' && state.surahList && state.surahList.length) return Promise.resolve(state.surahList);
    if(pendingList) return pendingList;
    pendingList = fetch(API + '/surah').then(function(r){ return r.json(); }).then(function(j){
      if(j && j.data && j.data.length){ state.surahList = j.data; QRApp.emit('surahlist'); }
      return state.surahList;
    }).catch(function(){ return (typeof state !== 'undefined' && state.surahList) || []; }).then(function(v){ pendingList = null; return v; });
    return pendingList;
  };

  // ---------- matching ----------
  // Lower-case, no diacritics, no spaces/hyphens/apostrophes: "Al-Baqarah" -> "albaqarah", "আল-বাকারা" -> "আলবাকারা"
  D.normalize = function(s){
    var t = String(s == null ? '' : s).toLowerCase();
    try{ t = t.normalize('NFD'); }catch(e){}
    return t
      .replace(/[ً-ٰٟۖ-ۭـ]/g, '')   // Arabic marks, tatweel
      .replace(/[̀-ͯ]/g, '')                                    // Latin combining marks
      .replace(/[ٱإأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/[^a-z0-9ऀ-ॿঀ-৿ء-ي]/g, '');
  };

  // "2:255", "২:২৫৫", "2 255", "2.255" -> {surah, ayah} or null
  D.parseRef = function(str){
    var t = D.asciiDigits(str).trim();
    var m = /^(\d{1,3})\s*[:：.\-\s]\s*(\d{1,3})$/.exec(t);
    if(!m) return null;
    var s = parseInt(m[1], 10), a = parseInt(m[2], 10);
    if(s < 1 || s > 114 || a < 1 || a > AYAH_COUNTS[s - 1]) return null;
    return { surah: s, ayah: a };
  };

  // ---------- an ayah's text (Arabic + the chosen translation), cached for offline previews ----------
  var memo = {};
  function cacheGet(){ return QRApp.prefs.get('ayah_cache', {}); }
  D.ayahPreviewCached = function(s, a){
    var key = s + ':' + a + ':' + state.translationEdition;
    if(memo[key]) return memo[key];
    var c = cacheGet()[key];
    if(c) memo[key] = c;
    return c || null;
  };
  var inflight = {};
  D.ayahPreview = function(s, a){
    var key = s + ':' + a + ':' + state.translationEdition;
    var hit = D.ayahPreviewCached(s, a);
    if(hit) return Promise.resolve(hit);
    if(inflight[key]) return inflight[key];
    var ed = state.translationEdition;
    inflight[key] = Promise.all([
      fetch(API + '/ayah/' + s + ':' + a + '/quran-uthmani').then(function(r){ return r.json(); }),
      fetch(API + '/ayah/' + s + ':' + a + '/' + ed).then(function(r){ return r.json(); })
    ]).then(function(res){
      var ar = res[0] && res[0].data, tr = res[1] && res[1].data;
      if(!ar || !ar.text) throw new Error('no ayah');
      var out = { arabic: ar.text, translation: (tr && tr.text) || '', global: ar.number || null, surahEn: (ar.surah && ar.surah.englishName) || '' };
      memo[key] = out;
      try{
        var all = cacheGet(); all[key] = out;
        var keys = Object.keys(all);
        if(keys.length > 80){ keys.slice(0, keys.length - 80).forEach(function(k){ delete all[k]; }); }
        QRApp.prefs.set('ayah_cache', all);
      }catch(e){}
      return out;
    }).then(function(v){ delete inflight[key]; return v; }, function(e){ delete inflight[key]; throw e; });
    return inflight[key];
  };

  // ---------- reading progress ----------
  D.ayahsRead = function(){ try{ return ayahsReadCount(); }catch(e){ return 0; } };
  D.readFraction = function(){ return Math.min(1, D.ayahsRead() / D.TOTAL_AYAHS); };
  // Fraction of a single surah that has been read (device-side data only).
  D.surahReadFraction = function(n){
    var total = AYAH_COUNTS[n - 1], c = 0, map = (state.ayahsRead || {});
    for(var a = 1; a <= total; a++){ if(map[n + ':' + a]) c++; }
    return total ? c / total : 0;
  };
  // Consecutive days with reading activity ending today - the same calculation as the website's statistics page.
  D.streak = function(){
    try{ return computeStreak(loadActivity()); }catch(e){ return 0; }
  };
  // Today's reading time in seconds (website activity log) and the whole-time total.
  D.todaySeconds = function(){
    try{ return (loadActivity()[todayStr()]) || 0; }catch(e){ return 0; }
  };
  D.ayahLabel = function(s, a){ return QRApp.surahName(s) + ' · ' + T('আয়াত ' + QRApp.N(a), 'Ayah ' + a); };
})();
