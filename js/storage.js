// ---------- Shared state ----------
const state = {
  mode: 'surah',
  surahList: [],
  fontStep: 0,
  bookmarks: {},
  reciter: 'ar.alafasy',
  lastRead: null,
  playlist: [],
  playIndex: -1,
  isPlaying: false,
  playbackRate: 1,
  repeatMode: 'off', // 'off' | 'ayah' (loop the current ayah) | 'surah' (loop the current surah)
  history: [],
  offlineSurahs: [],
  language: 'bn',
  translationEdition: 'bn.bengali', // Qur'an translation edition identifier (see js/reader.js loadTranslationEditions)
  translationEditions: [],          // up to 3 edition identifiers to show side-by-side (compare mode); empty = just translationEdition
  tajweedMode: false,               // approximate rule-based tajweed color highlighting (see js/tajweed.js)
  hafezMode: false,                 // হাফেজ মোড: শুধু আরবি, মুসহাফ-স্টাইল একটানা টেক্সট (see js/reader.js)
  transliterationMode: false,       // উচ্চারণ মোড: প্রতিটি আয়াতের নিচে বাংলা হরফে আনুমানিক উচ্চারণ (see js/transliteration.js)
  hifzReview: {},                   // হিফজ স্পেসড-রিপিটিশন: surahNum -> {stage, lastDone, nextDue}, LOCAL ONLY
  currentReaderView: null,          // last-opened {type, num}, used to reload in a newly picked translation language
  prayerMethod: 1,
  prayerNotify: false,
  prayerLocation: null,
  notes: {},
  searchCount: 0,
  ramadanMode: false,
  theme: 'emerald', // see THEMES in js/app.js for the full list + metadata
  taraweeh: { goal: RAMADAN_DEFAULT_RAKAT_GOAL, days: {} },
  // ---- Account / cloud-sync related (see js/auth.js) ----
  // NOTE ON PRIVACY OF SYNCED DATA: only aggregate progress numbers ever get
  // written to Firestore (see buildSyncSnapshot in js/auth.js) — never which
  // surahs/ayahs were read, bookmarks, notes, or reading history. Those stay
  // in localStorage on this device only.
  ayahsRead: {},              // map "surah:ayah" -> 1, LOCAL ONLY (device-side dedup)
  ayahsReadFloor: 0,          // highest ayahs-read COUNT seen from the cloud, no ayah identities
  audioSurahsPlayed: [],      // LOCAL ONLY (device-side dedup for the audio badge)
  audioSurahsPlayedFloor: 0,  // highest unique-surahs-played COUNT seen from the cloud
  bestStreak: 0,               // longest daily-reading streak ever reached, kept even if the
                                // current streak later resets to 0
  user: null,                   // set by auth.js on sign-in: { uid, name, email, position }

  // ---- Extra badge-tracking fields (aggregate-only, see js/stats.js BADGES) ----
  topicsExplored: [],          // LOCAL ONLY: unique topic ids opened, for "বিষয় অনুসন্ধানী"
  topicsExploredFloor: 0,      // highest unique-topics-explored COUNT seen from the cloud
  themesTried: [],             // unique theme ids ever applied
  languagesUsed: [],           // unique interface language codes ever selected
  qiblaUsed: false,            // ever opened + resolved the Qibla compass
  tajweedModeUsed: false,      // ever turned tajweed color-highlighting on
  hafezModeUsed: false,        // ever turned হাফেজ মোড on
  transliterationModeUsed: false, // ever turned উচ্চারণ (transliteration) mode on
  streakMilestonesCelebrated: [], // streak-milestone days already shown in the celebration modal (avoid repeats)
  translationCompareUsed: false, // ever compared 2+ translations side-by-side
  ramadanModeUsed: false,      // ever turned রমজান মোড on
  prayerNotifyEverEnabled: false, // ever successfully enabled prayer-time notifications
  nightOwlDone: false,         // ever recorded activity between 00:00–03:59
  earlyBirdDone: false,        // ever recorded activity between 04:00–06:59
  shareCount: 0,                // number of times the "আজকের আয়াত" share button was used

  // ---- Audio listening time (অডিও-সংক্রান্ত stats, see js/audio-stats.js) ----
  audioListenSeconds: {},       // map reciterId -> total seconds actually listened, LOCAL ONLY

  // ---- User-contributed UI translations (see js/translation-help.js) ----
  // map languageCode -> { i18nKey -> customText }, LOCAL ONLY. Applied on top
  // of the built-in I18N dictionaries by applyLanguage() in js/menu.js, so a
  // user can improve/replace any UI string for any language on their own device.
  customTranslations: {}
};

// ---------- localStorage persistence ----------
// All data (bookmarks, reciter choice, last-read position, listening history,
// downloaded-surah list) is kept in the browser's own localStorage, so it
// stays on the user's device between visits without needing any server or
// account, and remains fully readable offline.
const LS_KEYS = {
  bookmarks: 'qr_bookmarks',
  reciter: 'qr_reciter',
  lastRead: 'qr_last_read',
  history: 'qr_history',
  offlineSurahs: 'qr_offline_surahs',
  playbackRate: 'qr_playback_rate',
  repeatMode: 'qr_repeat_mode',
  language: 'qr_language',
  translationEdition: 'qr_translation_edition',
  translationEditions: 'qr_translation_editions_cache',
  translationEditionsSelected: 'qr_translation_editions_selected',
  tajweedMode: 'qr_tajweed_mode',
  hafezMode: 'qr_hafez_mode',
  transliterationMode: 'qr_translit_mode',
  transliterationModeUsed: 'qr_translit_used_ever',
  hifzReview: 'qr_hifz_review',
  streakMilestonesCelebrated: 'qr_streak_milestones_celebrated',
  prayerMethod: 'qr_prayer_method',
  prayerNotify: 'qr_prayer_notify',
  prayerLocation: 'qr_prayer_location',
  notes: 'qr_notes',
  searchCount: 'qr_search_count',
  audioSurahsPlayed: 'qr_audio_surahs_played',
  ramadanMode: 'qr_ramadan_mode',
  theme: 'qr_theme',
  taraweeh: 'qr_taraweeh',
  ayahsRead: 'qr_ayahs_read',
  ayahsReadFloor: 'qr_ayahs_read_floor',
  audioSurahsPlayedFloor: 'qr_audio_surahs_played_floor',
  bestStreak: 'qr_best_streak',
  topicsExplored: 'qr_topics_explored',
  topicsExploredFloor: 'qr_topics_explored_floor',
  themesTried: 'qr_themes_tried',
  languagesUsed: 'qr_languages_used',
  qiblaUsed: 'qr_qibla_used',
  tajweedModeUsed: 'qr_tajweed_used_ever',
  hafezModeUsed: 'qr_hafez_used_ever',
  translationCompareUsed: 'qr_compare_used_ever',
  ramadanModeUsed: 'qr_ramadan_used_ever',
  prayerNotifyEverEnabled: 'qr_prayer_notify_ever',
  nightOwlDone: 'qr_night_owl_done',
  earlyBirdDone: 'qr_early_bird_done',
  shareCount: 'qr_share_count',
  audioListenSeconds: 'qr_audio_listen_seconds',
  customTranslations: 'qr_custom_translations'
};

// Keep well above the "at least 10" requirement so older items don't get
// pushed out too quickly.
const HISTORY_MAX = 25;

function loadPrefs(){
  try{
    const raw = IDBKV.get(LS_KEYS.bookmarks);
    if(raw) state.bookmarks = JSON.parse(raw);
  }catch(e){ state.bookmarks = {}; }

  try{
    const r = IDBKV.get(LS_KEYS.reciter);
    if(r) state.reciter = r;
  }catch(e){}

  try{
    const raw = IDBKV.get(LS_KEYS.lastRead);
    if(raw) state.lastRead = JSON.parse(raw);
  }catch(e){ state.lastRead = null; }

  try{
    const raw = IDBKV.get(LS_KEYS.history);
    state.history = raw ? JSON.parse(raw) : [];
  }catch(e){ state.history = []; }

  try{
    const raw = IDBKV.get(LS_KEYS.offlineSurahs);
    state.offlineSurahs = raw ? JSON.parse(raw) : [];
    migrateOfflineSurahs();
  }catch(e){ state.offlineSurahs = []; }

  try{
    const r = parseFloat(IDBKV.get(LS_KEYS.playbackRate));
    if(r && r > 0) state.playbackRate = r;
  }catch(e){}

  try{
    const rm = IDBKV.get(LS_KEYS.repeatMode);
    if(rm === 'off' || rm === 'ayah' || rm === 'surah') state.repeatMode = rm;
  }catch(e){}

  try{
    const l = IDBKV.get(LS_KEYS.language);
    if(l && I18N[l]) state.language = l;
  }catch(e){}

  try{
    const t = IDBKV.get(LS_KEYS.translationEdition);
    if(t) state.translationEdition = t;
  }catch(e){}

  try{
    const raw = IDBKV.get(LS_KEYS.translationEditionsSelected);
    const parsed = raw ? JSON.parse(raw) : [];
    state.translationEditions = Array.isArray(parsed) ? parsed.slice(0,3) : [];
  }catch(e){ state.translationEditions = []; }

  try{
    state.tajweedMode = IDBKV.get(LS_KEYS.tajweedMode) === '1';
  }catch(e){ state.tajweedMode = false; }

  try{
    state.hafezMode = IDBKV.get(LS_KEYS.hafezMode) === '1';
  }catch(e){ state.hafezMode = false; }

  try{
    state.transliterationMode = IDBKV.get(LS_KEYS.transliterationMode) === '1';
  }catch(e){ state.transliterationMode = false; }

  try{
    state.transliterationModeUsed = IDBKV.get(LS_KEYS.transliterationModeUsed) === '1';
  }catch(e){ state.transliterationModeUsed = false; }

  try{
    const raw = IDBKV.get(LS_KEYS.hifzReview);
    state.hifzReview = raw ? JSON.parse(raw) : {};
    if(!state.hifzReview || typeof state.hifzReview !== 'object') state.hifzReview = {};
  }catch(e){ state.hifzReview = {}; }

  try{
    const raw = IDBKV.get(LS_KEYS.streakMilestonesCelebrated);
    state.streakMilestonesCelebrated = raw ? JSON.parse(raw) : [];
    if(!Array.isArray(state.streakMilestonesCelebrated)) state.streakMilestonesCelebrated = [];
  }catch(e){ state.streakMilestonesCelebrated = []; }

  try{
    const m = parseInt(IDBKV.get(LS_KEYS.prayerMethod), 10);
    if(Number.isInteger(m)) state.prayerMethod = m;
  }catch(e){}

  try{
    state.prayerNotify = IDBKV.get(LS_KEYS.prayerNotify) === '1';
  }catch(e){}

  try{
    const raw = IDBKV.get(LS_KEYS.prayerLocation);
    if(raw) state.prayerLocation = JSON.parse(raw);
  }catch(e){ state.prayerLocation = null; }

  try{
    const raw = IDBKV.get(LS_KEYS.notes);
    state.notes = raw ? JSON.parse(raw) : {};
  }catch(e){ state.notes = {}; }

  try{
    const n = parseInt(IDBKV.get(LS_KEYS.searchCount), 10);
    state.searchCount = Number.isInteger(n) && n > 0 ? n : 0;
  }catch(e){ state.searchCount = 0; }

  try{
    const raw = IDBKV.get(LS_KEYS.audioSurahsPlayed);
    state.audioSurahsPlayed = raw ? JSON.parse(raw) : [];
  }catch(e){ state.audioSurahsPlayed = []; }

  try{
    state.ramadanMode = IDBKV.get(LS_KEYS.ramadanMode) === '1';
  }catch(e){}

  try{
    const th = IDBKV.get(LS_KEYS.theme);
    if(th && THEMES.some(t => t.id === th)) state.theme = th;
  }catch(e){}

  try{
    const raw = IDBKV.get(LS_KEYS.taraweeh);
    state.taraweeh = raw ? JSON.parse(raw) : { goal: RAMADAN_DEFAULT_RAKAT_GOAL, days: {} };
    if(!state.taraweeh || typeof state.taraweeh !== 'object') state.taraweeh = { goal: RAMADAN_DEFAULT_RAKAT_GOAL, days: {} };
    if(!state.taraweeh.days) state.taraweeh.days = {};
    if(!state.taraweeh.goal) state.taraweeh.goal = RAMADAN_DEFAULT_RAKAT_GOAL;
  }catch(e){ state.taraweeh = { goal: RAMADAN_DEFAULT_RAKAT_GOAL, days: {} }; }

  try{
    const raw = IDBKV.get(LS_KEYS.ayahsRead);
    state.ayahsRead = raw ? JSON.parse(raw) : {};
    if(!state.ayahsRead || typeof state.ayahsRead !== 'object') state.ayahsRead = {};
  }catch(e){ state.ayahsRead = {}; }

  try{
    const n = parseInt(IDBKV.get(LS_KEYS.ayahsReadFloor), 10);
    state.ayahsReadFloor = Number.isInteger(n) && n > 0 ? n : 0;
  }catch(e){ state.ayahsReadFloor = 0; }

  try{
    const n = parseInt(IDBKV.get(LS_KEYS.audioSurahsPlayedFloor), 10);
    state.audioSurahsPlayedFloor = Number.isInteger(n) && n > 0 ? n : 0;
  }catch(e){ state.audioSurahsPlayedFloor = 0; }

  try{
    const n = parseInt(IDBKV.get(LS_KEYS.bestStreak), 10);
    state.bestStreak = Number.isInteger(n) && n > 0 ? n : 0;
  }catch(e){ state.bestStreak = 0; }

  try{
    const raw = IDBKV.get(LS_KEYS.topicsExplored);
    state.topicsExplored = raw ? JSON.parse(raw) : [];
  }catch(e){ state.topicsExplored = []; }

  try{
    const n = parseInt(IDBKV.get(LS_KEYS.topicsExploredFloor), 10);
    state.topicsExploredFloor = Number.isInteger(n) && n > 0 ? n : 0;
  }catch(e){ state.topicsExploredFloor = 0; }

  try{
    const raw = IDBKV.get(LS_KEYS.themesTried);
    state.themesTried = raw ? JSON.parse(raw) : [];
  }catch(e){ state.themesTried = []; }

  try{
    const raw = IDBKV.get(LS_KEYS.languagesUsed);
    state.languagesUsed = raw ? JSON.parse(raw) : [];
  }catch(e){ state.languagesUsed = []; }

  try{ state.qiblaUsed = IDBKV.get(LS_KEYS.qiblaUsed) === '1'; }catch(e){ state.qiblaUsed = false; }
  try{ state.tajweedModeUsed = IDBKV.get(LS_KEYS.tajweedModeUsed) === '1'; }catch(e){ state.tajweedModeUsed = false; }
  try{ state.hafezModeUsed = IDBKV.get(LS_KEYS.hafezModeUsed) === '1'; }catch(e){ state.hafezModeUsed = false; }
  try{ state.translationCompareUsed = IDBKV.get(LS_KEYS.translationCompareUsed) === '1'; }catch(e){ state.translationCompareUsed = false; }
  try{ state.ramadanModeUsed = IDBKV.get(LS_KEYS.ramadanModeUsed) === '1'; }catch(e){ state.ramadanModeUsed = false; }
  try{ state.prayerNotifyEverEnabled = IDBKV.get(LS_KEYS.prayerNotifyEverEnabled) === '1'; }catch(e){ state.prayerNotifyEverEnabled = false; }
  try{ state.nightOwlDone = IDBKV.get(LS_KEYS.nightOwlDone) === '1'; }catch(e){ state.nightOwlDone = false; }
  try{ state.earlyBirdDone = IDBKV.get(LS_KEYS.earlyBirdDone) === '1'; }catch(e){ state.earlyBirdDone = false; }

  try{
    const n = parseInt(IDBKV.get(LS_KEYS.shareCount), 10);
    state.shareCount = Number.isInteger(n) && n > 0 ? n : 0;
  }catch(e){ state.shareCount = 0; }

  try{
    const raw = IDBKV.get(LS_KEYS.audioListenSeconds);
    state.audioListenSeconds = raw ? JSON.parse(raw) : {};
    if(!state.audioListenSeconds || typeof state.audioListenSeconds !== 'object') state.audioListenSeconds = {};
  }catch(e){ state.audioListenSeconds = {}; }

  try{
    const raw = IDBKV.get(LS_KEYS.customTranslations);
    state.customTranslations = raw ? JSON.parse(raw) : {};
    if(!state.customTranslations || typeof state.customTranslations !== 'object') state.customTranslations = {};
  }catch(e){ state.customTranslations = {}; }
}

function saveLanguage(){
  try{ IDBKV.set(LS_KEYS.language, state.language); }catch(e){}
}
function saveTheme(){
  try{ IDBKV.set(LS_KEYS.theme, state.theme); }catch(e){}
}
function saveTranslationEdition(){
  try{ IDBKV.set(LS_KEYS.translationEdition, state.translationEdition); }catch(e){}
}
function saveTranslationEditionsSelected(){
  try{ IDBKV.set(LS_KEYS.translationEditionsSelected, JSON.stringify(state.translationEditions)); }catch(e){}
}
function saveTajweedMode(){
  try{ IDBKV.set(LS_KEYS.tajweedMode, state.tajweedMode ? '1' : '0'); }catch(e){}
}
function saveHafezMode(){
  try{ IDBKV.set(LS_KEYS.hafezMode, state.hafezMode ? '1' : '0'); }catch(e){}
}
function saveTransliterationMode(){
  try{ IDBKV.set(LS_KEYS.transliterationMode, state.transliterationMode ? '1' : '0'); }catch(e){}
}
function savePrayerMethod(){
  try{ IDBKV.set(LS_KEYS.prayerMethod, String(state.prayerMethod)); }catch(e){}
}
function savePrayerNotify(){
  try{ IDBKV.set(LS_KEYS.prayerNotify, state.prayerNotify ? '1' : '0'); }catch(e){}
}
function savePrayerLocation(){
  try{ IDBKV.set(LS_KEYS.prayerLocation, JSON.stringify(state.prayerLocation)); }catch(e){}
}
function saveCustomTranslations(){
  try{ IDBKV.set(LS_KEYS.customTranslations, JSON.stringify(state.customTranslations)); }catch(e){}
}

// ---------- Per-ayah notes ----------
function noteKey(surah, ayah){ return `${surah}:${ayah}`; }
function getNote(surah, ayah){ return state.notes[noteKey(surah, ayah)] || ''; }
function saveNote(surah, ayah, text){
  const key = noteKey(surah, ayah);
  const trimmed = (text || '').trim();
  if(trimmed) state.notes[key] = trimmed;
  else delete state.notes[key];
  try{ IDBKV.set(LS_KEYS.notes, JSON.stringify(state.notes)); }catch(e){}
}
function deleteNote(surah, ayah){ saveNote(surah, ayah, ''); }
function allNoteEntries(){
  return Object.keys(state.notes).map(key => {
    const [s, a] = key.split(':').map(Number);
    return { surah: s, ayah: a, text: state.notes[key] };
  });
}

// ---------- Search usage counter (used by the "Search Explorer" badge) ----------
function incrementSearchCount(){
  state.searchCount = (state.searchCount || 0) + 1;
  try{ IDBKV.set(LS_KEYS.searchCount, String(state.searchCount)); }catch(e){}
  queueCloudSync();
}

// ---------- Unique surahs listened to (used by the "Audio Explorer" badge) ----------
function trackAudioSurahPlayed(surahNum){
  if(!Number.isInteger(surahNum)) return;
  if(!state.audioSurahsPlayed.includes(surahNum)){
    state.audioSurahsPlayed.push(surahNum);
    try{ IDBKV.set(LS_KEYS.audioSurahsPlayed, JSON.stringify(state.audioSurahsPlayed)); }catch(e){}
    queueCloudSync();
  }
}

// ---------- Unique topics explored (used by the "বিষয় অনুসন্ধানী" badge) ----------
function trackTopicExplored(topicId){
  if(!topicId) return;
  if(!state.topicsExplored.includes(topicId)){
    state.topicsExplored.push(topicId);
    try{ IDBKV.set(LS_KEYS.topicsExplored, JSON.stringify(state.topicsExplored)); }catch(e){}
    queueCloudSync();
  }
}
function topicsExploredEffectiveCount(){
  return Math.max((state.topicsExplored||[]).length, state.topicsExploredFloor || 0);
}

// ---------- Unique themes / languages ever used (personalization badges) ----------
function trackThemeTried(themeId){
  if(!themeId) return;
  if(!state.themesTried.includes(themeId)){
    state.themesTried.push(themeId);
    try{ IDBKV.set(LS_KEYS.themesTried, JSON.stringify(state.themesTried)); }catch(e){}
    queueCloudSync();
  }
}
function trackLanguageUsed(lang){
  if(!lang) return;
  if(!state.languagesUsed.includes(lang)){
    state.languagesUsed.push(lang);
    try{ IDBKV.set(LS_KEYS.languagesUsed, JSON.stringify(state.languagesUsed)); }catch(e){}
    queueCloudSync();
  }
}

// ---------- Simple one-off "ever did this" flags (explorer badges) ----------
function markQiblaUsed(){
  if(state.qiblaUsed) return;
  state.qiblaUsed = true;
  try{ IDBKV.set(LS_KEYS.qiblaUsed, '1'); }catch(e){}
  queueCloudSync();
}
function markTajweedUsed(){
  if(state.tajweedModeUsed) return;
  state.tajweedModeUsed = true;
  try{ IDBKV.set(LS_KEYS.tajweedModeUsed, '1'); }catch(e){}
  queueCloudSync();
}
function markHafezUsed(){
  if(state.hafezModeUsed) return;
  state.hafezModeUsed = true;
  try{ IDBKV.set(LS_KEYS.hafezModeUsed, '1'); }catch(e){}
  queueCloudSync();
}
function markTransliterationUsed(){
  if(state.transliterationModeUsed) return;
  state.transliterationModeUsed = true;
  try{ IDBKV.set(LS_KEYS.transliterationModeUsed, '1'); }catch(e){}
  queueCloudSync();
}
function markCompareUsed(){
  if(state.translationCompareUsed) return;
  state.translationCompareUsed = true;
  try{ IDBKV.set(LS_KEYS.translationCompareUsed, '1'); }catch(e){}
  queueCloudSync();
}
function markRamadanModeUsed(){
  if(state.ramadanModeUsed) return;
  state.ramadanModeUsed = true;
  try{ IDBKV.set(LS_KEYS.ramadanModeUsed, '1'); }catch(e){}
  queueCloudSync();
}
function markPrayerNotifyEverEnabled(){
  if(state.prayerNotifyEverEnabled) return;
  state.prayerNotifyEverEnabled = true;
  try{ IDBKV.set(LS_KEYS.prayerNotifyEverEnabled, '1'); }catch(e){}
  queueCloudSync();
}

// ---------- Time-of-day badges: checked whenever activity is recorded ----------
function checkTimeOfDayBadges(){
  const hr = new Date().getHours();
  if(!state.nightOwlDone && hr >= 0 && hr < 4){
    state.nightOwlDone = true;
    try{ IDBKV.set(LS_KEYS.nightOwlDone, '1'); }catch(e){}
    queueCloudSync();
  }
  if(!state.earlyBirdDone && hr >= 4 && hr < 7){
    state.earlyBirdDone = true;
    try{ IDBKV.set(LS_KEYS.earlyBirdDone, '1'); }catch(e){}
    queueCloudSync();
  }
}

// ---------- "আজকের আয়াত" share counter (used by the "শেয়ারকারী" badge) ----------
function incrementShareCount(){
  state.shareCount = (state.shareCount || 0) + 1;
  try{ IDBKV.set(LS_KEYS.shareCount, String(state.shareCount)); }catch(e){}
  queueCloudSync();
}

// ---------- Distinct surahs actually read (dwell-tracked), for reading badges ----------
function surahsActuallyReadCount(){
  const set = new Set();
  Object.keys(state.ayahsRead || {}).forEach(k => {
    const s = parseInt(k.split(':')[0], 10);
    if(Number.isInteger(s)) set.add(s);
  });
  return set.size;
}

// ---------- Ramadan mode + Taraweeh tracker ----------
function saveRamadanMode(){
  try{ IDBKV.set(LS_KEYS.ramadanMode, state.ramadanMode ? '1' : '0'); }catch(e){}
}
function saveTaraweeh(){
  try{ IDBKV.set(LS_KEYS.taraweeh, JSON.stringify(state.taraweeh)); }catch(e){}
  queueCloudSync();
}
function setTaraweehDay(dayNum, rakats){
  const goal = state.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL;
  const clamped = Math.max(0, Math.min(goal, rakats));
  if(clamped <= 0) delete state.taraweeh.days[dayNum];
  else state.taraweeh.days[dayNum] = clamped;
  saveTaraweeh();
}

function saveBookmarks(){
  try{ IDBKV.set(LS_KEYS.bookmarks, JSON.stringify(state.bookmarks)); }catch(e){}
}
function saveReciter(){
  try{ IDBKV.set(LS_KEYS.reciter, state.reciter); }catch(e){}
}
function saveLastRead(){
  try{ IDBKV.set(LS_KEYS.lastRead, JSON.stringify(state.lastRead)); }catch(e){}
}
function savePlaybackRate(){
  try{ IDBKV.set(LS_KEYS.playbackRate, String(state.playbackRate)); }catch(e){}
}

function saveRepeatMode(){
  try{ IDBKV.set(LS_KEYS.repeatMode, state.repeatMode); }catch(e){}
}

// ---------- Listening history ----------
// Tracks the surahs the user has listened to (most recent first, de-duped by
// surah number) so at least the last several played surahs can be replayed
// instantly from local storage — no network needed to see or re-open them.
function addHistoryEntry(entry){
  state.history = state.history.filter(h => h.surah !== entry.surah);
  state.history.unshift(entry);
  if(state.history.length > HISTORY_MAX) state.history = state.history.slice(0, HISTORY_MAX);
  try{ IDBKV.set(LS_KEYS.history, JSON.stringify(state.history)); }catch(e){}
}

// ---------- Offline-downloaded surah tracking ----------
// Each entry: { surah, reciter, urls, ayahCount, ts }. `urls` is kept so a
// download can later be removed cleanly from Cache Storage. Older versions
// of this app stored offlineSurahs as a plain array of numbers — migrate
// those transparently to the new object shape (with no urls, so removal
// just clears the tracking entry, not the cache; harmless).
function migrateOfflineSurahs(){
  if(!Array.isArray(state.offlineSurahs)){ state.offlineSurahs = []; return; }
  const cleaned = state.offlineSurahs
    .map(o => typeof o === 'number' ? { surah:o, reciter:null, urls:[], ayahCount:null, ts:Date.now() } : o)
    .filter(o => o && Number.isInteger(o.surah) && o.surah >= 1 && o.surah <= 114)
    .map(o => ({
      surah: o.surah,
      reciter: (typeof o.reciter === 'string' && o.reciter) ? o.reciter : null,
      urls: Array.isArray(o.urls) ? o.urls : [],
      ayahCount: (typeof o.ayahCount === 'number' && o.ayahCount > 0) ? o.ayahCount : null,
      ts: (typeof o.ts === 'number' && isFinite(o.ts)) ? o.ts : Date.now()
    }));
  state.offlineSurahs = cleaned;
  // Persist the sanitized shape immediately so this cleanup only has to run
  // once — any leftover/broken entries from earlier testing won't keep
  // reappearing on every load.
  try{ IDBKV.set(LS_KEYS.offlineSurahs, JSON.stringify(state.offlineSurahs)); }catch(e){}
}
function findOfflineEntry(surahNum){
  return state.offlineSurahs.find(o => o.surah === surahNum);
}
function markSurahOffline(surahNum, reciter, urls, ayahCount){
  if(!Number.isInteger(surahNum) || surahNum < 1 || surahNum > 114) return;
  state.offlineSurahs = state.offlineSurahs.filter(o => o.surah !== surahNum);
  state.offlineSurahs.push({ surah: surahNum, reciter: reciter || null, urls: urls || [], ayahCount: ayahCount || null, ts: Date.now() });
  try{ IDBKV.set(LS_KEYS.offlineSurahs, JSON.stringify(state.offlineSurahs)); }catch(e){}
}
function isSurahOffline(surahNum){
  return state.offlineSurahs.some(o => o.surah === surahNum);
}
async function removeSurahOffline(surahNum){
  const entry = findOfflineEntry(surahNum);
  if(entry && entry.urls && entry.urls.length && 'caches' in window){
    try{
      const cache = await caches.open(AUDIO_CACHE_NAME);
      await Promise.all(entry.urls.map(u => cache.delete(u)));
    }catch(e){ /* cache may already be gone; tracking entry is removed regardless */ }
  }
  state.offlineSurahs = state.offlineSurahs.filter(o => o.surah !== surahNum);
  try{ IDBKV.set(LS_KEYS.offlineSurahs, JSON.stringify(state.offlineSurahs)); }catch(e){}
}

// ---------- Unique ayahs actually read (used by the "আয়াত পাঠ" lifetime stat) ----------
// Marked by an on-screen dwell-time check in js/reader.js (see initAyahReadTracking),
// so opening a surah alone doesn't count every ayah in it as "read".
function markAyahRead(key){
  if(!key || state.ayahsRead[key]) return;
  state.ayahsRead[key] = 1;
  try{ IDBKV.set(LS_KEYS.ayahsRead, JSON.stringify(state.ayahsRead)); }catch(e){}
  queueCloudSync();
  // Per-day breakdown for trend/monthly stats lives in js/stats-trends.js,
  // loaded later — guarded so this file never hard-depends on it.
  if(typeof recordAyahReadToday === 'function') recordAyahReadToday();
}
function ayahsReadCount(){
  return Math.max(Object.keys(state.ayahsRead || {}).length, state.ayahsReadFloor || 0);
}

// ---------- Per-reciter audio listening time (used by js/audio-stats.js) ----------
// Accumulated in small real-time deltas while audio is actually playing (not
// just "opened") — see initAudioListenTracking(). Persisted in a throttled
// way from that file; this is just the read side + the raw save helper.
function saveAudioListenSeconds(){
  try{ IDBKV.set(LS_KEYS.audioListenSeconds, JSON.stringify(state.audioListenSeconds)); }catch(e){}
}
function audioListenSecondsTotal(){
  return Object.values(state.audioListenSeconds || {}).reduce((s,v) => s + (v || 0), 0);
}
function topReciterByListenTime(){
  const entries = Object.entries(state.audioListenSeconds || {}).filter(([,v]) => v > 0);
  if(!entries.length) return null;
  entries.sort((a,b) => b[1] - a[1]);
  return entries.map(([id, seconds]) => ({ id, seconds }));
}

// ---------- Best (longest-ever) streak, kept separately so it survives streak resets ----------
function updateBestStreak(currentStreak){
  if(currentStreak > (state.bestStreak || 0)){
    state.bestStreak = currentStreak;
    try{ IDBKV.set(LS_KEYS.bestStreak, String(state.bestStreak)); }catch(e){}
    queueCloudSync();
  }
  // ঠিক একটি মাইলফলক (৩,৭,১৪,৩০...) দিনে স্পর্শ করলে — প্রতি মাইলফলকে
  // মাত্র একবারই — একটি শেয়ারযোগ্য "স্ট্রিক ব্যাজ" সেলিব্রেশন দেখানো হয়
  // (দেখুন js/share-card.js celebrateStreakMilestone)।
  if(typeof STREAK_MILESTONES !== 'undefined' && STREAK_MILESTONES.includes(currentStreak)){
    if(!state.streakMilestonesCelebrated.includes(currentStreak)){
      state.streakMilestonesCelebrated.push(currentStreak);
      try{ IDBKV.set(LS_KEYS.streakMilestonesCelebrated, JSON.stringify(state.streakMilestonesCelebrated)); }catch(e){}
      if(typeof celebrateStreakMilestone === 'function') celebrateStreakMilestone(currentStreak);
    }
  }
}

// ---------- হিফজ স্পেসড-রিপিটিশন রিভিউ (memorization review scheduler) ----------
// হাফেজ মোডে "মুখস্থ যাচাই" করার পর ইউজার একটি সূরার রিভিউ "সম্পন্ন" হিসেবে
// চিহ্নিত করলে, ধীরে ধীরে বাড়তে থাকা ব্যবধানে (১, ৩, ৭, ১৪, ৩০, ৬০ দিন)
// পরবর্তী রিভিউ শিডিউল হয় — classic spaced-repetition curve। সম্পূর্ণ
// ডিভাইস-লোকাল (কোন সূরা মুখস্থ করা হচ্ছে তা ক্লাউডে যায় না, অন্যান্য
// per-surah ডেটার মতোই — দেখুন state.notes/state.bookmarks এর প্রাইভেসি নোট)।
const HIFZ_REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];
function logHifzReview(surahNum){
  if(!Number.isInteger(surahNum)) return;
  const prev = state.hifzReview[surahNum] || { stage: 0 };
  const stage = Math.min(prev.stage || 0, HIFZ_REVIEW_INTERVALS_DAYS.length - 1);
  const days = HIFZ_REVIEW_INTERVALS_DAYS[stage];
  const next = new Date();
  next.setDate(next.getDate() + days);
  state.hifzReview[surahNum] = {
    stage: Math.min((prev.stage || 0) + 1, HIFZ_REVIEW_INTERVALS_DAYS.length - 1),
    lastDone: todayStr(),
    nextDue: next.toISOString().slice(0, 10)
  };
  try{ IDBKV.set(LS_KEYS.hifzReview, JSON.stringify(state.hifzReview)); }catch(e){}
  return days;
}
function hifzSurahsDueToday(){
  const today = todayStr();
  return Object.keys(state.hifzReview || {})
    .map(Number)
    .filter(s => {
      const r = state.hifzReview[s];
      return r && r.nextDue && r.nextDue <= today;
    })
    .sort((a, b) => a - b);
}

// ---------- Cloud sync hook ----------
// js/auth.js defines the real queueCloudSync() (debounced Firestore write) once a
// user is signed in. Before that script runs, or while signed out, this is a
// harmless no-op so every save*()/mark*() call above can call it unconditionally.
function queueCloudSync(){}

// ---------- Relative time in Bengali, for the history list ----------
function timeAgoBn(ts){
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if(diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if(diffMin < 60) return `${toBn(diffMin)} Minutes ago`;
  const diffHr = Math.floor(diffMin / 60);
  if(diffHr < 24) return `${toBn(diffHr)} Hours ago`;
  const diffDay = Math.floor(diffHr / 24);
  if(diffDay < 30) return `${toBn(diffDay)} Days ago`;
  const diffMon = Math.floor(diffDay / 30);
  return `${toBn(diffMon)} Month ago`;
}
