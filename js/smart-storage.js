// ---------- স্মার্ট স্টোরেজ ম্যানেজমেন্ট (js/smart-storage.js) ----------
// প্রেক্ষাপট: js/auto-offline.js নীরবে ব্যাকগ্রাউন্ডে পুরো ১১৪ সূরার অডিও
// ডাউনলোড করে রাখে যাতে পুরো অ্যাপ সম্পূর্ণ অফলাইনে চলে। কিন্তু ডিভাইসের
// স্টোরেজ কোটা প্রায় শেষ হয়ে গেলে ব্রাউজার নিজে থেকেই (persist() রিকোয়েস্ট
// করা সত্ত্বেও কোনো গ্যারান্টি ছাড়াই) যেকোনো ক্যাশ এলোমেলোভাবে মুছে দিতে
// পারে — যার ফলে সবচেয়ে বেশি শোনা সূরাটাও হঠাৎ অফলাইনে অদৃশ্য হয়ে যেতে পারে।
//
// এই মডিউল তা আগেই ঠেকায়: কোটার কাছাকাছি পৌঁছালে সবচেয়ে কম-সাম্প্রতিক
// ব্যবহৃত (LRU) সূরাগুলো নিজে থেকেই সরিয়ে জায়গা খালি করে — ব্রাউজারের
// এলোমেলো eviction-এর বদলে অ্যাপ নিজেই নিয়ন্ত্রিতভাবে সিদ্ধান্ত নেয় কোনটা
// রাখবে, কোনটা সরাবে। বর্তমানে চলমান/সাম্প্রতিক সূরা কখনো সরানো হয় না, এবং
// একটা ন্যূনতম সংখ্যক সূরা সবসময় অক্ষত রাখা হয়।

const SMART_STORAGE_HIGH_WATER = 0.90; // ব্যবহার এর বেশি হলে eviction শুরু হবে
const SMART_STORAGE_LOW_WATER  = 0.75; // এই স্তরে নামা পর্যন্ত eviction চলবে
const SMART_STORAGE_KEEP_MIN   = 5;    // অন্তত এতগুলো সূরা সবসময় অফলাইনে থাকবে

async function smartStorageEstimate(){
  if(!(navigator.storage && navigator.storage.estimate)) return null;
  try{ return await navigator.storage.estimate(); }catch(e){ return null; }
}

// একটি সূরার অডিও প্লে/ডাউনলোড হলে তার "সর্বশেষ ব্যবহার" সময় আপডেট করা হয় —
// eviction-এর সময় কোনটা "কম-ব্যবহৃত" তা বিচার করার একমাত্র ভিত্তি এটাই।
function touchOfflineSurah(surahNum){
  if(!Array.isArray(state.offlineSurahs)) return;
  const entry = state.offlineSurahs.find(o => o.surah === surahNum);
  if(!entry) return;
  entry.ts = Date.now();
  try{ IDBKV.set(LS_KEYS.offlineSurahs, JSON.stringify(state.offlineSurahs)); }catch(e){}
}

let smartStorageChecking = false;

// কোটার কাছাকাছি পৌঁছেছে কিনা যাচাই করে, দরকার হলে সবচেয়ে দীর্ঘদিন
// অব্যবহৃত অফলাইন সূরাগুলো একে একে সরিয়ে জায়গা খালি করে। নিরাপদ স্তরে
// (LOW_WATER) নামলেই থেমে যায়, একেবারে সব মুছে দেয় না।
async function smartStorageCheck(){
  if(smartStorageChecking) return { evicted: 0 };
  smartStorageChecking = true;
  try{
    const est = await smartStorageEstimate();
    if(!est || !est.quota) return { evicted: 0 };
    if((est.usage||0) / est.quota < SMART_STORAGE_HIGH_WATER) return { evicted: 0 };
    if(!Array.isArray(state.offlineSurahs) || state.offlineSurahs.length <= SMART_STORAGE_KEEP_MIN){
      return { evicted: 0 };
    }

    const currentlyPlaying = (state.playlist[state.playIndex] || {}).surah;
    const protectedSurahs = new Set([currentlyPlaying, state.lastRead && state.lastRead.surah].filter(Boolean));
    const candidates = state.offlineSurahs
      .filter(o => !protectedSurahs.has(o.surah))
      .sort((a, b) => (a.ts||0) - (b.ts||0)); // সবচেয়ে পুরনো/কম-ব্যবহৃত আগে

    let evicted = 0;
    for(const entry of candidates){
      if(state.offlineSurahs.length <= SMART_STORAGE_KEEP_MIN) break;
      const now = await smartStorageEstimate();
      if(!now || !now.quota || (now.usage||0) / now.quota < SMART_STORAGE_LOW_WATER) break;
      await removeSurahOffline(entry.surah);
      evicted++;
    }

    if(evicted > 0){
      if(typeof showToast === 'function'){
        showToast(`📦 ডিভাইসের জায়গা কমে যাওয়ায় কম-ব্যবহৃত ${toBn(evicted)}টি সূরার অফলাইন অডিও স্বয়ংক্রিয়ভাবে সরানো হয়েছে`);
      }
      if(typeof dlmRenderSummary === 'function' && document.getElementById('dlmHero')) dlmRenderSummary();
    }
    return { evicted };
  } finally {
    smartStorageChecking = false;
  }
}

// অ্যাপ চালু হওয়ার সময় একবার, এবং ইন্টারনেট ফিরে এলে আবার (তখনই মূলত
// ব্যাকগ্রাউন্ডে নতুন অডিও ক্যাশ হতে শুরু করে) — কোটা চেক করা হয়।
function initSmartStorage(){
  if(!(navigator.storage && navigator.storage.estimate)) return;
  smartStorageCheck();
  window.addEventListener('online', () => smartStorageCheck());
}