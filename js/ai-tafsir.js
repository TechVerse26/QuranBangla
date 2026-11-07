// ============================================================
// AI তাফসীর / প্রশ্নোত্তর সহকারী
// ============================================================
// এই ফাইল শুধু ব্রাউজার থেকে POST /api/ai-tafsir এ প্রশ্ন পাঠায় আর
// উত্তর দেখায়। আসল AI (Gemini) কলটা api/ai-tafsir.js (Vercel সার্ভারলেস
// ফাংশন) করে — তাই Gemini API key কখনো এই ফাইলে বা ব্রাউজারে থাকে না।
//
// সেটআপ (সম্পূর্ণ ফ্রি, কোনো কার্ড লাগে না): SETUP_AI_TAFSIR.txt দেখুন।
//
// দুইটা এন্ট্রি-পয়েন্ট:
//  ১) রিডারে প্রতিটি আয়াতের নিচে "AI তাফসীর" বাটন — openAiTafsirModal(ayahCtx)
//     সেই আয়াতের আরবি+অনুবাদ প্রেক্ষাপট হিসেবে নিয়ে খোলে।
//  ২) ড্রয়ারের "AI তাফসীর সহকারী" — openAiTafsirModal(null), সাধারণ প্রশ্নোত্তর মোড।
//
// ==== আধুনিকীকরণ (এই আপডেট) ====
// নেটওয়ার্ক/অথ/রেট-লিমিট লজিক অপরিবর্তিত — শুধু UI/UX স্তরে যোগ হয়েছে:
//  · প্রতিটি মডেল-বাবলের পাশে ছোট্ট অ্যাভাটার + **বোল্ড**/বুলেট/নাম্বার-লিস্ট
//    রেন্ডারিং (formatAiTafsirText) — আগে উত্তর পুরোপুরি প্লেইন টেক্সট ছিল
//  · উত্তরের নিচে কপি বাটন (navigator.clipboard, বাকি অ্যাপের প্যাটার্ন অনুসরণ করে)
//  · ইনপুট বার এখন অটো-গ্রো (আগে সবসময় ১ লাইনে আটকে থাকতো) + hard
//    maxlength + ২০০০-ক্যারেক্টার সীমার কাছে গেলে কাউন্টার দেখায়
//    (ব্যাকএন্ড api/ai-tafsir.js এই সীমাতেই সাইলেন্টলি ছেঁটে দিতো)
//  · সেন্ড বাটনে বিজি অবস্থায় স্পিনার (আগে শুধু disabled+faded ছিল)
//  · প্রতিটি নতুন বার্তায় হালকা fade+slide-in — glow/blur/gradient কোথাও
//    নেই, prefers-reduced-motion এ base.css এর গ্লোবাল রুল অনুযায়ী বন্ধ হয়ে যায়
//  · বাগফিক্স: চিপ একবার লুকানোর পর (প্রথম প্রশ্ন পাঠানোর পরে) মোডাল বন্ধ
//    করে আবার খুললে chips.style.display='none' রয়ে যেত — নতুন সাজেশন আর
//    কখনো দেখাতো না। এখন প্রতিবার openAiTafsirModal এ রিসেট হয়।
// ============================================================
//
// ==== আধুনিকীকরণ পর্ব ২ (এই আপডেট): ডায়াগ্রাম + অটো-সাজেশন ====
//  · api/ai-tafsir.js এখন প্রতিটা উত্তরের সাথে (প্রাসঙ্গিক হলে) একটা
//    structured diagram অবজেক্টও পাঠায় (timeline/tree/compare/steps/
//    list) — রেন্ডারিং js/ai-tafsir-diagram.js এ, সম্পূর্ণ pure JS+CSS,
//    কোনো চার্ট/ডায়াগ্রাম লাইব্রেরি ছাড়াই। appendAiTafsirBubble() bubble
//    এর ঠিক নিচে বসায় (renderAiTafsirDiagram লোড না থাকলেও চ্যাট ভাঙে না)।
//  · প্রতিটা AI উত্তরের পরে এখন নতুন, প্রসঙ্গ-ভিত্তিক ৩টা সাজেস্টেড প্রশ্ন
//    (Gemini থেকেই আসে, কুরআন/ইসলাম বিষয়ে সীমাবদ্ধ) চিপ আকারে দেখায় —
//    আগে প্রথম প্রশ্ন পাঠানোর পরে চিপ চিরতরে লুকিয়ে যেতো, এখন প্রতি
//    টার্নে renderAiTafsirChips() দিয়ে রিফ্রেশ হয় (নতুন সাজেশনের উপরে
//    ছোট্ট "আপনি হয়তো জানতে চাইবেন" লেবেল বসে, শুরুর জেনেরিক চিপ থেকে
//    আলাদা বোঝাতে)।
//  · চ্যাট শুরুর স্ট্যাটিক চিপও এখন ৮টা প্রশ্নের পুল থেকে প্রতিবার মোডাল
//    খোলার সময় র‍্যান্ডম ৩টা বেছে দেখায় (aiTafsirPickPrompts) — আগে
//    সবসময় একই ৩টা দেখাতো।
// ============================================================
//
// ==== আধুনিকীকরণ পর্ব ৫ (এই আপডেট): অ্যাকাউন্ট-গেট + IndexedDB হিস্ট্রি ====
//  · সাইন-ইন ছাড়া (অতিথি) এখন ডিভাইস-প্রতি সর্বমোট AIT_GUEST_LIMIT_DISPLAY
//    (api/ai-tafsir.js এর GUEST_LIMIT এর সাথে মিলিয়ে রাখা) টা প্রশ্ন করা
//    যায় — এটা দৈনিক সীমা না, একবারই; শেষ হয়ে গেলে চ্যাটের ভেতরেই একটা
//    কার্ড দেখায় (appendAiTafsirGuestGateCard) সাইন-ইন/সাইন-আপ বাটনসহ আর
//    ইনপুট লক করে দেয়, যতক্ষণ না সাইন-ইন হয় (রিয়েল-টাইমে আনলক হয় —
//    js/auth.js এর refreshCurrentView থেকে aiTafsirRefreshGateForAuthChange
//    ডাকা হয়)। আসল হিসাব সবসময় সার্ভারেই (api/ai-tafsir.js, Firestore-এ
//    ডিভাইস-আইডি ভিত্তিক), এখানে শুধু শেষ জানা সংখ্যাটা IDBKV-তে ক্যাশ
//    থাকে যাতে মোডাল আবার খুললে সাথে সাথেই (আরেকটা রিকোয়েস্ট ছাড়াই)
//    লক অবস্থা দেখানো যায়।
//  · প্রতিটা কথোপকথন এখন IndexedDB-তে (IDBKV, js/idb.js) স্বয়ংক্রিয়ভাবে
//    সংরক্ষিত হয় — হেডারে নতুন দুইটা বাটন: "নতুন আলোচনা" আর "আগের
//    আলোচনা" (ইতিহাস প্যানেল, সংরক্ষিত কথোপকথনের তালিকা + মুছে ফেলার
//    অপশন)। যেকোনোটাতে ট্যাপ করলে পুরনো চ্যাট (আয়াত-প্রসঙ্গ, সব বার্তা,
//    ডায়াগ্রামসহ) হুবহু ফিরিয়ে আনে, চালিয়ে যাওয়া যায়। সর্বোচ্চ
//    AIT_CONV_MAX টা কথোপকথন রাখা হয়, তার বেশি হলে সবচেয়ে পুরনোটা
//    স্বয়ংক্রিয়ভাবে মুছে যায়।
//  · qb_ait_device_id এখন raw localStorage এর বদলে IDBKV দিয়ে
//    পড়া/লেখা হয় (বাকি সব IndexedDB-ভিত্তিক ডেটার সাথে সামঞ্জস্যপূর্ণ
//    রাখতে) — আগে IDBKV এর এক-বারের localStorage-migration এই একটা কী
//    কে IndexedDB এ সরিয়ে নেওয়ার পর নিজের raw localStorage কল আবার
//    localStorage-ই লিখতো, ফলে migration এর পরের প্রথম লোডে ডিভাইস-আইডি
//    নিঃশব্দে বদলে যাওয়ার সুযোগ ছিল।
//  · সেন্ড বাটন এখন প্রশ্নের উত্তর আসার সময় "থামান" বাটনে বদলে যায়
//    (AbortController দিয়ে, ChatGPT/Claude এর প্যাটার্নের মতো) — আগে শুধু
//    disabled স্পিনার ছিল, চাইলে মাঝপথে থামানো যেতো না।
// ============================================================

let aiTafsirHistory = [];        // [{role:'user'|'model', parts:[{text}]}, ...] — Gemini-payload ফরম্যাট, শুধু এই চলতি সেশনের প্রসঙ্গের জন্য
let aiTafsirMessages = [];       // [{role, text, diagram}, ...] — পূর্ণাঙ্গ রেকর্ড (diagram সহ), IndexedDB-তে সংরক্ষণ ও পুরনো চ্যাট রিপ্লে করতে ব্যবহৃত
let aiTafsirCurrentAyah = null;  // {surahBn, ayahNum, arabic, translation} অথবা null (general mode)
let aiTafsirCurrentConvId = null;  // চলতি কথোপকথনের সংরক্ষিত আইডি — প্রথম বার্তা পাঠানোর পরেই সেট হয়, তার আগে null
let aiTafsirConvCreatedAt = null;  // চলতি কথোপকথন প্রথম কবে তৈরি হয়েছিল (persist এর সময় বসে)
let aiTafsirGateActive = false;    // true হলে অতিথি-সীমা শেষ, ইনপুট লক
let aiTafsirAbortController = null; // চলতি in-flight রিকোয়েস্ট থামানোর জন্য (সেন্ড বাটন "থামান" মোডে থাকলে)
let aiTafsirBusy = false;

// ---------- কথোপকথন-পার্সিস্টেন্স + অতিথি-সীমা ক্যাশ — IDBKV কী ----------
const AIT_CONV_INDEX_KEY = 'qb_ait_conversations';   // JSON array — সব সংরক্ষিত কথোপকথনের সারসংক্ষেপ {id,title,isAyah,msgCount,createdAt,updatedAt}
const AIT_CONV_PREFIX = 'qb_ait_conv_';              // + id -> একটা কথোপকথনের পূর্ণাঙ্গ JSON {id,ayahCtx,messages,createdAt,updatedAt}
const AIT_CONV_MAX = 40;                             // এর বেশি কথোপকথন জমলে সবচেয়ে পুরনোটা স্বয়ংক্রিয়ভাবে মুছে যায়
const AIT_GUEST_REMAINING_KEY = 'qb_ait_guest_remaining'; // সার্ভার থেকে সর্বশেষ জানা "অতিথি হিসেবে বাকি প্রশ্ন" সংখ্যার ক্যাশ
const AIT_GUEST_LIMIT_DISPLAY = 2;                   // শুধু UI-তে শুরুতেই দেখানোর জন্য — api/ai-tafsir.js এর GUEST_LIMIT এর সাথে মিলিয়ে রাখা

// প্রতিবার মোডাল খোলার সময় এই পুল থেকে র‍্যান্ডম ৩টা বেছে দেখানো হয়
// (aiTafsirPickPrompts) — তাই শুরুর চিপগুলোও বারবার একই থাকে না।
const AI_TAFSIR_AYAH_PROMPTS = [
  'এই আয়াতের মূল শিক্ষা কী?',
  'এই আয়াতটি কখন/কোন প্রেক্ষাপটে নাযিল হয়েছিল?',
  'আজকের জীবনে এই আয়াত কীভাবে প্রয়োগ করা যায়?',
  'এই আয়াতে ব্যবহৃত গুরুত্বপূর্ণ শব্দগুলোর অর্থ কী?',
  'এই আয়াতের সাথে সম্পর্কিত অন্য আয়াত আছে কি?',
  'এই আয়াত নিয়ে তাফসীরকারদের মধ্যে কোনো মতভেদ আছে কি?',
  'এই আয়াত থেকে কী দোয়া বা আমল শেখা যায়?',
  'এই আয়াতের ব্যাখ্যায় প্রাসঙ্গিক কোনো হাদিস আছে কি?'
];
const AI_TAFSIR_GENERAL_PROMPTS = [
  'সালাতে মনোযোগ ধরে রাখার উপায় কী?',
  'কুরআন তেলাওয়াতের আদব কী কী?',
  'তাওবা করার সঠিক নিয়ম কী?',
  'কুরআন মুখস্থ করার সহজ উপায় কী?',
  'জুমার দিনের ফজিলত কী?',
  'ইসলামে সবরের গুরুত্ব কতটুকু?',
  'রমজানের রোজার হিকমত কী?',
  'পিতামাতার হক সম্পর্কে ইসলাম কী বলে?'
];

// pool থেকে (in-place না বদলে) র‍্যান্ডম n টা বেছে দেয় — Fisher-Yates shuffle
function aiTafsirPickPrompts(pool, n){
  const arr = pool.slice();
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n || 3);
}

// চ্যাট শুরুর স্ট্যাটিক প্রশ্ন (openAiTafsirModal) আর প্রতিটা AI উত্তরের
// পরের Gemini-জেনারেটেড প্রসঙ্গ-ভিত্তিক ফলো-আপ (sendAiTafsirQuestion) —
// দুটোতেই এই একই ফাংশন দিয়ে চিপ বসে/মোছে। opts.dynamic:true হলে চিপের
// উপরে ছোট্ট একটা লেবেল বসে, যাতে বোঝা যায় এগুলো এই মুহূর্তের আলাপের
// ভিত্তিতে তৈরি — শুরুর জেনেরিক প্রশ্ন থেকে আলাদা।
function renderAiTafsirChips(list, opts){
  const chips = document.getElementById('aiTafsirChips');
  const input = document.getElementById('aiTafsirInput');
  if(!chips || !input) return;

  if(!Array.isArray(list) || !list.length){
    chips.innerHTML = '';
    chips.style.display = 'none';
    return;
  }

  const labelHtml = (opts && opts.dynamic)
    ? '<span class="ait-chips-label"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> আপনি হয়তো জানতে চাইবেন</span>'
    : '';
  chips.innerHTML = labelHtml + list.map(p => `<button type="button" class="ait-chip">${escapeHtml(p)}</button>`).join('');
  chips.style.display = '';

  chips.querySelectorAll('.ait-chip').forEach(c => {
    c.onclick = () => { input.value = c.textContent; sendAiTafsirQuestion(); };
  });
}

// প্রথম প্রশ্ন পাঠানোর সাথে সাথেই আয়াত-প্রসঙ্গ কার্ড (.ait-ctx) ভাঁজ করে
// দেয় (sendAiTafsirQuestion থেকে ডাকা হয়) — চ্যাটের জন্য জায়গা ফাঁকা করতে।
// এরপর ইউজার নিজে চেভরন বাটনে ট্যাপ করে যেকোনো সময় আবার খুলতে/বন্ধ করতে
// পারবেন (openAiTafsirModal এ বসানো handler) — তাই এই ফাংশন শুধু প্রথমবার,
// স্বয়ংক্রিয়ভাবে ভাঁজ করাতেই সীমাবদ্ধ, ইউজারের পরবর্তী পছন্দে হস্তক্ষেপ করে না।
function aiTafsirAutoCollapseCtx(){
  const head = document.getElementById('aiTafsirHeadCtx');
  if(!head || head.classList.contains('ait-ctx-collapsed')) return;
  head.classList.add('ait-ctx-collapsed');
  const toggle = document.getElementById('aiTafsirCtxToggle');
  if(toggle) toggle.setAttribute('aria-expanded', 'false');
}

const AIT_MAX_CHARS = 2000;          // api/ai-tafsir.js এর question.slice(0,2000) এর সাথে মিলিয়ে রাখা
const AIT_COUNTER_THRESHOLD = 1800;  // এর নিচে কাউন্টার লুকানো থাকে, অহেতুক জায়গা নেয় না
const AIT_TEXTAREA_MAX_H = 120;      // css/ai-tafsir.css এর textarea max-height এর সাথে মিলিয়ে রাখা

// IDBKV (js/idb.js) দিয়ে সংরক্ষিত — বাকি অ্যাপের সব IndexedDB-ভিত্তিক ডেটার
// সাথে সামঞ্জস্যপূর্ণ রাখতে। IDBKV কোনো কারণে লোড না হলে (স্ক্রিপ্ট-অর্ডার
// সমস্যা) সরাসরি localStorage এ ফলব্যাক করে, যাতে ফিচারটা কখনো ভেঙে না পড়ে।
function aiTafsirDeviceId(){
  const store = (typeof IDBKV !== 'undefined' && IDBKV.isReady) ? IDBKV : null;
  let id = store ? store.get('qb_ait_device_id') : (function(){ try{ return localStorage.getItem('qb_ait_device_id'); }catch(e){ return null; } })();
  if(!id){
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try{
      if(store) store.set('qb_ait_device_id', id);
      else localStorage.setItem('qb_ait_device_id', id);
    }catch(e){}
  }
  return id;
}

async function aiTafsirAuthPayload(){
  try{
    if(typeof fbAuth !== 'undefined' && fbAuth && fbAuth.currentUser){
      const idToken = await fbAuth.currentUser.getIdToken();
      return { idToken };
    }
  }catch(e){ /* সাইন-ইন থাকলেও token আনতে ব্যর্থ হলে নিচে anonymous fallback */ }
  return { deviceId: aiTafsirDeviceId() };
}

function aiTafsirIsSignedIn(){
  return typeof fbAuth !== 'undefined' && !!fbAuth && !!fbAuth.currentUser;
}

// ---------- কথোপকথন পার্সিস্টেন্স (IndexedDB, IDBKV এর মাধ্যমে) ----------
// প্রতিটা কথোপকথন দুই জায়গায় সংরক্ষিত হয়: (১) AIT_CONV_INDEX_KEY এ একটা
// হালকা সারসংক্ষেপ-তালিকা (হিস্ট্রি প্যানেলে দ্রুত রেন্ডার করতে, পুরো
// মেসেজ-বডি ছাড়াই), আর (২) AIT_CONV_PREFIX+id এ পূর্ণাঙ্গ বার্তা-সহ
// অবজেক্ট (কথোপকথন আবার খুললে রিপ্লে করতে)।
function aiTafsirGenId(){
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function aiTafsirLoadConvIndex(){
  try{
    const raw = IDBKV.get(AIT_CONV_INDEX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  }catch(e){ return []; }
}

function aiTafsirSaveConvIndex(list){
  try{ IDBKV.set(AIT_CONV_INDEX_KEY, JSON.stringify(list)); }catch(e){}
}

// প্রথম ইউজার-প্রশ্ন (বা আয়াত-প্রসঙ্গ থাকলে সূরা/আয়াত) থেকে একটা ছোট
// শিরোনাম বানায় — হিস্ট্রি প্যানেলের তালিকায় দেখানোর জন্য।
function aiTafsirDeriveTitle(){
  if(aiTafsirCurrentAyah){
    return `${aiTafsirCurrentAyah.surahBn || ''} · আয়াত ${toBn(aiTafsirCurrentAyah.ayahNum || '')}`;
  }
  const firstUser = aiTafsirMessages.find(m => m.role === 'user');
  if(firstUser && firstUser.text) return firstUser.text.slice(0, 60);
  return 'নতুন আলোচনা';
}

// প্রতিটা সফল প্রশ্নোত্তরের পরে (sendAiTafsirQuestion থেকে) ডাকা হয় —
// চলতি পুরো কথোপকথন IndexedDB এ সংরক্ষণ/আপডেট করে। খালি কথোপকথন (কোনো
// বার্তা এখনো পাঠানো হয়নি) কখনো সংরক্ষিত হয় না।
function aiTafsirPersistConversation(){
  if(!aiTafsirMessages.length || typeof IDBKV === 'undefined') return;
  const now = Date.now();
  if(!aiTafsirCurrentConvId) aiTafsirCurrentConvId = aiTafsirGenId();
  if(!aiTafsirConvCreatedAt) aiTafsirConvCreatedAt = now;

  const record = {
    id: aiTafsirCurrentConvId,
    ayahCtx: aiTafsirCurrentAyah,
    messages: aiTafsirMessages,
    createdAt: aiTafsirConvCreatedAt,
    updatedAt: now
  };
  try{ IDBKV.set(AIT_CONV_PREFIX + aiTafsirCurrentConvId, JSON.stringify(record)); }catch(e){ return; }

  let list = aiTafsirLoadConvIndex().filter(c => c.id !== aiTafsirCurrentConvId);
  list.unshift({
    id: aiTafsirCurrentConvId,
    title: aiTafsirDeriveTitle(),
    isAyah: !!aiTafsirCurrentAyah,
    msgCount: aiTafsirMessages.length,
    createdAt: record.createdAt,
    updatedAt: now
  });
  // সীমাহীন বৃদ্ধি ঠেকাতে সবচেয়ে পুরনো কথোপকথন(গুলো) স্বয়ংক্রিয়ভাবে ছাঁটাই
  if(list.length > AIT_CONV_MAX){
    list.slice(AIT_CONV_MAX).forEach(c => { try{ IDBKV.remove(AIT_CONV_PREFIX + c.id); }catch(e){} });
    list = list.slice(0, AIT_CONV_MAX);
  }
  aiTafsirSaveConvIndex(list);
}

function aiTafsirDeleteConversation(id){
  aiTafsirSaveConvIndex(aiTafsirLoadConvIndex().filter(c => c.id !== id));
  try{ IDBKV.remove(AIT_CONV_PREFIX + id); }catch(e){}
  if(aiTafsirCurrentConvId === id){ aiTafsirCurrentConvId = null; aiTafsirConvCreatedAt = null; } // চলতি চ্যাটই মুছে ফেললে পরের সেভ নতুন আইডি নেবে
  renderAiTafsirHistoryPanel();
}

// সংরক্ষিত একটা কথোপকথন খুলে চ্যাট এরিয়ায় হুবহু রিপ্লে করে (ডায়াগ্রামসহ),
// চালিয়ে যাওয়ার জন্য প্রস্তুত অবস্থায়।
function aiTafsirOpenConversation(id){
  let record;
  try{
    const raw = IDBKV.get(AIT_CONV_PREFIX + id);
    if(!raw) return;
    record = JSON.parse(raw);
  }catch(e){ return; }

  aiTafsirCurrentConvId = record.id;
  aiTafsirConvCreatedAt = record.createdAt || Date.now();
  aiTafsirCurrentAyah = record.ayahCtx || null;
  aiTafsirMessages = Array.isArray(record.messages) ? record.messages : [];
  aiTafsirHistory = aiTafsirMessages.map(m => ({ role: m.role, parts: [{ text: m.text || '' }] }));

  const body = document.getElementById('aiTafsirChat');
  if(body) body.innerHTML = '';
  aiTafsirRenderCtxHead(aiTafsirCurrentAyah, { collapsed: true }); // পুরনো চ্যাট খুললে সরাসরি ভাঁজ করা অবস্থায়, চ্যাটের জন্য জায়গা রেখে
  aiTafsirMessages.forEach(m => appendAiTafsirBubble(m.role, m.text || '', false, m.diagram || null));
  renderAiTafsirChips([]); // পুরনো চ্যাট চালিয়ে যাওয়ার সময় শুরুর/আগের ফলো-আপ চিপ আর প্রাসঙ্গিক না
  aiTafsirToggleHistoryPanel(false);
  aiTafsirRefreshGuestGateUI();

  const input = document.getElementById('aiTafsirInput');
  if(input){ input.value = ''; aiTafsirResizeInput(); aiTafsirUpdateCharCount(); input.focus(); }
}

function aiTafsirRelativeTime(ts){
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if(diffMin < 1) return 'এইমাত্র';
  if(diffMin < 60) return `${toBn(diffMin)} মিনিট আগে`;
  const diffHr = Math.round(diffMin / 60);
  if(diffHr < 24) return `${toBn(diffHr)} ঘণ্টা আগে`;
  const diffDay = Math.round(diffHr / 24);
  if(diffDay < 30) return `${toBn(diffDay)} দিন আগে`;
  try{ return new Date(ts).toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' }); }
  catch(e){ return new Date(ts).toLocaleDateString(); }
}

function renderAiTafsirHistoryPanel(){
  const listEl = document.getElementById('aiTafsirHistoryList');
  if(!listEl) return;
  const list = aiTafsirLoadConvIndex();
  if(!list.length){
    listEl.innerHTML = '<div class="ait-history-empty"><i class="fa-regular fa-comments" aria-hidden="true"></i><p>এখনো কোনো আলোচনা সংরক্ষিত হয়নি — একটা প্রশ্ন করলেই এখানে জমা হবে।</p></div>';
    return;
  }
  listEl.innerHTML = list.map(c => `
    <div class="ait-history-item${c.id === aiTafsirCurrentConvId ? ' ait-history-item-active' : ''}" data-id="${escapeHtml(c.id)}">
      <div class="ait-history-item-main">
        <div class="ait-history-item-title">${c.isAyah ? '<i class="fa-solid fa-bookmark" aria-hidden="true"></i> ' : ''}${escapeHtml(c.title || 'আলোচনা')}</div>
        <div class="ait-history-item-meta">${aiTafsirRelativeTime(c.updatedAt)} · ${toBn(c.msgCount || 0)}টি বার্তা</div>
      </div>
      <button type="button" class="ait-history-item-delete" data-del="${escapeHtml(c.id)}" aria-label="এই আলোচনা মুছে ফেলুন"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');

  listEl.querySelectorAll('.ait-history-item').forEach(el => {
    el.onclick = (e) => { if(!e.target.closest('[data-del]')) aiTafsirOpenConversation(el.getAttribute('data-id')); };
  });
  listEl.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); aiTafsirDeleteConversation(btn.getAttribute('data-del')); };
  });
}

function aiTafsirToggleHistoryPanel(show){
  const panel = document.getElementById('aiTafsirHistoryPanel');
  if(!panel) return;
  const willShow = show !== undefined ? show : (panel.style.display === 'none' || !panel.style.display);
  if(willShow) renderAiTafsirHistoryPanel();
  panel.style.display = willShow ? 'flex' : 'none';
}

// ---------- অতিথি-সীমা গেট ----------
// আসল হিসাব সবসময় সার্ভারে (api/ai-tafsir.js, Firestore); এখানে শুধু সর্বশেষ
// জানা "বাকি প্রশ্ন" সংখ্যাটা ক্যাশ থাকে যাতে মোডাল খোলা/পুরনো চ্যাটে
// যাওয়ার সাথে সাথেই (নেটওয়ার্ক রাউন্ড-ট্রিপ ছাড়াই) সঠিক লক-অবস্থা দেখানো যায়।
function aiTafsirGuestRemainingCached(){
  try{
    const raw = IDBKV.get(AIT_GUEST_REMAINING_KEY);
    if(raw === null || raw === undefined) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }catch(e){ return null; }
}

function aiTafsirSetInputLocked(locked, hintHtml){
  const input = document.getElementById('aiTafsirInput');
  const sendBtn = document.getElementById('aiTafsirSend');
  const remaining = document.getElementById('aiTafsirRemaining');
  if(input){ input.disabled = locked; input.placeholder = locked ? 'সাইন ইন করে চালিয়ে যান...' : 'আপনার প্রশ্ন লিখুন...'; }
  if(sendBtn) sendBtn.disabled = locked;
  if(remaining && hintHtml !== undefined) remaining.innerHTML = hintHtml;
}

// modal খোলার সময়, পুরনো কথোপকথনে যাওয়ার সময়, আর সাইন-ইন/আউট হওয়ার সময়
// (js/auth.js এর refreshCurrentView থেকে) ডাকা হয় — চলতি অ্যাকাউন্ট-অবস্থা
// অনুযায়ী ইনপুট লক/আনলক আর ফুটারের হিন্ট-টেক্সট ঠিক করে।
function aiTafsirRefreshGuestGateUI(){
  if(aiTafsirIsSignedIn()){
    aiTafsirGateActive = false;
    aiTafsirSetInputLocked(false, '');
    return;
  }
  const remaining = aiTafsirGuestRemainingCached();
  if(remaining !== null && remaining <= 0){
    aiTafsirActivateGuestGate(false); // false = নতুন কার্ড না জুড়ে শুধু ইনপুট লক — কার্ডটা শুধু লাইভ ফ্লোতেই (সীমা শেষ হওয়ার মুহূর্তে) দেখানো হয়
  } else {
    aiTafsirGateActive = false;
    const hint = `<i class="fa-solid fa-user" aria-hidden="true"></i> অতিথি হিসেবে ${remaining !== null ? toBn(remaining) : toBn(AIT_GUEST_LIMIT_DISPLAY)}টি প্রশ্ন করা যাবে — সাইন ইন করলে আরও বেশি`;
    aiTafsirSetInputLocked(false, hint);
  }
}

// appendCard=true হলে (সীমা শেষ হওয়ার লাইভ মুহূর্তে) চ্যাটের ভেতরে একটা
// সাইন-ইন CTA কার্ডও জোড়া হয়; false হলে (মোডাল/পুরনো-চ্যাট খোলার সময়) শুধু
// ইনপুট লক করা হয়, প্রতিবার আরেকটা কার্ড দিয়ে চ্যাট ভরিয়ে ফেলা হয় না।
function aiTafsirActivateGuestGate(appendCard){
  aiTafsirGateActive = true;
  aiTafsirSetInputLocked(true, '<i class="fa-solid fa-lock" aria-hidden="true"></i> অতিথি হিসেবে প্রশ্নের সুযোগ শেষ হয়েছে');
  if(appendCard && !document.getElementById('aiTafsirGateCard')) appendAiTafsirGuestGateCard();
}

function appendAiTafsirGuestGateCard(){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return;
  const row = document.createElement('div');
  row.className = 'ait-msg ait-msg-model';
  row.appendChild(aiTafsirAvatarEl());
  const col = document.createElement('div');
  col.className = 'ait-msg-col';
  const card = document.createElement('div');
  card.className = 'ait-gate-card';
  card.id = 'aiTafsirGateCard';
  card.innerHTML = `
    <p>অতিথি হিসেবে ${toBn(AIT_GUEST_LIMIT_DISPLAY)}টি প্রশ্নের সুযোগ শেষ হয়েছে। বিনামূল্যে চালিয়ে যেতে সাইন ইন করুন বা নতুন অ্যাকাউন্ট খুলুন।</p>
    <button type="button" class="ait-gate-btn" id="aiTafsirGateSignin">সাইন ইন / সাইন আপ করুন</button>
  `;
  col.appendChild(card);
  row.appendChild(col);
  body.appendChild(row);
  aiTafsirScrollToRow(row, 'model');
  const btn = document.getElementById('aiTafsirGateSignin');
  if(btn) btn.onclick = () => { if(typeof openAuthFlow === 'function') openAuthFlow('choice'); };
}

// js/auth.js এর refreshCurrentView() থেকে ডাকা হয় (AI তাফসীর মোডাল খোলা
// থাকলে) — সাইন-ইন হয়ে গেলে গেট-কার্ড সরিয়ে ইনপুট সাথে সাথেই আনলক করে,
// মোডাল বন্ধ-খোলা করার দরকার হয় না।
function aiTafsirRefreshGateForAuthChange(){
  aiTafsirRefreshGuestGateUI();
  if(aiTafsirIsSignedIn()){
    const card = document.getElementById('aiTafsirGateCard');
    const row = card && card.closest('.ait-msg');
    if(row) row.remove();
  }
}

// ---------- হালকা মার্কডাউন → HTML (pure JS, কোনো লাইব্রেরি নেই) ----------
// সাপোর্ট করে: **বোল্ড**, *ইটালিক*, "- "/"• "/"* " বুলেট লিস্ট,
// "1. "/"১. " নাম্বার লিস্ট (বাংলা+ইংরেজি অঙ্ক দুটোই), খালি লাইনে প্যারাগ্রাফ ব্রেক।
// escapeHtml() দিয়ে আগেই এসকেপ করা টেক্সটের উপর কাজ করে — তাই AI-এর উত্তরে
// আক্ষরিক HTML থাকলেও তা কখনো ট্যাগ হিসেবে রেন্ডার হবে না, নিরাপদ।
const AIT_BULLET_RE = /^[-*•]\s+(.+)/;
const AIT_NUMBERED_RE = /^([০-৯]+|\d+)[.)]\s+(.+)/;

function aiTafsirInline(str){
  return str
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function formatAiTafsirText(text){
  const escaped = escapeHtml(text || '').replace(/\r\n/g, '\n');
  const lines = escaped.split('\n');
  const blocks = [];
  let para = [];
  let list = null; // {type:'ul'|'ol', items:[]}

  const flushPara = () => { if(para.length){ blocks.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if(list){ blocks.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } };

  lines.forEach(raw => {
    const line = raw.trim();
    const bullet = line.match(AIT_BULLET_RE);
    const numbered = !bullet && line.match(AIT_NUMBERED_RE);
    if(bullet){
      flushPara();
      if(!list || list.type !== 'ul'){ flushList(); list = { type: 'ul', items: [] }; }
      list.items.push('<li>' + aiTafsirInline(bullet[1]) + '</li>');
    } else if(numbered){
      flushPara();
      if(!list || list.type !== 'ol'){ flushList(); list = { type: 'ol', items: [] }; }
      list.items.push('<li>' + aiTafsirInline(numbered[2]) + '</li>');
    } else if(line === ''){
      flushPara(); flushList();
    } else {
      flushList();
      para.push(aiTafsirInline(line));
    }
  });
  flushPara(); flushList();

  return blocks.join('') || '';
}

// ---------- মডেল-বার্তার অ্যাভাটার — হেডার/ড্রয়ারের wand-sparkles আইকনের
// সাথে সামঞ্জস্যপূর্ণ, যাতে পুরো ফিচার জুড়ে একই "AI" ভিজ্যুয়াল আইডেন্টিটি থাকে ----------
function aiTafsirAvatarEl(){
  const span = document.createElement('span');
  span.className = 'ait-avatar';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
  return span;
}

function aiTafsirCopyBtn(rawText){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ait-copy-btn';
  btn.setAttribute('aria-label', 'উত্তর কপি করুন');
  btn.innerHTML = '<i class="fa-regular fa-copy"></i> কপি';
  btn.onclick = () => {
    if(!navigator.clipboard) return;
    navigator.clipboard.writeText(rawText).then(() => {
      btn.classList.add('ait-copied');
      btn.innerHTML = '<i class="fa-solid fa-check"></i> কপি হয়েছে';
      if(typeof showToast === 'function') showToast('কপি হয়েছে');
      setTimeout(() => {
        btn.classList.remove('ait-copied');
        btn.innerHTML = '<i class="fa-regular fa-copy"></i> কপি';
      }, 1600);
    }).catch(() => {});
  };
  return btn;
}

// ayahCtx দিলে সেই আয়াত-প্রসঙ্গে খোলে, null দিলে সাধারণ প্রশ্নোত্তর মোডে।
// আয়াত-প্রসঙ্গ হেডার বসায় — openAiTafsirModal (নতুন চ্যাট) আর
// aiTafsirOpenConversation (পুরনো চ্যাট রিপ্লে) দুই জায়গা থেকেই ডাকা হয়,
// তাই একই মার্কআপ/টগল-লজিক দুইবার লেখা লাগে না। opts.collapsed:true হলে
// শুরুতেই ভাঁজ করা অবস্থায় বসে (পুরনো চ্যাট খোলার সময় চ্যাটের জন্য জায়গা
// রাখতে) — নতুন চ্যাটে (openAiTafsirModal) ডিফল্ট খোলা অবস্থায় থাকে, প্রথম
// প্রশ্ন পাঠানোর সাথে সাথে aiTafsirAutoCollapseCtx() আলাদাভাবে ভাঁজ করে।
function aiTafsirRenderCtxHead(ayahCtx, opts){
  const head = document.getElementById('aiTafsirHeadCtx');
  if(!head) return;
  if(!ayahCtx){ head.style.display = 'none'; head.innerHTML = ''; return; }

  const collapsed = !!(opts && opts.collapsed);
  head.style.display = 'block';
  head.classList.toggle('ait-ctx-collapsed', collapsed);
  head.innerHTML = `
    <div class="ait-ctx-top">
      <div class="ait-ctx-surah">${escapeHtml(ayahCtx.surahBn || '')} · আয়াত ${toBn(ayahCtx.ayahNum || '')}</div>
      <button type="button" class="ait-ctx-toggle" id="aiTafsirCtxToggle" aria-label="আয়াত দেখান/আড়াল করুন" aria-expanded="${collapsed ? 'false' : 'true'}"><i class="fa-solid fa-chevron-up"></i></button>
    </div>
    <div class="ait-ctx-body">
      <div class="ait-ctx-body-inner">
        <div class="ait-ctx-ar">${ayahCtx.arabic || ''}</div>
        ${ayahCtx.translation ? `<div class="ait-ctx-tr">${escapeHtml(ayahCtx.translation)}</div>` : ''}
      </div>
    </div>`;
  const ctxToggle = document.getElementById('aiTafsirCtxToggle');
  if(ctxToggle){
    ctxToggle.onclick = () => {
      const nowCollapsed = head.classList.toggle('ait-ctx-collapsed');
      ctxToggle.setAttribute('aria-expanded', String(!nowCollapsed));
    };
  }
}

// ayahCtx দিলে সেই আয়াত-প্রসঙ্গে খোলে, null দিলে সাধারণ প্রশ্নোত্তর মোডে —
// সবসময় একটা টাটকা/খালি কথোপকথন দিয়ে শুরু হয় (পুরনো চালিয়ে যেতে
// হিস্ট্রি প্যানেল থেকে aiTafsirOpenConversation ব্যবহার করুন)।
function openAiTafsirModal(ayahCtx){
  aiTafsirCurrentAyah = ayahCtx || null;
  aiTafsirHistory = [];
  aiTafsirMessages = [];
  aiTafsirCurrentConvId = null;
  aiTafsirConvCreatedAt = null;

  const head = document.getElementById('aiTafsirHeadCtx');
  const chips = document.getElementById('aiTafsirChips');
  const body = document.getElementById('aiTafsirChat');
  const input = document.getElementById('aiTafsirInput');
  if(!head || !chips || !body || !input) return;

  body.innerHTML = '';
  aiTafsirToggleHistoryPanel(false);
  input.value = '';
  aiTafsirResizeInput();
  aiTafsirUpdateCharCount();

  aiTafsirRenderCtxHead(ayahCtx);
  renderAiTafsirChips(
    aiTafsirPickPrompts(ayahCtx ? AI_TAFSIR_AYAH_PROMPTS : AI_TAFSIR_GENERAL_PROMPTS),
    { dynamic: false }
  );

  appendAiTafsirBubble('model', ayahCtx
    ? 'এই আয়াত নিয়ে যা জানতে চান জিজ্ঞাসা করুন। নিচের সাজেশনগুলো থেকেও বেছে নিতে পারেন।'
    : 'ইসলাম বা কুরআন নিয়ে যেকোনো প্রশ্ন করুন। কোনো নির্দিষ্ট আয়াতের ব্যাখ্যা জানতে চাইলে রিডারে সেই আয়াতের নিচের "AI তাফসীর" বাটন থেকে জিজ্ঞাসা করলে আরও নির্ভুল উত্তর পাবেন।'
  );

  aiTafsirRefreshGuestGateUI();
  openModal('aiTafsirModal');
  input.focus();
}

// .ait-chat থেকে যথেষ্ট উপরে স্ক্রল করা থাকলে (নিচে>120px) .ait-scroll-bottom
// FAB দেখায় — নতুন বার্তা এলে (নিচে দেখুন) আর ম্যানুয়াল স্ক্রলে (নিচে
// DOMContentLoaded এ 'scroll' লিসেনার) দুই জায়গা থেকেই ডাকা হয়।
function aiTafsirUpdateScrollFab(){
  const chatEl = document.getElementById('aiTafsirChat');
  const fab = document.getElementById('aiTafsirScrollBottom');
  if(!chatEl || !fab) return;
  const distanceFromBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
  fab.classList.toggle('ait-visible', distanceFromBottom > 120);
}

// নতুন বার্তা আসলে স্ক্রল-পজিশন ঠিক করে — user এর নিজের (ছোট) বার্তার
// ক্ষেত্রে একদম নিচে (চেনা চ্যাট-কনভেনশন), কিন্তু model এর উত্তরের
// ক্ষেত্রে বার্তাটার *শুরু* (অ্যাভাটারসহ) দেখায়, একদম নিচে না — কারণ
// উত্তর viewport এর চেয়ে লম্বা হলে "নিচে" স্ক্রল করলে শুরুটা (এমনকি
// আগের বার্তাও) স্ক্রল হয়ে উপরে চলে যেতো, যেটাই ছিল আসল সমস্যা।
// .ait-chat এখন position:absolute (css/ai-tafsir.css) তাই row.offsetTop
// সরাসরি .ait-chat এর সাপেক্ষে নির্ভুল আসে।
function aiTafsirScrollToRow(row, role){
  const body = document.getElementById('aiTafsirChat');
  if(!body || !row) return;
  body.scrollTop = (role === 'user') ? body.scrollHeight : Math.max(0, row.offsetTop - 8);
  aiTafsirUpdateScrollFab();
}

function appendAiTafsirBubble(role, text, isError, diagram){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return null;

  const row = document.createElement('div');
  row.className = 'ait-msg ait-msg-' + role;
  if(role === 'model') row.appendChild(aiTafsirAvatarEl());

  const col = document.createElement('div');
  col.className = 'ait-msg-col';

  const bubble = document.createElement('div');
  bubble.className = 'ait-bubble ait-' + role + (isError ? ' ait-error' : '');
  bubble.innerHTML = formatAiTafsirText(text);
  col.appendChild(bubble);

  // diagram থাকলে bubble এর ঠিক নিচে বসে — js/ai-tafsir-diagram.js (আলাদা
  // pure JS/CSS রেন্ডারার ফাইল) কোনো কারণে লোড না হলেও (typeof চেক) চ্যাট
  // ভেঙে পড়ে না, শুধু ডায়াগ্রামটা বাদ যায়।
  if(role === 'model' && !isError && diagram && typeof renderAiTafsirDiagram === 'function'){
    const diagramEl = renderAiTafsirDiagram(diagram);
    if(diagramEl) col.appendChild(diagramEl);
  }

  if(role === 'model' && !isError && text && text.trim()){
    col.appendChild(aiTafsirCopyBtn(text));
  }

  row.appendChild(col);
  body.appendChild(row);
  aiTafsirScrollToRow(row, role);
  return bubble;
}

function appendAiTafsirTyping(){
  const body = document.getElementById('aiTafsirChat');
  if(!body) return null;

  const row = document.createElement('div');
  row.className = 'ait-msg ait-msg-model';
  row.appendChild(aiTafsirAvatarEl());

  const col = document.createElement('div');
  col.className = 'ait-msg-col';
  const bubble = document.createElement('div');
  bubble.className = 'ait-bubble ait-model ait-typing';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  col.appendChild(bubble);

  row.appendChild(col);
  body.appendChild(row);
  aiTafsirScrollToRow(row, 'model');
  return row; // .remove() পুরো সারি (অ্যাভাটারসহ) সরিয়ে দেবে
}

// ---------- ইনপুট বার: অটো-গ্রো টেক্সটএরিয়া + ক্যারেক্টার কাউন্টার ----------
// আগে টেক্সটএরিয়া সবসময় ১ লাইনের উচ্চতায় আটকে থাকতো (ভেতরে স্ক্রল হতো);
// এখন লেখা বাড়ার সাথে সাথে বক্সও বাড়ে (সর্বোচ্চ ১২০px), তারপর ভেতরে স্ক্রল হয়।
function aiTafsirResizeInput(){
  const el = document.getElementById('aiTafsirInput');
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, AIT_TEXTAREA_MAX_H) + 'px';
}

function aiTafsirUpdateCharCount(){
  const el = document.getElementById('aiTafsirInput');
  const counter = document.getElementById('aiTafsirCharCount');
  if(!el || !counter) return;
  const len = el.value.length;
  if(len >= AIT_COUNTER_THRESHOLD){
    counter.textContent = `${toBn(len)} / ${toBn(AIT_MAX_CHARS)}`;
    counter.classList.add('ait-visible');
  } else {
    counter.classList.remove('ait-visible');
  }
}

// loading=true হলে সেন্ড বাটন একটা "থামান" বাটনে বদলে যায় (নিচে
// aiTafsirHandleSendClick দেখুন) — তাই disabled রাখা হয় না, শুধু আইকন/
// aria-label বদলায়।
function aiTafsirSetSendLoading(loading){
  const btn = document.getElementById('aiTafsirSend');
  if(!btn) return;
  btn.classList.toggle('ait-send-loading', loading);
  btn.setAttribute('aria-label', loading ? 'থামান' : 'পাঠান');
  btn.innerHTML = loading
    ? '<i class="fa-solid fa-stop"></i>'
    : '<i class="fa-solid fa-paper-plane"></i>';
}

// সেন্ড বাটনে ক্লিক এখন দুই কাজ করতে পারে অবস্থাভেদে: ব্যস্ত না থাকলে প্রশ্ন
// পাঠায়, ব্যস্ত থাকলে (উত্তর আসছে) চলতি রিকোয়েস্ট থামিয়ে দেয়।
function aiTafsirHandleSendClick(){
  if(aiTafsirBusy){
    if(aiTafsirAbortController) aiTafsirAbortController.abort();
    return;
  }
  sendAiTafsirQuestion();
}

async function sendAiTafsirQuestion(){
  if(aiTafsirBusy || aiTafsirGateActive) return;
  const inputEl = document.getElementById('aiTafsirInput');
  if(!inputEl) return;
  const question = inputEl.value.trim();
  if(!question) return;

  // প্রথম প্রশ্ন — তাই আয়াত-কার্ড ভাঁজ করে চ্যাটের জন্য জায়গা ফাঁকা করা হয়
  if(aiTafsirHistory.length === 0 && aiTafsirCurrentAyah) aiTafsirAutoCollapseCtx();

  // পাঠানোর সাথে সাথেই আগের চিপ সরিয়ে ফেলা হয় (উত্তর আসা পর্যন্ত পুরনো/
  // অপ্রাসঙ্গিক সাজেশন দেখানো ঠিক না) — সফল উত্তর এলে নিচে
  // renderAiTafsirChips() দিয়ে নতুন প্রসঙ্গ-ভিত্তিক সাজেশন আবার বসে।
  renderAiTafsirChips([]);

  inputEl.value = '';
  aiTafsirResizeInput();
  aiTafsirUpdateCharCount();
  appendAiTafsirBubble('user', question);
  aiTafsirHistory.push({ role: 'user', parts: [{ text: question }] });
  aiTafsirMessages.push({ role: 'user', text: question });

  aiTafsirBusy = true;
  aiTafsirSetSendLoading(true); // সেন্ড বাটন এখনও enabled — busy অবস্থায় "থামান" হিসেবে কাজ করে
  const typingEl = appendAiTafsirTyping();
  aiTafsirAbortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

  try{
    const authPart = await aiTafsirAuthPayload();
    const res = await fetch('/api/ai-tafsir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: aiTafsirHistory.slice(0, -1),
        ayahContext: aiTafsirCurrentAyah,
        ...authPart
      }),
      signal: aiTafsirAbortController ? aiTafsirAbortController.signal : undefined
    });
    const data = await res.json().catch(() => ({}));
    if(typingEl) typingEl.remove();

    if(!res.ok){
      aiTafsirHistory.pop();
      aiTafsirMessages.pop();
      if(data.error === 'guest_limit_reached'){
        try{ IDBKV.set(AIT_GUEST_REMAINING_KEY, '0'); }catch(e){}
        aiTafsirActivateGuestGate(true);
      } else if(data.error === 'rate_limited'){
        appendAiTafsirBubble('model', 'আজকের জন্য প্রশ্নের সীমা শেষ হয়ে গেছে 🙏 আগামীকাল আবার চেষ্টা করুন।', true);
      } else if(data.error === 'not_configured'){
        appendAiTafsirBubble('model', 'এই ফিচারটি এখনো সেটআপ করা হয়নি। SETUP_AI_TAFSIR.txt ফাইলটি অনুসরণ করুন।', true);
      } else {
        appendAiTafsirBubble('model', 'দুঃখিত, এখন উত্তর দিতে পারছি না। একটু পর আবার চেষ্টা করুন।', true);
      }
      return;
    }

    appendAiTafsirBubble('model', data.answer || '', false, data.diagram || null);
    aiTafsirHistory.push({ role: 'model', parts: [{ text: data.answer || '' }] });
    aiTafsirMessages.push({ role: 'model', text: data.answer || '', diagram: data.diagram || null });
    aiTafsirPersistConversation();
    renderAiTafsirChips(Array.isArray(data.suggestions) ? data.suggestions : [], { dynamic: true });

    if(typeof data.remainingToday === 'number'){
      const counter = document.getElementById('aiTafsirRemaining');
      if(counter) counter.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> আজ আর ${toBn(data.remainingToday)}টি প্রশ্ন করা যাবে`;
    } else if(typeof data.remainingGuestMessages === 'number'){
      try{ IDBKV.set(AIT_GUEST_REMAINING_KEY, String(data.remainingGuestMessages)); }catch(e){}
      if(data.remainingGuestMessages <= 0) aiTafsirActivateGuestGate(true); // এই বার্তার পরই সীমা শেষ — পরের চেষ্টার আগেই গেট দেখিয়ে দেওয়া হয়
      else{
        const counter = document.getElementById('aiTafsirRemaining');
        if(counter) counter.innerHTML = `<i class="fa-solid fa-user"></i> অতিথি হিসেবে আর ${toBn(data.remainingGuestMessages)}টি প্রশ্ন করা যাবে`;
      }
    }
  }catch(e){
    if(typingEl) typingEl.remove();
    aiTafsirHistory.pop();
    aiTafsirMessages.pop();
    appendAiTafsirBubble('model', (e && e.name === 'AbortError') ? 'প্রশ্নটি থামানো হয়েছে।' : 'ইন্টারনেট সংযোগ পরীক্ষা করুন।', true);
  }finally{
    aiTafsirBusy = false;
    aiTafsirAbortController = null;
    // sendBtn.disabled ইচ্ছাকৃতভাবে এখানে ছোঁয়া হয় না — সেটা এখন শুধু
    // অতিথি-গেটের (aiTafsirSetInputLocked) দখলে; উত্তর আসতে আসতেই যদি গেট
    // সক্রিয় হয়ে যায় (guest_limit_reached), এখানে আবার enable করে দিলে
    // সেই লক ভেঙে যেতো।
    aiTafsirSetSendLoading(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sendBtn = document.getElementById('aiTafsirSend');
  const inputEl = document.getElementById('aiTafsirInput');
  const closeBtn = document.getElementById('aiTafsirClose');
  const newChatBtn = document.getElementById('aiTafsirNewChat');
  const historyBtn = document.getElementById('aiTafsirHistoryBtn');
  const historyCloseBtn = document.getElementById('aiTafsirHistoryClose');
  const chatEl = document.getElementById('aiTafsirChat');

  if(chatEl){
    chatEl.setAttribute('role', 'log');
    chatEl.setAttribute('aria-live', 'polite');
    chatEl.addEventListener('scroll', aiTafsirUpdateScrollFab);
  }

  const scrollFab = document.getElementById('aiTafsirScrollBottom');
  if(scrollFab){
    scrollFab.onclick = () => {
      const body = document.getElementById('aiTafsirChat');
      if(body) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
    };
  }

  if(inputEl){
    inputEl.maxLength = AIT_MAX_CHARS;

    // টেক্সটএরিয়াকে একটা wrapper এর ভেতরে ঢুকিয়ে সেখানে ক্যারেক্টার-কাউন্টার
    // বসানো হয় — pure JS দিয়ে DOM নোড সরানো হচ্ছে, index.html ছোঁয়া হয়নি;
    // existing event listeners (যেগুলো নিচে বসছে) এই মুভের পরেও ঠিক থাকে।
    const wrap = document.createElement('div');
    wrap.className = 'ait-input-wrap';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);
    const counter = document.createElement('span');
    counter.id = 'aiTafsirCharCount';
    counter.className = 'ait-char-count';
    wrap.appendChild(counter);

    inputEl.addEventListener('input', () => { aiTafsirResizeInput(); aiTafsirUpdateCharCount(); });
    inputEl.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendAiTafsirQuestion(); }
    });
  }

  if(sendBtn) sendBtn.onclick = aiTafsirHandleSendClick;
  if(closeBtn) closeBtn.onclick = () => closeModal('aiTafsirModal');
  // নতুন আলোচনা: চলতি মোড (আয়াত-প্রসঙ্গ থাকলে সেটা রেখেই, নাহলে সাধারণ)
  // অক্ষুণ্ণ রেখে একদম টাটকা চ্যাট শুরু করে।
  if(newChatBtn) newChatBtn.onclick = () => openAiTafsirModal(aiTafsirCurrentAyah);
  if(historyBtn) historyBtn.onclick = () => aiTafsirToggleHistoryPanel();
  if(historyCloseBtn) historyCloseBtn.onclick = () => aiTafsirToggleHistoryPanel(false);
  if(typeof wireModalBackdrop === 'function') wireModalBackdrop('aiTafsirModal');
});
