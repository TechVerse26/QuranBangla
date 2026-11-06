// api/ai-tafsir.js
// Vercel Serverless Function — Deploy path: POST /api/ai-tafsir
//
// js/ai-tafsir.js (ব্রাউজার) শুধু এখানে প্রশ্ন পাঠায় আর উত্তর দেখায়।
// আসল Gemini API কলটা এই ফাইলেই (সার্ভারে) হয় — তাই GEMINI_API_KEY
// কখনো ব্রাউজারে/ক্লায়েন্ট কোডে যায় না।
//
// প্রয়োজনীয় প্যাকেজ: firebase-admin (root package.json-এ আগে থেকেই আছে,
// নতুন কিছু npm install করার দরকার নেই)।
//
// প্রয়োজনীয় Environment Variables (Vercel Dashboard → Settings →
// Environment Variables → Production ও Preview দুই জায়গাতেই):
//   GEMINI_API_KEY             -> https://aistudio.google.com থেকে ফ্রি key
//   FIREBASE_SERVICE_ACCOUNT   -> আগে থেকেই থাকার কথা (send-reset-email.js
//                                 ফিচারের জন্য বসানো হয়েছিল); এখানেও
//                                 সাইন-ইন যাচাই ও দৈনিক প্রশ্ন-সংখ্যা
//                                 গোনার জন্য ব্যবহৃত হয়।
//
// env variable যোগ/পরিবর্তনের পর Vercel-এ Redeploy বাধ্যতামূলক —
// নাহলে চলমান ডিপ্লয়মেন্ট নতুন variable দেখতে পাবে না।
//
// ==== এই আপডেটে যা ঠিক হয়েছে ====
// ১) FIREBASE_SERVICE_ACCOUNT না থাকলে বা ভুল ফরম্যাটে থাকলে আগে পুরো
//    ফাংশনটাই ক্র্যাশ করে HTML/খালি এরর পেজ দিত (JSON.parse module-এর
//    টপ-লেভেলে ছিল) — ব্রাউজারে তখন res.json() পার্স ব্যর্থ হয়ে
//    "ইন্টারনেট সংযোগ পরীক্ষা করুন" জাতীয় ভুল বার্তা দেখাতো, আসল কারণ
//    (কনফিগ মিসিং) কখনো বোঝা যেতো না। এখন এটা try/catch দিয়ে ধরা হয় এবং
//    পরিষ্কার JSON এরর (`not_configured`) ফেরত দেয়।
// ২) FIREBASE_SERVICE_ACCOUNT পেস্ট করার সময় private_key এর ভেতরের
//    নিউলাইন (\n) মাঝে মাঝে literal দুই-ক্যারেক্টার ব্যাকস্ল্যাশ-n হয়ে
//    যায় (Vercel dashboard এ পেস্ট করার সময়) — এতে admin.credential.cert
//    ব্যর্থ হয়। এখন সেটা স্বয়ংক্রিয়ভাবে ঠিক করে নেয়।
// ৩) গুগল প্রায়ই ফ্রি মডেলের নাম/লাইনআপ বদলায় বা বন্ধ করে দেয় (যেমন
//    gemini-2.5-flash ১৬ অক্টোবর ২০২৬-এ বন্ধ হয়ে যাচ্ছে)। আগে একটামাত্র
//    মডেল নাম হার্ডকোড ছিল — সেটা বন্ধ/পরিবর্তন হলেই পুরো ফিচার মরে
//    যেতো। এখন একটা লিস্ট আছে — একটা মডেল ব্যর্থ হলে (৪০৪/কোটা/অন্য
//    এরর) সাথে সাথে পরেরটা স্বয়ংক্রিয়ভাবে ট্রাই হয়, ইউজার কিছুই টের
//    পায় না। ভবিষ্যতে গুগল আবার নাম বদলালেও অ্যাপ নিজে থেকেই সামলে
//    নেবে যতক্ষণ লিস্টের অন্তত একটা মডেল চালু থাকে।
// ৪) (নতুন) প্রতিটা উত্তর এখন Gemini-র structured output (responseSchema)
//    দিয়ে চাওয়া হয় — তাই একটাই কলে answer টেক্সটের পাশাপাশি (প্রাসঙ্গিক
//    হলে) একটা diagram অবজেক্ট (timeline/tree/compare/steps/list) আর ৩টা
//    প্রসঙ্গ-ভিত্তিক ফলো-আপ suggestions ফেরত আসে। JSON parse ব্যর্থ হলে
//    (খুবই বিরল, নিচে parseStructuredAnswer দেখুন) পুরো raw টেক্সটটাই
//    answer হিসেবে ব্যবহার হয় — অর্থাৎ diagram/suggestions না থাকলেও
//    মূল উত্তর দেওয়া কখনো ভেঙে পড়ে না।
// ৫) (নতুন) সাইন-ইন ছাড়া (অতিথি, deviceId ভিত্তিক) প্রশ্নের সীমা আগে
//    সাইন-ইন করা ইউজারদের মতোই DAILY_LIMIT (দৈনিক ২০টা) ছিল — এখন আলাদা,
//    অনেক ছোট, দৈনিক-না-হয়ে-সর্বমোট GUEST_LIMIT (নিচে দেখুন), একদম আলাদা
//    Firestore কালেকশনে (ai_tafsir_guest_usage, কোনো তারিখ-সাফিক্স ছাড়া)
//    ট্র্যাক হয়। সীমা শেষ হলে নতুন error code 'guest_limit_reached' ফেরত
//    যায় (আগের 'rate_limited' থেকে আলাদা, যাতে ফ্রন্টএন্ড দুটো ক্ষেত্রে
//    আলাদা বার্তা/সাইন-ইন CTA দেখাতে পারে — দেখুন js/ai-tafsir.js)। সাইন-ইন
//    করা ইউজারদের (uid ভিত্তিক) দৈনিক DAILY_LIMIT ফ্লো অপরিবর্তিত।

const admin = require('firebase-admin');

// ---------- Firebase Admin init (ক্র্যাশ-প্রুফ) ----------
let firebaseInitError = null;
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env variable খালি/নেই');
    const svc = JSON.parse(raw);
    // Vercel dashboard-এ পেস্ট করার সময় private_key এর নিউলাইন মাঝে মাঝে
    // literal "\n" (ব্যাকস্ল্যাশ + n) থেকে যায় — থাকলে আসল নিউলাইনে বদলে দিন।
    if (svc && typeof svc.private_key === 'string') {
      svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } catch (e) {
    firebaseInitError = e;
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// ---------- Gemini মডেল — ফলব্যাক লিস্ট (উপর থেকে নিচে ক্রমানুসারে ট্রাই হয়) ----------
// গুগল ফ্রি মডেল প্রায়ই বদলায়/বন্ধ করে — একটা ব্যর্থ হলে পরেরটা অটো ট্রাই হয়।
// সবগুলো ব্যর্থ হলে aistudio.google.com এ গিয়ে বর্তমান ফ্রি মডেলের নাম
// দেখে এই লিস্টের উপরে নতুন একটা লাইন যোগ করে দিলেই চলবে।
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite', // স্থিতিশীল, ফ্রি (billing লাগে না) — কমপক্ষে মে ২০২৭ পর্যন্ত
  'gemini-3.5-flash-lite', // নতুন স্থিতিশীল ভার্সন, ফ্রি — কমপক্ষে জুলাই ২০২৭ পর্যন্ত
  'gemini-2.5-flash',      // পুরনো মডেল, ১৬ অক্টোবর ২০২৬-এ বন্ধ হবে — ততদিন ব্যাকআপ হিসেবে
  'gemini-flash-latest',   // গুগলের অটো-আপডেট alias — উপরের সব ব্যর্থ হলে শেষ ভরসা
];
const DAILY_LIMIT = 20; // সাইন-ইন করা ইউজার প্রতি দৈনিক প্রশ্নের সীমা (Firebase uid ভিত্তিক, প্রতিদিন রিসেট হয়)
const GUEST_LIMIT = 2;  // সাইন-ইন ছাড়া (অতিথি, deviceId ভিত্তিক) সর্বমোট প্রশ্নের সীমা — দৈনিক না, একবারই; এরপর সাইন-ইন/অ্যাকাউন্ট প্রয়োজন

const SYSTEM_PROMPT = `আপনি একজন বিনয়ী ও জ্ঞানী ইসলামিক সহকারী। কুরআনের আয়াত ও ইসলামী বিষয়ে সহজ, নির্ভরযোগ্য বাংলা ভাষায় উত্তর দিন। উত্তর সংক্ষিপ্ত ও প্রাসঙ্গিক রাখুন। নিশ্চিত না হলে স্পষ্টভাবে সেটা জানান এবং একজন আলেমের সাথে পরামর্শ করার পরামর্শ দিন।

আপনার উত্তর অবশ্যই নিচের তিনটা অংশে (JSON schema অনুযায়ী) গঠিত হতে হবে:

১) "answer" — মূল উত্তর। প্রয়োজন অনুযায়ী **বোল্ড**, "- " দিয়ে বুলেট লিস্ট, "১. "/"1. " দিয়ে নাম্বার লিস্ট, আর খালি লাইন দিয়ে প্যারাগ্রাফ আলাদা করতে পারেন — এটাই একমাত্র সাপোর্টেড ফরম্যাটিং, অন্য কোনো মার্কডাউন/HTML ব্যবহার করবেন না।

২) "diagram" — শুধু তখনই দিন যখন একটা ভিজ্যুয়াল সত্যিই বোঝাপড়া সহজ করে দেবে; বেশিরভাগ উত্তরেই এটা null থাকা উচিত। পাঁচটা ধরনের মধ্যে সবচেয়ে উপযুক্তটা বেছে নিন —
  · timeline: ঐতিহাসিক ঘটনাক্রম বা নাযিলের প্রেক্ষাপট (item: label=সময়/পর্ব, desc=ঘটনা)
  · tree: বংশ/সম্পর্ক/নবীদের ধারাবাহিকতা (item: label=মূল ব্যক্তি, sub=সরাসরি-সম্পর্কিত নামের তালিকা)
  · compare: দুইটা বিষয়/মত/ধারণার তুলনা (columns: [বাম শিরোনাম, ডান শিরোনাম], item: label=তুলনার বিষয়, left ও right=দুই পাশের মান)
  · steps: কোনো ইবাদত/আমলের ধারাবাহিক ধাপ (item: label=ধাপের নাম, desc=বিস্তারিত)
  · list: গণনাযোগ্য বিষয়ের তালিকা — রুকন/প্রকারভেদ/নাম ইত্যাদি (item: label=নাম, desc=সংক্ষিপ্ত ব্যাখ্যা)
  সর্বোচ্চ ৬টা item রাখুন, প্রতিটা label/desc এক লাইনের মতো সংক্ষিপ্ত রাখুন।

৩) "suggestions" — এই আলাপের ধারাবাহিকতায় ব্যবহারকারী স্বাভাবিকভাবে যা জিজ্ঞাসা করতে পারে এমন ৩টা ছোট, সুনির্দিষ্ট প্রশ্ন। সবসময় কুরআন/ইসলাম বিষয়ে — এই আয়াত/প্রসঙ্গের গভীরে যায় এমন প্রশ্ন — কখনো এর বাইরের কোনো বিষয় (সাধারণ প্রযুক্তি, বিনোদন, রাজনীতি ইত্যাদি) সাজেস্ট করবেন না, আর এই কথোপকথনে আগে করা কোনো প্রশ্নের হুবহু পুনরাবৃত্তি করবেন না।`;

// ---------- Structured output schema — Gemini প্রতিটা উত্তর এই গঠনেই ফেরত দেয় ----------
// (দেখুন https://ai.google.dev/gemini-api/docs/structured-output)
const AIT_DIAGRAM_TYPES = ['timeline', 'tree', 'compare', 'steps', 'list'];

const AIT_DIAGRAM_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    label: { type: 'STRING' },
    desc: { type: 'STRING', nullable: true },
    left: { type: 'STRING', nullable: true },
    right: { type: 'STRING', nullable: true },
    sub: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
  },
  required: ['label'],
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    diagram: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        type: { type: 'STRING', enum: AIT_DIAGRAM_TYPES },
        title: { type: 'STRING' },
        columns: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
        items: { type: 'ARRAY', items: AIT_DIAGRAM_ITEM_SCHEMA },
      },
      required: ['type', 'title', 'items'],
      propertyOrdering: ['type', 'title', 'columns', 'items'],
    },
    suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['answer', 'suggestions'],
  propertyOrdering: ['answer', 'diagram', 'suggestions'],
};

// ---------- diagram/suggestions sanitize — Gemini schema মেনে চললেও সার্ভার-সাইডে
// আরেকবার সীমা বেঁধে দেওয়া হয় (defense-in-depth, বাকি এন্ডপয়েন্টের প্যাটার্নের মতোই) ----------
function sanitizeDiagram(d) {
  if (!d || typeof d !== 'object' || !AIT_DIAGRAM_TYPES.includes(d.type)) return null;
  const items = (Array.isArray(d.items) ? d.items : [])
    .slice(0, 8)
    .map((it) => {
      if (!it || typeof it !== 'object' || !it.label) return null;
      const out = { label: String(it.label).slice(0, 80) };
      if (it.desc) out.desc = String(it.desc).slice(0, 220);
      if (it.left) out.left = String(it.left).slice(0, 120);
      if (it.right) out.right = String(it.right).slice(0, 120);
      if (Array.isArray(it.sub) && it.sub.length) {
        out.sub = it.sub.slice(0, 6).map((s) => String(s).slice(0, 60));
      }
      return out;
    })
    .filter(Boolean);
  if (!items.length) return null;

  const out = { type: d.type, title: String(d.title || '').slice(0, 80), items };
  if (Array.isArray(d.columns) && d.columns.length) {
    out.columns = d.columns.slice(0, 2).map((c) => String(c).slice(0, 30));
  }
  return out;
}

function sanitizeSuggestions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 4)
    .map((s) => s.trim().slice(0, 140));
}

// Gemini JSON mode-এও মাঝে মাঝে ```json ... ``` কোড-ফেন্সে মুড়ে দেয় — ছেঁটে ফেলা হয়।
// JSON.parse ব্যর্থ হলে পুরো raw টেক্সটটাকেই answer ধরে নেওয়া হয়, যাতে diagram/
// suggestions অংশ ছাড়া হলেও মূল উত্তরটা কখনো ভেঙে না পড়ে।
function parseStructuredAnswer(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && typeof parsed.answer === 'string' && parsed.answer.trim()) {
      return {
        answer: parsed.answer.trim(),
        diagram: sanitizeDiagram(parsed.diagram),
        suggestions: sanitizeSuggestions(parsed.suggestions),
      };
    }
  } catch (e) { /* নিচে raw টেক্সট দিয়েই fallback */ }
  return { answer: cleaned, diagram: null, suggestions: [] };
}

function todayKeyDhaka() {
  // এশিয়া/ঢাকা সময় অনুযায়ী "আজ" — দিন বদল বাংলাদেশ সময়ের মধ্যরাতে হয়,
  // UTC মধ্যরাতে না। en-CA লোকেল সরাসরি YYYY-MM-DD ফরম্যাট দেয়।
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// একটা নির্দিষ্ট মডেল দিয়ে Gemini কল করে — সফল হলে answer টেক্সট, নাহলে null
async function tryOneModel(model, contents) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    }
  );
  const geminiData = await geminiRes.json().catch(() => ({}));
  const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
  const rawText = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map((p) => p.text || '').join('').trim()
    : '';

  if (!geminiRes.ok || !rawText) {
    return { ok: false, status: geminiRes.status, data: geminiData };
  }
  const structured = parseStructuredAnswer(rawText);
  if (!structured.answer) {
    return { ok: false, status: geminiRes.status, data: geminiData };
  }
  return { ok: true, ...structured };
}

// GEMINI_MODELS লিস্ট ক্রমানুসারে ট্রাই করে — প্রথমটা ব্যর্থ হলে পরেরটা,
// এভাবে যতক্ষণ না একটা কাজ করে বা লিস্ট শেষ হয়ে যায়।
async function askGeminiWithFallback(contents) {
  let lastFailure = null;
  for (const model of GEMINI_MODELS) {
    try {
      const result = await tryOneModel(model, contents);
      if (result.ok) {
        return { answer: result.answer, diagram: result.diagram, suggestions: result.suggestions, modelUsed: model };
      }
      // Vercel Dashboard → Project → Logs-এ এই লাইনটা দেখলে কোন মডেল কেন
      // ব্যর্থ হলো (ভুল নাম, কোটা শেষ, বিলিং লাগবে ইত্যাদি) বোঝা যাবে
      console.error(`ai-tafsir: model "${model}" ব্যর্থ, status ${result.status}`, JSON.stringify(result.data).slice(0, 500));
      lastFailure = result;
    } catch (e) {
      console.error(`ai-tafsir: model "${model}" কল করতে গিয়ে এরর:`, e.message);
      lastFailure = { status: 0, data: { error: e.message } };
    }
  }
  return { answer: null, diagram: null, suggestions: [], failure: lastFailure };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST ব্যবহার করুন' });
  }

  if (!process.env.GEMINI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT || firebaseInitError || !db) {
    console.error(
      'ai-tafsir: not configured —',
      !process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY নেই' : '',
      !process.env.FIREBASE_SERVICE_ACCOUNT ? 'FIREBASE_SERVICE_ACCOUNT নেই' : '',
      firebaseInitError ? `Firebase init এরর: ${firebaseInitError.message}` : ''
    );
    return res.status(500).json({ error: 'not_configured' });
  }

  const { question, history, ayahContext, idToken, deviceId } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'প্রশ্ন দেওয়া হয়নি' });
  }

  // পরিচয় নির্ধারণ — সাইন-ইন থাকলে Firebase uid যাচাই করে, না থাকলে
  // anonymous deviceId ব্যবহৃত হয় (isGuest = true)
  let identityKey = null;
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      identityKey = `uid_${decoded.uid}`;
    } catch (e) {
      console.error('ai-tafsir: idToken যাচাই ব্যর্থ:', e.message);
    }
  }
  const isGuest = !identityKey;
  if (isGuest) {
    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(401).json({ error: 'পরিচয় শনাক্ত করা যায়নি, আবার চেষ্টা করুন' });
    }
    identityKey = `dev_${deviceId}`;
  }

  // সাইন-ইন করা ইউজার: প্রতিদিন রিসেট হওয়া DAILY_LIMIT (আগের মতোই, তারিখ-
  // সাফিক্সসহ ai_tafsir_usage এ)। অতিথি: ডিভাইস-প্রতি সর্বমোট GUEST_LIMIT —
  // কোনো তারিখ-সাফিক্স নেই (তাই দিন বদলালেও রিসেট হয় না), সম্পূর্ণ আলাদা
  // কালেকশনে (ai_tafsir_guest_usage), যাতে সাইন-ইন করা ইউজারদের দৈনিক
  // ডকুমেন্টের সাথে গুলিয়ে না যায়। আরও প্রশ্নের একমাত্র উপায় অ্যাকাউন্ট
  // খোলা/সাইন-ইন করা — দেখুন js/ai-tafsir.js এর অতিথি-সীমা গেট।
  const limit = isGuest ? GUEST_LIMIT : DAILY_LIMIT;
  const usageRef = isGuest
    ? db.collection('ai_tafsir_guest_usage').doc(identityKey)
    : db.collection('ai_tafsir_usage').doc(`${identityKey}_${todayKeyDhaka()}`);

  try {
    // সীমা — ট্রানজেকশনে গুনে বাড়ানো হয়, যাতে পরপর দ্রুত একাধিক রিকোয়েস্ট
    // (যেমন ডাবল-ট্যাপ) এলেও কেউ সীমা এড়িয়ে যেতে না পারে
    let newCount = null;
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const current = snap.exists ? (snap.data().count || 0) : 0;
      if (current >= limit) return false;
      newCount = current + 1;
      tx.set(usageRef, {
        count: newCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });

    if (!allowed) {
      return res.status(429).json({ error: isGuest ? 'guest_limit_reached' : 'rate_limited' });
    }

    // পূর্ববর্তী চ্যাট-হিস্ট্রি (সর্বোচ্চ শেষ ১০ টার্ন — টোকেন খরচ নিয়ন্ত্রণে)
    const contents = [];
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    for (const turn of trimmedHistory) {
      if (turn && (turn.role === 'user' || turn.role === 'model') && Array.isArray(turn.parts)) {
        const text = String((turn.parts[0] && turn.parts[0].text) || '').slice(0, 4000);
        if (text) contents.push({ role: turn.role, parts: [{ text }] });
      }
    }

    let questionText = question.trim().slice(0, 2000);
    if (ayahContext && typeof ayahContext === 'object' && ayahContext.arabic) {
      const surahBn = String(ayahContext.surahBn || '').slice(0, 200);
      const ayahNum = String(ayahContext.ayahNum || '').slice(0, 20);
      const arabic = String(ayahContext.arabic || '').slice(0, 1000);
      const translation = String(ayahContext.translation || '').slice(0, 2000);
      questionText = `[প্রসঙ্গ: ${surahBn} আয়াত ${ayahNum} — ${arabic}${translation ? ' — অনুবাদ: ' + translation : ''}]\n\n${questionText}`;
    }
    contents.push({ role: 'user', parts: [{ text: questionText }] });

    const { answer, diagram, suggestions } = await askGeminiWithFallback(contents);

    if (!answer) {
      // লিস্টের সবগুলো মডেলই ব্যর্থ হলে সীমা থেকে এই প্রশ্নটা ফেরত দিন —
      // Google/আমাদের সমস্যায় ইউজারের/অতিথির কোটা যেন নষ্ট না হয়
      await usageRef.set({ count: admin.firestore.FieldValue.increment(-1) }, { merge: true });
      return res.status(502).json({ error: 'upstream_error' });
    }

    const response = { answer, diagram: diagram || null, suggestions: suggestions || [] };
    // দুটোর মধ্যে শুধু একটাই ফেরত যায় (isGuest অনুযায়ী) — js/ai-tafsir.js
    // যেটা পায় সেই অনুযায়ী দৈনিক-কাউন্টার বা অতিথি-কাউন্টার আপডেট করে।
    if (isGuest) response.remainingGuestMessages = Math.max(0, limit - newCount);
    else response.remainingToday = Math.max(0, limit - newCount);
    return res.status(200).json(response);
  } catch (e) {
    console.error('ai-tafsir: unexpected error', e);
    return res.status(500).json({ error: 'server_error' });
  }
};
