// ---------- Static data & constants ----------
// NOTE: this file is loaded both as a normal <script> in index.html AND via
// importScripts() inside sw.js, so it must stay free of any `window`/`document`
// references — only plain constants and pure helper functions belong here.
const API = 'https://api.alquran.cloud/v1';
const AUDIO_CDN = 'https://cdn.islamic.network/quran/audio/128';
const PRAYER_API = 'https://api.aladhan.com/v1';

// ---------- Hadith books (see js/hadith.js) ----------
// Source: fawazahmed0/hadith-api (free, open, CDN-hosted via jsDelivr) — each
// of these 6 major collections has a maintained Bengali translation edition
// ("ben-<book>"). `info.json` on the same host gives the chapter/section
// names + hadith-number ranges for every book (kept in English there; we
// show that alongside the Bengali chapter number rather than hand-translate
// ~400 chapter titles, matching how most Bengali hadith sites label chapters).
const HADITH_API_BASE = 'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1';
const HADITH_BOOKS = [
  { id:'bukhari',  edition:'ben-bukhari',  nameBn:'সহীহ বুখারী',      nameEn:'Sahih al-Bukhari',    compilerBn:'ইমাম বুখারী (রহ.)',    total:7563 },
  { id:'muslim',   edition:'ben-muslim',   nameBn:'সহীহ মুসলিম',      nameEn:'Sahih Muslim',        compilerBn:'ইমাম মুসলিম (রহ.)',     total:7563 },
  { id:'abudawud', edition:'ben-abudawud', nameBn:'সুনানে আবু দাউদ',  nameEn:'Sunan Abu Dawud',     compilerBn:'ইমাম আবু দাউদ (রহ.)',   total:5274 },
  { id:'tirmidhi', edition:'ben-tirmidhi', nameBn:'জামে তিরমিযী',     nameEn:'Jami at-Tirmidhi',    compilerBn:'ইমাম তিরমিযী (রহ.)',    total:3956 },
  { id:'nasai',    edition:'ben-nasai',    nameBn:'সুনানে নাসাঈ',     nameEn:"Sunan an-Nasa'i",     compilerBn:'ইমাম নাসাঈ (রহ.)',      total:5761 },
  { id:'ibnmajah', edition:'ben-ibnmajah', nameBn:'সুনানে ইবনে মাজাহ', nameEn:'Sunan Ibn Majah',     compilerBn:'ইমাম ইবনে মাজাহ (রহ.)', total:4341 }
];
// Maps the (English) grading terms used across scholars in the API's
// `grades` array to short Bengali labels shown as a colored badge.
const HADITH_GRADE_BN = {
  'Sahih':'সহীহ', 'Hasan':'হাসান', 'Daif':'দ্বঈফ', "Da'if":'দ্বঈফ', 'Very Daif':'অতি দ্বঈফ',
  'Hasan Sahih':'হাসান সহীহ', 'Sahih Lighairihi':'সহীহ লিগাইরিহি', 'Hasan Lighairihi':'হাসান লিগাইরিহি',
  'Sahih Muquf':'সহীহ মাওকুফ', 'Sahih Maqtu':'সহীহ মাকতু', 'Isnaad Sahih':'সনদ সহীহ', 'Isnaad Hasan':'সনদ হাসান',
  'Mursal':'মুরসাল', 'Shadh':'শায', 'Munkar':'মুনকার', 'Daif Jiddan':'অতি দ্বঈফ'
};

// ---------- Theme gallery ----------
// Each theme is a full, self-consistent design (colors, corner shape, and a
// background glow), not just a light/dark recolor — see the matching
// body[data-theme="..."] block in css/base.css for the actual values.
// `dark` marks themes that sit on a dark base, which also adds the
// .theme-dark-accent class to body so a handful of accent colors switch to
// gold for contrast, same as the old dedicated "night mode" toggle did.
// `swatch` is 3 representative colors, used to draw the little preview
// strip on each card in the theme picker.
const THEMES = [
  { id:'emerald', nameKey:'theme_emerald', descKey:'theme_emerald_desc', dark:false, swatch:['#FBF6EC','#0E3B36','#C0973A'] },
  { id:'night',   nameKey:'theme_night',   descKey:'theme_night_desc',   dark:true,  swatch:['#0F1F1B','#123A34','#D9B45E'] },
  { id:'royal',   nameKey:'theme_royal',   descKey:'theme_royal_desc',   dark:true,  swatch:['#170F26','#3D2470','#E3B854'] },
  { id:'desert',  nameKey:'theme_desert',  descKey:'theme_desert_desc',  dark:false, swatch:['#FBF1E4','#B5581F','#C9932F'] },
  { id:'ocean',   nameKey:'theme_ocean',   descKey:'theme_ocean_desc',   dark:false, swatch:['#EEF6F8','#116E8C','#E0A94B'] },
  { id:'amoled',  nameKey:'theme_amoled',  descKey:'theme_amoled_desc',  dark:true,  swatch:['#000000','#101010','#E6B94D'] },
  { id:'rose',    nameKey:'theme_rose',    descKey:'theme_rose_desc',    dark:false, swatch:['#FDF3F5','#B5476B','#CDA15A'] }
];

// Bump the version suffix any time app-shell files change so the service
// worker picks up a fresh copy instead of serving a stale cached version.
const SW_VERSION = 'v1.03.03.01806';
const SHELL_CACHE_NAME = `qr-shell-${SW_VERSION}`;
const API_CACHE_NAME = `qr-api-${SW_VERSION}`;
const AUDIO_CACHE_NAME = `qr-audio-${SW_VERSION}`;
const FONT_CACHE_NAME = `qr-fonts-${SW_VERSION}`;

// ---------- Tiered offline precache ----------
// Only what's needed for the app to open, show the home screen, and read/
// listen to a surah goes into the install-time precache (APP_SHELL_CORE).
// Everything else (auth, theme builder, hadith, qibla, ramadan, stats,
// share-card, download manager, translation help, non-default UI
// languages, surah info/benefits, transliteration) is NOT force-downloaded
// on install — it's still fully cached for offline use the first time its
// own <script> tag is actually fetched, because sw.js's fetch handler
// already does cache-first for every same-origin request regardless of
// this list. Trimming this list only changes what's proactively downloaded
// before the listener has done anything, cutting the first-install payload
// by roughly the size of those deferred files.
const APP_SHELL_CORE = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/header.css',
  './css/layout.css',
  './css/reader.css',
  './css/search.css',
  './css/player.css',
  './css/app-shell.css',
  './css/planner.css',
  './css/topics.css',
  './css/library-stats.css',
  './css/bottom-nav.css',
  './css/drawer.css',
  './css/modals.css',
  './css/prayer.css',
  './css/dictionary.css',
  './css/help.css',
  './css/ayah-of-day.css',
  './css/notes.css',
  './css/ramadan.css',
  './css/auth.css',
  './css/tajweed.css',
  './css/qibla.css',
  './css/download-manager.css',
  './css/theme-builder.css',
  './css/hadith.css',
  './css/session-security.css',
  './css/ai-tafsir.css',
  './css/ai-tafsir-diagram.css',
  './js/data.js',
  './js/platform.js',
  './js/i18n/bn.js',
  './js/storage.js',
  './js/smart-storage.js',
  './js/idb.js',
  './js/firebase-config.js',
  './js/player.js',
  './js/reader.js',
  './js/sidebar.js',
  './js/search.js',
  './js/nav.js',
  './js/menu.js',
  './js/onboarding.js',
  './js/app.js',
  './js/ai-tafsir-diagram.js',
  './js/ai-tafsir.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Cached lazily on first real use instead of at install — see note above.
// (The Android app's own UI files under ./app/ are NOT listed here: a normal browser never needs them.
// In the app, js/platform.js loads them and app/js/boot.js asks this worker to cache them once the app has
// started, through the CACHE_ASSETS message handled in sw.js.)
const APP_SHELL_DEFERRED = [
  './js/surah-info.js',
  './js/surah-benefits.js',
  './js/i18n/en.js',
  './js/i18n/ar.js',
  './js/i18n/ur.js',
  './js/i18n/hi.js',
  './js/i18n/id.js',
  './js/i18n/tr.js',
  './js/i18n/fr.js',
  './js/i18n/es.js',
  './js/i18n/ru.js',
  './js/i18n/sw.js',
  './js/i18n/zh.js',
  './js/i18n/fa.js',
  './js/i18n/ms.js',
  './js/transliteration.js',
  './js/emailjs-config.js',
  './js/otp.js',
  './js/session-security.js',
  './js/auth.js',
  './js/reset-password.js',
  './js/push.js',
  './js/topics.js',
  './js/planner.js',
  './js/stats.js',
  './js/stats-trends.js',
  './js/audio-stats.js',
  './js/share-card.js',
  './js/ramadan.js',
  './js/tajweed.js',
  './js/qibla.js',
  './js/translation-help.js',
  './js/download-manager.js',
  './js/auto-offline.js',
  './js/theme-builder.js',
  './js/hadith.js',
  './js/donation-banner.js',
  // public pages (also opened from the Android app's About screen) + their shared contact config
  './privacy.html',
  './terms.html',
  './account-deletion.html',
  './css/legal.css',
  './js/legal.js',
  './app-config.js'
];

// sw.js installs APP_SHELL_CORE only. Kept as one combined list too, in case
// anything elsewhere still expects the full historical APP_SHELL_FILES name.
const APP_SHELL_FILES = APP_SHELL_CORE;

const bnDigits = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
function toBn(n){ return String(n).split('').map(d => /[0-9]/.test(d) ? bnDigits[+d] : d).join(''); }

// A curated pool used for the "Ayah of the Day" home card — one is picked
// deterministically per calendar day so it stays the same all day and
// changes at midnight.
const AYAH_OF_DAY_POOL = [
  {s:2,a:255}, {s:94,a:5}, {s:94,a:6}, {s:13,a:28}, {s:2,a:286},
  {s:65,a:3}, {s:3,a:159}, {s:39,a:53}, {s:2,a:152}, {s:16,a:97},
  {s:29,a:69}, {s:9,a:40}, {s:2,a:216}, {s:20,a:114}, {s:17,a:23},
  {s:31,a:14}, {s:49,a:13}, {s:59,a:22}, {s:59,a:23}, {s:59,a:24},
  {s:112,a:1}, {s:21,a:35}, {s:6,a:162}, {s:3,a:139}, {s:33,a:41},
  {s:8,a:2}, {s:24,a:35}, {s:4,a:1}, {s:30,a:21}, {s:41,a:34}
];
function ayahOfTheDay(){
  const d = new Date();
  const dayNum = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return AYAH_OF_DAY_POOL[dayNum % AYAH_OF_DAY_POOL.length];
}

const RAMADAN_DEFAULT_RAKAT_GOAL = 20;

const surahNamesBn = ["আল-ফাতিহা","আল-বাকারা","আলে ইমরান","আন-নিসা","আল-মায়িদা","আল-আনআম","আল-আরাফ","আল-আনফাল","আত-তাওবা","ইউনুস","হুদ","ইউসুফ","আর-রাদ","ইব্রাহীম","আল-হিজর","আন-নাহল","বনী ইসরাঈল (আল-ইসরা)","আল-কাহফ","মারইয়াম","ত্বা-হা","আল-আম্বিয়া","আল-হাজ্জ","আল-মুমিনূন","আন-নূর","আল-ফুরকান","আশ-শুআরা","আন-নামল","আল-কাসাস","আল-আনকাবূত","আর-রূম","লুকমান","আস-সাজদাহ","আল-আহযাব","সাবা","ফাতির","ইয়াসীন","আস-সাফফাত","সোয়াদ","আয-যুমার","গাফির","হা-মীম আস-সাজদাহ (ফুসসিলাত)","আশ-শূরা","আয-যুখরুফ","আদ-দুখান","আল-জাসিয়া","আল-আহকাফ","মুহাম্মাদ","আল-ফাতহ","আল-হুজুরাত","ক্বাফ","আয-যারিয়াত","আত-তূর","আন-নাজম","আল-ক্বামার","আর-রাহমান","আল-ওয়াকিয়া","আল-হাদীদ","আল-মুজাদালা","আল-হাশর","আল-মুমতাহিনা","আস-সফ","আল-জুমুআ","আল-মুনাফিকুন","আত-তাগাবুন","আত-তালাক","আত-তাহরীম","আল-মুলক","আল-কলম","আল-হাক্কাহ","আল-মাআরিজ","নূহ","আল-জ্বিন","আল-মুয্যাম্মিল","আল-মুদ্দাসসির","আল-কিয়ামাহ","আদ-দাহর (আল-ইনসান)","আল-মুরসালাত","আন-নাবা","আন-নাযিআত","আবাসা","আত-তাকভীর","আল-ইনফিতার","আল-মুতাফফিফীন","আল-ইনশিকাক","আল-বুরূজ","আত-তারিক","আল-আ'লা","আল-গাশিয়া","আল-ফজর","আল-বালাদ","আশ-শামস","আল-লাইল","আদ-দুহা","আশ-শারহ","আত-তীন","আল-আলাক","আল-ক্বদর","আল-বাইয়্যিনা","আয-যিলযাল","আল-আদিয়াত","আল-ক্বারিয়া","আত-তাকাসুর","আল-আসর","আল-হুমাযাহ","আল-ফীল","কুরাইশ","আল-মাউন","আল-কাওসার","আল-কাফিরুন","আন-নসর","আল-লাহাব","আল-ইখলাস","আল-ফালাক","আন-নাস"];




// প্রতিটি ক্বারীর জন্য বাংলা নাম, দেশ (পতাকা ইমোজি) ও তিলাওয়াতের ধরন — স্মার্ট
// ক্বারী-পিকারে দেখানোর জন্য (js/menu.js openReciterPicker দ্রষ্টব্য)। id গুলো
// অপরিবর্তিত রাখা হয়েছে যেন অডিও CDN লিংক (js/player.js currentAudioUrl) ভেঙে না যায়।
const reciters = [
  { id: 'ar.alafasy', name: 'Mishary Alafasy', bn: 'মিশারী রাশিদ আল-আফাসী', flag: '🇰🇼', style: 'মুরাত্তাল · সুমধুর ও পরিচিত কণ্ঠ' },
  { id: 'ar.husary', name: 'Mahmoud Khalil Al-Hussari', bn: 'মাহমুদ খলিল আল-হুসারী', flag: '🇪🇬', style: 'মুরাত্তাল · স্পষ্ট, ধীরস্থির তিলাওয়াত' },
  { id: 'ar.minshawi', name: 'Muhammad Minshawi', bn: 'মুহাম্মাদ সিদ্দিক আল-মিনশাবী', flag: '🇪🇬', style: 'মুরাত্তাল · আবেগঘন কণ্ঠ' },
  { id: 'ar.shaatree', name: 'Abu Bakr Ash-Shatri', bn: 'আবু বকর আশ-শাত্বরী', flag: '🇸🇦', style: 'মুরাত্তাল · প্রাণবন্ত সুর' },
  { id: 'ar.mahermuaiqly', name: 'Maher Al-Muaiqly', bn: 'মাহের আল-মুয়াইক্বিলী', flag: '🇸🇦', style: 'মুরাত্তাল · মক্কার ইমাম' },
  { id: 'ar.ahmedajamy', name: 'Ahmed Al-Ajamy', bn: 'আহমাদ বিন আলী আল-আজামী', flag: '🇸🇦', style: 'মুরাত্তাল · দ্রুতগতির তিলাওয়াত' },
  { id: 'ar.muhammadayyoub', name: 'Muhammad Ayyoub', bn: 'মুহাম্মাদ আইয়্যুব', flag: '🇸🇦', style: 'মুরাত্তাল · মদীনার ইমাম' },
  // ইয়াসির আল-দোসারী (Yasser Al Dosari): এই ক্বারীর তিলাওয়াত cdn.islamic.network-এ
  // আয়াত-ভিত্তিক (per-ayah) ফাইল আকারে নেই — শুধু সম্পূর্ণ সূরা আকারে (mp3quran.net
  // CDN-এ) পাওয়া যায়। তাই audioType:'surah' দিয়ে চিহ্নিত করা হয়েছে; buildAudioUrl()
  // (নিচে দেখুন) এই ফ্ল্যাগ অনুযায়ী পুরো সূরার mp3 লিংক বানায়, আয়াত-নম্বর অনুযায়ী নয়।
  {
    id: 'ar.yasseraldosari', name: 'Yasser Al Dosari', bn: 'ইয়াসির আল-দোসারী', flag: '🇸🇦',
    style: 'মুরাত্তাল · মক্কার হারামের ইমাম', audioType: 'surah', surahBase: 'https://server11.mp3quran.net/download/yasser'
  }
];

// একটি নির্দিষ্ট আয়াতের (বা, আয়াত-ভিত্তিক অডিও না থাকলে, পুরো সূরার) অডিও mp3
// লিংক বানানোর একক জায়গা — player.js ও js/download-manager.js দুটোই এখান থেকে
// URL নেয়, যাতে নতুন কোনো "সম্পূর্ণ-সূরা-শুধু" ক্বারী যোগ করলে দুই জায়গায় আলাদা
// করে কোড লিখতে না হয়।
function buildAudioUrl(reciterId, surahNum, globalNumber){
  const r = reciters.find(x => x.id === reciterId);
  if(r && r.audioType === 'surah'){
    return `${r.surahBase}/${String(surahNum).padStart(3,'0')}.mp3`;
  }
  return `${AUDIO_CDN}/${reciterId}/${globalNumber}.mp3`;
}


// ---------- Social / share links ----------
// TODO(Imran): এই লিংকগুলো আপনার আসল ওয়েবসাইট, ফেসবুক পেজ এবং ইউটিউব চ্যানেলের
// ঠিকানা দিয়ে পরিবর্তন করে নিন।
const SOCIAL_LINKS = {
  website: 'https://rupshajf.vercel.app',
  facebook: 'https://facebook.com/rupshajonokollanfoundation',
  youtube: 'https://youtube.com/@rupshajonokollanfoundation'
};

// ---------- Prayer time calculation methods (Aladhan API) ----------
const PRAYER_METHODS = [
  { id: 1,  name: 'ইউনিভার্সিটি অব ইসলামিক সায়েন্সেস, করাচি' },
  { id: 3,  name: 'Muslim World League' },
  { id: 2,  name: 'ISNA (উত্তর আমেরিকা)' },
  { id: 4,  name: 'উম্মুল কুরা, মক্কা' },
  { id: 5,  name: 'মিশরীয় সাধারণ জরিপ কর্তৃপক্ষ' },
  { id: 8,  name: 'উপসাগরীয় অঞ্চল' },
  { id: 13, name: 'দিয়ানেত, তুরস্ক' },
  { id: 20, name: 'কেমেনাগ, ইন্দোনেশিয়া' }
];

// ---------- Simple built-in Islamic / Qur'anic term dictionary ----------
// A lightweight glossary so common words met while reading can be looked up
// instantly, fully offline (plain data, no network call needed).
const DICTIONARY_DATA = [
  { term: 'আল্লাহ', meaning: 'সৃষ্টিকর্তা, একমাত্র উপাস্য; ইসলামে ব্যবহৃত সর্বোচ্চ নাম।' },
  { term: 'আয়াত', meaning: 'কুরআনের একটি বাক্য বা নিদর্শন; কুরআনের ক্ষুদ্রতম অংশবিশেষ।' },
  { term: 'সূরা', meaning: 'কুরআনের একটি অধ্যায়; মোট ১১৪টি সূরা রয়েছে।' },
  { term: 'পারা (জুয)', meaning: 'গোটা কুরআনকে সমান ৩০ ভাগে ভাগ করা প্রতিটি অংশ।' },
  { term: 'রুকু', meaning: 'সূরার মধ্যে একটি ছোট অনুচ্ছেদ বা বিভাজন, তিলাওয়াতে বিরতির জন্য ব্যবহৃত।' },
  { term: 'তিলাওয়াত', meaning: 'কুরআন সুন্দর সুরে ও নিয়ম মেনে পাঠ করা।' },
  { term: 'তাজবীদ', meaning: 'কুরআন সঠিক উচ্চারণ ও নিয়মে পড়ার বিজ্ঞান।' },
  { term: 'তাফসীর', meaning: 'কুরআনের আয়াতের বিস্তারিত ব্যাখ্যা ও বিশ্লেষণ।' },
  { term: 'হাদীস', meaning: 'রাসূলুল্লাহ (সা.)-এর কথা, কাজ ও অনুমোদন সম্পর্কিত বর্ণনা।' },
  { term: 'সুন্নাহ', meaning: 'রাসূলুল্লাহ (সা.)-এর দেখানো পথ ও জীবনাদর্শ।' },
  { term: 'সালাত (নামাজ)', meaning: 'দৈনিক পাঁচ ওয়াক্ত ফরজ ইবাদত।' },
  { term: 'ফজর', meaning: 'ভোরবেলার প্রথম নামাজের ওয়াক্ত, সুবহে সাদিক থেকে সূর্যোদয় পর্যন্ত।' },
  { term: 'যোহর', meaning: 'দুপুরের নামাজের ওয়াক্ত, সূর্য হেলে যাওয়ার পর শুরু হয়।' },
  { term: 'আসর', meaning: 'বিকেলের নামাজের ওয়াক্ত।' },
  { term: 'মাগরিব', meaning: 'সূর্যাস্তের পরপরই আদায় করা নামাজের ওয়াক্ত।' },
  { term: 'ইশা', meaning: 'রাতের নামাজের ওয়াক্ত।' },
  { term: 'কিবলা', meaning: 'নামাজে মুখ করার নির্দিষ্ট দিক, কাবা শরীফের দিক।' },
  { term: 'হিজরত', meaning: 'রাসূলুল্লাহ (সা.)-এর মক্কা থেকে মদীনায় স্থানান্তর; ইসলামি বর্ষপঞ্জির সূচনা বিন্দু।' },
  { term: 'হিজরী সন', meaning: 'চন্দ্র মাস অনুসারে গণনাকৃত ইসলামি বর্ষপঞ্জি।' },
  { term: 'রমজান', meaning: 'ইসলামি বর্ষপঞ্জির নবম মাস, যে মাসে সিয়াম পালন করা হয় ও কুরআন নাজিল হয়েছিল।' },
  { term: 'সিয়াম (রোজা)', meaning: 'ভোর থেকে সূর্যাস্ত পর্যন্ত পানাহার ও যাবতীয় নিষিদ্ধ কাজ থেকে বিরত থাকা।' },
  { term: 'যাকাত', meaning: 'নির্দিষ্ট পরিমাণ সম্পদের ওপর ফরজ বার্ষিক দান।' },
  { term: 'হজ্জ', meaning: 'সামর্থ্যবানদের জন্য জীবনে একবার মক্কায় গিয়ে নির্দিষ্ট নিয়মে পালনীয় ইবাদত।' },
  { term: 'উমরাহ', meaning: 'নির্দিষ্ট সময় ছাড়াই যেকোনো সময় করা যায় এমন ছোট হজ্জ।' },
  { term: 'দুআ', meaning: 'আল্লাহর কাছে প্রার্থনা বা মিনতি।' },
  { term: 'জিকির', meaning: 'আল্লাহর নাম বা প্রশংসাসূচক বাক্য বারবার স্মরণ করা।' },
  { term: 'তাওবা', meaning: 'গুনাহ থেকে অনুতপ্ত হয়ে আল্লাহর কাছে ফিরে আসা।' },
  { term: 'ইস্তিগফার', meaning: 'আল্লাহর কাছে ক্ষমা প্রার্থনা করা।' },
  { term: 'তাওহীদ', meaning: 'আল্লাহর একত্ববাদে বিশ্বাস; ইসলামের মূল ভিত্তি।' },
  { term: 'শিরক', meaning: 'আল্লাহর সাথে অন্য কিছুকে শরিক করা; সবচেয়ে বড় গুনাহ।' },
  { term: 'ইমান', meaning: 'আল্লাহ, ফেরেশতা, কিতাব, রাসূল, আখিরাত ও তাকদীরে বিশ্বাস।' },
  { term: 'ইসলাম', meaning: 'আল্লাহর ইচ্ছার কাছে আত্মসমর্পণ; শান্তির ধর্ম।' },
  { term: 'নবী', meaning: 'আল্লাহর পক্ষ থেকে ওহী প্রাপ্ত ব্যক্তি, যাকে নতুন শরিয়ত দেওয়া হয়নি।' },
  { term: 'রাসূল', meaning: 'আল্লাহর পক্ষ থেকে নতুন শরিয়তসহ প্রেরিত বার্তাবাহক।' },
  { term: 'ওহী', meaning: 'আল্লাহর পক্ষ থেকে নবী-রাসূলদের কাছে প্রেরিত বার্তা বা নির্দেশনা।' },
  { term: 'ফেরেশতা', meaning: 'নূর দ্বারা সৃষ্ট আল্লাহর একনিষ্ঠ অনুগত সৃষ্টি।' },
  { term: 'জিন', meaning: 'আগুন দ্বারা সৃষ্ট প্রাণী, যাদেরও ইবাদতের নির্দেশ দেওয়া হয়েছে।' },
  { term: 'আখিরাত', meaning: 'মৃত্যুর পরের অনন্ত জীবন।' },
  { term: 'জান্নাত', meaning: 'পরকালে মুমিনদের জন্য প্রতিশ্রুত চিরস্থায়ী শান্তির স্থান।' },
  { term: 'জাহান্নাম', meaning: 'পরকালে অবাধ্যদের জন্য নির্ধারিত শাস্তির স্থান।' },
  { term: 'কিয়ামত', meaning: 'সৃষ্টিজগৎ ধ্বংস হয়ে পুনরুত্থানের দিন।' },
  { term: 'মিজান', meaning: 'কিয়ামতের দিন প্রত্যেকের কাজ ওজন করার দাঁড়িপাল্লা।' },
  { term: 'সিরাত', meaning: 'জাহান্নামের ওপর স্থাপিত পুল, যা পার হয়ে জান্নাতে যেতে হবে।' },
  { term: 'বিসমিল্লাহ', meaning: '"আল্লাহর নামে" — যেকোনো ভালো কাজ শুরুর আগে বলা বাক্য।' },
  { term: 'আলহামদুলিল্লাহ', meaning: '"সমস্ত প্রশংসা আল্লাহর জন্য" — কৃতজ্ঞতা প্রকাশক বাক্য।' },
  { term: 'সুবহানাল্লাহ', meaning: '"আল্লাহ পবিত্র" — আল্লাহর মহিমা প্রকাশক বাক্য।' },
  { term: 'আল্লাহু আকবার', meaning: '"আল্লাহ সবচেয়ে বড়" — তাকবীর হিসেবে ব্যবহৃত হয়।' },
  { term: 'ইনশাআল্লাহ', meaning: '"আল্লাহ চাইলে" — ভবিষ্যতের কোনো কাজের কথা বলার সময় ব্যবহৃত হয়।' },
  { term: 'মাশাআল্লাহ', meaning: '"আল্লাহ যা চেয়েছেন তাই হয়েছে" — প্রশংসা বা বিস্ময় প্রকাশে ব্যবহৃত হয়।' },
  { term: 'জাযাকাল্লাহ', meaning: '"আল্লাহ আপনাকে উত্তম প্রতিদান দিন" — কৃতজ্ঞতা প্রকাশক বাক্য।' },
  { term: 'উম্মাহ', meaning: 'বিশ্বের সকল মুসলমানের সমষ্টিগত জাতি বা সম্প্রদায়।' },
  { term: 'মসজিদ', meaning: 'মুসলমানদের নামাজ ও ইবাদতের জন্য নির্ধারিত স্থান।' },
  { term: 'ইমাম', meaning: 'যিনি জামাতে নামাজের নেতৃত্ব দেন।' },
  { term: 'খুতবা', meaning: 'জুমা বা ঈদের নামাজের আগে দেওয়া বক্তৃতা।' },
  { term: 'তারাবীহ', meaning: 'রমজান মাসে ইশার নামাজের পর জামাতে পড়া অতিরিক্ত নামাজ।' },
  { term: 'ইতিকাফ', meaning: 'বিশেষত রমজানের শেষ দশকে মসজিদে অবস্থান করে ইবাদতে মগ্ন থাকা।' },
  { term: 'সাদাকা', meaning: 'স্বেচ্ছায় দেওয়া দান, যা ফরজ নয়।' },
  { term: 'হালাল', meaning: 'শরিয়তে বৈধ বা অনুমোদিত।' },
  { term: 'হারাম', meaning: 'শরিয়তে নিষিদ্ধ বা অবৈধ।' }
];

// ---------- UI translation dictionary ----------
// The actual per-language text lives in js/i18n/<code>.js (one small file per
// language, e.g. js/i18n/bn.js, js/i18n/en.js...), loaded via <script> tags
// in index.html right after this file. Each of those files just does
// `I18N.<code> = {...}`, populating the empty shell declared here.
//
// This split matters because sw.js loads this file (data.js) via
// importScripts() for its cache-name/app-shell constants, but the service
// worker itself never needs any UI text — so keeping ~260 lines of
// translated strings out of data.js keeps that importScripts() call (and
// therefore every service worker boot) lighter. js/menu.js still loops
// generically over whatever languages exist on this object, so adding a
// new language later is just: add js/i18n/xx.js + list it in index.html
// and APP_SHELL_FILES below.
const I18N = {};

// Shared translation lookup, usable anywhere in the app (not just the
// data-i18n DOM pass in applyLanguage). Same precedence as applyLanguage:
// a user's own contributed translation wins, then the active language's
// dictionary, then English as the last-resort fallback. Any module that
// builds HTML dynamically (profile modal, etc.) can call tr('some_key')
// and it will always reflect state.language at render time.
function tr(key){
  const dict = (typeof I18N !== 'undefined' && I18N[state.language]) || I18N.en;
  const custom = (state.customTranslations && state.customTranslations[state.language]) || {};
  if(custom[key] !== undefined) return custom[key];
  if(dict && dict[key] !== undefined) return dict[key];
  return (I18N.en && I18N.en[key] !== undefined) ? I18N.en[key] : key;
}

// Locale-aware digit formatting: Bengali numerals for the bn interface,
// plain Arabic numerals for every other language (matching what those
// languages' own users expect — Bengali is the one script this app
// renders in a non-Latin numeral system by default).
function localNum(n){
  return state.language === 'bn' ? toBn(n) : String(n);
}

// Interface-language picker metadata: controls the order/labels shown in the
// "Language" picker in Settings. `dir` marks languages written right-to-left.
const UI_LANG_META = [
  { code: 'bn', label: 'বাংলা' },
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'ur', label: 'اردو', dir: 'rtl' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'zh', label: '中文' },
  { code: 'fa', label: 'فارسی', dir: 'rtl' },
  { code: 'ms', label: 'Bahasa Melayu' }
];

// 2-letter language codes that are written right-to-left — used both for the
// interface language (UI_LANG_META above) and for whichever Qur'an
// translation edition the user picks (see loadTranslationEditions in
// js/reader.js), since a Sindhi or Pashto translation should render RTL too
// even though there's no full UI dictionary for it yet.
const RTL_LANG_CODES = ['ar','ur','fa','ps','he','sd','ckb','dv'];
