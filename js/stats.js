// ---------- Reading statistics: streak, weekly chart, badges ----------
// Activity is tracked as seconds-read-per-date in localStorage. There's no
// server or account, so this is purely a local, on-device streak — it
// resets if the user clears site data, same as bookmarks/history.
const STATS_LS_KEY = 'qr_activity';
const DAILY_GOAL_MIN = 1; // matches the "0 min / 1 min" style daily goal
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365];
const WEEKDAY_LABELS_BN = ['SU','MO','TU','WD','TH','FR','ST'];

function loadActivity(){
  try{
    const raw = IDBKV.get(STATS_LS_KEY);
    return raw ? JSON.parse(raw) : {};
  }catch(e){ return {}; }
}
function saveActivity(a){
  try{ IDBKV.set(STATS_LS_KEY, JSON.stringify(a)); }catch(e){}
  queueCloudSync();
}

// Called from openSurah/openJuz/openPage/openHizb/openRuku, from audio
// playback, and from marking a planner day — i.e. any real reading/listening
// activity — so the streak reflects actual use, not just opening the app.
function recordActivityToday(){
  const activity = loadActivity();
  const key = todayStr();
  activity[key] = (activity[key] || 0) + 15; // nominal bump per action
  saveActivity(activity);
  checkTimeOfDayBadges();
}

// A lightweight ticking timer that only accumulates while the reader is
// actually open and the tab is focused, for a more realistic minutes count.
function initReadingTimer(){
  setInterval(() => {
    if(document.hidden) return;
    if(!readerArea || readerArea.style.display === 'none') return;
    const activity = loadActivity();
    const key = todayStr();
    activity[key] = (activity[key] || 0) + 20;
    saveActivity(activity);
    checkTimeOfDayBadges();
  }, 20000);
}

function computeStreak(activity){
  let streak = 0;
  const d = new Date();
  while(true){
    const key = d.toISOString().slice(0,10);
    if((activity[key] || 0) > 0){ streak++; d.setDate(d.getDate()-1); }
    else break;
  }
  return streak;
}

// Total seconds ever recorded across all dates — the "অতিবাহিত সময়" lifetime stat.
function totalTimeSpentSeconds(activity){
  return Object.values(activity || {}).reduce((sum, s) => sum + (s || 0), 0);
}
function formatDurationBn(totalSeconds){
  const totalMin = Math.floor(totalSeconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if(h <= 0) return `${toBn(m)} মিনিট`;
  return `${toBn(h)} ঘন্টা ${toBn(m)} মিনিট`;
}

function nextMilestone(streak){
  return STREAK_MILESTONES.find(m => m > streak) || (streak + 30);
}

// ---------- Badges: real unlock logic tied to actual app usage ----------
// A large, categorized badge set. Every badge's progress() reads only real,
// already-tracked app state (see js/storage.js) — nothing here is decorative.
const BADGE_ICON_SVGS = {
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5V4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
  trophy: '<path d="M8 3h8v4a4 4 0 0 1-8 0V3Z"/><path d="M6 5H4a2 2 0 0 0 0 4h2"/><path d="M18 5h2a2 2 0 0 1 0 4h-2"/><path d="M9 14h6"/><path d="M12 11v3"/><path d="M8 21h8"/><path d="M10 21c0-2 1-3 2-3s2 1 2 3"/>',
  audio: '<path d="M4.5 13.5a7.5 7.5 0 0 1 15 0"/><rect x="3.2" y="13.5" width="4.2" height="7" rx="1.6"/><rect x="16.6" y="13.5" width="4.2" height="7" rx="1.6"/>',
  waveform: '<path d="M3 12h2l2-7 3 14 2-9 2 5 2-3h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.8"/><path d="M20 20l-4.3-4.3"/>',
  flame: '<path d="M12 2s5 4.5 5 10a5 5 0 0 1-10 0c0-1.5.8-2.5 1.5-3.5C9 10 9 12 10 12c1 0 .5-3 .5-5C13 8 12 2 12 2Z"/>',
  calendarCheck: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="m8 15 2.3 2.3L16 12.5"/>',
  bookmarkIc: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  ramadan: '<path d="M12 3a9 9 0 1 0 8.9 10.4A6.5 6.5 0 0 1 12 3z"/><path d="M18 3.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/>',
  star: '<path d="m12 2 2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 16.9 5.8 20.3l1.6-6.8L2.2 8.9l6.9-.6L12 2Z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m14.5 9.5-2 5-5 2 2-5 5-2Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  highlighter: '<path d="m9 11 6-6 4 4-6 6H9v-4Z"/><path d="M5 21h14"/><path d="m5 21 3-6 3 3-3 3H5Z"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-1 5.8V15a3 3 0 0 0 3 3h1"/><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 1 5.8V15a3 3 0 0 1-3 3h-1"/><path d="M9 4v15"/><path d="M15 4v15"/>',
  map: '<path d="M9 3 4 5v16l5-2 6 2 5-2V3l-5 2-6-2Z"/><path d="M9 3v16"/><path d="M15 5v16"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  palette: '<path d="M12 2a10 10 0 1 0 0 20c1.5 0 2-.8 2-2s-1-1.3-1-2.5S14 16 15.5 16H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10Z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/>',
  userCheck: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/><path d="m16 12 2 2 3.5-3.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'
};
function badgeIconSvg(icon){
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${BADGE_ICON_SVGS[icon]||BADGE_ICON_SVGS.star}</svg>`;
}
// Effective unique-surahs-played count = whichever is higher between this
// device's own local list and the aggregate count last synced from the
// cloud (see js/auth.js) — never the cloud's actual surah list, since that's
// never uploaded in the first place.
function audioSurahsPlayedEffectiveCount(){
  return Math.max((state.audioSurahsPlayed||[]).length, state.audioSurahsPlayedFloor || 0);
}
// Set to true/false by renderStatsView() each render — whether every day so
// far in the current week (Sun..today) has some recorded activity.
let weekFullyActiveSoFar = false;
const STREAK_TIER_LABELS = ['সূচনা স্ট্রিক','সাপ্তাহিক স্ট্রিক','দ্বি-সাপ্তাহিক স্ট্রিক','মাসিক নিষ্ঠা','দ্বি-মাসিক নিষ্ঠা','শতক স্ট্রিক','বার্ষিক নিষ্ঠা'];

function makeCountBadge(id, label, icon, goal, progressFn, category, unit){
  return {
    id, label, icon, category, goal,
    progress: () => Math.min(progressFn(), goal),
    caption: () => `${toBn(Math.min(progressFn(), goal))}/${toBn(goal)}${unit ? ' ' + unit : ''}`
  };
}
function makeFlagBadge(id, label, icon, category, flagFn, doneCaption, todoCaption){
  return {
    id, label, icon, category, goal: 1,
    progress: () => flagFn() ? 1 : 0,
    caption: () => flagFn() ? doneCaption : todoCaption
  };
}

const BADGE_CATEGORIES = [
  { id: 'reading', label: 'পড়াশোনা' },
  { id: 'audio', label: 'শ্রবণ' },
  { id: 'search', label: 'অনুসন্ধান' },
  { id: 'streak', label: 'ধারাবাহিকতা' },
  { id: 'collection', label: 'সংগ্রহ' },
  { id: 'ramadan', label: 'রমজান' },
  { id: 'explore', label: 'অভিযান' },
  { id: 'planner', label: 'পরিকল্পনা' },
  { id: 'time', label: 'সময়' },
  { id: 'personalize', label: 'ব্যক্তিগতকরণ' },
  { id: 'account', label: 'অ্যাকাউন্ট' }
];

const BADGES = [
  // ---- পড়াশোনা (unique ayahs + unique surahs actually read) ----
  makeCountBadge('ayah50', 'নতুন সূচনা', 'book', 50, ayahsReadCount, 'reading', 'আয়াত'),
  makeCountBadge('ayah200', 'নিয়মিত পাঠক', 'book', 200, ayahsReadCount, 'reading', 'আয়াত'),
  makeCountBadge('ayah500', 'নিবেদিত পাঠক', 'book', 500, ayahsReadCount, 'reading', 'আয়াত'),
  makeCountBadge('ayah1000', 'সহস্র আয়াত', 'book', 1000, ayahsReadCount, 'reading', 'আয়াত'),
  makeCountBadge('khatam', 'কুরআন খতম', 'trophy', 6236, ayahsReadCount, 'reading', 'আয়াত'),
  makeCountBadge('surah10', 'সূরা অভিযাত্রী', 'book', 10, surahsActuallyReadCount, 'reading', 'সূরা পঠিত'),
  makeCountBadge('surah50', 'সূরা সংগ্রাহক', 'book', 50, surahsActuallyReadCount, 'reading', 'সূরা পঠিত'),
  makeCountBadge('surahAll', 'সম্পূর্ণ সূরা পাঠ', 'trophy', 114, surahsActuallyReadCount, 'reading', 'সূরা পঠিত'),

  // ---- শ্রবণ (unique surahs listened) ----
  makeCountBadge('audio', 'অডিও এক্সপ্লোরার', 'audio', 5, audioSurahsPlayedEffectiveCount, 'audio', 'সূরা শোনা'),
  makeCountBadge('audio20', 'অডিও অনুরাগী', 'audio', 20, audioSurahsPlayedEffectiveCount, 'audio', 'সূরা শোনা'),
  makeCountBadge('audio50', 'অডিও বিশেষজ্ঞ', 'waveform', 50, audioSurahsPlayedEffectiveCount, 'audio', 'সূরা শোনা'),
  makeCountBadge('audioAll', 'সম্পূর্ণ অডিও কুরআন', 'trophy', 114, audioSurahsPlayedEffectiveCount, 'audio', 'সূরা শোনা'),

  // ---- অনুসন্ধান ----
  makeCountBadge('search', 'সার্চ এক্সপ্লোরার', 'search', 5, () => state.searchCount||0, 'search', 'সার্চ'),
  makeCountBadge('search25', 'সার্চ গুরু', 'search', 25, () => state.searchCount||0, 'search', 'সার্চ'),
  makeCountBadge('search50', 'সার্চ মাস্টার', 'search', 50, () => state.searchCount||0, 'search', 'সার্চ'),

  // ---- ধারাবাহিকতা (best-ever streak, kept even after a reset) ----
  ...STREAK_MILESTONES.map((n, i) => makeCountBadge('streak'+n, STREAK_TIER_LABELS[i]||`${n} দিনের স্ট্রিক`, 'flame', n, () => state.bestStreak||0, 'streak', 'দিন')),
  makeFlagBadge('weeklyChampion', 'সাপ্তাহিক চ্যাম্পিয়ন', 'calendarCheck', 'streak', () => weekFullyActiveSoFar, 'এই সপ্তাহের প্রতিদিন পড়া হয়েছে', 'এই সপ্তাহের প্রতিদিন পড়ুন'),

  // ---- সংগ্রহ (bookmarks, notes, offline downloads) ----
  makeCountBadge('bookmark5', 'সংগ্রাহক', 'bookmarkIc', 5, () => Object.keys(state.bookmarks||{}).length, 'collection', 'বুকমার্ক'),
  makeCountBadge('bookmark15', 'বুকমার্ক বিশেষজ্ঞ', 'bookmarkIc', 15, () => Object.keys(state.bookmarks||{}).length, 'collection', 'বুকমার্ক'),
  makeCountBadge('note5', 'নোট লেখক', 'pencil', 5, () => Object.keys(state.notes||{}).length, 'collection', 'নোট'),
  makeCountBadge('note15', 'চিন্তাশীল পাঠক', 'pencil', 15, () => Object.keys(state.notes||{}).length, 'collection', 'নোট'),
  makeCountBadge('offline3', 'অফলাইন সংগ্রাহক', 'download', 3, () => (state.offlineSurahs||[]).length, 'collection', 'সূরা ডাউনলোড'),
  makeCountBadge('offline10', 'অফলাইন মাস্টার', 'download', 10, () => (state.offlineSurahs||[]).length, 'collection', 'সূরা ডাউনলোড'),
  makeCountBadge('sharer', 'দাতা (শেয়ারকারী)', 'star', 5, () => state.shareCount||0, 'collection', 'বার শেয়ার'),

  // ---- রমজান ----
  makeCountBadge('ramadan', 'হার্ট অব রমযান', 'ramadan', 1, () => taraweehCompletedCount ? taraweehCompletedCount() : 0, 'ramadan', 'তারাবীহ লগ'),
  makeCountBadge('taraweeh10', 'তারাবীহ তারকা', 'ramadan', 10, () => taraweehCompletedCount ? taraweehCompletedCount() : 0, 'ramadan', 'তারাবীহ লগ'),
  makeCountBadge('taraweeh20', 'তারাবীহ চ্যাম্পিয়ন', 'ramadan', 20, () => taraweehCompletedCount ? taraweehCompletedCount() : 0, 'ramadan', 'তারাবীহ লগ'),
  makeCountBadge('taraweeh30', 'পূর্ণ রমজান তারাবীহ', 'trophy', 30, () => taraweehCompletedCount ? taraweehCompletedCount() : 0, 'ramadan', 'তারাবীহ লগ'),
  makeFlagBadge('ramadanModeUsed', 'রমজানের আবহ', 'ramadan', 'ramadan', () => !!state.ramadanModeUsed, 'রমজান মোড চালু করা হয়েছে', 'সেটিংস থেকে রমজান মোড চালু করুন'),

  // ---- অভিযান (feature explorer) ----
  makeCountBadge('topics5', 'বিষয় অনুসন্ধানী', 'star', 5, topicsExploredEffectiveCount, 'explore', 'বিষয়'),
  makeFlagBadge('qibla', 'কিবলা আবিষ্কারক', 'compass', 'explore', () => !!state.qiblaUsed, 'কিবলা খুঁজে বের করা হয়েছে', 'কিবলা কম্পাস ব্যবহার করুন'),
  makeFlagBadge('compare', 'তুলনামূলক অধ্যয়ন', 'layers', 'explore', () => !!state.translationCompareUsed, '২+ অনুবাদ পাশাপাশি দেখা হয়েছে', 'পাশাপাশি ২+ অনুবাদ বেছে নিন'),
  makeFlagBadge('tajweed', 'তাজবীদ অনুশীলনকারী', 'highlighter', 'explore', () => !!state.tajweedModeUsed, 'তাজবীদ হাইলাইট ব্যবহৃত হয়েছে', 'সেটিংস থেকে তাজবীদ মোড চালু করুন'),
  makeFlagBadge('hafez', 'হাফেজ মোড', 'brain', 'explore', () => !!state.hafezModeUsed, 'হাফেজ মোড ব্যবহৃত হয়েছে', 'রিডারে হাফেজ মোড চালু করুন'),

  // ---- পরিকল্পনা ----
  makeFlagBadge('plannerCreated', 'পরিকল্পক', 'map', 'planner', () => loadPlanners().length > 0, 'একটি প্ল্যানার তৈরি হয়েছে', 'একটি রিডিং প্ল্যানার তৈরি করুন'),
  makeCountBadge('plannerDays30', 'অধ্যবসায়ী পাঠক', 'calendarCheck', 30, () => loadPlanners().reduce((s,p) => s + (p.completedDays||0), 0), 'planner', 'দিন সম্পন্ন'),
  makeFlagBadge('plannerFinished', 'লক্ষ্য অর্জনকারী', 'trophy', 'planner', () => loadPlanners().some(p => p.completedDays >= p.days), 'একটি প্ল্যানার সম্পন্ন হয়েছে', 'একটি প্ল্যানার সম্পূর্ণ করুন'),

  // ---- সময় ----
  makeFlagBadge('nightOwl', 'রাত জাগা পাঠক', 'moon', 'time', () => !!state.nightOwlDone, 'গভীর রাতে পড়া হয়েছে', 'রাত ১২টা–৪টার মধ্যে পড়ুন'),
  makeFlagBadge('earlyBird', 'ফজরের পাখি', 'sun', 'time', () => !!state.earlyBirdDone, 'ভোরে পড়া হয়েছে', 'ভোর ৪টা–৭টার মধ্যে পড়ুন'),

  // ---- ব্যক্তিগতকরণ ----
  makeCountBadge('themeExplorer', 'থিম অনুসন্ধানী', 'palette', 3, () => (state.themesTried||[]).length, 'personalize', 'থিম চেষ্টা'),
  makeCountBadge('multilingual', 'বহুভাষী', 'globe', 2, () => (state.languagesUsed||[]).length, 'personalize', 'ভাষা'),

  // ---- অ্যাকাউন্ট ----
  makeFlagBadge('account', 'অ্যাকাউন্ট তৈরি', 'userCheck', 'account', () => !!state.user, 'অ্যাকাউন্ট তৈরি হয়েছে', 'সাইন আপ করুন'),
  makeFlagBadge('prayerNotify', 'নামাজ সচেতন', 'bell', 'account', () => !!state.prayerNotifyEverEnabled, 'নামাজের বিজ্ঞপ্তি চালু করা হয়েছে', 'নামাজের বিজ্ঞপ্তি চালু করুন')
];

function unlockedBadgesCount(){
  return BADGES.filter(b => b.progress() >= b.goal).length;
}

function badgeCardHtml(b){
  const progress = b.progress();
  const unlocked = progress >= b.goal;
  return `<div class="badge-card${unlocked?' unlocked':''}">
    <div class="badge-ic-box">${badgeIconSvg(b.icon)}${unlocked?'':'<span class="badge-lock-dot"><i class="fa-solid fa-lock"></i></span>'}</div>
    <div class="badge-name-v2">${b.label}</div>
    <div class="badge-progress-v2">${b.caption()}</div>
  </div>`;
}

// Main stats page shows a compact showcase: unlocked badges first (most
// recently completed feel), then the closest-to-unlock ones, capped at 6 —
// full breakdown lives behind "সবগুলো দেখুন".
function renderBadgesShowcase(){
  const sorted = BADGES.slice().sort((a,b) => {
    const au = a.progress() >= a.goal, bu = b.progress() >= b.goal;
    if(au !== bu) return au ? -1 : 1;
    return (b.progress()/b.goal) - (a.progress()/a.goal);
  });
  return sorted.slice(0, 6).map(badgeCardHtml).join('');
}

function renderBadgesSummaryBar(){
  const total = BADGES.length;
  const unlocked = unlockedBadgesCount();
  const pct = Math.round((unlocked/total)*100);
  return `
    <div class="badges-summary">
      <div class="badges-summary-text"><b>${toBn(unlocked)}</b> / ${toBn(total)} ব্যাজ অর্জিত</div>
      <div class="badges-summary-bar"><div class="badges-summary-fill" style="width:${pct}%"></div></div>
    </div>`;
}

// "সবগুলো দেখুন" — a full, categorized modal listing every badge and how to
// unlock it, reusing the app's existing generic .app-modal look.
function openAllBadgesModal(){
  const old = document.getElementById('allBadgesModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'allBadgesModal';
  wrap.style.display = 'flex';
  const sections = BADGE_CATEGORIES.map(cat => {
    const items = BADGES.filter(b => b.category === cat.id);
    if(!items.length) return '';
    return `
      <div class="badge-cat-title">${cat.label}</div>
      <div class="badges-grid badges-grid-modal">${items.map(badgeCardHtml).join('')}</div>`;
  }).join('');
  wrap.innerHTML = `
    <div class="app-modal-box">
      <div class="app-modal-head">
        <h3><i class="fa-solid fa-award"></i> All badges</h3>
        <button class="app-modal-close" id="allBadgesClose">✕</button>
      </div>
      <div class="app-modal-body">
        ${renderBadgesSummaryBar()}
        ${sections}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('allBadgesClose').onclick = remove;
}

// ---------- Sign-up / login prompt + signed-in account strip ----------
function renderAccountArea(){
  const user = state.user;
  if(user){
    const avatarStyle = user.photoData
      ? ` style="background-image:url('${user.photoData}');background-size:cover;background-position:center;"`
      : (user.avatarColor ? ` style="background:${user.avatarColor}"` : '');
    return `
      <div class="stats-card account-strip">
        <button type="button" class="account-strip-clickable" id="statsAccountStripInfo">
          <div class="account-avatar-ring">
            <div class="account-avatar"${avatarStyle}>${user.photoData ? '' : avatarGlyph(user)}</div>
          </div>
          <div class="account-info">
            <div class="account-name">${escapeHtml(user.name || tr('profile_default_user'))}</div>
            ${user.email ? `<div class="account-email"><i class="fa-regular fa-envelope"></i><span>${escapeHtml(user.email)}</span></div>` : ''}
          </div>
          <div class="account-strip-chevron-wrap"><i class="fa-solid fa-chevron-right account-strip-chevron"></i></div>
        </button>
        <button class="account-logout-btn" id="statsLogoutBtn" aria-label="${tr('profile_logout')}"><i class="fa-solid fa-right-from-bracket"></i></button>
      </div>`;
  }
  return `
    <div class="stats-card auth-prompt-card">
      <div class="auth-prompt-icon"><i class="fa-solid fa-user-plus"></i></div>
      <div class="auth-prompt-text">${tr('profile_auth_prompt_text')}</div>
      <button class="auth-cta-btn" id="statsAuthBtn">${tr('profile_auth_prompt_btn')}</button>
    </div>`;
}

// ---------- Lifetime activity row ----------
function renderLifetimeActivity(activity, streak){
  const loggedIn = !!state.user;
  const ayahCount = loggedIn ? toBn(ayahsReadCount()) : '--';
  const timeSpent = loggedIn ? formatDurationBn(totalTimeSpentSeconds(activity)) : '--';
  const best = loggedIn ? toBn(Math.max(state.bestStreak || 0, streak)) : '--';
  return `
    <div class="section-title-sm">Lifetime Activity</div>
    <div class="lifetime-grid">
      <div class="lifetime-box">
        <i class="fa-solid fa-bolt"></i>
        <div class="lifetime-val">${ayahCount}</div>
        <div class="lifetime-label">আয়াত পাঠ</div>
      </div>
      <div class="lifetime-box">
        <i class="fa-regular fa-clock"></i>
        <div class="lifetime-val">${timeSpent}</div>
        <div class="lifetime-label">অতিবাহিত সময়</div>
      </div>
      <div class="lifetime-box">
        <i class="fa-solid fa-medal"></i>
        <div class="lifetime-val">${best}</div>
        <div class="lifetime-label">সেরা স্ট্রিক</div>
      </div>
    </div>
    ${loggedIn ? '' : '<div class="lifetime-login-hint">আপনার পরিসংখ্যান ট্র্যাক করতে লগ ইন করুন।</div>'}`;
}

// ---------- Mini "আজকের আয়াত" card for the stats page, with share/copy/refresh ----------
let statsAodState = null;
async function fetchAyahPair(s, a){
  const [arRes, bnRes] = await Promise.all([
    fetch(`${API}/ayah/${s}:${a}/quran-uthmani`).then(r => r.json()),
    fetch(`${API}/ayah/${s}:${a}/${state.translationEdition}`).then(r => r.json())
  ]);
  return {
    s, a,
    arabic: arRes && arRes.data ? arRes.data.text : '',
    bengali: bnRes && bnRes.data ? bnRes.data.text : ''
  };
}
function renderStatsAodCard(){
  const box = document.getElementById('statsAodBox');
  if(!box) return;
  if(!statsAodState){
    box.innerHTML = `<div class="aod-loading">loading...</div>`;
    return;
  }
  const surahName = surahNamesBn[statsAodState.s-1] || ('সূরা ' + statsAodState.s);
  box.innerHTML = `
    <div class="aod-arabic" style="font-size:18px;">${statsAodState.arabic || ''}</div>
    <div class="aod-bengali" style="color:var(--ink-soft);">${statsAodState.bengali || ''}</div>
    <div class="aod-ref">সূরা ${surahName} — আয়াত ${toBn(statsAodState.a)}</div>
    <div class="stats-aod-actions">
      <button id="statsAodShare" title="শেয়ার করুন"><i class="fa-solid fa-share"></i></button>
      <button id="statsAodCopy" title="কপি করুন"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
      <button id="statsAodRefresh" title="নতুন আয়াত"><i class="fa-solid fa-rotate-right"></i></button>
    </div>`;
  const shareText = () => `${statsAodState.arabic}\n\n${statsAodState.bengali}\n— সূরা ${surahName}, আয়াত ${toBn(statsAodState.a)}`;
  document.getElementById('statsAodShare').onclick = async () => {
    if(navigator.share){ try{ await navigator.share({ text: shareText() }); incrementShareCount(); }catch(e){} }
    else { try{ await navigator.clipboard.writeText(shareText()); showToast('Copied'); incrementShareCount(); }catch(e){} }
  };
  document.getElementById('statsAodCopy').onclick = () => openSurahAndScrollTo(statsAodState.s, statsAodState.a);
  document.getElementById('statsAodRefresh').onclick = () => loadStatsAod(true);
}
async function loadStatsAod(forceRandom){
  let s, a;
  if(forceRandom){
    const pick = AYAH_OF_DAY_POOL[Math.floor(Math.random() * AYAH_OF_DAY_POOL.length)];
    s = pick.s; a = pick.a;
  } else {
    const today = ayahOfTheDay();
    s = today.s; a = today.a;
  }
  statsAodState = null;
  renderStatsAodCard();
  try{
    statsAodState = await fetchAyahPair(s, a);
  }catch(e){
    const box = document.getElementById('statsAodBox');
    if(box) box.innerHTML = `<div class="aod-loading">Could not load, check internet connection.</div>`;
    return;
  }
  renderStatsAodCard();
}

// ---------- Time management: goal ring + weekly bars + monthly heatmap ----------
const HEATMAP_WEEKS = 10; // ~70 days, like a compact GitHub-style contribution graph
function buildHeatmapWeeks(activity){
  const today = new Date();
  const endDow = today.getDay();
  const gridEnd = new Date(today); gridEnd.setDate(today.getDate() + (6 - endDow)); // extend to end of this week (Sat)
  const totalDays = HEATMAP_WEEKS * 7;
  const gridStart = new Date(gridEnd); gridStart.setDate(gridEnd.getDate() - (totalDays - 1));
  const days = [];
  let maxMin = 1;
  for(let i=0;i<totalDays;i++){
    const d = new Date(gridStart); d.setDate(gridStart.getDate()+i);
    const key = d.toISOString().slice(0,10);
    const min = Math.floor((activity[key]||0)/60);
    if(min > maxMin) maxMin = min;
    days.push({ key, min, future: d > today });
  }
  const weeks = [];
  for(let w=0; w<HEATMAP_WEEKS; w++) weeks.push(days.slice(w*7, w*7+7));
  return { weeks, maxMin };
}
function heatmapLevel(min, maxMin){
  if(min <= 0) return 0;
  const ratio = min / maxMin;
  if(ratio > 0.75) return 4;
  if(ratio > 0.45) return 3;
  if(ratio > 0.15) return 2;
  return 1;
}
function renderTimeManagement(ctx){
  const { todayMin, streak, milestone, weekMinutes, maxWeekMin, weekTotalMin, dow, activity } = ctx;
  const goalPct = Math.min(100, Math.round((todayMin / DAILY_GOAL_MIN) * 100));
  const ringCirc = 2 * Math.PI * 30;
  const ringOffset = ringCirc - (goalPct/100) * ringCirc;
  const streakPct = Math.min(100, Math.round((streak / milestone) * 100));

  const { weeks, maxMin } = buildHeatmapWeeks(activity);
  const monthTotalMin = Object.keys(activity).filter(k => k.slice(0,7) === todayStr().slice(0,7))
    .reduce((s,k) => s + Math.floor((activity[k]||0)/60), 0);
  const activeDaysInHeatmap = weeks.flat().filter(d => !d.future && d.min > 0).length;
  const avgPerActiveDay = activeDaysInHeatmap ? Math.round((weeks.flat().reduce((s,d)=>s+(d.future?0:d.min),0)) / activeDaysInHeatmap) : 0;

  return `
    <div class="section-title-sm">Time spent with us</div>
    <div class="stats-card time-goal-card">
      <div class="time-goal-ring-wrap">
        <svg viewBox="0 0 70 70" width="86" height="86" class="time-goal-ring${todayMin>0?' active':''}">
          <circle cx="35" cy="35" r="30" class="ring-track"/>
          <circle cx="35" cy="35" r="30" class="ring-fill" stroke-dasharray="${ringCirc}" stroke-dashoffset="${ringOffset}"/>
        </svg>
        <div class="time-goal-ring-center"><i class="fa-solid fa-bolt"></i></div>
      </div>
      <div class="time-goal-text">
        <div class="stats-label">আজকে পড়ুন</div>
        <div class="stats-big">${toBn(todayMin)} min <span class="stats-goal">/ ${toBn(DAILY_GOAL_MIN)} min</span></div>
        <div class="stats-label" style="margin-top:12px;">বর্তমান স্ট্রিক</div>
        <div class="stats-big">${toBn(streak)} দিন</div>
      </div>
    </div>

    <div class="stats-card">
      <div class="stats-top-row" style="margin-bottom:2px;">
        <div class="stats-label">এই সপ্তাহ</div>
        <div class="stats-label">মোট ${toBn(weekTotalMin)} মিনিট </div>
      </div>
      <div class="week-chart">
        ${weekMinutes.map((m,i) => `
          <div class="week-col">
            <div class="week-bar-track"><div class="week-bar-fill" style="height:${Math.round((m/maxWeekMin)*70)}px"></div></div>
            <div class="week-day${i===dow?' today':''}">${WEEKDAY_LABELS_BN[i]}</div>
            <div class="week-min">${toBn(m)}m</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="stats-card">
      <div class="streak-range-row">
        <div><div class="stats-big-sm">${toBn(streak)}d</div><div class="stats-label">বর্তমান স্ট্রিক</div></div>
        <div style="text-align:right;"><div class="stats-big-sm">${toBn(milestone)}d</div><div class="stats-label">পরবর্তী লক্ষ্য</div></div>
      </div>
      <div class="planner-progress-bar" style="margin-top:8px;"><div class="planner-progress-fill" style="width:${streakPct}%"></div></div>
    </div>

    <div class="stats-card heatmap-card">
      <div class="stats-label" style="margin-bottom:10px;">গত ১০ সপ্তাহের কার্যকলাপ</div>
      <div class="heatmap-grid">
        ${weeks.map(week => `<div class="heatmap-col">${week.map(d => {
          if(d.future) return `<div class="heatmap-cell heatmap-future"></div>`;
          const lvl = heatmapLevel(d.min, maxMin);
          return `<div class="heatmap-cell heatmap-lv${lvl}" title="${d.key}: ${d.min}m"></div>`;
        }).join('')}</div>`).join('')}
      </div>
      <div class="heatmap-legend"><span>কম</span><span class="heatmap-cell heatmap-lv0"></span><span class="heatmap-cell heatmap-lv1"></span><span class="heatmap-cell heatmap-lv2"></span><span class="heatmap-cell heatmap-lv3"></span><span class="heatmap-cell heatmap-lv4"></span><span>বেশি</span></div>
      <div class="lifetime-grid" style="margin-top:14px;">
        <div class="lifetime-box">
          <i class="fa-solid fa-calendar-days"></i>
          <div class="lifetime-val">${toBn(monthTotalMin)}m</div>
          <div class="lifetime-label">এই মাসে</div>
        </div>
        <div class="lifetime-box">
          <i class="fa-solid fa-chart-line"></i>
          <div class="lifetime-val">${toBn(avgPerActiveDay)}m</div>
          <div class="lifetime-label">দৈনিক গড়</div>
        </div>
        <div class="lifetime-box">
          <i class="fa-solid fa-fire"></i>
          <div class="lifetime-val">${toBn(activeDaysInHeatmap)}</div>
          <div class="lifetime-label">সক্রিয় দিন</div>
        </div>
      </div>
    </div>
  `;
}

function renderStatsView(){
  const container = document.getElementById('statsContainer');
  const activity = loadActivity();
  const todaySec = activity[todayStr()] || 0;
  const todayMin = Math.floor(todaySec / 60);
  const streak = computeStreak(activity);
  const milestone = nextMilestone(streak);
  updateBestStreak(streak);

  // This week's per-day minutes (Sun..Sat)
  const now = new Date();
  const dow = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - dow);
  const weekMinutes = [];
  for(let i=0;i<7;i++){
    const d = new Date(weekStart); d.setDate(weekStart.getDate()+i);
    const key = d.toISOString().slice(0,10);
    weekMinutes.push(Math.floor((activity[key]||0)/60));
  }
  const maxWeekMin = Math.max(1, ...weekMinutes);
  weekFullyActiveSoFar = weekMinutes.slice(0, dow+1).every(m => m > 0);
  const weekTotalMin = weekMinutes.reduce((s,m) => s+m, 0);

  container.innerHTML = `
    ${renderAccountArea()}

    <div class="badges-head">
      <span>Badge</span>
      <a href="javascript:void(0)" id="statsSeeAllBadges">See all</a>
    </div>
    ${renderBadgesSummaryBar()}
    <div class="badges-grid">
      ${renderBadgesShowcase()}
    </div>

    <div class="section-title-sm">Today's verse</div>
    <div class="stats-card stats-aod-card" id="statsAodBox">
      <div class="aod-loading">loading...</div>
    </div>

    ${renderLifetimeActivity(activity, streak)}

    ${renderTimeManagement({ todayMin, streak, milestone, weekMinutes, maxWeekMin, weekTotalMin, dow, activity })}

    ${typeof renderTrendsSection === 'function' ? renderTrendsSection() : ''}

    ${typeof renderAudioStatsSection === 'function' ? renderAudioStatsSection() : ''}

    ${typeof renderSocialShareSection === 'function' ? renderSocialShareSection() : ''}
  `;

  document.getElementById('statsSeeAllBadges').onclick = openAllBadgesModal;
  const authBtn = document.getElementById('statsAuthBtn');
  // সাইন আপ/লগইন পপ-আপ হিসেবে না দেখিয়ে সরাসরি "প্রোফাইল" পেজে নিয়ে যায় (js/profile-view.js)।
  if(authBtn) authBtn.onclick = () => goToProfilePage('choice');
  const logoutBtn = document.getElementById('statsLogoutBtn');
  if(logoutBtn) logoutBtn.onclick = () => confirmLogout();
  const accountStripInfo = document.getElementById('statsAccountStripInfo');
  if(accountStripInfo) accountStripInfo.onclick = () => goToProfilePage();
  const shareBtn = document.getElementById('statsOpenShareCard');
  if(shareBtn) shareBtn.onclick = () => openShareCardModal();
  const streakShareBtn = document.getElementById('statsOpenStreakShareCard');
  if(streakShareBtn) streakShareBtn.onclick = () => openStreakShareCardModal(Math.max(state.bestStreak||0, streak, 1));
  loadStatsAod(false);
}

function initStats(){
  initReadingTimer();
  if(typeof initAudioStats === 'function') initAudioStats();
}
