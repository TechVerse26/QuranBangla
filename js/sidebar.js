// ---------- List renderers: surah / juz / bookmarks / history / offline ----------
// These render into whichever container is passed in (Home tab uses
// #homeListContainer, Library tab uses #libraryListContainer) so the same
// logic can be reused across both parts of the new bottom-nav layout.

async function fetchSurahList(){
  const container = document.getElementById('homeListContainer');
  try{
    const res = await fetch(`${API}/surah`);
    const data = await res.json();
    state.surahList = data.data;
    renderSurahList(container);
    renderHomeExtras();
    if(typeof initAutoOfflineCache === 'function') initAutoOfflineCache();
  }catch(e){
    if(container) container.innerHTML = `<div class="error-box">Could not load the surah list.<br><button onclick="fetchSurahList()">Try again.</button></div>`;
  }
}

function renderSurahList(container){
  if(!container) return;
  container.innerHTML = '';
  state.surahList.forEach(s => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(s.number)}</div>
      <div class="li-text">
        <div class="li-title">${surahNamesBn[s.number-1] || s.englishName}${isSurahOffline(s.number) ? ' <span class="offline-dot" title="Saved offline">⬇</span>' : ''}</div>
        <div class="li-sub">${s.name}</div>
      </div>
      <div class="li-meta">${toBn(s.numberOfAyahs)} আয়াত</div>`;
    item.onclick = () => openSurah(s.number);
    container.appendChild(item);
  });
}

function renderJuzList(container){
  if(!container) return;
  container.innerHTML = '';
  for(let i=1;i<=30;i++){
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(i)}</div>
      <div class="li-text"><div class="li-title">পারা ${toBn(i)}</div></div>`;
    item.onclick = () => openJuz(i);
    container.appendChild(item);
  }
}

function renderHizbList(container){
  if(!container) return;
  container.innerHTML = '';
  for(let i=1;i<=60;i++){
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(i)}</div>
      <div class="li-text"><div class="li-title">হিজব ${toBn(i)}</div></div>`;
    item.onclick = () => openHizb(i);
    container.appendChild(item);
  }
}

function renderPageList(container){
  if(!container) return;
  container.innerHTML = '';
  for(let i=1;i<=604;i++){
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(i)}</div>
      <div class="li-text"><div class="li-title">পৃষ্ঠা ${toBn(i)}</div></div>`;
    item.onclick = () => openPage(i);
    container.appendChild(item);
  }
}

function renderRukuList(container){
  if(!container) return;
  container.innerHTML = '';
  for(let i=1;i<=556;i++){
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(i)}</div>
      <div class="li-text"><div class="li-title">রুকু ${toBn(i)}</div></div>`;
    item.onclick = () => openRuku(i);
    container.appendChild(item);
  }
}

// ---------- সুন্দর, আঁকা illustration সহ empty-state (আগে শুধু প্লেইন টেক্সট
// ছিল)। একটাই ছোট inline SVG সেট ব্যবহার করে reserved/notes/history/offline —
// চারটা লিস্টের জন্য চারটা ভিন্ন থিমেটিক আইকন, অ্যাপের গোল্ড/টিল রঙেই আঁকা, তাই
// কোনো এক্সটার্নাল ইমেজ ছাড়াই অফলাইনেও পুরোপুরি কাজ করবে। ----------
const EMPTY_STATE_ICONS = {
  bookmark: `<path d="M28 14h40a4 4 0 0 1 4 4v54l-24-15-24 15V18a4 4 0 0 1 4-4z"/>`,
  note: `<rect x="17" y="13" width="50" height="58" rx="5"/><path d="M27 29h30M27 40h30M27 51h18"/><path d="M58 56l11-11 6 6-11 11-8 2 2-8z" fill="var(--gold-soft)"/>`,
  history: `<circle cx="44" cy="45" r="28"/><path d="M44 29v16l11 7"/><path d="M18 22a34 34 0 1 0 6-9"/><path d="M12 8v13h13"/>`,
  offline: `<path d="M26 54a13 13 0 0 1 2-25.8A17 17 0 0 1 61 30a11 11 0 0 1-2 24H26z"/><path d="M44 42v21M37 55l7 7 7-7"/>`
};
function emptyStateHtml({icon, title, subtitle}){
  return `<div class="empty-state">
    <svg class="empty-state-illus" viewBox="0 0 84 84" width="84" height="84" fill="none" stroke="var(--gold)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${EMPTY_STATE_ICONS[icon]||''}</svg>
    <div class="empty-state-title">${title}</div>
    <div class="empty-state-sub">${subtitle}</div>
  </div>`;
}

function renderBookmarksList(container){
  if(!container) return;
  const keys = Object.keys(state.bookmarks);
  if(keys.length === 0){
    container.innerHTML = emptyStateHtml({
      icon: 'bookmark',
      title: 'এখনও কোনো আয়াত সংরক্ষণ করা হয়নি',
      subtitle: 'একটি আয়াত পড়ার সময় "☆ সংরক্ষণ করুন" বাটনে চাপুন।'
    });
    return;
  }
  container.innerHTML = '';
  keys.forEach(key => {
    const [surahNum, ayahInSurah] = key.split(':').map(Number);
    const s = state.surahList.find(x => x.number === surahNum);
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(surahNum)}</div>
      <div class="li-text">
        <div class="li-title">${(s ? (surahNamesBn[surahNum-1]||s.englishName) : 'সূরা '+surahNum)}</div>
        <div class="li-sub">আয়াত ${toBn(ayahInSurah)}</div>
      </div>`;
    item.onclick = () => openSurahAndScrollTo(surahNum, ayahInSurah);
    container.appendChild(item);
  });
}

// Shows the last several surahs the user has actually listened to, so they
// can jump back into recent tilawat instantly — even fully offline, since
// this list is read straight from localStorage.
function renderHistoryList(container){
  if(!container) return;
  if(!state.history.length){
    container.innerHTML = emptyStateHtml({
      icon: 'history',
      title: 'এখনও কোনো তিলাওয়াত শোনা হয়নি',
      subtitle: 'একটি আয়াত বা সূরা চালু করলে এখানে দেখা যাবে, পরে দ্রুত আবার শোনার জন্য।'
    });
    return;
  }
  container.innerHTML = '';
  state.history.forEach(h => {
    const reciterName = (reciters.find(r => r.id === h.reciter) || {}).name || '';
    const item = document.createElement('div');
    item.className = 'list-item history-item';
    item.innerHTML = `<div class="badge-num">${toBn(h.surah)}</div>
      <div class="li-text">
        <div class="li-title">${h.title}${isSurahOffline(h.surah) ? ' <span class="offline-dot" title="Saved offline">⬇</span>' : ''}</div>
        <div class="li-sub">আয়াত ${toBn(h.ayah)} · ${reciterName}</div>
      </div>
      <div class="li-meta">${timeAgoBn(h.ts)}</div>`;
    item.onclick = () => openSurahAndScrollTo(h.surah, h.ayah);
    container.appendChild(item);
  });
}

// Shows every ayah that has a personal note attached.
function renderNotesList(container){
  if(!container) return;
  const entries = allNoteEntries().sort((a,b) => a.surah - b.surah || a.ayah - b.ayah);
  if(!entries.length){
    container.innerHTML = emptyStateHtml({
      icon: 'note',
      title: 'এখনও কোনো নোট লেখা হয়নি',
      subtitle: 'একটি আয়াত পড়ার সময় "🖊 নোট লিখুন" বাটনে চাপুন।'
    });
    return;
  }
  container.innerHTML = '';
  entries.forEach(({surah, ayah, text}) => {
    const s = state.surahList.find(x => x.number === surah);
    const item = document.createElement('div');
    item.className = 'list-item note-item';
    item.innerHTML = `<div class="badge-num">${toBn(surah)}</div>
      <div class="li-text">
        <div class="li-title">${(s ? (surahNamesBn[surah-1]||s.englishName) : 'সূরা '+surah)} — আয়াত ${toBn(ayah)}</div>
        <div class="li-sub note-item-text">${escapeHtml(text)}</div>
      </div>
      <button class="offline-remove-btn" title="নোট মুছুন">Delete</button>`;
    item.querySelector('.li-text').onclick = () => openSurahAndScrollTo(surah, ayah);
    item.querySelector('.badge-num').onclick = () => openSurahAndScrollTo(surah, ayah);
    item.querySelector('.offline-remove-btn').onclick = (e) => {
      e.stopPropagation();
      deleteNote(surah, ayah);
      renderNotesList(container);
    };
    container.appendChild(item);
  });
}

// When opening a surah from the "Offline" list, make sure playback uses the
// SAME reciter that was active when the audio was downloaded — otherwise
// currentAudioUrl() in player.js builds a URL for whatever reciter happens to
// be selected right now, that file was never cached, and playback silently
// fails while truly offline (even though the download itself succeeded).
//
// We also MUST switch back to the "home" view first (goToView('home')),
// exactly like openSurahAndScrollTo() does. openSurah() only toggles
// readerArea's own display, but readerArea lives inside the "view-home"
// section, which stays hidden (.view{display:none}) while the Library tab
// is active. Without this, the reader/play button render correctly in the
// DOM but the whole section is invisible, so taps on it appear to do
// nothing at all.
function openOfflineSurah(entry){
  if(entry.reciter && entry.reciter !== state.reciter){
    state.reciter = entry.reciter;
    saveReciter();
    if(typeof updateReciterLabels === 'function') updateReciterLabels();
  }
  goToView('home');
  openSurah(entry.surah);
}

// Shows surahs that have been downloaded for offline listening, so the
// user can see at a glance what's actually saved on this device (and undo
// a download to free up space) — separate from the plain surah/juz lists.
function renderOfflineList(container){
  if(!container) return;
  const validEntries = state.offlineSurahs.filter(o => Number.isInteger(o.surah) && o.surah >= 1 && o.surah <= 114);
  const managerLinkHtml = `<button class="settings-btn" id="dlmOpenFromLibrary" style="width:100%;justify-content:center;margin-bottom:10px;">
    <i class="fa-solid fa-cloud-arrow-down"></i> <span>ডাউনলোড ম্যানেজার খুলুন</span>
  </button>`;
  if(!validEntries.length){
    container.innerHTML = managerLinkHtml + emptyStateHtml({
      icon: 'offline',
      title: 'এখনও কোনো সূরা অফলাইনে সংরক্ষণ করা হয়নি',
      subtitle: 'ডাউনলোড ম্যানেজার থেকে যেকোনো সূরা আগে থেকেই সংরক্ষণ করে রাখা যায়।'
    });
    const btn = document.getElementById('dlmOpenFromLibrary');
    if(btn) btn.onclick = () => { if(typeof openDownloadManager === 'function') openDownloadManager(); };
    return;
  }
  const sorted = [...validEntries].sort((a,b) => b.ts - a.ts);
  container.innerHTML = managerLinkHtml;
  const managerBtn = document.getElementById('dlmOpenFromLibrary');
  if(managerBtn) managerBtn.onclick = () => { if(typeof openDownloadManager === 'function') openDownloadManager(); };
  sorted.forEach(entry => {
    const s = state.surahList.find(x => x.number === entry.surah);
    const title = s ? (surahNamesBn[entry.surah-1] || s.englishName) : ('সূরা ' + entry.surah);
    const reciterName = (reciters.find(r => r.id === entry.reciter) || {}).name || '';
    const ayahCount = entry.ayahCount || (s ? s.numberOfAyahs : null);
    const item = document.createElement('div');
    item.className = 'list-item offline-item';
    item.innerHTML = `<div class="badge-num">${toBn(entry.surah)}</div>
      <div class="li-text">
        <div class="li-title">${title} <span class="offline-dot" title="Saved offline">⬇</span></div>
        <div class="li-sub">${ayahCount ? toBn(ayahCount) + ' আয়াত' : ''}${reciterName ? ' · ' + reciterName : ''}</div>
      </div>
      <div class="li-meta">${timeAgoBn(entry.ts)}</div>
      <button class="offline-remove-btn" title="Delete from offline">Delete</button>`;
    item.querySelector('.li-text').onclick = () => openOfflineSurah(entry);
    item.querySelector('.badge-num').onclick = () => openOfflineSurah(entry);
    item.querySelector('.offline-remove-btn').onclick = async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Deleting...';
      await removeSurahOffline(entry.surah);
      renderOfflineList(container);
      const openOfflineBtn = document.getElementById('offlineBtn');
      if(openOfflineBtn && state.playlist.length && state.playlist[0].surah === entry.surah){
        openOfflineBtn.classList.remove('downloaded');
        openOfflineBtn.disabled = false;
        openOfflineBtn.textContent = '⬇ Save offline';
      }
    };
    container.appendChild(item);
  });
}

function markSelected(idx, container){
  const scope = container || document.getElementById('homeListContainer');
  if(!scope) return;
  scope.querySelectorAll('.list-item').forEach((el,i)=>el.classList.toggle('selected', i===idx));
}

// ---------- Ayah of the Day (home landing card) ----------
// Picks a deterministic ayah for today (see ayahOfTheDay() in data.js) and
// caches its fetched text in localStorage for that calendar day only, so
// re-opening the app the same day shows it instantly with no network call,
// and it still works fully offline after the first load.
//
// Card layout (photo-style):
//   [ 📖  Daily Ayah  ·  ]     [ read-btn ] [ play-btn ]
//   ─────────────────────────────────────────────────────
//   Arabic text (right-aligned, large)
//   Bengali translation
//   ─────────────────────────────────────────────────────
//   Surah Name (S:A)               🔊 Qari Name
function renderAyahOfDay(){
  const card = document.getElementById('ayahOfDayCard');
  if(!card) return;
  const {s, a} = ayahOfTheDay();
  const todayKey = new Date().toDateString();
  let cached = null;
  try{
    const raw = IDBKV.get('qr_aod_cache');
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && parsed.date === todayKey && parsed.s === s && parsed.a === a) cached = parsed;
    }
  }catch(e){}

  // ---- Wire up play button after DOM injection ----
  function wireAodButtons(globalNumber, surahNameEn){
    const playBtn = document.getElementById('aodPlayBtn');
    const readBtn = document.getElementById('aodReadBtn');

    if(readBtn){
      readBtn.addEventListener('click', e => {
        e.stopPropagation();
        openSurahAndScrollTo(s, a);
      });
    }

    if(playBtn && globalNumber){
      playBtn.addEventListener('click', e => {
        e.stopPropagation();
        // Build a single-ayah playlist and hand it to the existing player
        state.playlist = [{
          key: `${s}:${a}`,
          globalNumber: globalNumber,
          surah: s,
          numberInSurah: a,
          title: surahNamesBn[s-1] || ('সূরা ' + s)
        }];
        state.playIndex = 0;
        if(typeof playAtIndex === 'function') playAtIndex(0, true);
        // Visual feedback: mark the button as "playing"
        playBtn.classList.add('aod-playing');
        playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        // Listen for pause/end to reset the button
        const audioEl = document.getElementById('audioEl');
        if(audioEl){
          const resetBtn = () => {
            if(playBtn){
              playBtn.classList.remove('aod-playing');
              playBtn.innerHTML = '<i class="fa-solid fa-circle-play"></i>';
            }
          };
          audioEl.addEventListener('pause', resetBtn, { once: true });
          audioEl.addEventListener('ended', resetBtn, { once: true });
        }
      });
    }
  }

  // ---- Build the full card HTML ----
  function renderCard(arabic, bengali, globalNumber, surahNameEn){
    const surahNameBn = surahNamesBn[s-1] || ('সূরা ' + s);
    const displayRef = surahNameEn
      ? `${surahNameEn} (${s}:${toBn(a)})`
      : `সূরা ${surahNameBn} (${s}:${toBn(a)})`;
    const reciter = reciters.find(r => r.id === state.reciter);
    const reciterLabel = reciter ? (reciter.name) : '';
    const canPlay = !!(globalNumber);

    card.innerHTML = `
      <div class="aod-header">
        <div class="aod-title-wrap">
          <div class="aod-title-icon"><i class="fa-solid fa-book-quran"></i></div>
          <span class="aod-title-text">Daily Ayah</span>
          <span class="aod-badge-dot"></span>
        </div>
        <div class="aod-actions">
          <button class="aod-btn" id="aodReadBtn" title="সূরায় যান">
            <i class="fa-solid fa-book-open"></i>
          </button>
          ${canPlay ? `<button class="aod-btn aod-play-btn" id="aodPlayBtn" title="তিলাওয়াত শুনুন">
            <i class="fa-solid fa-circle-play"></i>
          </button>` : ''}
        </div>
      </div>
      <div class="aod-body">
        <div class="aod-arabic">${arabic || ''}</div>
        <div class="aod-bengali">${bengali || ''}</div>
      </div>
      <div class="aod-footer">
        <span class="aod-ref">${displayRef}</span>
        ${reciterLabel ? `<span class="aod-qari"><i class="fa-solid fa-volume-high"></i>${reciterLabel}</span>` : ''}
      </div>`;

    wireAodButtons(globalNumber, surahNameEn);
  }

  // ---- Show loading state ----
  const buildLoadingHtml = () => `
    <div class="aod-header">
      <div class="aod-title-wrap">
        <div class="aod-title-icon"><i class="fa-solid fa-book-quran"></i></div>
        <span class="aod-title-text">Daily Ayah</span>
        <span class="aod-badge-dot"></span>
      </div>
    </div>
    <div class="aod-loading">লোড হচ্ছে…</div>`;

  // ---- Use cache if valid ----
  if(cached && cached.edition === state.translationEdition){
    renderCard(cached.arabic, cached.bengali, cached.globalNumber || null, cached.surahNameEn || null);
    return;
  }

  card.innerHTML = buildLoadingHtml();

  Promise.all([
    fetch(`${API}/ayah/${s}:${a}/quran-uthmani`).then(r => r.json()),
    fetch(`${API}/ayah/${s}:${a}/${state.translationEdition}`).then(r => r.json())
  ]).then(([arRes, bnRes]) => {
    const arabic       = arRes && arRes.data ? arRes.data.text : '';
    const bengali      = bnRes && bnRes.data ? bnRes.data.text : '';
    const globalNumber = arRes && arRes.data ? arRes.data.number : null;
    const surahNameEn  = arRes && arRes.data && arRes.data.surah ? arRes.data.surah.englishName : null;
    renderCard(arabic, bengali, globalNumber, surahNameEn);
    try{
      IDBKV.set('qr_aod_cache', JSON.stringify({
        date: todayKey, s, a,
        edition: state.translationEdition,
        arabic, bengali, globalNumber, surahNameEn
      }));
    }catch(e){}
  }).catch(() => {
    card.innerHTML = buildLoadingHtml().replace('লোড হচ্ছে…', 'লোড করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করুন।');
  });
}

// ---------- হোম পেজের "Reading streak" প্রোগ্রেস রিং ----------
// js/stats.js এর loadActivity()/computeStreak()/nextMilestone() ও
// DAILY_GOAL_MIN রিইউজ করে — স্ট্যাটস পেজের মতোই একই ডেটা, শুধু হোমে একটা
// ছোট, দ্রুত-দৃশ্যমান SVG রিং আকারে। রিং = বর্তমান স্ট্রিক / পরবর্তী মাইলফলক;
// আজকে ইতিমধ্যে পড়া/শোনা হয়ে থাকলে রিং সোনালি (active), না হলে হালকা রঙে
// থাকে — যাতে বোঝা যায় আজ স্ট্রিক বজায় রাখা এখনও বাকি।
function renderHomeStreakRing(){
  const box = document.getElementById('homeStreakRing');
  if(!box) return;
  const activity = loadActivity();
  const todaySec = activity[todayStr()] || 0;
  const todayDone = todaySec > 0;
  const streak = computeStreak(activity);
  const milestone = nextMilestone(streak);
  const r = 30, circumference = 2 * Math.PI * r;
  const frac = milestone > 0 ? Math.min(1, streak / milestone) : 0;
  const dashoffset = circumference * (1 - frac);
  box.innerHTML = `
    <div class="streak-ring-card${todayDone ? ' active' : ''}" id="streakRingCard">
      <div class="streak-ring-wrap">
        <svg class="streak-ring-svg" width="72" height="72" viewBox="0 0 72 72">
          <defs>
            <linearGradient id="srsGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="var(--gold-soft)"/>
              <stop offset="100%" stop-color="var(--gold)"/>
            </linearGradient>
          </defs>
          <circle class="srs-track" cx="36" cy="36" r="${r}" fill="none" stroke-width="6"/>
          <circle class="srs-fill" cx="36" cy="36" r="${r}" fill="none" stroke-width="6"
            stroke="${todayDone ? 'url(#srsGrad)' : 'var(--ink-soft)'}"
            stroke-dasharray="${circumference}" stroke-dashoffset="${dashoffset}" stroke-linecap="round"/>
        </svg>
        <div class="streak-ring-center">
          <i class="fa-solid fa-fire"></i>
          <span class="srn-num">${toBn(streak)}</span>
          <span class="srn-label">দিন</span>
        </div>
      </div>
      <div class="streak-ring-text">
        <div class="streak-ring-title">${streak > 0 ? `${toBn(streak)} দিনের স্ট্রিক চলছে` : 'আজই স্ট্রিক শুরু করুন'}</div>
        <div class="streak-ring-sub">${todayDone
          ? `পরবর্তী লক্ষ্য ${toBn(milestone)} দিন — চালিয়ে যান!`
          : 'আজ একটি আয়াত পড়ে/শুনে স্ট্রিক বজায় রাখুন'}</div>
        <div class="streak-ring-progress"><div class="srp-fill" style="width:${Math.round(frac*100)}%"></div></div>
      </div>
    </div>`;
  document.getElementById('streakRingCard').onclick = () => goToView('stats');
}

// ---------- হোম পেজ: আজ যেসব সূরার হিফজ রিভিউ বাকি (spaced-repetition) ----------
// js/storage.js hifzSurahsDueToday() থেকে ডেটা নেয় — খালি থাকলে কার্ডটি
// সম্পূর্ণ লুকানো থাকে, যাতে যারা হিফজ ফিচার ব্যবহারই করেন না তাদের হোম
// পেজে অপ্রাসঙ্গিক জায়গা না নেয়।
function renderHifzReviewCard(){
  const box = document.getElementById('hifzReviewCard');
  if(!box) return;
  const due = typeof hifzSurahsDueToday === 'function' ? hifzSurahsDueToday() : [];
  if(!due.length){ box.innerHTML = ''; return; }
  const chipsHtml = due.slice(0, 6).map(s => `<button class="chip hifz-due-chip" data-surah="${s}">${surahNamesBn[s-1] || ('সূরা '+s)}</button>`).join('');
  box.innerHTML = `
    <div class="hifz-review-card">
      <div class="hifz-review-ic"><i class="fa-solid fa-brain"></i></div>
      <div class="hifz-review-mid">
        <div class="hifz-review-title">আজকের হিফজ রিভিউ</div>
        <div class="hifz-review-sub">${toBn(due.length)}টি সূরা রিভিউর সময় হয়েছে — হাফেজ মোডে খুলে ঝালিয়ে নিন</div>
        <div class="hifz-review-chips">${chipsHtml}</div>
      </div>
    </div>`;
  box.querySelectorAll('.hifz-due-chip').forEach(chip => {
    chip.onclick = () => {
      const num = parseInt(chip.getAttribute('data-surah'), 10);
      if(!Number.isInteger(num)) return;
      state.hafezMode = true;
      if(typeof saveHafezMode === 'function') saveHafezMode();
      openSurah(num).then(() => { if(typeof applyHafezModeUI === 'function') applyHafezModeUI(); });
    };
  });
}

// ---------- Home tab: last-read chips + quick links ----------
const QUICK_LINKS = [
  { label: 'আল-মুলক', surah: 67 },
  { label: 'আল-কাহফ', surah: 18 },
  { label: 'আয়াতুল কুরসী', surah: 2, ayah: 255 },
  { label: 'ইয়াসীন', surah: 36 },
  { label: 'আর-রাহমান', surah: 55 }
];

function renderHomeExtras(){
  if(typeof renderStatusRow === 'function') renderStatusRow();
  renderAyahOfDay();
  renderHomeStreakRing();
  if(typeof renderHifzReviewCard === 'function') renderHifzReviewCard();
  const lastChips = document.getElementById('lastReadChips');
  const lastTitle = document.getElementById('lastReadTitle');
  if(lastChips){
    lastChips.innerHTML = '';
    const recents = state.history.slice(0, 4);
    if(recents.length){
      lastTitle.style.display = '';
      recents.forEach(h => {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.textContent = `${h.title} ${toBn(h.surah)}:${toBn(h.ayah)}`;
        chip.onclick = () => openSurahAndScrollTo(h.surah, h.ayah);
        lastChips.appendChild(chip);
      });
    } else {
      lastTitle.style.display = 'none';
    }
  }
  const qlChips = document.getElementById('quickLinkChips');
  if(qlChips){
    qlChips.innerHTML = '';
    QUICK_LINKS.forEach(q => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = q.label;
      chip.onclick = () => q.ayah ? openSurahAndScrollTo(q.surah, q.ayah) : openSurah(q.surah);
      qlChips.appendChild(chip);
    });
  }
}
