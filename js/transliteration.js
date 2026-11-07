// ---------- আরবি → বাংলা উচ্চারণ (Approximate phonetic transliteration) ----------
// এটি কোনো একাডেমিক/স্কলারলি ট্রান্সলিটারেশন স্ট্যান্ডার্ড নয় — css/tajweed.js এর
// "approximate tajweed highlighting" যেমন নিছক একটি ভিজ্যুয়াল সহায়ক, ঠিক তেমনি
// এটিও একটি রুল-বেসড, ক্যারেক্টার-বাই-ক্যারেক্টার আনুমানিক উচ্চারণ সহায়ক —
// যারা আরবি হরফ চিনতে পারেন না তাদের জন্য মোটামুটি কাছাকাছি শব্দ-উচ্চারণ দেখানোর
// উদ্দেশ্যে। কোনো নেটওয়ার্ক/API কল লাগে না — সম্পূর্ণ ক্লায়েন্ট-সাইড, তাই
// অফলাইনেও কাজ করে (অ্যাপের অফলাইন-ফার্স্ট দর্শনের সাথে সামঞ্জস্যপূর্ণ)।

const AR_TO_BN_MAP = {
  // Hamza / Alif
  'ء':'', 'أ':'আ', 'إ':'ই', 'آ':'আ', 'ا':'আ',
  // Letters
  'ب':'ব', 'ت':'ত', 'ث':'স', 'ج':'জ', 'ح':'হ', 'خ':'খ',
  'د':'দ', 'ذ':'য', 'ر':'র', 'ز':'য', 'س':'স', 'ش':'শ',
  'ص':'স', 'ض':'দ', 'ط':'ত', 'ظ':'য', 'ع':'আ', 'غ':'গ',
  'ف':'ফ', 'ق':'ক', 'ك':'ক', 'ل':'ল', 'م':'ম', 'ن':'ন',
  'ه':'হ', 'و':'ও', 'ي':'ই', 'ة':'হ', 'ى':'আ', 'ئ':'ই', 'ؤ':'উ',
  // লাম-আলিফ লিগেচার
  'ﻻ':'লা', 'ﻷ':'লা', 'ﻹ':'লি', 'ﻵ':'লা',
  // Short vowel diacritics (harakat) — এগুলো নিজে থেকে স্বরধ্বনি যোগ করে,
  // পূর্ববর্তী ব্যঞ্জনবর্ণকে e/i/o স্বরে রূপান্তর করার জন্য নিচে আলাদাভাবে
  // হ্যান্ডেল করা হয়েছে (তাই এখানে শুধু ম্যাপিং টেবিলের রেফারেন্স হিসেবে রাখা)
  'َ':'a', 'ِ':'i', 'ُ':'u', 'ْ':'', 'ّ':'shadda', 'ً':'an', 'ٍ':'in', 'ٌ':'un', 'ـ':''
};

const AR_DIACRITICS_RE = /[\u064B-\u0652\u0670\u06D6-\u06ED]/;

function transliterateArabicWord(word){
  if(!word) return '';
  let out = '';
  const chars = Array.from(word);
  for(let i = 0; i < chars.length; i++){
    const ch = chars[i];
    if(ch === 'ّ'){ // শাদ্দাহ — সরল পদ্ধতি: শেষ বাংলা অক্ষরের সাথে হসন্ত+পুনরাবৃত্তি দিয়ে দ্বিত্ব বোঝানো
      if(out.length) out += '্' + out[out.length-1];
      continue;
    }
    if(AR_DIACRITICS_RE.test(ch)){
      // স্বরচিহ্ন — নিজে থেকে দৃশ্যমান অক্ষর যোগ করে না, উচ্চারণ কাছাকাছি
      // রাখতে ফাতহা/কাসরা/দাম্মা উপেক্ষা করা হয় (বাংলা হরফের অন্তর্নিহিত
      // "অ/আ" স্বরই কাছাকাছি ধ্বনি দেয়), শুধু তানভীন যোগ করি।
      if(ch === 'ً') out += 'ন';
      else if(ch === 'ٍ') out += 'নি';
      else if(ch === 'ٌ') out += 'ন';
      continue;
    }
    const mapped = AR_TO_BN_MAP[ch];
    if(mapped !== undefined) out += mapped;
    else if(/\s/.test(ch)) out += ch;
    // অজানা/যতিচিহ্ন অক্ষর হলে বাদ দেওয়া হয় (যেমন কুরআনিক স্টপ-সাইন প্রতীক)
  }
  return out || '';
}

// পুরো একটি আয়াতের আরবি টেক্সট (স্পেস দিয়ে আলাদা করা শব্দ) কে বাংলা
// হরফে উচ্চারণে রূপান্তর করে — প্রতিটি শব্দ আলাদাভাবে প্রসেস করে মাঝে
// এক স্পেস দিয়ে জোড়া লাগানো হয়।
const _translitCache = new Map();
function transliterateArabic(arabicText){
  if(!arabicText) return '';
  if(_translitCache.has(arabicText)) return _translitCache.get(arabicText);
  const result = arabicText.trim().split(/\s+/)
    .map(w => transliterateArabicWord(w))
    .filter(Boolean)
    .join(' ');
  if(_translitCache.size > 2000) _translitCache.clear(); // সরল ক্যাশ-সাইজ গার্ড
  _translitCache.set(arabicText, result);
  return result;
}
