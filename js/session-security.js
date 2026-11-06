// ---------- লগইন হিস্টোরি, ডিভাইস শনাক্তকরণ ও দূর থেকে লগ-আউট ----------
// প্রতিটি প্রকৃত সাইন-ইন/সাইন-আপ অ্যাকশনে (পেজ রিফ্রেশে persisted সেশন আবার
// লোড হলে নয়) Firestore-এ users/{uid}/sessions/{sessionId} ডকুমেন্টে একটি
// রেকর্ড লেখা হয় — ব্রাউজার, অপারেটিং সিস্টেম, ডিভাইস টাইপ, সংযোগের ধরন
// (ওয়াই-ফাই/মোবাইল ডেটা — শুধু ব্রাউজার যতটা প্রকাশ করে), আনুমানিক IP,
// শহর/দেশ ও ISP-এর নাম সহ। এরপর সেই ইমেইলে একটি নিরাপত্তা নোটিশ যায়।
//
// গুরুত্বপূর্ণ সীমাবদ্ধতা (সততার সাথে বলা দরকার, কোডে-ও কমেন্ট হিসেবে থাকছে):
// কোনো ওয়েবসাইট থেকে WiFi-এর নাম (SSID) বা সিম/মোবাইল অপারেটরের নাম
// (Grameenphone/Robi/Banglalink) সরাসরি জানার কোনো ব্রাউজার API নেই —
// এটা প্রাইভেসি/সিকিউরিটির কারণে কোনো ব্রাউজারই দেয় না। যেটা করা যায়:
// IP-ভিত্তিক ISP-এর নাম (যেটা মোবাইল ডেটার ক্ষেত্রে প্রায়ই অপারেটরের নামই
// দেখায়, যেমন "Grameenphone Ltd") ও Network Information API (শুধু
// Android Chrome-এ কাজ করে) দিয়ে "wifi" না "cellular" — নাম নয়, শুধু ধরন।
//
// লগইন-অ্যালার্ট ইমেইল: একই IP থেকে আগেও এই অ্যাকাউন্টে লগইন হয়ে থাকলে
// দ্বিতীয়বার ইমেইল যায় না — IP বদলালেই কেবল নতুন করে সতর্কতা ইমেইল যায়
// (দেখুন নিচে isNewIp)। প্রতিটি সেশন রেকর্ডে দেশ/অঞ্চল/টাইমজোন/লগইন-পদ্ধতি
// (ইমেইল/Google ইত্যাদি)-ও এখন সংরক্ষিত হয়, লগইন হিস্টোরি মোডালে দেখা যায়।
//
// PRIVACY NOTE: এই ফাইলটি users/{uid}/sessions/{sessionId}-এ IP/লোকেশন/
// ডিভাইস তথ্য লেখে। firebase-config.js-এর কমেন্টে থাকা Firestore rules-এ
// এই সাবকালেকশনের জন্য owner-only rule যোগ করতে ভুলবেন না (নিচে দেখুন)।

const SESSION_DEVICE_ID_KEY = 'qc_device_id';     // localStorage — এই ব্রাউজার/ডিভাইসের জন্য স্থায়ী
const SESSION_TAB_ID_KEY = 'qc_session_id';        // sessionStorage — এই ট্যাব/সেশনের জন্যই, ট্যাব বন্ধ হলে মুছে যায়
const SESSION_FRESH_LOGIN_KEY = 'qc_fresh_login';  // sessionStorage — সাইন-ইন বাটনে চাপ দেয়ার ঠিক আগে সেট করা হয়
const SESSION_LOC_CACHE_KEY = 'qc_ip_location_cache';
const SESSION_ONLINE_WINDOW_MS = 2 * 60 * 1000; // সর্বশেষ ২ মিনিটের মধ্যে হার্টবিট থাকলে "অনলাইন" দেখানো হয়

let _sessionRevokeUnsub = null;
let _sessionHeartbeatTimer = null;

// ---------- আইডি ম্যানেজমেন্ট ----------
function genRandomId(prefix){
  try{ if(crypto && crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function getDeviceId(){
  try{
    let id = localStorage.getItem(SESSION_DEVICE_ID_KEY);
    if(!id){ id = genRandomId('dev'); localStorage.setItem(SESSION_DEVICE_ID_KEY, id); }
    return id;
  }catch(e){ return 'unknown-device'; }
}

function getOrCreateTabSessionId(){
  try{
    let id = sessionStorage.getItem(SESSION_TAB_ID_KEY);
    if(!id){ id = genRandomId('ses'); sessionStorage.setItem(SESSION_TAB_ID_KEY, id); }
    return id;
  }catch(e){ return genRandomId('ses'); }
}

// auth.js-এর সাইন-ইন/সাইন-আপ বাটনগুলো থেকে কল হয় — এখান থেকে বোঝা যায় এটা
// প্রকৃত "লগইন করা হলো" মুহূর্ত, শুধু পেজ রিলোডে পুরনো সেশন ফিরে আসা নয়।
function markFreshLoginIntent(){
  try{ sessionStorage.setItem(SESSION_FRESH_LOGIN_KEY, '1'); }catch(e){}
}
function consumeFreshLoginIntent(){
  try{
    const v = sessionStorage.getItem(SESSION_FRESH_LOGIN_KEY) === '1';
    sessionStorage.removeItem(SESSION_FRESH_LOGIN_KEY);
    return v;
  }catch(e){ return false; }
}

// ---------- ডিভাইস/ব্রাউজার শনাক্তকরণ ----------
function parseDeviceInfo(){
  const ua = navigator.userAgent || '';
  let browser = 'অজানা ব্রাউজার', browserIcon = 'fa-solid fa-globe';
  if(/FBAN|FBAV/.test(ua)){ browser = 'Facebook অ্যাপ ব্রাউজার'; browserIcon = 'fa-brands fa-facebook'; }
  else if(/Instagram/.test(ua)){ browser = 'Instagram অ্যাপ ব্রাউজার'; browserIcon = 'fa-brands fa-instagram'; }
  else if(/EdgA|EdgiOS|Edg\//.test(ua)){ browser = 'Microsoft Edge'; browserIcon = 'fa-brands fa-edge'; }
  else if(/OPR\/|OPiOS|Opera/.test(ua)){ browser = 'Opera'; browserIcon = 'fa-brands fa-opera'; }
  else if(/SamsungBrowser/.test(ua)){ browser = 'Samsung Internet'; browserIcon = 'fa-solid fa-mobile-screen-button'; }
  else if(/CriOS/.test(ua)){ browser = 'Chrome (iOS)'; browserIcon = 'fa-brands fa-chrome'; }
  else if(/Chrome\//.test(ua)){ browser = 'Google Chrome'; browserIcon = 'fa-brands fa-chrome'; }
  else if(/FxiOS/.test(ua)){ browser = 'Firefox (iOS)'; browserIcon = 'fa-brands fa-firefox'; }
  else if(/Firefox\//.test(ua)){ browser = 'Mozilla Firefox'; browserIcon = 'fa-brands fa-firefox'; }
  else if(/Version\/.*Safari\//.test(ua)){ browser = 'Safari'; browserIcon = 'fa-brands fa-safari'; }

  let os = 'অজানা সিস্টেম';
  if(/Windows/.test(ua)) os = 'Windows';
  else if(/Android/.test(ua)) os = 'Android';
  else if(/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if(/Mac OS X/.test(ua)) os = 'macOS';
  else if(/Linux/.test(ua)) os = 'Linux';

  let deviceType = 'desktop', deviceIcon = 'fa-solid fa-desktop', deviceLabel = 'ডেস্কটপ/ল্যাপটপ';
  if(/iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))){
    deviceType = 'tablet'; deviceIcon = 'fa-solid fa-tablet-screen-button'; deviceLabel = 'ট্যাবলেট';
  } else if(/Mobi|iPhone|Android.*Mobile/.test(ua)){
    deviceType = 'mobile'; deviceIcon = 'fa-solid fa-mobile-screen-button'; deviceLabel = 'মোবাইল';
  }

  // Network Information API — সমর্থন খুবই সীমিত (মূলত Android Chrome),
  // এবং শুধু ধরন দেয় ("wifi"/"cellular"), নাম নয়।
  let connectionLabel = '';
  try{
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if(conn){
      if(conn.type === 'wifi') connectionLabel = 'ওয়াই-ফাই';
      else if(conn.type === 'cellular') connectionLabel = 'মোবাইল ডেটা';
      else if(conn.effectiveType) connectionLabel = 'ইন্টারনেট (' + conn.effectiveType.toUpperCase() + ')';
    }
  }catch(e){}

  return { browser, browserIcon, os, deviceType, deviceIcon, deviceLabel, connectionLabel, userAgent: ua };
}

// ---------- IP + আনুমানিক লোকেশন / ISP ----------
// একটি ফ্রি, key-বিহীন IP-geolocation API ব্যবহার করা হচ্ছে, একটা ব্যাকআপসহ।
// প্রতি ট্যাব-সেশনে একবারই ফেচ হয় (sessionStorage-এ ক্যাশ করা থাকে)।
async function fetchIpLocation(){
  try{
    const cached = sessionStorage.getItem(SESSION_LOC_CACHE_KEY);
    if(cached) return JSON.parse(cached);
  }catch(e){}

  const result = { ip: '', city: '', country: '', isp: '', countryCode: '', regionName: '', timezone: '', lat: null, lon: null };
  try{
    const r = await fetch('https://ipapi.co/json/');
    if(r.ok){
      const d = await r.json();
      if(d && !d.error){
        result.ip = d.ip || '';
        result.city = d.city || '';
        result.country = d.country_name || '';
        result.isp = d.org || '';
        result.countryCode = d.country_code || '';
        result.regionName = d.region || '';
        result.timezone = d.timezone || '';
        result.lat = typeof d.latitude === 'number' ? d.latitude : null;
        result.lon = typeof d.longitude === 'number' ? d.longitude : null;
      }
    }
  }catch(e){ /* নেটওয়ার্ক ব্লকড বা রেট-লিমিট হতে পারে, নিচে ব্যাকআপ চেষ্টা হবে */ }

  if(!result.ip){
    try{
      const r2 = await fetch('https://ipwho.is/');
      if(r2.ok){
        const d2 = await r2.json();
        if(d2 && d2.success !== false){
          result.ip = d2.ip || '';
          result.city = d2.city || '';
          result.country = d2.country || '';
          result.isp = (d2.connection && d2.connection.isp) || '';
          result.countryCode = d2.country_code || '';
          result.regionName = d2.region || '';
          result.timezone = (d2.timezone && d2.timezone.id) || '';
          result.lat = typeof d2.latitude === 'number' ? d2.latitude : null;
          result.lon = typeof d2.longitude === 'number' ? d2.longitude : null;
        }
      }
    }catch(e){}
  }

  try{ sessionStorage.setItem(SESSION_LOC_CACHE_KEY, JSON.stringify(result)); }catch(e){}
  return result;
}

// ---------- লগইন পদ্ধতি (ইমেইল/পাসওয়ার্ড নাকি Google ইত্যাদি) ----------
function getLoginMethodLabel(fbUser){
  try{
    const pid = (fbUser.providerData && fbUser.providerData[0] && fbUser.providerData[0].providerId) || '';
    if(pid === 'google.com') return { text: 'Google', icon: 'fa-brands fa-google' };
    if(pid === 'facebook.com') return { text: 'Facebook', icon: 'fa-brands fa-facebook' };
    if(pid === 'password') return { text: 'ইমেইল/পাসওয়ার্ড', icon: 'fa-solid fa-key' };
    return { text: pid || 'অজানা', icon: 'fa-solid fa-key' };
  }catch(e){ return { text: 'অজানা', icon: 'fa-solid fa-key' }; }
}

// দেশ-কোড (যেমন "BD") থেকে 🇧🇩-এর মতো ফ্ল্যাগ ইমোজি বানানো — কোনো এক্সট্রা
// লাইব্রেরি বা API ছাড়াই, শুধু ইউনিকোড রিজিওনাল ইন্ডিকেটর ব্যবহার করে।
function countryFlagEmoji(code){
  if(!code || code.length !== 2) return '';
  try{
    const base = 0x1F1E6;
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => base + (c.charCodeAt(0) - 65)));
  }catch(e){ return ''; }
}


async function recordSessionActivity(fbUser){
  if(!fbDb || !fbUser) return;
  const tabSessionId = getOrCreateTabSessionId();
  const deviceId = getDeviceId();
  const isFresh = consumeFreshLoginIntent();
  const ref = fbDb.collection('users').doc(fbUser.uid).collection('sessions').doc(tabSessionId);

  if(!isFresh){
    // অ্যাপ আবার খোলা হয়েছে বা পেজ রিফ্রেশ হয়েছে — Firebase-এ আগে থেকেই সাইন-ইন
    // ছিল। এটা নতুন "লগইন" নয়, তাই ইমেইল যাবে না — শুধু হার্টবিট আপডেট হবে।
    try{ await ref.set({ deviceId, lastActiveAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); }catch(e){}
    startSessionHeartbeat(fbUser.uid, tabSessionId);
    listenForRemoteLogout(fbUser.uid, tabSessionId);
    return;
  }

  // ---- প্রকৃত, সরাসরি লগইন/সাইন-আপ অ্যাকশন ----
  const info = parseDeviceInfo();
  const loc = await fetchIpLocation();
  const loginMethod = getLoginMethodLabel(fbUser);

  let isNewDevice = true;
  try{
    const prior = await fbDb.collection('users').doc(fbUser.uid).collection('sessions')
      .where('deviceId', '==', deviceId).limit(1).get();
    isNewDevice = prior.empty;
  }catch(e){}

  // ---- IP-ভিত্তিক ডুপ্লিকেট-ইমেইল প্রতিরোধ ----
  // একই IP থেকে আগেও এই অ্যাকাউন্টে লগইন হয়ে থাকলে (অর্থাৎ পরিচিত/স্থায়ী
  // নেটওয়ার্ক থেকেই বারবার লগইন হচ্ছে), প্রতিবারই নতুন করে "নতুন লগইন" ইমেইল
  // পাঠানো বিরক্তিকর — তাই সেক্ষেত্রে দ্বিতীয়বার আর ইমেইল যাবে না। IP পাল্টালে
  // (অন্য নেটওয়ার্ক/ডিভাইস/লোকেশন থেকে) তবেই নতুন করে সতর্কতা ইমেইল যাবে।
  // IP শনাক্তই করা না গেলে (API ব্যর্থ) নিরাপদ দিকেই থাকা হয় — ইমেইল পাঠানো হয়,
  // যেন কোনো প্রকৃত নতুন লগইন চোখ এড়িয়ে না যায়।
  let isNewIp = true;
  if(loc.ip){
    try{
      const priorIp = await fbDb.collection('users').doc(fbUser.uid).collection('sessions')
        .where('ip', '==', loc.ip).limit(1).get();
      isNewIp = priorIp.empty;
    }catch(e){ isNewIp = true; }
  }

  const payload = {
    deviceId,
    browser: info.browser, browserIcon: info.browserIcon,
    os: info.os, deviceType: info.deviceType, deviceIcon: info.deviceIcon, deviceLabel: info.deviceLabel,
    connectionLabel: info.connectionLabel,
    ip: loc.ip || '', city: loc.city || '', country: loc.country || '', isp: loc.isp || '',
    countryCode: loc.countryCode || '', regionName: loc.regionName || '', timezone: loc.timezone || '',
    lat: loc.lat, lon: loc.lon,
    loginMethod: loginMethod.text, loginMethodIcon: loginMethod.icon,
    userAgent: info.userAgent,
    isNewDevice, isNewIp, emailSent: isNewIp,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
    revoked: false
  };
  try{ await ref.set(payload, { merge: true }); }catch(e){ console.warn('সেশন রেকর্ড ব্যর্থ:', e); }

  startSessionHeartbeat(fbUser.uid, tabSessionId);
  listenForRemoteLogout(fbUser.uid, tabSessionId);
  sendNewLoginAlertEmail(fbUser, info, loc, isNewDevice, isNewIp);
}

// ---------- "এখন অনলাইন" প্রেজেন্স হার্টবিট ----------
// Firestore-এ Realtime DB-এর মতো সরাসরি onDisconnect() নেই, তাই ট্যাব বন্ধ
// হয়ে গেলে সেটা তাৎক্ষণিকভাবে জানা যায় না — এর বদলে প্রতি ৬০ সেকেন্ডে একটা
// হার্টবিট পাঠানো হয় এবং "অনলাইন" দেখানো হয় সর্বশেষ হার্টবিট ২ মিনিটের
// মধ্যে হলে; না হলে "সর্বশেষ সক্রিয় ছিল" হিসেবে দেখানো হয়।
function startSessionHeartbeat(uid, tabSessionId){
  if(_sessionHeartbeatTimer) clearInterval(_sessionHeartbeatTimer);
  const beat = () => {
    if(document.hidden || !fbDb || !fbAuth || !fbAuth.currentUser) return;
    fbDb.collection('users').doc(uid).collection('sessions').doc(tabSessionId)
      .set({ lastActiveAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
  };
  beat();
  _sessionHeartbeatTimer = setInterval(beat, 60000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) beat(); });
}

function stopSessionHeartbeat(){
  if(_sessionHeartbeatTimer){ clearInterval(_sessionHeartbeatTimer); _sessionHeartbeatTimer = null; }
  if(_sessionRevokeUnsub){ _sessionRevokeUnsub(); _sessionRevokeUnsub = null; }
}

// ---------- দূর থেকে লগ-আউট শোনা (real-time) ----------
// এই ডিভাইসের নিজের সেশন ডকুমেন্টে "revoked:true" হলে সাথে সাথে সাইন-আউট।
function listenForRemoteLogout(uid, tabSessionId){
  if(_sessionRevokeUnsub) _sessionRevokeUnsub();
  _sessionRevokeUnsub = fbDb.collection('users').doc(uid).collection('sessions').doc(tabSessionId)
    .onSnapshot(async (doc) => {
      if(doc.exists && doc.data().revoked === true){
        stopSessionHeartbeat();
        try{ sessionStorage.removeItem(SESSION_TAB_ID_KEY); }catch(e){}
        if(typeof showToast === 'function') showToast('এই সেশনটি দূর থেকে লগ-আউট করা হয়েছে।');
        try{ await fbAuth.signOut(); }catch(e){}
      }
    }, () => {});
}

// ---------- একটি নির্দিষ্ট সেশন বা সব (অন্য) সেশন লগ-আউট করা ----------
async function revokeOneSession(uid, sessionId){
  try{ await fbDb.collection('users').doc(uid).collection('sessions').doc(sessionId).set({ revoked: true }, { merge: true }); }
  catch(e){ console.warn('সেশন বাতিল ব্যর্থ:', e); throw e; }
}

async function logoutAllSessions(uid, keepCurrent){
  const tabSessionId = getOrCreateTabSessionId();
  const snap = await fbDb.collection('users').doc(uid).collection('sessions').get();
  const batch = fbDb.batch();
  let count = 0;
  snap.forEach(doc => {
    if(keepCurrent && doc.id === tabSessionId) return;
    batch.update(doc.ref, { revoked: true });
    count++;
  });
  if(count) await batch.commit();
  return count;
}

// ---------- নতুন লগইন ইমেইল অ্যালার্ট ----------
function isLoginAlertEmailConfigured(){
  return typeof EMAILJS_CONFIG !== 'undefined'
    && EMAILJS_CONFIG.publicKey && !/PASTE_YOUR/.test(EMAILJS_CONFIG.publicKey)
    && EMAILJS_CONFIG.loginAlertTemplateId && !/PASTE_YOUR/.test(EMAILJS_CONFIG.loginAlertTemplateId);
}

function formatLoginTimeBn(d){
  const months = (typeof BN_MONTHS !== 'undefined') ? BN_MONTHS : ['জানু','ফেব্রু','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্ট','অক্টো','নভে','ডিসে'];
  let h = d.getHours(); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12; if(h === 0) h = 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${toBn(d.getDate())} ${months[d.getMonth()]}, ${toBn(d.getFullYear())} — ${toBn(h)}:${toBn(mm)} ${ampm}`;
}

async function sendNewLoginAlertEmail(fbUser, info, loc, isNewDevice, isNewIp){
  if(!isNewIp) return; // একই IP থেকে আগেও লগইন হয়েছে — বারবার একই সতর্কতা-ইমেইল পাঠিয়ে বিরক্ত করা হবে না
  if(!isLoginAlertEmailConfigured()) return;
  if(typeof ensureEmailJsReady !== 'function' || !ensureEmailJsReady()) return;
  const email = fbUser.email; if(!email) return;

  const revokeUrl = window.location.origin + window.location.pathname + '?action=logoutAllDevices';
  const locationText = [loc.city, loc.country].filter(Boolean).join(', ') || 'শনাক্ত করা যায়নি';
  const deviceText = `${info.browser} · ${info.os} · ${info.deviceLabel}`;

  try{
    await emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.loginAlertTemplateId, {
      to_email: email,
      to_name: fbUser.displayName || email.split('@')[0],
      device_text: deviceText,
      location_text: locationText,
      isp_text: loc.isp || 'শনাক্ত করা যায়নি',
      ip_text: loc.ip || 'শনাক্ত করা যায়নি',
      login_time: formatLoginTimeBn(new Date()),
      new_device_text: isNewDevice ? 'উল্লেখ্য: এটি এই অ্যাকাউন্টে প্রথমবার ব্যবহৃত হচ্ছে এমন একটি ডিভাইস।' : '',
      revoke_url: revokeUrl
    });
  }catch(e){ console.warn('লগইন-অ্যালার্ট ইমেইল ব্যর্থ:', e); }
}

// ---------- ইমেইলের লিংক থেকে "সব ডিভাইস থেকে লগ-আউট করুন" ফ্লো ----------
// reset-password.js-এর প্যাটার্ন অনুসরণ করে: URL-এ ?action=logoutAllDevices
// থাকলে ধরে নেয়া হয় ব্যবহারকারী ইমেইলের লিংক থেকে এসেছেন। লগইন করা না
// থাকলে আগে সাইন-ইন করতে বলা হয় (Firestore rules অনুযায়ী শুধু নিজের uid-র
// সেশনই কেউ বাতিল করতে পারে), তারপর স্বয়ংক্রিয়ভাবে সব ডিভাইস (এই ব্রাউজার
// ট্যাবসহ) লগ-আউট হয়ে যায়।
function isLogoutAllDevicesLink(){
  try{ return new URLSearchParams(window.location.search).get('action') === 'logoutAllDevices'; }
  catch(e){ return false; }
}

async function runLogoutAllDevicesFlow(fbUser){
  if(!isLogoutAllDevicesLink()) return;
  try{
    const count = await logoutAllSessions(fbUser.uid, false); // নিজেরটাসহ সবই লগ-আউট
    if(typeof showToast === 'function'){
      showToast(count ? 'সব ডিভাইস থেকে লগ-আউট করা হয়েছে।' : 'কোনো সক্রিয় সেশন পাওয়া যায়নি।');
    }
  }catch(e){
    if(typeof showToast === 'function') showToast('লগ-আউট করতে সমস্যা হয়েছে, আবার চেষ্টা করুন।');
  }finally{
    try{
      const url = new URL(window.location.href);
      url.searchParams.delete('action');
      window.history.replaceState({}, '', url.toString());
    }catch(e){}
  }
}

// index.html-এর হেড/বডি লোড হওয়ার পর একবার চেক করে, লগইন করা না থাকলে
// সরাসরি সাইন-ইন স্ক্রিন খুলে দেয় যাতে ব্যবহারকারী সহজেই এগিয়ে যেতে পারেন।
document.addEventListener('DOMContentLoaded', () => {
  if(!isLogoutAllDevicesLink()) return;
  const tryOpen = () => {
    if(typeof fbAuth === 'undefined' || !fbAuth){ setTimeout(tryOpen, 400); return; }
    if(fbAuth.currentUser) return; // onSignedIn hook-এই এটা হ্যান্ডেল হবে
    if(typeof openAuthFlow === 'function'){
      openAuthFlow('login');
      if(typeof showToast === 'function') showToast('সব ডিভাইস থেকে লগ-আউট করতে আগে সাইন-ইন করুন।');
    }
  };
  setTimeout(tryOpen, 600);
});

// ---------- প্রোফাইলে "লগইন হিস্টোরি ও সক্রিয় সেশন" মোডাল ----------
function relativeTimeBn(date){
  if(!date) return 'অজানা সময়';
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if(mins < 1) return 'এইমাত্র';
  if(mins < 60) return `${toBn(mins)} মিনিট আগে`;
  const hrs = Math.floor(mins / 60);
  if(hrs < 24) return `${toBn(hrs)} ঘণ্টা আগে`;
  const days = Math.floor(hrs / 24);
  if(days < 30) return `${toBn(days)} দিন আগে`;
  return formatLoginTimeBn(date);
}

function sessionDocToDate(ts){
  try{ return ts && ts.toDate ? ts.toDate() : null; }catch(e){ return null; }
}

// দুই তারিখের ব্যবধানকে "৩ ঘণ্টা ২০ মিনিট"-এর মতো বাংলা টেক্সটে রূপান্তর —
// একটি সেশন কতক্ষণ সক্রিয় ছিল/আছে তা বোঝাতে ব্যবহৃত হয়।
function durationBn(from, to){
  if(!from || !to) return '';
  let mins = Math.floor((to.getTime() - from.getTime()) / 60000);
  if(mins < 1) return '';
  if(mins < 60) return `${toBn(mins)} মিনিট`;
  const hrs = Math.floor(mins / 60); mins = mins % 60;
  if(hrs < 24) return mins ? `${toBn(hrs)} ঘণ্টা ${toBn(mins)} মিনিট` : `${toBn(hrs)} ঘণ্টা`;
  const days = Math.floor(hrs / 24);
  return `${toBn(days)} দিন`;
}

async function openSessionHistoryModal(){
  const user = state.user;
  if(!user || !fbDb) return;

  const old = document.getElementById('sessionHistoryModal');
  if(old) old.remove();

  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'sessionHistoryModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal session-history-box">
      <div class="app-modal-head"><h3>লগইন হিস্টোরি ও সক্রিয় সেশন</h3><button class="app-modal-close" id="sessHistClose">✕</button></div>
      <div class="app-modal-body">
        <p class="session-history-hint">আপনার অ্যাকাউন্টে যেসব ডিভাইস থেকে প্রবেশ করা হয়েছে তার তালিকা। যেকোনো অচেনা সেশন দেখলে সরাসরি সেটি লগ-আউট করে দিন।</p>
        <div id="sessHistSummary" class="session-history-summary"></div>
        <div id="sessHistList" class="session-list"><div class="session-loading">লোড হচ্ছে...</div></div>
        <button type="button" class="settings-btn profile-action-btn profile-action-danger" id="sessHistLogoutAll" style="margin-top:12px;">
          <i class="fa-solid fa-right-from-bracket"></i><span>অন্য সব ডিভাইস থেকে লগ-আউট করুন</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('sessHistClose').onclick = remove;

  const currentTabSessionId = getOrCreateTabSessionId();
  const listEl = document.getElementById('sessHistList');

  try{
    const snap = await fbDb.collection('users').doc(user.uid).collection('sessions')
      .orderBy('lastActiveAt', 'desc').limit(25).get();
    if(snap.empty){
      listEl.innerHTML = '<div class="session-loading">এখনও কোনো সেশন রেকর্ড নেই।</div>';
    } else {
      const onlineCount = snap.docs.filter(doc => {
        const la = sessionDocToDate(doc.data().lastActiveAt);
        return la && (Date.now() - la.getTime() < SESSION_ONLINE_WINDOW_MS);
      }).length;
      const summaryEl = document.getElementById('sessHistSummary');
      if(summaryEl){
        summaryEl.innerHTML = `<i class="fa-solid fa-shield-halved"></i> সর্বমোট ${toBn(snap.size)}টি সেশন রেকর্ড · ${toBn(onlineCount)}টি এখন সক্রিয়`;
      }

      listEl.innerHTML = snap.docs.map(doc => {
        const d = doc.data();
        const isCurrent = doc.id === currentTabSessionId;
        const createdAt = sessionDocToDate(d.createdAt);
        const lastActive = sessionDocToDate(d.lastActiveAt);
        const isOnline = lastActive && (Date.now() - lastActive.getTime() < SESSION_ONLINE_WINDOW_MS);

        const flag = countryFlagEmoji(d.countryCode);
        const locationText = [d.city, d.regionName, d.country].filter(Boolean).join(', ');
        const durText = durationBn(createdAt, lastActive);

        // প্রতিটি তথ্য এখন আলাদা আলাদা বর্ডার-বক্স ("চিপ") হিসেবে দেখানো হয়,
        // যাতে কোন তথ্য কীসের জন্য তা এক নজরেই বোঝা যায় — সব একসাথে একলাইনে
        // গুঁতিয়ে না থেকে।
        const chips = [
          { icon: 'fa-solid fa-location-dot', label: 'লোকেশন', value: (flag ? flag + ' ' : '') + (locationText || 'শনাক্ত করা যায়নি') },
          { icon: 'fa-solid fa-tower-broadcast', label: 'ইন্টারনেট সেবাদাতা', value: d.isp },
          { icon: 'fa-solid fa-network-wired', label: 'আইপি ঠিকানা', value: d.ip },
          { icon: 'fa-solid fa-key', label: 'লগইন পদ্ধতি', value: d.loginMethod },
          { icon: 'fa-solid fa-signal', label: 'সংযোগ', value: d.connectionLabel },
          { icon: 'fa-solid fa-clock', label: 'সময় অঞ্চল', value: d.timezone },
          { icon: 'fa-solid fa-calendar-plus', label: 'প্রথম প্রবেশ', value: createdAt ? formatLoginTimeBn(createdAt) : '' },
          { icon: 'fa-solid fa-hourglass-half', label: 'স্থিতিকাল', value: durText }
        ].filter(c => c.value);

        const chipsHtml = chips.map(c => `
          <div class="session-info-chip">
            <i class="${escapeHtml(c.icon)}"></i>
            <div class="session-info-chip-text">
              <span class="session-info-chip-label">${escapeHtml(c.label)}</span>
              <span class="session-info-chip-value">${escapeHtml(c.value)}</span>
            </div>
          </div>`).join('');

        const mapsLink = (typeof d.lat === 'number' && typeof d.lon === 'number')
          ? `<a href="https://www.google.com/maps?q=${d.lat},${d.lon}" target="_blank" rel="noopener" class="session-map-link"><i class="fa-solid fa-location-dot"></i> মানচিত্রে দেখুন</a>` : '';
        const emailTag = (d.emailSent === false)
          ? '<span class="session-badge session-badge-muted" title="একই আইপি থেকে আগেও লগইন হয়েছে বলে এবার নতুন করে সতর্কতা-ইমেইল পাঠানো হয়নি"><i class="fa-solid fa-envelope-circle-check"></i> ইমেইল পাঠানো হয়নি (পরিচিত আইপি)</span>' : '';

        return `
        <div class="session-item${isCurrent ? ' session-item-current' : ''}" data-session-id="${escapeHtml(doc.id)}">
          <div class="session-item-top">
            <div class="session-item-icon"><i class="${escapeHtml(d.browserIcon || 'fa-solid fa-globe')}"></i></div>
            <div class="session-item-headline">
              <div class="session-item-title-row">
                <span class="session-item-title">${escapeHtml(d.browser || 'অজানা ব্রাউজার')} · ${escapeHtml(d.os || 'অজানা সিস্টেম')}</span>
                ${isCurrent ? '<span class="session-badge session-badge-current">এই ডিভাইস</span>' : ''}
                ${d.isNewDevice && !isCurrent ? '<span class="session-badge session-badge-new">🆕 নতুন ডিভাইস</span>' : ''}
                ${d.mfaVerified ? '<span class="session-badge session-badge-mfa"><i class="fa-solid fa-shield-halved"></i> 2FA যাচাইকৃত</span>' : ''}
              </div>
              <div class="session-item-status-row">
                <span class="session-device-badge"><i class="${escapeHtml(d.deviceIcon || 'fa-solid fa-desktop')}"></i> ${escapeHtml(d.deviceLabel || '')}</span>
                <span class="session-status-text ${isOnline ? 'is-online' : ''}">
                  <span class="session-online-dot ${isOnline ? 'online' : 'offline'}"></span>
                  ${isOnline ? 'এখন সক্রিয় আছে' : ('সর্বশেষ সক্রিয়: ' + relativeTimeBn(lastActive))}
                </span>
              </div>
            </div>
            ${isCurrent ? '' : `<button type="button" class="session-revoke-btn" data-revoke="${escapeHtml(doc.id)}" aria-label="এই সেশন লগ-আউট করুন"><i class="fa-solid fa-xmark"></i></button>`}
          </div>
          <div class="session-info-grid">${chipsHtml}</div>
          ${(mapsLink || emailTag) ? `<div class="session-item-extra">${mapsLink}${emailTag}</div>` : ''}
        </div>`;
      }).join('');
    }
  }catch(e){
    listEl.innerHTML = '<div class="session-loading">লোড করা যায়নি, আবার চেষ্টা করুন।</div>';
  }

  listEl.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      try{
        await revokeOneSession(user.uid, btn.getAttribute('data-revoke'));
        const item = btn.closest('.session-item');
        if(item) item.remove();
        if(typeof showToast === 'function') showToast('সেশনটি লগ-আউট করা হয়েছে।');
      }catch(e){
        btn.disabled = false;
        if(typeof showToast === 'function') showToast('লগ-আউট করা যায়নি, আবার চেষ্টা করুন।');
      }
    };
  });

  document.getElementById('sessHistLogoutAll').onclick = async () => {
    const btn = document.getElementById('sessHistLogoutAll');
    btn.disabled = true;
    try{
      const count = await logoutAllSessions(user.uid, true);
      if(typeof showToast === 'function') showToast(count ? 'অন্য সব ডিভাইস থেকে লগ-আউট করা হয়েছে।' : 'অন্য কোনো সক্রিয় সেশন নেই।');
      remove();
    }catch(e){
      btn.disabled = false;
      if(typeof showToast === 'function') showToast('লগ-আউট করতে সমস্যা হয়েছে, আবার চেষ্টা করুন।');
    }
  };
}
