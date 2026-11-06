// ---------- App-wide walkthrough (premium coach-mark onboarding) ----------
// Highlights real UI elements with a glowing spotlight + glass tooltip card.
// EVERY major section of the app gets its own short recap the first time
// the user visits it — bottom-nav views, the drawer, the reader toolbar,
// the audio player, and every modal (settings, prayer times, qibla,
// dictionary, downloads, translation help, taraweeh). Each section
// remembers separately whether it's been shown (localStorage), so a user
// only ever sees a given recap once, whenever they first get there.

const ONBOARDING_SEEN_PREFIX = 'qb_onb_seen_';

const ONBOARDING_TOURS = {

  // ---- First launch: whole-app overview (home view) ----
  home: [
    { target: null, icon: 'fa-hand-sparkles', title: 'স্বাগতম! 😊', text: 'কুরআন বাংলা অ্যাপে আপনাকে স্বাগতম। অ্যাপের মূল ফিচারগুলো এক নজরে দেখে নিন' },
    { target: '#menuBtn', icon: 'fa-bars', title: 'মেনু বাটন', text: 'এখানে ট্যাপ করলে সালাতের সময়সূচি, কিবলা, তারাবীহ ট্র্যাকার, অভিধান, ডাউনলোড ম্যানেজার ও সেটিংসসহ আরও অনেক ফিচার পাবেন।' },
    { target: '#searchInput', icon: 'fa-magnifying-glass', title: 'আয়াত খুঁজুন', text: 'বাংলা বা আরবি যেকোনো ভাষায় লিখে সরাসরি আয়াত খুঁজে বের করতে পারবেন।' },
    { target: '#themeBtn', icon: 'fa-palette', title: 'থিম পরিবর্তন', text: 'অ্যাপের রঙ ও লুক আপনার পছন্দমতো বদলে নিতে এখানে চাপুন — একাধিক সুন্দর থিম থেকে বেছে নিতে পারবেন।' },
    { target: '#ayahOfDayCard', icon: 'fa-sun', title: 'আজকের আয়াত', text: 'প্রতিদিন একটি নতুন আয়াত এখানে দেখতে পাবেন — অ্যাপ খুললেই একটু হলেও কুরআন পড়া হয়ে যাবে।' },
    { target: '#homeSubtabs', icon: 'fa-book-open', title: 'পড়ার ধরন বেছে নিন', text: 'সূরা, পৃষ্ঠা, পারা, হিজব বা রুকু অনুযায়ী — যেভাবে ইচ্ছা কুরআন পড়তে পারবেন এখান থেকে।' },
    { target: '.bn-item[data-view="home"]', icon: 'fa-house', title: 'হোম', text: 'কুরআন পড়া শুরু করার মূল পাতা — সবসময় এখান থেকেই শুরু করবেন।' },
    { target: '.bn-item[data-view="planner"]', icon: 'fa-calendar-check', title: 'প্ল্যানার', text: 'কুরআন খতম বা পড়ার একটা রুটিন প্ল্যান বানিয়ে নিজের অগ্রগতি ট্র্যাক করতে পারবেন। এখানে গেলে বিস্তারিত দেখাবো।' },
    { target: '.bn-item[data-view="topics"]', icon: 'fa-layer-group', title: 'বিষয়ভিত্তিক', text: 'নির্দিষ্ট একটি বিষয় (যেমন: ধৈর্য, তাওবা) নিয়ে কুরআনের সংশ্লিষ্ট আয়াতগুলো একসাথে পড়তে পারবেন।' },
    { target: '.bn-item[data-view="library"]', icon: 'fa-bookmark', title: 'লাইব্রেরি', text: 'আপনার সংরক্ষিত আয়াত, নোট, পড়ার ইতিহাস এবং অফলাইন ডাউনলোড করা সূরাগুলো এখানে পাবেন।' },
    { target: '.bn-item[data-view="hadith"]', icon: 'fa-scroll', title: 'হাদিস', text: 'বিভিন্ন হাদিস গ্রন্থ থেকে অধ্যায় ও বই অনুযায়ী হাদিস পড়তে পারবেন।' },
    { target: '.bn-item[data-view="stats"]', icon: 'fa-chart-line', title: 'পরিসংখ্যান', text: 'আপনার পড়ার ধারাবাহিকতা (স্ট্রিক), মোট পঠিত আয়াত ও অন্যান্য পরিসংখ্যান দেখতে পাবেন।' },
    { target: null, icon: 'fa-circle-check', title: 'প্রস্তুত! 🎉', text: 'এখন থেকে যে অংশেই প্রথমবার যাবেন, সেই অংশে কী কী আছে তা নিজে থেকেই সংক্ষেপে দেখিয়ে দেওয়া হবে। এই মূল গাইডটি আবার দেখতে মেনু ➜ "অ্যাপ পরিচিতি"-তে যান।', celebrate: true }
  ],

  // ---- Planner view: first visit ----
  planner: [
    { target: '#plTabMine', icon: 'fa-user', title: 'আমার প্ল্যানার', text: 'আপনার নিজের তৈরি করা রিডিং প্ল্যান ও তার অগ্রগতি এখানে দেখা যাবে।' },
    { target: '#plTabFind', icon: 'fa-magnifying-glass', title: 'প্ল্যানার খুঁজুন', text: 'রেডিমেড বা কমিউনিটির তৈরি প্ল্যান খুঁজে নিজের প্ল্যানারে যুক্ত করতে পারবেন।' },
    { target: '#plTabDone', icon: 'fa-circle-check', title: 'সম্পন্ন হয়েছে', text: 'যেসব প্ল্যান আপনি সম্পূর্ণ শেষ করেছেন, সেগুলোর তালিকা এখানে জমা থাকবে।' }
  ],

  // ---- Topics view: first visit ----
  topics: [
    { target: '#topicsListContainer', icon: 'fa-layer-group', title: 'বিষয়ভিত্তিক আয়াত', text: 'কোনো একটি বিষয় (যেমন: সবর, শোকর, তাওবা) ট্যাপ করলে সেই বিষয়ে কুরআনের সংশ্লিষ্ট সব আয়াত একসাথে দেখতে পাবেন।' }
  ],

  // ---- Library view: first visit ----
  library: [
    { target: '#libTabBookmarks', icon: 'fa-bookmark', title: 'বুকমার্ক', text: 'আপনার বুকমার্ক করা আয়াতগুলো এখানে জমা থাকবে।' },
    { target: '#libTabNotes', icon: 'fa-note-sticky', title: 'নোট', text: 'যেকোনো আয়াতে লেখা আপনার ব্যক্তিগত নোটগুলো এখানে পাবেন।' },
    { target: '#libTabHistory', icon: 'fa-clock-rotate-left', title: 'ইতিহাস', text: 'আপনি সম্প্রতি কোন কোন সূরা/আয়াত পড়েছেন, তার ইতিহাস এখানে দেখা যাবে।' },
    { target: '#libTabOffline', icon: 'fa-cloud-arrow-down', title: 'অফলাইন', text: 'অফলাইনে পড়ার জন্য ডাউনলোড করা সূরাগুলো এখানে ব্যবস্থাপনা করতে পারবেন।' }
  ],

  // ---- Hadith view: first visit ----
  hadith: [
    { target: '#hadithBooksContainer', icon: 'fa-scroll', title: 'হাদিস গ্রন্থ', text: 'পছন্দের হাদিস গ্রন্থ বেছে নিন — এরপর অধ্যায় ধরে ধরে হাদিস পড়তে পারবেন।' }
  ],

  // ---- Stats view: first visit ----
  stats: [
    { target: '#statsContainer', icon: 'fa-chart-line', title: 'পরিসংখ্যান', text: 'আপনার দৈনিক পড়ার ধারাবাহিকতা (স্ট্রিক), মোট পঠিত আয়াত, শোনা অডিও ও আরও অনেক পরিসংখ্যান এখানে একসাথে দেখতে পাবেন।' }
  ],

  // ---- Hamburger drawer: first time opened ----
  drawer: [
    { target: '#drawerSearchInput', icon: 'fa-magnifying-glass', title: 'মেনু সার্চ', text: 'নিচের সবগুলো ফিচারের মধ্যে থেকে দ্রুত খুঁজে নিতে এখানে লিখুন।' },
    { target: '#drawerGoToAyah', icon: 'fa-location-arrow', title: 'নির্দিষ্ট আয়াতে যান', text: 'সূরা:আয়াত নম্বর লিখে (যেমন 2:255) সরাসরি সেই আয়াতে চলে যেতে পারবেন।' },
    { target: '#drawerPrayerTimes', icon: 'fa-clock', title: 'সালাতের সময়সূচি', text: 'আপনার এলাকার ভিত্তিতে পাঁচ ওয়াক্ত সালাতের সময় দেখতে পাবেন।' },
    { target: '#drawerQibla', icon: 'fa-compass', title: 'কিবলার দিক', text: 'কম্পাসের মাধ্যমে কাবার সঠিক দিক নির্ণয় করতে পারবেন।' },
    { target: '#drawerTaraweeh', icon: 'fa-moon', title: 'তারাবীহ ট্র্যাকার', text: 'রমজান মাসে প্রতিদিনের তারাবীহর রাকাত হিসাব রাখতে পারবেন।' },
    { target: '#drawerDictionary', icon: 'fa-book', title: 'অভিধান', text: 'ইসলামী পরিভাষার অর্থ খুঁজে জানতে পারবেন।' },
    { target: '#drawerDownloads', icon: 'fa-cloud-arrow-down', title: 'ডাউনলোড ম্যানেজার', text: 'অফলাইনে শোনার জন্য সূরার অডিও ডাউনলোড করে ব্যবস্থাপনা করতে পারবেন।' },
    { target: '#drawerSettings', icon: 'fa-gear', title: 'সেটিংস', text: 'ভাষা, অনুবাদ, ক্বারী, থিম, ফন্ট সাইজ ও আরও অনেক কিছু এখান থেকে কাস্টমাইজ করতে পারবেন।' },
    { target: '#drawerTranslationHelp', icon: 'fa-language', title: 'অনুবাদে সহায়তা', text: 'নিজের ভাষায় অনুবাদে অবদান রাখতে চাইলে এখান থেকে শুরু করতে পারবেন।' },
    { target: '#drawerShare', icon: 'fa-share-nodes', title: 'শেয়ার করুন', text: 'অ্যাপটি পরিবার বা বন্ধুদের সাথে শেয়ার করতে এখানে চাপুন।' },
    { target: '#drawerHelp', icon: 'fa-circle-question', title: 'সাহায্য ও সহযোগিতা', text: 'সচরাচর জিজ্ঞাসিত প্রশ্ন ও যোগাযোগের তথ্য এখানে পাবেন।' }
  ],

  // ---- Reader toolbar: first time a surah/page is opened ----
  reader: [
    { target: '#readerBackBtn', icon: 'fa-arrow-left', title: 'ফিরে যান', text: 'পড়া শেষে এখানে চাপলে আগের তালিকায় ফিরে যাবেন।' },
    { target: '#hafezModeBtn', icon: 'fa-book-quran', title: 'হাফেজ মোড', text: 'শুধু আরবি টেক্সট, মুসহাফের মতো স্টাইলে পড়তে চাইলে এটি চালু করুন।' },
    { target: '#translitModeBtn', icon: 'fa-font', title: 'উচ্চারণ মোড', text: 'প্রতিটি আয়াতের নিচে বাংলা হরফে আরবি উচ্চারণ দেখতে এটি ব্যবহার করুন।' },
    { target: '#incFont', icon: 'fa-text-height', title: 'ফন্ট সাইজ', text: 'অ+ ও অ− বাটন দিয়ে পড়ার সুবিধার্থে লেখার আকার ছোট-বড় করতে পারবেন।' }
  ],

  // ---- Audio player bar: first time audio starts ----
  player: [
    { target: '#playPauseBtn', icon: 'fa-play', title: 'প্লে / পজ', text: 'তিলাওয়াত চালু বা থামাতে এখানে চাপুন।' },
    { target: '#reciterFieldBtn', icon: 'fa-user', title: 'ক্বারী পরিবর্তন', text: 'পছন্দের ক্বারী বেছে নিতে এখানে চাপুন।' },
    { target: '#speedBtn', icon: 'fa-gauge-high', title: 'প্লেব্যাক স্পিড', text: 'তিলাওয়াতের গতি কমাতে বা বাড়াতে এখানে চাপুন।' },
    { target: '#seekBar', icon: 'fa-sliders', title: 'সময় নিয়ন্ত্রণ', text: 'টেনে তিলাওয়াতের যেকোনো অংশে চলে যেতে পারবেন।' },
    { target: '#playerClose', icon: 'fa-xmark', title: 'প্লেয়ার বন্ধ করুন', text: 'তিলাওয়াত সম্পূর্ণ বন্ধ করতে এখানে চাপুন।' }
  ],

  // ---- Settings modal: first time opened ----
  settings: [
    { target: '.settings-cat-item[data-cat="lang"]', icon: 'fa-language', title: 'ভাষা ও অনুবাদ', text: 'অ্যাপের ভাষা এবং কুরআনের অনুবাদ পরিবর্তন করতে পারবেন।' },
    { target: '.settings-cat-item[data-cat="recite"]', icon: 'fa-microphone', title: 'তিলাওয়াত ও পাঠ', text: 'ক্বারী, তাজভীদ মোড ও পাঠসংক্রান্ত অন্যান্য সেটিংস এখানে পাবেন।' },
    { target: '.settings-cat-item[data-cat="appearance"]', icon: 'fa-palette', title: 'চেহারা', text: 'থিম ও ফন্ট সাইজসহ অ্যাপের চেহারা নিয়ন্ত্রণ করতে পারবেন।' },
    { target: '.settings-cat-item[data-cat="prayer"]', icon: 'fa-mosque', title: 'নামাজ', text: 'সালাতের সময় গণনার পদ্ধতি ও নোটিফিকেশন সেট করতে পারবেন।' },
    { target: '.settings-cat-item[data-cat="special"]', icon: 'fa-wand-magic-sparkles', title: 'বিশেষ মোড', text: 'রমজান মোডসহ অন্যান্য বিশেষ ফিচার এখান থেকে চালু-বন্ধ করতে পারবেন।' }
  ],

  // ---- Prayer times modal: first time opened ----
  prayer: [
    { target: '#prayerBody', icon: 'fa-clock', title: 'সালাতের সময়সূচি', text: 'অবস্থান অনুমতি দিলে আপনার এলাকার ভিত্তিতে পাঁচ ওয়াক্ত সালাতের সময় স্বয়ংক্রিয়ভাবে দেখানো হবে।' }
  ],

  // ---- Qibla modal: first time opened ----
  qibla: [
    { target: '#qiblaBody', icon: 'fa-compass', title: 'কিবলার দিক', text: 'মোবাইলের কম্পাস ব্যবহার করে কাবার সঠিক দিক এখানে দেখতে পাবেন।' }
  ],

  // ---- Dictionary modal: first time opened ----
  dictionary: [
    { target: '#dictSearchInput', icon: 'fa-book', title: 'অভিধান', text: 'ইসলামী পরিভাষা লিখে তার অর্থ খুঁজে বের করতে পারবেন।' }
  ],

  // ---- Download manager modal: first time opened ----
  downloads: [
    { target: '#dlmHero', icon: 'fa-cloud-arrow-down', title: 'ডাউনলোড ম্যানেজার', text: 'মোট কতটুকু অফলাইন ডাউনলোড আছে এবং স্টোরেজ ব্যবহার এখানে দেখতে পাবেন।' },
    { target: '#dlmSearchInput', icon: 'fa-magnifying-glass', title: 'সূরা খুঁজুন', text: 'যে সূরা অফলাইনে শুনতে চান, তা খুঁজে ডাউনলোড করে নিতে পারবেন।' }
  ],

  // ---- Translation help modal: first time opened ----
  translationHelp: [
    { target: '#trHelpLangList', icon: 'fa-language', title: 'অনুবাদে সহায়তা', text: 'যে ভাষায় অনুবাদে অবদান রাখতে চান, তা এখান থেকে বেছে নিন।' }
  ],

  // ---- Taraweeh tracker modal: first time opened ----
  taraweeh: [
    { target: '#taraweehBody', icon: 'fa-moon', title: 'তারাবীহ ট্র্যাকার', text: 'রমজানের প্রতিটি দিনের তারাবীহ নামাজের রাকাত সংখ্যা এখানে চিহ্নিত করে রাখতে পারবেন।' }
  ]
};

let onbActiveTourName = null;
let onbActiveSteps = null;
let onbCurrentStep = 0;
let onbEls = null; // cached DOM refs for the overlay
let onbResizeHandler = null;
let onbKeyHandler = null;

function onbSeenKey(name){ return ONBOARDING_SEEN_PREFIX + name; }

function onbHasSeen(name){
  try{ return !!localStorage.getItem(onbSeenKey(name)); }catch(e){ return false; }
}

function onbMarkSeen(name){
  try{ localStorage.setItem(onbSeenKey(name), '1'); }catch(e){}
}

function onbResetAllSeen(){
  try{
    Object.keys(ONBOARDING_TOURS).forEach(name => localStorage.removeItem(onbSeenKey(name)));
  }catch(e){}
}

// Tiny, non-intrusive haptic tick — only fires if the device supports it.
function onbBuzz(ms){
  try{ if(navigator.vibrate) navigator.vibrate(ms || 8); }catch(e){}
}

function onbBuildOverlay(){
  if(onbEls) return onbEls;
  const root = document.createElement('div');
  root.id = 'onbRoot';
  root.className = 'onb-root';
  root.innerHTML = `
    <div class="onb-dim"></div>
    <div class="onb-pulse" style="display:none;"></div>
    <div class="onb-spot" style="display:none;"></div>
    <div class="onb-card">
      <div class="onb-card-glow"></div>
      <div class="onb-card-head">
        <div class="onb-icon-badge"><i class="fa-solid"></i></div>
        <span class="onb-step-count"></span>
        <button class="onb-skip" type="button">বাদ দিন <i class="fa-solid fa-xmark"></i></button>
      </div>
      <h3 class="onb-title"></h3>
      <p class="onb-text"></p>
      <div class="onb-dots"></div>
      <div class="onb-progress"><div class="onb-progress-fill"></div></div>
      <div class="onb-actions">
        <button class="onb-prev" type="button"><i class="fa-solid fa-chevron-left"></i> আগে</button>
        <button class="onb-next" type="button"><span class="onb-next-label">পরবর্তী</span> <i class="fa-solid fa-chevron-right"></i></button>
      </div>
    </div>`;
  document.body.appendChild(root);
  onbEls = {
    root,
    dim: root.querySelector('.onb-dim'),
    spot: root.querySelector('.onb-spot'),
    pulse: root.querySelector('.onb-pulse'),
    card: root.querySelector('.onb-card'),
    iconBadge: root.querySelector('.onb-icon-badge i'),
    fill: root.querySelector('.onb-progress-fill'),
    dots: root.querySelector('.onb-dots'),
    count: root.querySelector('.onb-step-count'),
    title: root.querySelector('.onb-title'),
    text: root.querySelector('.onb-text'),
    skip: root.querySelector('.onb-skip'),
    prev: root.querySelector('.onb-prev'),
    next: root.querySelector('.onb-next'),
    nextLabel: root.querySelector('.onb-next-label')
  };
  onbEls.skip.onclick = () => { onbBuzz(6); onbEndTour(); };
  onbEls.prev.onclick = () => { onbBuzz(6); onbGoto(onbCurrentStep - 1); };
  onbEls.next.onclick = () => {
    onbBuzz(10);
    if(onbCurrentStep >= onbActiveSteps.length - 1) onbEndTour();
    else onbGoto(onbCurrentStep + 1);
  };
  return onbEls;
}

function onbPositionCard(targetRect){
  const els = onbEls;
  const cardW = els.card.offsetWidth;
  const cardH = els.card.offsetHeight;
  const margin = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if(!targetRect){
    els.card.style.top = ((vh - cardH) / 2) + 'px';
    els.card.style.left = Math.max(margin, (vw - cardW) / 2) + 'px';
    els.card.classList.remove('onb-arrow-top','onb-arrow-bottom','onb-arrow-left','onb-arrow-right');
    return;
  }

  const spaceBelow = vh - targetRect.bottom;
  const spaceAbove = targetRect.top;
  let top, side;

  if(spaceBelow >= cardH + margin + 12){
    top = targetRect.bottom + margin;
    side = 'top'; // arrow on card's top edge, pointing up at target
  } else if(spaceAbove >= cardH + margin + 12){
    top = targetRect.top - cardH - margin;
    side = 'bottom'; // arrow on card's bottom edge, pointing down at target
  } else {
    // Not enough space above/below (e.g. target is very tall) — dock the
    // card to the safer vertical half of the screen instead.
    top = targetRect.top > vh / 2 ? margin : vh - cardH - margin;
    side = targetRect.top > vh / 2 ? 'bottom' : 'top';
  }
  top = Math.max(margin, Math.min(top, vh - cardH - margin));

  let left = targetRect.left + targetRect.width / 2 - cardW / 2;
  left = Math.max(margin, Math.min(left, vw - cardW - margin));

  els.card.style.top = top + 'px';
  els.card.style.left = left + 'px';
  els.card.classList.remove('onb-arrow-top','onb-arrow-bottom','onb-arrow-left','onb-arrow-right');
  els.card.classList.add('onb-arrow-' + side);

  // Position the arrow horizontally so it still points at the target's
  // center even though the card itself got clamped to stay on-screen.
  const arrowLeft = Math.max(20, Math.min(targetRect.left + targetRect.width / 2 - left, cardW - 20));
  els.card.style.setProperty('--onb-arrow-x', arrowLeft + 'px');
}

function onbRenderDots(){
  const els = onbEls;
  const total = onbActiveSteps.length;
  // Keep dots readable — beyond 8 steps, fall back to the progress bar only.
  if(total > 8){
    els.dots.style.display = 'none';
    els.dots.innerHTML = '';
    return;
  }
  els.dots.style.display = 'flex';
  els.dots.innerHTML = '';
  for(let i = 0; i < total; i++){
    const dot = document.createElement('span');
    dot.className = 'onb-dot' + (i === onbCurrentStep ? ' active' : i < onbCurrentStep ? ' done' : '');
    els.dots.appendChild(dot);
  }
}

function onbRenderStep(){
  const step = onbActiveSteps[onbCurrentStep];
  const els = onbBuildOverlay();

  // Brief fade/rise animation on the card content each time we advance.
  els.card.classList.remove('onb-pop');
  void els.card.offsetWidth; // restart animation
  els.card.classList.add('onb-pop');

  els.iconBadge.className = 'fa-solid ' + (step.icon || 'fa-star');
  els.count.textContent = `${onbCurrentStep + 1} / ${onbActiveSteps.length}`;
  els.fill.style.width = (((onbCurrentStep + 1) / onbActiveSteps.length) * 100) + '%';
  els.title.textContent = step.title;
  els.text.textContent = step.text;
  els.prev.style.visibility = onbCurrentStep === 0 ? 'hidden' : 'visible';
  const isLast = onbCurrentStep === onbActiveSteps.length - 1;
  els.nextLabel.textContent = isLast ? 'শেষ করুন' : 'পরবর্তী';
  els.next.classList.toggle('onb-next-final', isLast);
  els.card.classList.toggle('onb-celebrate', !!step.celebrate);
  onbRenderDots();

  const targetEl = step.target ? document.querySelector(step.target) : null;

  const place = () => {
    if(targetEl){
      const r = targetEl.getBoundingClientRect();
      const pad = 8;
      els.spot.style.display = 'block';
      els.pulse.style.display = 'block';
      [els.spot, els.pulse].forEach(node => {
        node.style.top = (r.top - pad) + 'px';
        node.style.left = (r.left - pad) + 'px';
        node.style.width = (r.width + pad * 2) + 'px';
        node.style.height = (r.height + pad * 2) + 'px';
      });
      onbPositionCard(r);
    } else {
      els.spot.style.display = 'none';
      els.pulse.style.display = 'none';
      onbPositionCard(null);
    }
  };

  if(targetEl){
    targetEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    // Two rAFs so layout/scroll settles before we measure the rect.
    requestAnimationFrame(() => requestAnimationFrame(place));
  } else {
    place();
  }
}

function onbGoto(index){
  if(index < 0 || index >= onbActiveSteps.length) return;
  // If a step's target has vanished (e.g. modal content changed), skip past
  // it instead of showing a spotlight over nothing.
  const step = onbActiveSteps[index];
  if(step.target && !document.querySelector(step.target)){
    const dir = index > onbCurrentStep ? 1 : -1;
    onbCurrentStep = index;
    const next = index + dir;
    if(next >= 0 && next < onbActiveSteps.length) return onbGoto(next);
  }
  onbCurrentStep = index;
  onbRenderStep();
}

function onbEndTour(){
  if(onbActiveTourName) onbMarkSeen(onbActiveTourName);
  if(onbEls && onbEls.root){
    onbEls.root.classList.add('onb-closing');
    setTimeout(() => { if(onbEls && onbEls.root) onbEls.root.remove(); onbEls = null; }, 220);
  }
  if(onbResizeHandler){
    window.removeEventListener('resize', onbResizeHandler);
    onbResizeHandler = null;
  }
  if(onbKeyHandler){
    window.removeEventListener('keydown', onbKeyHandler);
    onbKeyHandler = null;
  }
  document.body.classList.remove('onb-active');
  onbActiveTourName = null;
  onbActiveSteps = null;
}

// Starts a named tour immediately (used both for auto-recaps and manual
// replay). Any tour already on screen is stopped first.
function onbStartTour(name){
  const steps = ONBOARDING_TOURS[name];
  if(!steps || !steps.length) return;
  if(onbEls) onbEndTour();

  document.body.classList.add('onb-active');
  onbActiveTourName = name;
  onbActiveSteps = steps;
  onbCurrentStep = 0;
  onbBuildOverlay();
  onbRenderStep();
  onbBuzz(12);

  onbResizeHandler = () => onbRenderStep();
  window.addEventListener('resize', onbResizeHandler);

  // Keyboard support — feels far more "app-grade" on tablets/desktops.
  onbKeyHandler = (e) => {
    if(e.key === 'Escape'){ onbBuzz(6); onbEndTour(); }
    else if(e.key === 'ArrowRight' || e.key === 'Enter'){
      if(onbCurrentStep >= onbActiveSteps.length - 1) onbEndTour();
      else onbGoto(onbCurrentStep + 1);
    }
    else if(e.key === 'ArrowLeft') onbGoto(onbCurrentStep - 1);
  };
  window.addEventListener('keydown', onbKeyHandler);
}

// Starts a named tour only if the user hasn't seen it yet (this is the hook
// called from around the app — bottom-nav switches, modal opens, etc.). A
// short delay lets the destination's content finish rendering first.
function onbMaybeStart(name, delay){
  if(onbHasSeen(name)) return;
  if(onbEls) return; // don't interrupt a tour already in progress
  setTimeout(() => {
    if(onbEls) return; // a tour started in the meantime
    if(onbHasSeen(name)) return;
    onbStartTour(name);
  }, delay == null ? 450 : delay);
}

// Manual "replay the app guide" entry point from the drawer. Resets every
// section's seen-flag too, so revisiting each part of the app will show its
// recap again, exactly like a brand-new user would see it.
function startOnboardingTour(){
  const drawer = document.getElementById('moreDrawer');
  const scrim = document.getElementById('scrim');
  if(drawer && drawer.classList.contains('open')){
    drawer.classList.remove('open');
    if(scrim) scrim.style.display = 'none';
  }
  onbResetAllSeen();
  onbStartTour('home');
}

function initOnboarding(){
  const replayBtn = document.getElementById('drawerOnboarding');
  if(replayBtn){
    replayBtn.onclick = () => {
      const drawer = document.getElementById('moreDrawer');
      const scrim = document.getElementById('scrim');
      if(drawer) drawer.classList.remove('open');
      if(scrim) scrim.style.display = 'none';
      startOnboardingTour();
    };
  }

  if(!onbHasSeen('home')){
    // Small delay so the home view has fully rendered (surah list, ayah of
    // day card, etc.) before we start measuring element positions.
    setTimeout(() => onbStartTour('home'), 700);
  }
}
