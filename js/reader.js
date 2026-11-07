// ---------- Reader: surah/juz/page/hizb/ruku fetch & render, bookmarks, font size ----------
const mainContent = document.getElementById('mainContent');
const readerToolbar = document.getElementById('readerToolbar');
const homeLanding = document.getElementById('homeLanding');
const readerArea = document.getElementById('readerArea');

function showReaderArea(){
  homeLanding.style.display = 'none';
  readerArea.style.display = 'block';
}
function showHomeLanding(){
  readerArea.style.display = 'none';
  homeLanding.style.display = 'block';
}

function initReaderBack(){
  document.getElementById('readerBackBtn').onclick = showHomeLanding;
}

// ---------- হাফেজ মোড (Hafez / memorization mode) ----------
// state.hafezMode চালু থাকলে readerArea তে .hafez-mode ক্লাস বসে, যেটা
// CSS দিয়েই অনুবাদ/নোট লুকিয়ে ও আয়াতগুলোকে মুসহাফের মতো একটানা টেক্সটে
// দেখায় (দেখুন css/reader.css) — তাই টগল করলে রি-রেন্ডারের দরকার হয় না।
// state.hafezTestMode (মুখস্থ যাচাই) সেশন-ভিত্তিক, সংরক্ষিত হয় না — অ্যাপ
// প্রতিবার নতুন করে খুললে বন্ধ অবস্থাতেই শুরু হয়।
let hafezTestMode = false;
let lastRenderedAyahs = null;

function applyHafezModeUI(){
  readerArea.classList.toggle('hafez-mode', !!state.hafezMode);
  const btn = document.getElementById('hafezModeBtn');
  if(btn) btn.classList.toggle('active', !!state.hafezMode);
  const testBtn = document.getElementById('hafezTestBtn');
  if(testBtn) testBtn.style.display = state.hafezMode ? 'inline-flex' : 'none';
  const reviewBtn = document.getElementById('hifzReviewDoneBtn');
  if(reviewBtn) reviewBtn.style.display = state.hafezMode ? 'inline-flex' : 'none';
  if(!state.hafezMode){ hafezTestMode = false; applyHafezTestUI(); }
  renderHafezPageHint(lastRenderedAyahs);
}

// ---------- উচ্চারণ মোড (Transliteration mode) ----------
// state.transliterationMode চালু থাকলে readerArea তে .translit-mode ক্লাস বসে,
// যেটা CSS দিয়েই প্রতিটি আয়াতের নিচে থাকা .translit-text দেখায় (দেখুন
// css/reader.css)। টেক্সট নিজেই renderReader()-এ প্রতিটি আয়াতের জন্য একবার
// js/transliteration.js দিয়ে জেনারেট হয়ে বসে থাকে — তাই টগল করলে রি-রেন্ডারের
// দরকার হয় না, শুধু CSS ভিজিবিলিটি বদলায়।
function applyTransliterationModeUI(){
  readerArea.classList.toggle('translit-mode', !!state.transliterationMode);
  const btn = document.getElementById('translitModeBtn');
  if(btn) btn.classList.toggle('active', !!state.transliterationMode);
}

function initTransliterationToggle(){
  const btn = document.getElementById('translitModeBtn');
  if(btn){
    btn.onclick = () => {
      state.transliterationMode = !state.transliterationMode;
      saveTransliterationMode();
      if(state.transliterationMode) markTransliterationUsed();
      applyTransliterationModeUI();
    };
  }
  applyTransliterationModeUI();
}

function applyHafezTestUI(){
  readerArea.classList.toggle('hafez-test', hafezTestMode);
  const testBtn = document.getElementById('hafezTestBtn');
  if(testBtn) testBtn.classList.toggle('active', hafezTestMode);
  document.querySelectorAll('.ayah-card.revealed').forEach(c => c.classList.remove('revealed'));
}

function initHafezToolbar(){
  const hafezBtn = document.getElementById('hafezModeBtn');
  if(hafezBtn){
    hafezBtn.onclick = () => {
      state.hafezMode = !state.hafezMode;
      saveHafezMode();
      if(state.hafezMode) markHafezUsed();
      applyHafezModeUI();
    };
  }
  const testBtn = document.getElementById('hafezTestBtn');
  if(testBtn){
    testBtn.onclick = () => { hafezTestMode = !hafezTestMode; applyHafezTestUI(); };
  }
  const reviewBtn = document.getElementById('hifzReviewDoneBtn');
  if(reviewBtn){
    reviewBtn.onclick = () => {
      const view = state.currentReaderView;
      if(!view || view.type !== 'surah'){
        showToast('একটি সূরা খুলে তারপর রিভিউ সম্পন্ন করুন।');
        return;
      }
      const days = logHifzReview(view.num);
      showToast(`রিভিউ সম্পন্ন! পরবর্তী রিভিউ ${toBn(days)} দিন পর।`);
      if(typeof renderHifzReviewCard === 'function') renderHifzReviewCard();
    };
  }
  initTransliterationToggle();
  applyHafezModeUI();
  // ট্যাপ করলে শুধু সেই আয়াতটি সাময়িকভাবে স্পষ্ট হয় (মুখস্থ যাচাইয়ের জন্য) —
  // mainContent প্রতিবার নতুন করে রেন্ডার হয়, তাই স্থায়ী readerArea-তে
  // ইভেন্ট-ডেলিগেশন ব্যবহার করা হয়েছে।
  readerArea.addEventListener('click', (e) => {
    if(!hafezTestMode) return;
    const card = e.target.closest('.ayah-card');
    if(!card) return;
    if(e.target.closest('.play-toggle, .note-toggle-btn, button')) return;
    card.classList.toggle('revealed');
  });
}

// ---------- হাফেজ মোডে থাকলে বর্তমান অংশটি প্রকৃত মুসহাফের কোন পৃষ্ঠায়
// আছে তা দেখিয়ে পৃষ্ঠা-মোডে (আসল ৬০৪ পৃষ্ঠার হাফিজি লে-আউট) দ্রুত যাওয়ার
// শর্টকাট দেয়, আর পৃষ্ঠা-মোডে থাকলে সরাসরি আগের/পরের পৃষ্ঠায় পাতা ওল্টানোর
// বাটন দেখায় — এটাই হাফিজি পড়ার স্বাভাবিক পদ্ধতি। ----------
function renderHafezPageHint(ayahs){
  const hintEl = document.getElementById('hafezPageHint');
  if(!hintEl) return;
  if(!state.hafezMode || !ayahs || !ayahs.length){
    hintEl.style.display = 'none'; hintEl.innerHTML = '';
    return;
  }
  const view = state.currentReaderView;
  if(view && view.type === 'page'){
    const num = view.num;
    hintEl.style.display = 'block';
    hintEl.innerHTML = `<div class="hafez-page-nav">
      <button id="hafezPrevPage"${num<=1?' disabled':''}><i class="fa-solid fa-arrow-right"></i> পূর্ববর্তী পৃষ্ঠা</button>
      <button id="hafezNextPage"${num>=604?' disabled':''}>পরবর্তী পৃষ্ঠা <i class="fa-solid fa-arrow-left"></i></button>
    </div>`;
    const prevBtn = document.getElementById('hafezPrevPage');
    const nextBtn = document.getElementById('hafezNextPage');
    if(prevBtn) prevBtn.onclick = () => openPage(num - 1);
    if(nextBtn) nextBtn.onclick = () => openPage(num + 1);
  } else if(ayahs[0] && ayahs[0].page){
    const pageNum = ayahs[0].page;
    hintEl.style.display = 'flex';
    hintEl.innerHTML = `<span>📖 এই অংশ মুসহাফের পৃষ্ঠা ${toBn(pageNum)}-এ আছে।</span>
      <button id="hafezGoPage">পৃষ্ঠা মোডে পড়ুন</button>`;
    const goBtn = document.getElementById('hafezGoPage');
    if(goBtn) goBtn.onclick = () => openPage(pageNum);
  } else {
    hintEl.style.display = 'none'; hintEl.innerHTML = '';
  }
}

// ---------- Qur'an translation editions (all languages the API offers) ----------
// The Al Quran Cloud API lists 50+ translation editions across dozens of
// languages. We fetch that list once, cache it (both in memory and
// localStorage, so it also works offline after the first successful load),
// and let the user pick any of them from Settings instead of being locked
// to Bengali/English.
let translationEditionsCache = null;
async function loadTranslationEditions(){
  if(translationEditionsCache) return translationEditionsCache;
  try{
    const raw = IDBKV.get(LS_KEYS.translationEditions);
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed) && parsed.length) translationEditionsCache = parsed;
    }
  }catch(e){}
  try{
    const res = await fetch(`${API}/edition?format=text&type=translation`);
    const data = (await res.json()).data;
    if(Array.isArray(data) && data.length){
      translationEditionsCache = data;
      try{ IDBKV.set(LS_KEYS.translationEditions, JSON.stringify(data)); }catch(e){}
    }
  }catch(e){ /* offline / network error — fall back to whatever was cached above */ }
  return translationEditionsCache || [];
}

function findTranslationEdition(identifier){
  return (translationEditionsCache || []).find(e => e.identifier === identifier);
}

// Best-effort direction detection for the currently-selected translation
// edition, so ayah translation text renders RTL for languages like Urdu,
// Persian, or Sindhi even without a full UI dictionary entry for them.
function translationDirection(identifier){
  const id = identifier || state.translationEdition;
  const edition = findTranslationEdition(id);
  if(edition && edition.direction) return edition.direction;
  const langCode = (id || '').split('.')[0];
  return RTL_LANG_CODES.includes(langCode) ? 'rtl' : 'ltr';
}

// ---------- Compare mode: up to 3 translation editions side-by-side ----------
// state.translationEditions is the list picked in Settings > "তুলনামূলক অনুবাদ".
// When empty, the reader falls back to the single primary translationEdition
// exactly like before, so this feature is fully opt-in.
function activeTranslationEditions(){
  return (state.translationEditions && state.translationEditions.length) ? state.translationEditions : [state.translationEdition];
}

// Fetches the Arabic (quran-uthmani) text plus every active translation
// edition in parallel for a given API path (e.g. "surah/2", "juz/5"), and
// maps them into one ayahs[] array shared by openSurah/openJuz/openPage/etc.
async function fetchAyahsWithTranslations(pathBase, surahOf){
  const editions = activeTranslationEditions();
  const urls = [`${API}/${pathBase}/quran-uthmani`, ...editions.map(ed => `${API}/${pathBase}/${ed}`)];
  const responses = await Promise.all(urls.map(u => fetch(u)));
  const jsons = await Promise.all(responses.map(r => r.json()));
  const arData = jsons[0].data;
  const trDatas = jsons.slice(1).map(j => j.data);
  const ayahs = arData.ayahs.map((a,i) => ({
    number: a.number,
    numberInSurah: a.numberInSurah,
    surah: surahOf ? surahOf(a) : a.surah,
    page: a.page,
    arabic: a.text,
    translations: editions.map((ed, ei) => ({
      identifier: ed,
      label: translationEditionLabel(ed),
      dir: translationDirection(ed),
      text: (trDatas[ei] && trDatas[ei].ayahs[i]) ? trDatas[ei].ayahs[i].text : ''
    }))
  }));
  return { arData, ayahs };
}

// Remembers which reader view (surah/juz/page/hizb/ruku + number) is
// currently open, so changing the translation language can silently
// re-fetch and re-render the same passage in the newly chosen language.
function reopenCurrentReaderView(){
  const v = state.currentReaderView;
  if(!v) return;
  if(v.type === 'surah') openSurah(v.num);
  else if(v.type === 'juz') openJuz(v.num);
  else if(v.type === 'page') openPage(v.num);
  else if(v.type === 'hizb') openHizb(v.num);
  else if(v.type === 'ruku') openRuku(v.num);
}

function showLoader(){
  showReaderArea();
  mainContent.innerHTML = `<div class="loader"><div class="spinner"></div><span>Loading verses...</span></div>`;
  readerToolbar.style.display='none';
}

function openSurahAndScrollTo(surahNum, ayahInSurah){
  goToView('home');
  openSurah(surahNum).then(() => {
    setTimeout(() => {
      const el = document.getElementById(`ayah-${surahNum}-${ayahInSurah}`);
      if(el) el.scrollIntoView({behavior:'smooth', block:'center'});
    }, 250);
  });
}

async function openSurah(num){
  showLoader();
  state.currentReaderView = { type: 'surah', num };
  try{
    const { arData, ayahs } = await fetchAyahsWithTranslations(`surah/${num}`, () => num);
    renderReader({
      header: { arName: arData.name, bnName: surahNamesBn[num-1] || arData.englishName, meta: `${arData.revelationType === 'Meccan' ? 'মাক্কী' : 'মাদানী'} · ${toBn(arData.numberOfAyahs)} আয়াত`, playLabel: `সম্পূর্ণ সূরা শুনুন` },
      showBismillah: num !== 1 && num !== 9,
      surahInfo: surahInfoBn[num],
      surahBenefits: surahBenefitsBn[num],
      ayahs
    });
    state.lastRead = { surah: num, ayah: ayahs[0] ? ayahs[0].numberInSurah : 1 };
    saveLastRead();
    recordActivityToday();
  }catch(e){
    mainContent.innerHTML = `<div class="error-box">${offlineAwareErrorMsg('সূরা')}<br><button onclick="openSurah(${num})">Try again.</button></div>`;
  }
}

function offlineAwareErrorMsg(label){
  if(typeof navigator !== 'undefined' && navigator.onLine === false){
    return `You are now offline and this ${label} The file was not previously saved, so it could not be loaded. Please try again when you have an internet connection.`;
  }
  return `${label} Could not load, check internet connection.`;
}

async function openJuz(num){
  showLoader();
  state.currentReaderView = { type: 'juz', num };
  try{
    const { arData, ayahs } = await fetchAyahsWithTranslations(`juz/${num}`, a => a.surah.number);
    renderReader({
      header: { arName: `الجزء ${num}`, bnName: `পারা ${toBn(num)}`, meta: `${toBn(arData.ayahs.length)} আয়াত`, playLabel: `সম্পূর্ণ পারা শুনুন` },
      showBismillah: false,
      ayahs
    });
    recordActivityToday();
  }catch(e){
    mainContent.innerHTML = `<div class="error-box">${offlineAwareErrorMsg('পারা')}<br><button onclick="openJuz(${num})">আবার চেষ্টা করুন</button></div>`;
  }
}

async function openPage(num){
  showLoader();
  state.currentReaderView = { type: 'page', num };
  try{
    const { arData, ayahs } = await fetchAyahsWithTranslations(`page/${num}`, a => a.surah.number);
    renderReader({
      header: { arName: `صفحة ${num}`, bnName: `পৃষ্ঠা ${toBn(num)}`, meta: `${toBn(arData.ayahs.length)} আয়াত`, playLabel: `সম্পূর্ণ পৃষ্ঠা শুনুন` },
      showBismillah: false,
      ayahs
    });
    recordActivityToday();
  }catch(e){
    mainContent.innerHTML = `<div class="error-box">${offlineAwareErrorMsg('পৃষ্ঠা')}<br><button onclick="openPage(${num})">আবার চেষ্টা করুন</button></div>`;
  }
}

async function openHizb(num){
  showLoader();
  state.currentReaderView = { type: 'hizb', num };
  try{
    const { arData, ayahs } = await fetchAyahsWithTranslations(`hizbQuarter/${num}`, a => a.surah.number);
    renderReader({
      header: { arName: `حزب ${num}`, bnName: `হিজব ${toBn(num)}`, meta: `${toBn(arData.ayahs.length)} আয়াত`, playLabel: `সম্পূর্ণ হিজব শুনুন` },
      showBismillah: false,
      ayahs
    });
    recordActivityToday();
  }catch(e){
    mainContent.innerHTML = `<div class="error-box">${offlineAwareErrorMsg('হিজব')}<br><button onclick="openHizb(${num})">আবার চেষ্টা করুন</button></div>`;
  }
}

async function openRuku(num){
  showLoader();
  state.currentReaderView = { type: 'ruku', num };
  try{
    const { arData, ayahs } = await fetchAyahsWithTranslations(`ruku/${num}`, a => a.surah.number);
    renderReader({
      header: { arName: `ركوع ${num}`, bnName: `রুকু ${toBn(num)}`, meta: `${toBn(arData.ayahs.length)} আয়াত`, playLabel: `সম্পূর্ণ রুকু শুনুন` },
      showBismillah: false,
      ayahs
    });
    recordActivityToday();
  }catch(e){
    mainContent.innerHTML = `<div class="error-box">${offlineAwareErrorMsg('রুকু')}<br><button onclick="openRuku(${num})">আবার চেষ্টা করুন</button></div>`;
  }
}

// ---------- তিলাওয়াতের সময় শব্দ-অনুযায়ী (word-by-word) হাইলাইটের জন্য প্রতিটি
// আরবি শব্দকে আলাদা <span> এ মুড়ে দেওয়া হয়। এরপর tajweedHighlight() এই
// span-wrapped টেক্সটের উপরেই চলে (তাজভীদ শুধু ভেতরের অক্ষর-প্যাটার্ন
// রেগেক্স-ম্যাচ করে, তাই span ট্যাগে কোনো প্রভাব পড়ে না)। ----------
function wrapArabicWords(arabicText){
  if(!arabicText) return arabicText;
  return arabicText.trim().split(/\s+/).map((w, i) => `<span class="qw" data-widx="${i}">${w}</span>`).join(' ');
}

function renderReader({header, showBismillah, surahInfo, surahBenefits, ayahs}){
  showReaderArea();
  readerToolbar.style.display='flex';
  if(typeof onbMaybeStart === 'function') onbMaybeStart('reader');
  state.playlist = ayahs.map(a => ({ key:`${a.surah}:${a.numberInSurah}`, globalNumber:a.number, surah:a.surah, numberInSurah:a.numberInSurah, title:(surahNamesBn[a.surah-1]||('সূরা '+a.surah)) }));
  const singleSurah = ayahs.length && ayahs.every(a => a.surah === ayahs[0].surah) ? ayahs[0].surah : null;
  const alreadyOffline = singleSurah && isSurahOffline(singleSurah);
  let html = `<div class="surah-header">
    <div class="ar-name">${header.arName}</div>
    <div class="bn-name">${header.bnName}</div>
    <div class="meta">${header.meta}</div>
    <div class="header-btn-row">
      <button class="play-all-btn" id="playAllBtn">▶ ${header.playLabel}</button>
      <button class="offline-btn${alreadyOffline ? ' downloaded' : ''}" id="offlineBtn">${alreadyOffline ? '✓ Saved offline' : '⬇ Save offline'}</button>
    </div>
  </div>`;
  if(surahInfo){
    html += `<button class="surah-info-trigger" id="surahInfoTrigger" type="button" aria-haspopup="dialog">
      <span class="sit-icon"><i class="fa-solid fa-book-quran"></i></span>
      <span class="sit-label">সূরার পরিচিতি ও শানে নুযুল</span>
      <span class="sit-arrow"><i class="fa-solid fa-chevron-right"></i></span>
    </button>`;
  }
  if(showBismillah) html += `<div class="bismillah">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</div>`;
  const compareMode = ayahs.length && ayahs[0].translations && ayahs[0].translations.length > 1;
  ayahs.forEach(a => {
    const key = `${a.surah}:${a.numberInSurah}`;
    const isBookmarked = !!state.bookmarks[key];
    const noteText = getNote(a.surah, a.numberInSurah);
    const translationsHtml = (a.translations && a.translations.length ? a.translations : [{text:'', dir:'ltr', label:''}])
      .map(t => {
        const style = t.dir === 'rtl' ? ' style="direction:rtl;text-align:right;"' : '';
        const labelHtml = compareMode ? `<div class="tr-edition-label">${t.label}</div>` : '';
        return `<div class="bn-text${compareMode ? ' bn-text-compare' : ''}"${style}>${labelHtml}${t.text}</div>`;
      }).join('');
    html += `<div class="ayah-card" id="ayah-${key.replace(':','-')}" data-key="${key}">
      <div class="medallion">
        ${starSvg()}
        <span>${toBn(a.numberInSurah)}</span>
      </div>
      <div class="ayah-body">
        <div class="ar-text">${tajweedHighlight(wrapArabicWords(a.arabic))}</div>
        <div class="translit-text">${typeof transliterateArabic === 'function' ? transliterateArabic(a.arabic) : ''}</div>
        ${translationsHtml}
        <div class="ayah-actions">
          <button class="play-toggle" data-key="${key}"><i class="fa-solid fa-play"></i> শুনুন</button>
          <button class="${isBookmarked?'bookmarked':''}" onclick="toggleBookmark('${key}', this)">${isBookmarked?'★ সংরক্ষিত':'☆ সংরক্ষণ'}</button>
          <button class="note-toggle-btn${noteText?' has-note':''}" data-note-key="${key}">${noteText?'📝 নোট দেখুন':'🖊 নোট লিখুন'}</button>
          <button class="ai-tafsir-ayah-btn" data-key="${key}"><i class="fa-solid fa-wand-magic-sparkles"></i> AI তাফসীর</button>
        </div>
        <div class="note-preview-wrap" data-note-wrap="${key}">
          ${noteText ? `<div class="note-preview" data-note-preview="${key}">${escapeHtml(noteText)}</div>` : ''}
        </div>
      </div>
    </div>`;
  });
  mainContent.innerHTML = html;
  applyFontSize();
  lastRenderedAyahs = ayahs;
  hafezTestMode = false;
  applyHafezTestUI();
  renderHafezPageHint(ayahs);

  const surahInfoTrigger = document.getElementById('surahInfoTrigger');
  if(surahInfoTrigger){
    surahInfoTrigger.onclick = () => openSurahInfoModal(header, surahInfo, surahBenefits);
  }
  document.getElementById('playAllBtn').onclick = () => playAtIndex(0, true);
  const offlineBtn = document.getElementById('offlineBtn');
  if(offlineBtn) offlineBtn.onclick = () => downloadCurrentAudioForOffline(offlineBtn);
  document.querySelectorAll('.play-toggle').forEach(btn => {
    btn.onclick = () => {
      const key = btn.getAttribute('data-key');
      const idx = state.playlist.findIndex(p => p.key === key);
      if(idx === -1) return;
      if(state.isPlaying && state.playIndex === idx){ pausePlayback(); }
      else { playAtIndex(idx, true); }
    };
  });
  document.querySelectorAll('.note-toggle-btn').forEach(btn => {
    btn.onclick = () => openNoteEditor(btn.getAttribute('data-note-key'));
  });
  document.querySelectorAll('.ai-tafsir-ayah-btn').forEach(btn => {
    btn.onclick = () => {
      const k = btn.getAttribute('data-key');
      const a = ayahs.find(x => `${x.surah}:${x.numberInSurah}` === k);
      if(!a || typeof openAiTafsirModal !== 'function') return;
      const tr = (a.translations && a.translations[0]) ? a.translations[0].text : '';
      openAiTafsirModal({ surahBn: header.bnName, ayahNum: a.numberInSurah, arabic: a.arabic, translation: tr });
    };
  });
  syncPlayingUI();
  initAyahReadTracking();
}

// ---------- সূরার পরিচিতি ও শানে নুযুল — popup মোডাল ----------
// surahInfoBn (js/surah-info.js) এর টেক্সটে গুরুত্বপূর্ণ শব্দ/নাম (নবী, স্থান,
// ঘটনা, একক-উদ্ধৃতি চিহ্নে থাকা মূল শব্দ) স্বয়ংক্রিয়ভাবে হাইলাইট করার জন্য।
const SURAH_INFO_HL_TERMS = [
  // স্থান ও সময়কাল
  'মক্কায়','মদীনায়','মক্কার','মদীনার','মক্কা','মদীনা','হেরা গুহায়','হেরা গুহা','নাখলা উপত্যকায়',
  // নবী-রাসূলগণ
  'ইব্রাহীম (আঃ)','মূসা (আঃ)','ঈসা (আঃ)','ইউসুফ (আঃ)','নূহ (আঃ)','হুদ (আঃ)','সালেহ (আঃ)','লূত (আঃ)',
  'শুয়াইব (আঃ)','দাউদ (আঃ)','সুলাইমান (আঃ)','ইউনুস (আঃ)','ইয়াহইয়া (আঃ)','যাকারিয়া (আঃ)','আদম (আঃ)',
  'মারইয়াম (আঃ)','খিযির (আঃ)','ইসমাঈল (আঃ)','আইয়ুব (আঃ)',
  'ইব্রাহীম','মূসা','ঈসা','ইউসুফ','নূহ','হুদ','সালেহ','লূত','শুয়াইব','দাউদ','সুলাইমান','ইউনুস',
  'ইয়াহইয়া','যাকারিয়া','মারইয়াম','খিযির','ইসমাঈল','আইয়ুব','যুলকারনাইন',
  // নবীজী (সাঃ)
  'নবীজীর (সাঃ)','নবীজীকে (সাঃ)','নবীজী (সাঃ)','নবীজীর','নবীজীকে','নবীজী',
  // সাহাবা ও ঐতিহাসিক ব্যক্তিত্ব
  'আয়েশা (রাঃ)','আবু বকর (রাঃ)','উমর ইবনুল খাত্তাব (রাঃ)','আবু লাহাব','আবু তালিব','খাদীজা (রাঃ)',
  'জাফর ইবনে আবি তালিব (রাঃ)','ইমাম শাফিঈ (রহঃ)','উম্মে জামিল','আব্দুল্লাহ ইবনে উম্মে মাকতুম (রাঃ)',
  'আব্দুল্লাহ ইবনে উবাই','খাওলা বিনতে সালাবা','হাতিব ইবনে আবি বালতাআ (রাঃ)','জুবাইর ইবনে মুতঈম',
  'বিলকিস','ফিরআউন',
  // বড় ঘটনা
  'বদর যুদ্ধের','বদর যুদ্ধ','উহুদ যুদ্ধের','উহুদ যুদ্ধ','খন্দক (আহযাব) যুদ্ধের','তাবুক অভিযানের',
  'মক্কা বিজয়ের','মক্কা বিজয়','হুদাইবিয়ার সন্ধির','হিজরতের','মিরাজের','লাইলাতুল কদর','ইফকের ঘটনা',
  "'আমুল হুযন'",'আমুল হুযন'
];
function highlightSurahInfoText(text){
  if(!text) return '';
  const quoted = [];
  // ১) একক-উদ্ধৃতি চিহ্নে '...' থাকা মূল শব্দগুলো (মূল লেখাতেই গুরুত্বপূর্ণ হিসেবে চিহ্নিত) আলাদা করে রাখা হয়
  let working = text.replace(/'([^']+)'/g, (m, inner) => {
    quoted.push(inner);
    return `\u0000${quoted.length - 1}\u0000`;
  });
  // ২) প্রেক্ষাপটে গুরুত্বপূর্ণ নাম/স্থান/ঘটনা (দৈর্ঘ্য অনুযায়ী বড় থেকে ছোট ক্রমে, যাতে একে অপরকে না কাটে)
  const terms = [...SURAH_INFO_HL_TERMS].sort((a, b) => b.length - a.length);
  terms.forEach(term => {
    if(!term || working.indexOf(term) === -1) return;
    working = working.split(term).join(`\u0001${term}\u0001`);
  });
  working = working.replace(/\u0001([^\u0001]*)\u0001/g, (m, inner) => `<mark class="sit-hl">${inner}</mark>`);
  working = working.replace(/\u0000(\d+)\u0000/g, (m, idx) => `<mark class="sit-hl">${quoted[Number(idx)]}</mark>`);
  return working;
}

function openSurahInfoModal(header, surahInfo, surahBenefits){
  let modal = document.getElementById('surahInfoModal');
  if(!modal){
    modal = document.createElement('div');
    modal.className = 'app-modal surah-info-modal';
    modal.id = 'surahInfoModal';
    modal.innerHTML = `
      <div class="app-modal-box">
        <div class="app-modal-head">
          <h3><i class="fa-solid fa-book-quran"></i> সূরার পরিচিতি ও শানে নুযুল</h3>
          <button class="app-modal-close" id="surahInfoModalClose">✕</button>
        </div>
        <div class="app-modal-body">
          <div class="sit-modal-head" id="sitModalHead"></div>
          <div class="sit-modal-text" id="sitModalText"></div>
          <div id="sitModalBenefits"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModalBackdrop('surahInfoModal');
    document.getElementById('surahInfoModalClose').onclick = () => closeModal('surahInfoModal');
  }
  document.getElementById('sitModalHead').innerHTML =
    `<span class="sit-modal-ar">${header.arName}</span><span class="sit-modal-bn">${header.bnName}</span>`;
  document.getElementById('sitModalText').innerHTML = highlightSurahInfoText(surahInfo);
  document.getElementById('sitModalBenefits').innerHTML = renderSurahBenefitsHtml(surahBenefits);
  openModal('surahInfoModal');
}

// ---------- সূরার ফজিলত, ব্যবহার ও প্রতিকার — শানে নুযুলের ঠিক নিচে দেখানো হয় ----------
// js/surah-benefits.js এর surahBenefitsBn ডেটা থেকে দুটি অংশ রেন্ডার করে: কোথায়/কখন
// পড়লে বেশি সওয়াব-উপকার (usage) এবং হাদীস/প্রচলিত রেওয়ায়েত অনুযায়ী রোগমুক্তি বা
// সুরক্ষার সাথে সম্পর্কিত অংশ (ailment, যদি প্রযোজ্য হয়)।
function renderSurahBenefitsHtml(benefits){
  if(!benefits || (!benefits.usage && !benefits.ailment)) return '';
  let html = '';
  if(benefits.usage){
    html += `<div class="sit-benefit-block sit-benefit-usage">
      <div class="sit-benefit-title"><i class="fa-solid fa-hands-praying"></i> কোন কাজে ও কখন পড়া উত্তম</div>
      <div class="sit-benefit-text">${highlightSurahInfoText(benefits.usage)}</div>
    </div>`;
  }
  if(benefits.ailment){
    html += `<div class="sit-benefit-block sit-benefit-ailment">
      <div class="sit-benefit-title"><i class="fa-solid fa-mortar-pestle"></i> রোগমুক্তি ও সুরক্ষার জন্য প্রচলিত আমল</div>
      <div class="sit-benefit-text">${highlightSurahInfoText(benefits.ailment)}</div>
      <div class="sit-benefit-note">এটি ইসলামি ঐতিহ্যে বর্ণিত আধ্যাত্মিক ফজিলতের পরিচিতি মাত্র — চিকিৎসকের পরামর্শ ও প্রয়োজনীয় চিকিৎসার বিকল্প নয়।</div>
    </div>`;
  }
  return html;
}

// ---------- Marks ayahs as "read" for the লাইফটাইম stats once they've
// actually stayed on screen for a bit, not just flashed past while scrolling. ----------
let ayahReadObserver = null;
function initAyahReadTracking(){
  if(!('IntersectionObserver' in window)) return;
  if(ayahReadObserver) ayahReadObserver.disconnect();
  const dwellTimers = new Map();
  ayahReadObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const key = entry.target.getAttribute('data-key');
      if(!key) return;
      if(entry.isIntersecting){
        if(dwellTimers.has(key) || state.ayahsRead[key]) return;
        const t = setTimeout(() => { markAyahRead(key); dwellTimers.delete(key); }, 1500);
        dwellTimers.set(key, t);
      } else {
        const t = dwellTimers.get(key);
        if(t){ clearTimeout(t); dwellTimers.delete(key); }
      }
    });
  }, { threshold: 0.6 });
  document.querySelectorAll('.ayah-card').forEach(el => ayahReadObserver.observe(el));
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Inline note editor: opens a small textarea + save/cancel right under the
// ayah whose note button was tapped, so editing stays in context instead of
// jumping to a separate modal.
function openNoteEditor(key){
  const wrap = document.querySelector(`[data-note-wrap="${key}"]`);
  if(!wrap) return;
  const [surahStr, ayahStr] = key.split(':');
  const surah = parseInt(surahStr, 10), ayah = parseInt(ayahStr, 10);
  const current = getNote(surah, ayah);
  wrap.innerHTML = `<div class="note-edit-box">
    <textarea class="note-textarea" placeholder="এই আয়াত সম্পর্কে আপনার নোট লিখুন...">${escapeHtml(current)}</textarea>
    <div class="note-edit-actions">
      ${current ? `<button class="note-delete-btn" data-act="delete">🗑 মুছুন</button>` : ''}
      <button class="note-cancel-btn" data-act="cancel">বাতিল</button>
      <button class="note-save-btn" data-act="save">সংরক্ষণ করুন</button>
    </div>
  </div>`;
  const textarea = wrap.querySelector('.note-textarea');
  textarea.focus();
  wrap.querySelector('[data-act="save"]').onclick = () => {
    saveNote(surah, ayah, textarea.value);
    renderNotePreview(wrap, key, surah, ayah);
  };
  wrap.querySelector('[data-act="cancel"]').onclick = () => renderNotePreview(wrap, key, surah, ayah);
  const delBtn = wrap.querySelector('[data-act="delete"]');
  if(delBtn) delBtn.onclick = () => { deleteNote(surah, ayah); renderNotePreview(wrap, key, surah, ayah); };
}

function renderNotePreview(wrap, key, surah, ayah){
  const text = getNote(surah, ayah);
  wrap.innerHTML = text ? `<div class="note-preview" data-note-preview="${key}">${escapeHtml(text)}</div>` : '';
  const btn = document.querySelector(`.note-toggle-btn[data-note-key="${key}"]`);
  if(btn){
    btn.classList.toggle('has-note', !!text);
    btn.textContent = text ? '📝 নোট দেখুন' : '🖊 নোট লিখুন';
  }
  const libList = document.getElementById('libraryListContainer');
  if(libList && document.getElementById('libTabNotes') && document.getElementById('libTabNotes').classList.contains('active')) renderNotesList(libList);
}

function starSvg(){
  return `<svg width="38" height="38" viewBox="0 0 38 38"><polygon points="19,2 22,12 33,9 25,17 33,25 22,22 19,33 16,22 5,25 13,17 5,9 16,12"
    fill="var(--gold-soft)" stroke="var(--gold)" stroke-width="1"/></svg>`;
}

// Bookmarks are stored via localStorage (see storage.js) so starred ayahs
// stay saved on the user's own device between visits.
function toggleBookmark(key, btn){
  if(state.bookmarks[key]){ delete state.bookmarks[key]; btn.classList.remove('bookmarked'); btn.textContent='☆ Save'; }
  else { state.bookmarks[key] = true; btn.classList.add('bookmarked'); btn.textContent='★ Reserved'; }
  saveBookmarks();
  const libList = document.getElementById('libraryListContainer');
  if(libList && document.getElementById('libTabBookmarks').classList.contains('active')) renderBookmarksList(libList);
}

function applyFontSize(){
  const arBase = 26 + state.fontStep*2;
  const bnBase = 16 + state.fontStep*1;
  document.documentElement.style.setProperty('--ar-size', arBase+'px');
  document.documentElement.style.setProperty('--bn-size', bnBase+'px');
}
