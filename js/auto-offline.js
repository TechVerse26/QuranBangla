// ---------- স্মার্ট অটো-অফলাইন ক্যাশ ইঞ্জিন (js/auto-offline.js) ----------
// লক্ষ্য: ইউজারকে "ডাউনলোড ম্যানেজার" খুঁজে গিয়ে বাটনে চাপতে হবে না —
// অ্যাপ নিজে থেকেই, চুপচাপ ব্যাকগ্রাউন্ডে, ধীরে ধীরে পুরো কুরআনের টেক্সট ও
// (বর্তমানে বাছাই করা ক্বারীর) অডিও ক্যাশ করে ফেলবে, যাতে একদম সম্পূর্ণ
// অফলাইনেও পুরো অ্যাপ কাজ করে।
//
// এটা একই cache/state ব্যবহার করে যা ডাউনলোড ম্যানেজার (js/download-manager.js)
// আগে থেকেই ব্যবহার করে — একই AUDIO_CACHE_NAME, একই state.offlineSurahs,
// একই markSurahOffline/isSurahOffline। তাই এই নীরব ব্যাকগ্রাউন্ড কাজ আর
// ম্যানুয়াল ডাউনলোড বাটন — দুটোই একই single source of truth-এর উপর কাজ করে;
// কোনো সূরা দুইবার ডাউনলোড হয় না।
//
// "স্মার্ট" মানে:
//  - শুধু ইন্টারনেট থাকলেই চলে, এবং ডেটা-সেভার মোড চালু থাকলে থামে
//  - সম্ভব হলে ধীর/মোবাইল-ডেটা কানেকশনে চালায় না (Wi-Fi/ভালো কানেকশনেই)
//  - একবারে সব না নিয়ে একটার পর একটা সূরা, মাঝে ছোট বিরতি দিয়ে — যাতে UI/ব্যাটারি/ডেটা
//    কোনোটাতেই চাপ না পড়ে
//  - বন্ধ হয়ে গেলে (ট্যাব বন্ধ, অফলাইন হয়ে যাওয়া) ঠিক যেখানে থেমেছিল, সেখান
//    থেকেই পরের বার আবার শুরু হয় — শুরু থেকে না
//  - ইন্টারনেট আবার ফিরে এলে (online ইভেন্ট) নিজে থেকেই আবার চালু হয়ে যায়

const AUTO_OFFLINE_CURSOR_KEY = 'qr_auto_offline_cursor'; // সর্বশেষ সম্পূর্ণ হওয়া সূরা নম্বর
const AUTO_OFFLINE_STEP_DELAY_MS = 900; // প্রতি সূরার পর ছোট বিরতি
let autoOfflineRunning = false;
let autoOfflineNotifiedStart = false;

// ---------- কানেকশন-সচেতনতা: ডেটা-সেভার/স্লো কানেকশনে চালাবে না ----------
function autoOfflineNetworkLooksSafe(){
  if(!navigator.onLine) return false;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if(conn){
    if(conn.saveData) return false; // ইউজারের ডেটা-সেভার মোড সম্মান করা
    if(conn.type && !['wifi', 'ethernet'].includes(conn.type)){
      // মোবাইল ডেটা/অজানা টাইপ হলে শুধু effectiveType ভালো থাকলেই এগোবে
      if(conn.effectiveType && ['slow-2g', '2g', '3g'].includes(conn.effectiveType)) return false;
    }
  }
  return true;
}

function getAutoOfflineCursor(){
  try{
    const raw = IDBKV.get(AUTO_OFFLINE_CURSOR_KEY);
    return raw ? JSON.parse(raw) : 0;
  }catch(e){ return 0; }
}
function setAutoOfflineCursor(n){
  try{ IDBKV.set(AUTO_OFFLINE_CURSOR_KEY, JSON.stringify(n)); }catch(e){}
}

// ---------- মূল এন্ট্রি পয়েন্ট: js/sidebar.js এর fetchSurahList() সফল হওয়ার
// পর একবার কল হয় (state.surahList ততক্ষণে রেডি থাকে) ----------
async function initAutoOfflineCache(){
  if(autoOfflineRunning) return;
  if(!('caches' in window)) return; // এই ব্রাউজারে অফলাইন ক্যাশ সাপোর্ট নেই
  if(typeof dlmBulkRunning !== 'undefined' && dlmBulkRunning) return; // ম্যানুয়াল বাল্ক-ডাউনলোড ইতিমধ্যে চলছে
  if(!state.surahList || !state.surahList.length) return;
  if(!autoOfflineNetworkLooksSafe()) return;

  const totalTarget = state.surahList.length || 114;
  if((state.offlineSurahs||[]).length >= totalTarget) return; // ইতিমধ্যে সম্পূর্ণ

  autoOfflineRunning = true;
  runAutoOfflineLoop();
}

async function runAutoOfflineLoop(){
  const startCursor = getAutoOfflineCursor();
  if(!autoOfflineNotifiedStart && startCursor === 0){
    autoOfflineNotifiedStart = true;
    if(typeof showToast === 'function'){
      showToast('আপনাদের সুবিধার জন্য সম্পূর্ণ অটো অফলাইন সাপোর্ট সুবিধা করা হয়েছে');
    }
  }

  for(const s of state.surahList){
    if(s.number <= startCursor && isSurahOffline(s.number)) continue;
    if(!autoOfflineNetworkLooksSafe()){
      // ইন্টারনেট চলে গেছে বা কানেকশন খারাপ — এখানেই থেমে যাওয়া, পরের
      // 'online' ইভেন্টে বা পরের অ্যাপ-লোডে ঠিক এখান থেকেই আবার চলবে।
      autoOfflineRunning = false;
      return;
    }
    if(typeof dlmBulkRunning !== 'undefined' && dlmBulkRunning){
      // ইউজার নিজেই ম্যানুয়ালি ডাউনলোড ম্যানেজার থেকে বাল্ক-ডাউনলোড চালু
      // করেছে — দুটো একসাথে না চালিয়ে সরে যাওয়া, দ্বন্দ্ব এড়াতে।
      autoOfflineRunning = false;
      return;
    }
    if(!isSurahOffline(s.number)){
      // নতুন সূরা ক্যাশ করার আগে স্টোরেজ কোটা যাচাই — কাছাকাছি পৌঁছে গেলে
      // js/smart-storage.js সবচেয়ে কম-ব্যবহৃত পুরনো সূরাগুলো নিজে থেকেই
      // সরিয়ে জায়গা খালি করে, যাতে ব্রাউজার এলোমেলোভাবে ক্যাশ না মোছে।
      if(typeof smartStorageCheck === 'function') await smartStorageCheck();
      try{
        const globalNumbers = await dlmFetchGlobalNumbers(s.number);
        const urls = dlmAudioUrls(globalNumbers, state.reciter, s.number);
        await dlmCacheUrlsAwait(urls);
        markSurahOffline(s.number, state.reciter, urls, urls.length);
        if(typeof dlmRenderSummary === 'function' && document.getElementById('dlmHero')){
          dlmRenderSummary(); // ডাউনলোড ম্যানেজার খোলা থাকলে লাইভ আপডেট দেখাবে
        }
      }catch(e){
        // এই সূরাটা এই মুহূর্তে ব্যর্থ হয়েছে (নেটওয়ার্ক/API সমস্যা) — কার্সার
        // এগিয়ে না নিয়ে পরের রানে এটা থেকেই আবার চেষ্টা করা হবে।
        autoOfflineRunning = false;
        return;
      }
    }
    setAutoOfflineCursor(s.number);
    await new Promise(resolve => setTimeout(resolve, AUTO_OFFLINE_STEP_DELAY_MS));
  }

  autoOfflineRunning = false;
  if(typeof showToast === 'function'){
    showToast('✅ সম্পূর্ণ কুরআন এখন সম্পূর্ণ অফলাইনে পড়া ও শোনা যাবে');
  }
}

// ইন্টারনেট আবার ফিরে এলে, আগে থামা থাকলে নিজে থেকেই আবার শুরু হয়ে যায়।
window.addEventListener('online', () => {
  if(!autoOfflineRunning) initAutoOfflineCache();
});
