// ---------- Firebase Auth + Firestore sync ----------
// Everything needed to connect this app's account system to Firebase lives
// in this one file (plus js/firebase-config.js, where the project keys go).
// Nothing here needs Firebase Hosting — it works fine served from anywhere,
// as long as the config in js/firebase-config.js is filled in and the
// domain is added under Authentication → Settings → Authorized domains.

let fbApp = null, fbAuth = null, fbDb = null;
let firebaseReady = false;
let authUnsub = null;
let cloudSyncTimer = null;
let cloudSyncInFlight = false;
let suppressNextSync = false; // true while we're applying a just-downloaded cloud snapshot
let cloudSyncPending = false; // true when the last push failed/was skipped (offline) and is waiting to retry

function isFirebaseConfigured(){
  return typeof FIREBASE_CONFIG !== 'undefined'
    && FIREBASE_CONFIG.apiKey
    && !/PASTE_YOUR/.test(FIREBASE_CONFIG.apiKey);
}

function initAuth(){
  if(typeof firebase === 'undefined' || !isFirebaseConfigured()) return; // SDK not loaded / not configured yet
  try{
    fbApp = firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    firebaseReady = true;
  }catch(e){ console.warn('Firebase init failed:', e); return; }

  authUnsub = fbAuth.onAuthStateChanged(async (fbUser) => {
    if(fbUser){
      const finishSignIn = async () => {
        await onSignedIn(fbUser);
        // লগইন হিস্টোরি রেকর্ড + ডিভাইস শনাক্তকরণ + দূর থেকে লগ-আউট শোনা (js/session-security.js)
        if(typeof recordSessionActivity === 'function') recordSessionActivity(fbUser);
        // ইমেইলের "সব ডিভাইস থেকে লগ-আউট করুন" লিংক থেকে এসে থাকলে সেটা এখানেই সম্পন্ন হয়
        if(typeof runLogoutAllDevicesFlow === 'function') runLogoutAllDevicesFlow(fbUser);
        // state.user.uid is now set — load this account's own custom theme
        // (if any) instead of whatever the previous account left applied.
        if(typeof reloadCustomThemeForCurrentUser === 'function') reloadCustomThemeForCurrentUser();
      };
      // অ্যাকাউন্টে টু-ফ্যাক্টর অথেনটিকেশন চালু থাকলে (js/mfa.js), এখানেই আগে
      // চ্যালেঞ্জ দেখানো হয় — পাস না করা পর্যন্ত state.user সেট হয় না, তাই বাকি
      // অ্যাপ এখনো "সাইন-আউট" অবস্থাতেই দেখায়।
      if(typeof requireMfaIfNeeded === 'function') requireMfaIfNeeded(fbUser, finishSignIn);
      else await finishSignIn();
    } else {
      state.user = null;
      if(typeof stopSessionHeartbeat === 'function') stopSessionHeartbeat();
      // Back to the device's guest bucket — clears any signed-in account's
      // custom theme rather than leaving it visible to the next guest/account.
      if(typeof reloadCustomThemeForCurrentUser === 'function') reloadCustomThemeForCurrentUser();
      refreshCurrentView();
    }
  });
}

function refreshCurrentView(){
  // সাইন-ইন/আউট হলে হোম পেজের স্ট্যাটাস রো (js/status.js) সাথে সাথেই
  // আপডেট হওয়া দরকার — লগ-আউট করলে অন্যদের স্ট্যাটাস আর দেখানো চলবে না,
  // আর নতুন করে লগইন করলে আগের সেশনের পুরনো ক্যাশ না দেখিয়ে টাটকা তালিকা
  // আনতে হবে।
  if(typeof statusRowFetchedAt !== 'undefined') statusRowFetchedAt = 0;
  if(typeof renderStatusRow === 'function') renderStatusRow();

  const statsView = document.getElementById('view-stats');
  if(statsView && statsView.classList.contains('active') && typeof renderStatsView === 'function') renderStatsView();
  // প্রোফাইল পেজ খোলা থাকলে সাইন-ইন/সাইন-আউট হওয়ার সাথে সাথেই এটাও রিফ্রেশ
  // হওয়া দরকার — সাইন-আপ/লগইন স্ক্রিন থেকে সরাসরি প্রোফাইলে বদলে যেতে হবে,
  // কোনো পপ-আপ বন্ধ করার প্রয়োজন নেই (js/profile-view.js)।
  const profileView = document.getElementById('view-profile');
  if(profileView && profileView.classList.contains('active') && typeof renderProfileView === 'function') renderProfileView();
  // পরীক্ষা পেজ খোলা অবস্থায় লগইন/লগআউট হলে এডমিন বাটনও সাথে সাথে
  // যাচাই/লুকানো হওয়া দরকার, পরের বার ট্যাব খোলার জন্য অপেক্ষা না করেই (js/exam.js)।
  const examView = document.getElementById('view-exam');
  if(examView && examView.classList.contains('active') && typeof checkExamAdminStatus === 'function') checkExamAdminStatus();
  // AI তাফসীর মোডাল (js/ai-tafsir.js) খোলা থাকলে সাইন-ইন/আউট হওয়ার সাথে
  // সাথেই অতিথি-সীমার গেট রিফ্রেশ/আনলক হওয়া দরকার — মোডাল বন্ধ-খোলা করা
  // ছাড়াই, ঠিক উপরের ভিউগুলোর মতোই।
  const aiTafsirModalEl = document.getElementById('aiTafsirModal');
  if(aiTafsirModalEl && aiTafsirModalEl.style.display === 'flex' && typeof aiTafsirRefreshGateForAuthChange === 'function') aiTafsirRefreshGateForAuthChange();
}

// ---------- Sign-in / sign-up / forgot-password overlay ----------
// একটা রি-ইউজেবল সোশ্যাল-সাইন-ইন রো — Google/Facebook/X/GitHub/Microsoft
// (js/auth.js নিচের SOCIAL_PROVIDERS লিস্ট থেকে) — চয়েস, সাইন-আপ আর লগইন,
// এই তিনটা স্ক্রিনেই একই রো বসানো হয়, যাতে যেখান থেকেই শুরু হোক না কেন
// এক ট্যাপে যেকোনো প্ল্যাটফর্ম দিয়ে সরাসরি অ্যাকাউন্ট তৈরি/সাইন-ইন করা যায়।
function socialAuthButtonsHtml(){
  return `
    <div class="auth-social-divider"><span>অথবা</span></div>
    <div class="auth-social-row">
      ${SOCIAL_PROVIDERS.map(p => `<button type="button" class="auth-social-btn" data-social-provider="${p.id}" style="--brand-color:${p.color}" aria-label="${escapeHtml(p.label)} দিয়ে সাইন ইন করুন" title="${escapeHtml(p.label)}"><i class="${p.icon}"></i></button>`).join('')}
    </div>`;
}

// A single full-screen overlay with four "screens" swapped in and out,
// mirroring the reference design: choice → (signup | login) → forgot.
function ensureAuthOverlay(){
  let overlay = document.getElementById('authOverlay');
  if(overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'authOverlay';
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-screen" id="authScreenChoice">
      <div class="auth-topbar">
        <button class="auth-back" data-close="1"><i class="fa-solid fa-arrow-left"></i></button>
        <span>সাইন আপ / লগইন করুন</span>
      </div>
      <div class="auth-body">
        <div class="auth-scene auth-scene-choice">
          <div class="auth-icon-box"><i class="fa-solid fa-book-open"></i></div>
          <div class="auth-medal"><i class="fa-solid fa-star"></i></div>
          <i class="fa-solid fa-sparkles auth-spark s1"></i>
          <i class="fa-solid fa-sparkles auth-spark s2"></i>
          <span class="auth-dot" style="top:8px;left:6px;"></span>
        </div>
        <h2 class="auth-title">অ্যাকাউন্ট তৈরি করুন</h2>
        <p class="auth-sub">আপনার অর্জন ও পড়ার অগ্রগতি সুরক্ষিত রাখুন। আপনার সম্পূর্ণ পরিসংখ্যান এক জায়গায় দেখুন।</p>
        <button class="auth-cta-btn" id="authGoSignup">ইমেইল দিয়ে সাইন আপ করুন</button>
        ${socialAuthButtonsHtml()}
        <div class="auth-switch">অলরেডি অ্যাকাউন্ট আছে? <a href="javascript:void(0)" id="authGoLogin">লগইন করুন</a></div>
      </div>
    </div>

    <div class="auth-screen" id="authScreenSignup" style="display:none;">
      <div class="auth-topbar">
        <button class="auth-back" data-back="choice"><i class="fa-solid fa-arrow-left"></i></button>
        <span>সাইন আপ</span>
      </div>
      <div class="auth-body">
        <div class="auth-scene auth-scene-signup">
          <div class="auth-card-tile"></div>
          <div class="auth-plus-mock">
            <div class="auth-plus-circle"><i class="fa-solid fa-plus"></i></div>
            <div class="auth-plus-row"><span class="dot"></span><span class="bar"></span></div>
            <div class="auth-plus-row"><span class="dot"></span><span class="bar short"></span></div>
          </div>
        </div>
        <h2 class="auth-title">কুরআন বাংলা অ্যাকাউন্ট তৈরি করুন</h2>
        <p class="auth-sub">আমাদের যেকোনো অ্যাপে এই অ্যাকাউন্ট দিয়ে লগইন এবং সিঙ্ক করুন।</p>
        <input class="auth-field" id="suName" type="text" placeholder="নাম">
        <input class="auth-field" id="suPosition" type="text" placeholder="পদবি (ঐচ্ছিক)">
        <input class="auth-field" id="suEmail" type="email" placeholder="ইমেইল">
        <input class="auth-field" id="suPassword" type="password" placeholder="পাসওয়ার্ড">
        <input class="auth-field" id="suPasswordConfirm" type="password" placeholder="পাসওয়ার্ড নিশ্চিত করুন">
        <div class="auth-error" id="suError"></div>
        <button class="auth-cta-btn has-icon" id="suSubmit"><span>সাইন আপ</span><span class="cta-icon-dot"><i class="fa-solid fa-plus"></i></span></button>
        ${socialAuthButtonsHtml()}
      </div>
    </div>

    <div class="auth-screen" id="authScreenLogin" style="display:none;">
      <div class="auth-topbar">
        <button class="auth-back" data-back="choice"><i class="fa-solid fa-arrow-left"></i></button>
        <span>লগইন করুন</span>
      </div>
      <div class="auth-body">
        <div class="auth-scene auth-scene-login">
          <div class="auth-icon-box"><i class="fa-solid fa-right-to-bracket"></i></div>
          <span class="auth-leaf l1"></span>
          <span class="auth-leaf l2"></span>
          <i class="fa-solid fa-sparkles auth-spark s3"></i>
        </div>
        <h2 class="auth-title">বিদ্যমান অ্যাকাউন্টে লগইন করুন</h2>
        <input class="auth-field" id="liEmail" type="email" placeholder="ইমেইল">
        <input class="auth-field" id="liPassword" type="password" placeholder="পাসওয়ার্ড">
        <div class="auth-error" id="liError"></div>
        <button class="auth-cta-btn" id="liSubmit">লগইন করুন</button>
        <div class="auth-switch"><a href="javascript:void(0)" id="liForgot">পাসওয়ার্ড ভুলে গেছেন?</a></div>
        ${socialAuthButtonsHtml()}
      </div>
    </div>

    <div class="auth-screen" id="authScreenForgot" style="display:none;">
      <div class="auth-topbar">
        <button class="auth-back" data-back="login"><i class="fa-solid fa-arrow-left"></i></button>
        <span>পাসওয়ার্ড পুনরুদ্ধার করুন</span>
      </div>
      <div class="auth-body">
        <h2 class="auth-title">পুনরুদ্ধার করতে নিবন্ধিত ইমেইলটি প্রবেশ করুন</h2>
        <p class="auth-sub">চিন্তা করবেন না, আমরা আপনার ইমেইলে একটি পাসওয়ার্ড পুনরুদ্ধারের লিঙ্ক পাঠাবো।</p>
        <input class="auth-field" id="fgEmail" type="email" placeholder="ইমেইল">
        <div class="auth-error" id="fgError"></div>
        <button class="auth-cta-btn" id="fgSubmit">পুনরুদ্ধারের লিঙ্ক ইমেইল করুন</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('[data-close]').forEach(b => b.onclick = closeAuthFlow);
  overlay.querySelectorAll('[data-back]').forEach(b => b.onclick = () => showAuthScreen(b.getAttribute('data-back')));

  document.getElementById('authGoSignup').onclick = () => showAuthScreen('signup');
  document.getElementById('authGoLogin').onclick = () => showAuthScreen('login');
  document.getElementById('liForgot').onclick = () => showAuthScreen('forgot');
  overlay.querySelectorAll('[data-social-provider]').forEach(btn => {
    btn.onclick = () => handleSocialSignIn(btn.getAttribute('data-social-provider'), btn);
  });
  document.getElementById('suSubmit').onclick = handleEmailSignup;
  document.getElementById('liSubmit').onclick = handleEmailLogin;
  document.getElementById('fgSubmit').onclick = handlePasswordReset;

  return overlay;
}

function openAuthFlow(screen){
  if(!firebaseReady){
    showToast(typeof isFirebaseConfigured === 'function' && !isFirebaseConfigured()
      ? 'এখনো এই ফিউচারটি উপলব্ধ করা হয়নি'
      : 'সাইন ইন এখন লোড করা যায়নি, একটু পর আবার চেষ্টা করুন');
    return;
  }
  ensureAuthOverlay();
  showAuthScreen(screen || 'choice');
  document.getElementById('authOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeAuthFlow(){
  const overlay = document.getElementById('authOverlay');
  if(overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
}
function showAuthScreen(name){
  ['choice','signup','login','forgot'].forEach(n => {
    const el = document.getElementById('authScreen' + n.charAt(0).toUpperCase() + n.slice(1));
    if(el) el.style.display = (n === name) ? 'block' : 'none';
  });
}

// ---------- Actions ----------
// যেকোনো SOCIAL_PROVIDERS এন্ট্রি (Google/Facebook/X/GitHub/Microsoft) দিয়ে
// সাইন-ইন করায় — নতুন ইমেইল হলে Firebase নিজে থেকেই নতুন অ্যাকাউন্ট বানিয়ে
// দেয়, তাই এটাই একইসাথে "সোশ্যাল দিয়ে সাইন আপ" আর "সোশ্যাল দিয়ে লগইন"।
async function handleSocialSignIn(providerId, triggerBtn){
  const meta = getSocialProvider(providerId);
  if(!meta) return;
  const provider = meta.factory();
  if(typeof markFreshLoginIntent === 'function') markFreshLoginIntent(); // লগইন হিস্টোরি/ইমেইল অ্যালার্টের জন্য — js/session-security.js
  if(triggerBtn){ triggerBtn.disabled = true; triggerBtn.classList.add('is-busy'); }
  try{
    await fbAuth.signInWithPopup(provider);
    closeAuthFlow();
  }catch(e){
    // Popups are blocked inside some installed-PWA / in-app browser contexts —
    // fall back to a full-page redirect, which always works.
    if(e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment' || e.code === 'auth/cancelled-popup-request')){
      try{ await fbAuth.signInWithRedirect(provider); }catch(e2){ showToast(`${meta.label} দিয়ে সাইন-ইন ব্যর্থ হয়েছে`); }
    } else if(e && e.code === 'auth/account-exists-with-different-credential'){
      showToast('এই ইমেইলে আগে থেকেই অন্য পদ্ধতিতে অ্যাকাউন্ট আছে — সেই পদ্ধতিতে লগইন করে প্রোফাইল থেকে এটি লিংক করে নিন');
    } else if(e && e.code === 'auth/operation-not-allowed'){
      showToast(`${meta.label} সাইন-ইন এখনো Firebase কনসোলে চালু করা হয়নি`);
    } else if(e && e.code !== 'auth/popup-closed-by-user'){
      showToast(`${meta.label} দিয়ে সাইন-ইন ব্যর্থ হয়েছে`);
    }
  }finally{
    if(triggerBtn){ triggerBtn.disabled = false; triggerBtn.classList.remove('is-busy'); }
  }
}

async function handleEmailSignup(){
  const name = document.getElementById('suName').value.trim();
  const position = document.getElementById('suPosition').value.trim();
  const email = document.getElementById('suEmail').value.trim();
  const pass = document.getElementById('suPassword').value;
  const pass2 = document.getElementById('suPasswordConfirm').value;
  const errBox = document.getElementById('suError');
  errBox.textContent = '';

  if(!name || !email || !pass){ errBox.textContent = 'সব ঘর পূরণ করুন।'; return; }
  if(pass.length < 6){ errBox.textContent = 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'; return; }
  if(pass !== pass2){ errBox.textContent = 'পাসওয়ার্ড দুটি মিলছে না।'; return; }

  const btn = document.getElementById('suSubmit');
  const btnOriginal = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'অপেক্ষা করুন...';
  if(typeof markFreshLoginIntent === 'function') markFreshLoginIntent(); // লগইন হিস্টোরি/ইমেইল অ্যালার্টের জন্য
  try{
    const cred = await fbAuth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await fbDb.collection('users').doc(cred.user.uid).set({
      name, position, email, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    closeAuthFlow();
  }catch(e){
    errBox.textContent = authErrorMessageBn(e);
  }finally{
    btn.disabled = false; btn.innerHTML = btnOriginal;
  }
}

async function handleEmailLogin(){
  const email = document.getElementById('liEmail').value.trim();
  const pass = document.getElementById('liPassword').value;
  const errBox = document.getElementById('liError');
  errBox.textContent = '';
  if(!email || !pass){ errBox.textContent = 'ইমেইল ও পাসওয়ার্ড দিন।'; return; }

  const btn = document.getElementById('liSubmit');
  btn.disabled = true; btn.textContent = 'অপেক্ষা করুন...';
  if(typeof markFreshLoginIntent === 'function') markFreshLoginIntent(); // লগইন হিস্টোরি/ইমেইল অ্যালার্টের জন্য
  try{
    await fbAuth.signInWithEmailAndPassword(email, pass);
    closeAuthFlow();
  }catch(e){
    errBox.textContent = authErrorMessageBn(e);
  }finally{
    btn.disabled = false; btn.textContent = 'লগইন করুন';
  }
}

// Firebase Authentication-এর নিজস্ব built-in পাসওয়ার্ড-রিসেট — কোনো কাস্টম
// API/সার্ভার/থার্ড-পার্টি ইমেইল-সার্ভিস নেই। actionCodeSettings আসছে
// js/firebase-config.js থেকে (PASSWORD_RESET_ACTION_CODE_SETTINGS)।
async function handlePasswordReset(){
  const email = document.getElementById('fgEmail').value.trim();
  const errBox = document.getElementById('fgError');
  errBox.textContent = '';
  if(!email){ errBox.textContent = 'ইমেইল দিন।'; return; }
  const btn = document.getElementById('fgSubmit');
  btn.disabled = true; btn.textContent = 'পাঠানো হচ্ছে...';
  try{
    await fbAuth.sendPasswordResetEmail(email, PASSWORD_RESET_ACTION_CODE_SETTINGS);
    showToast('পুনরুদ্ধারের লিঙ্ক ইমেইলে পাঠানো হয়েছে');
    closeAuthFlow();
  }catch(e){
    // কোন ইমেইল রেজিস্টার্ড আছে তা বাইরের কেউ যেন বুঝতে না পারে, তাই
    // user-not-found তেও একই সফল বার্তা দেখানো হয়।
    if(e && e.code === 'auth/user-not-found'){
      showToast('পুনরুদ্ধারের লিঙ্ক ইমেইলে পাঠানো হয়েছে');
      closeAuthFlow();
    }else if(e && e.code === 'auth/invalid-email'){
      errBox.textContent = 'সঠিক ইমেইল দিন।';
    }else{
      errBox.textContent = 'ইন্টারনেট সংযোগ পরীক্ষা করুন।';
    }
  }finally{
    btn.disabled = false; btn.textContent = 'পুনরুদ্ধারের লিঙ্ক ইমেইল করুন';
  }
}

function authErrorMessageBn(e){
  const code = e && e.code;
  const map = {
    'auth/email-already-in-use': 'এই ইমেইল দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে।',
    'auth/invalid-email': 'সঠিক ইমেইল দিন।',
    'auth/weak-password': 'পাসওয়ার্ড খুবই দুর্বল।',
    'auth/user-not-found': 'এই ইমেইলে কোনো অ্যাকাউন্ট পাওয়া যায়নি।',
    'auth/wrong-password': 'পাসওয়ার্ড সঠিক নয়।',
    'auth/invalid-credential': 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।',
    'auth/too-many-requests': 'অনেকবার চেষ্টা করা হয়েছে, একটু পর আবার চেষ্টা করুন।',
    'auth/network-request-failed': 'ইন্টারনেট সংযোগ পরীক্ষা করুন।'
  };
  return map[code] || 'কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন।';
}

function confirmLogout(){
  const old = document.getElementById('logoutConfirmModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'logoutConfirmModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>লগ আউট করবেন?</h3><button class="app-modal-close" id="logoutClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">আপনার এই ডিভাইসের ডেটা থাকবে, তবে ক্লাউড সিঙ্ক বন্ধ হয়ে যাবে যতক্ষণ না আবার লগইন করেন।</p>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="logoutCancel">বাতিল</button>
          <button class="tw-save-btn" id="logoutYes">লগ আউট করুন</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('logoutClose').onclick = remove;
  document.getElementById('logoutCancel').onclick = remove;
  document.getElementById('logoutYes').onclick = async () => {
    remove();
    try{ await fbAuth.signOut(); }catch(e){}
    showToast('লগ আউট করা হয়েছে');
  };
}

// ---------- Firestore sync ----------
// On sign-in: pull the cloud copy (if any), merge it with whatever is
// already on this device, save the merged result locally, then push it
// back up — so both directions end up consistent.
async function onSignedIn(fbUser){
  state.user = {
    uid: fbUser.uid,
    name: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : 'ব্যবহারকারী'),
    email: fbUser.email || '',
    position: '',        // পদবি — pulled from Firestore below, editable via the profile modal
    avatarColor: '',     // custom avatar color, editable via the profile modal
    avatarIcon: '',       // preset picture-avatar, editable via the profile modal (empty = use initials)
    photoData: null,      // uploaded profile photo (data URL) — pulled from Firestore below
    phone: '',           // ফোন নম্বর — pulled from Firestore below, editable via the profile modal
    district: '',        // ঠিকানা/এলাকা — pulled from Firestore below, editable via the profile modal
    birthDate: '',        // জন্ম তারিখ — pulled from Firestore below, editable via the profile modal
    bio: '',              // সংক্ষিপ্ত পরিচিতি — pulled from Firestore below, editable via the profile modal
    favoriteQari: '',     // প্রিয় ক্বারী — pulled from Firestore below, editable via the profile modal
    favoriteSurah: '',    // প্রিয় সূরা — pulled from Firestore below, editable via the profile modal
    joinedAt: (fbUser.metadata && fbUser.metadata.creationTime) || null,
    providerIds: (fbUser.providerData || []).map(p => p.providerId),
    provider: (fbUser.providerData && fbUser.providerData[0] && fbUser.providerData[0].providerId) || 'password'
  };
  refreshCurrentView();

  try{
    const doc = await fbDb.collection('users').doc(fbUser.uid).get();
    if(doc.exists){
      const cloud = doc.data();
      if(cloud.name && !fbUser.displayName){ state.user.name = cloud.name; }
      if(cloud.position){ state.user.position = cloud.position; }
      if(cloud.avatarColor){ state.user.avatarColor = cloud.avatarColor; }
      if(cloud.avatarIcon){ state.user.avatarIcon = cloud.avatarIcon; }
      // এটাই আসল বাগ ছিল — ছবি Firestore-এ ঠিকমতো সেভ হতো, কিন্তু রিফ্রেশের
      // সময় state.user নতুন করে বানানোর সময় এই লাইনটা ছিল না, তাই cloud.photoData
      // থাকলেও কখনো state.user-এ ফিরে আসত না এবং প্রোফাইল ছবি "উধাও" দেখাত।
      if(cloud.photoData){ state.user.photoData = cloud.photoData; }
      if(cloud.phone){ state.user.phone = cloud.phone; }
      if(cloud.district){ state.user.district = cloud.district; }
      if(cloud.birthDate){ state.user.birthDate = cloud.birthDate; }
      if(cloud.bio){ state.user.bio = cloud.bio; }
      if(cloud.favoriteQari){ state.user.favoriteQari = cloud.favoriteQari; }
      if(cloud.favoriteSurah){ state.user.favoriteSurah = cloud.favoriteSurah; }
      // এডমিন প্যানেল থেকে সেট করা মডারেশন ফিল্ড — নিচে enforceAccountStatus()
      // এইগুলো পড়ে ব্লক/সীমিত অ্যাকাউন্টের ব্যবস্থা করে।
      state.user.status = cloud.status || 'active';
      state.user.statusReason = cloud.statusReason || '';
      state.user.customThemeGranted = !!cloud.customThemeGranted;
      state.user.mfa = cloud.mfa || null; // টু-ফ্যাক্টর অথেনটিকেশন অবস্থা (js/mfa.js)
      mergeCloudIntoLocal(cloud.progress || {});

      if(state.user.status === 'blocked'){
        await enforceBlockedAccount();
        return; // ব্লক করা হলে বাকি সাইন-ইন ফ্লো (সিঙ্ক পুশ ইত্যাদি) চালানো হবে না
      }
      if(state.user.status === 'restricted'){
        showRestrictedBanner();
      }
    }
  }catch(e){ console.warn('Cloud fetch failed:', e); }

  refreshCurrentView();
  queueCloudSync(true); // push the merged result back up immediately
}

// এডমিন প্যানেল থেকে "ব্লক" করা অ্যাকাউন্ট — সাথে সাথে সাইন-আউট করে
// দেওয়া হয় এবং কারণ (যদি থাকে) সহ একটা মেসেজ দেখানো হয়।
async function enforceBlockedAccount(){
  const reason = state.user.statusReason;
  try{ await fbAuth.signOut(); }catch(e){}
  showToast(
    reason
      ? `আপনার অ্যাকাউন্টে প্রবেশাধিকার সাময়িকভাবে বন্ধ করা হয়েছে: ${reason}`
      : 'আপনার অ্যাকাউন্টে প্রবেশাধিকার সাময়িকভাবে বন্ধ করা হয়েছে। বিস্তারিত জানতে সহায়তার সাথে যোগাযোগ করুন।',
    'error'
  );
}

// এডমিন প্যানেল থেকে "সীমিত" করা অ্যাকাউন্ট — লগইন করতে পারে, শুধু
// প্রোফাইল টেক্সট (নাম/পদবি/বায়ো) এডিট করতে পারে না। saveProfileChanges()-এ
// এর জন্য গার্ড আছে; এখানে শুধু একটা নোটিফিকেশন দেখানো হয়।
function showRestrictedBanner(){
  showToast(
    state.user.statusReason
      ? `আপনার অ্যাকাউন্ট বর্তমানে সীমিত অবস্থায় আছে: ${state.user.statusReason}`
      : 'আপনার অ্যাকাউন্ট বর্তমানে সীমিত অবস্থায় আছে — প্রোফাইলের নাম/পদবি/বায়ো পরিবর্তন করা যাবে না।',
    'error'
  );
}

// Combines a downloaded Firestore `progress` object into the local `state` +
// localStorage. IMPORTANT: the cloud document only ever contains aggregate
// progress numbers (streaks, counts, daily reading seconds) — never which
// surahs/ayahs were read, bookmarks, notes, or reading history, so there is
// nothing "content-shaped" here to merge, only numbers to take the max of.
function mergeCloudIntoLocal(cloud){
  if(!cloud || typeof cloud !== 'object') return;
  suppressNextSync = true;

  // Daily reading time (date -> seconds). Dates alone reveal nothing about
  // which surah was read, so this is safe to merge by date.
  if(cloud.activity && typeof cloud.activity === 'object'){
    const local = loadActivity();
    const merged = { ...cloud.activity };
    Object.keys(local).forEach(k => { merged[k] = Math.max(merged[k] || 0, local[k] || 0); });
    saveActivity(merged);
  }

  if(typeof cloud.searchCount === 'number'){
    state.searchCount = Math.max(state.searchCount || 0, cloud.searchCount);
    try{ IDBKV.set(LS_KEYS.searchCount, String(state.searchCount)); }catch(e){}
  }
  if(typeof cloud.bestStreak === 'number'){
    state.bestStreak = Math.max(state.bestStreak || 0, cloud.bestStreak);
    try{ IDBKV.set(LS_KEYS.bestStreak, String(state.bestStreak)); }catch(e){}
  }
  // Aggregate counts only — the actual sets of which ayahs/surahs stay local
  // on each device and are never uploaded.
  if(typeof cloud.ayahsReadCount === 'number'){
    state.ayahsReadFloor = Math.max(state.ayahsReadFloor || 0, cloud.ayahsReadCount);
    try{ IDBKV.set(LS_KEYS.ayahsReadFloor, String(state.ayahsReadFloor)); }catch(e){}
  }
  if(typeof cloud.audioSurahsPlayedCount === 'number'){
    state.audioSurahsPlayedFloor = Math.max(state.audioSurahsPlayedFloor || 0, cloud.audioSurahsPlayedCount);
    try{ IDBKV.set(LS_KEYS.audioSurahsPlayedFloor, String(state.audioSurahsPlayedFloor)); }catch(e){}
  }
  // Taraweeh tracker: per-Ramadan-day rakat counts. Not surah-related, so
  // it's treated as progress and merged (cloud as base, local wins on conflict).
  if(cloud.taraweeh && typeof cloud.taraweeh === 'object'){
    state.taraweeh.days = { ...(cloud.taraweeh.days||{}), ...(state.taraweeh.days||{}) };
    state.taraweeh.goal = state.taraweeh.goal || cloud.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL;
    saveTaraweeh();
  }

  // Extra badge-progress fields — same aggregate-only, no-content-identity rule.
  if(typeof cloud.topicsExploredCount === 'number'){
    state.topicsExploredFloor = Math.max(state.topicsExploredFloor || 0, cloud.topicsExploredCount);
    try{ IDBKV.set(LS_KEYS.topicsExploredFloor, String(state.topicsExploredFloor)); }catch(e){}
  }
  if(Array.isArray(cloud.themesTried)){
    state.themesTried = Array.from(new Set([...(state.themesTried||[]), ...cloud.themesTried]));
    try{ IDBKV.set(LS_KEYS.themesTried, JSON.stringify(state.themesTried)); }catch(e){}
  }
  if(Array.isArray(cloud.languagesUsed)){
    state.languagesUsed = Array.from(new Set([...(state.languagesUsed||[]), ...cloud.languagesUsed]));
    try{ IDBKV.set(LS_KEYS.languagesUsed, JSON.stringify(state.languagesUsed)); }catch(e){}
  }
  const boolFlags = ['qiblaUsed','tajweedModeUsed','hafezModeUsed','translationCompareUsed','ramadanModeUsed','prayerNotifyEverEnabled','nightOwlDone','earlyBirdDone'];
  boolFlags.forEach(flag => {
    if(cloud[flag] === true && !state[flag]){
      state[flag] = true;
      try{ IDBKV.set(LS_KEYS[flag], '1'); }catch(e){}
    }
  });
  if(typeof cloud.shareCount === 'number'){
    state.shareCount = Math.max(state.shareCount || 0, cloud.shareCount);
    try{ IDBKV.set(LS_KEYS.shareCount, String(state.shareCount)); }catch(e){}
  }

  suppressNextSync = false;
}

// Builds the plain-object snapshot that gets written to users/{uid}.progress
// in Firestore. Deliberately contains ONLY aggregate progress numbers —
// no bookmarks, notes, reading history, last-read position, or which
// surahs/ayahs were involved. Those remain in localStorage on-device only.
function buildSyncSnapshot(){
  return {
    activity: loadActivity(),                 // { "YYYY-MM-DD": secondsReadThatDay }
    searchCount: state.searchCount,
    bestStreak: state.bestStreak,
    ayahsReadCount: ayahsReadCount(),
    audioSurahsPlayedCount: (state.audioSurahsPlayed||[]).length,
    taraweeh: state.taraweeh,
    // Extra badge-progress fields, aggregate-only (see mergeCloudIntoLocal for the privacy rule)
    topicsExploredCount: (state.topicsExplored||[]).length,
    themesTried: state.themesTried || [],
    languagesUsed: state.languagesUsed || [],
    qiblaUsed: !!state.qiblaUsed,
    tajweedModeUsed: !!state.tajweedModeUsed,
    hafezModeUsed: !!state.hafezModeUsed,
    translationCompareUsed: !!state.translationCompareUsed,
    ramadanModeUsed: !!state.ramadanModeUsed,
    prayerNotifyEverEnabled: !!state.prayerNotifyEverEnabled,
    nightOwlDone: !!state.nightOwlDone,
    earlyBirdDone: !!state.earlyBirdDone,
    shareCount: state.shareCount || 0
  };
}

// Debounced push so rapid local changes (e.g. scrolling through several
// ayahs, ticking off several taraweeh days) collapse into one Firestore write.
//
// Offline resilience: if the device is offline (or the write fails for any
// other reason) the change is never silently dropped — cloudSyncPending is
// set, a small pill in the header reflects it (see updateConnStatusPill in
// js/app.js), and the moment the browser fires 'online' again the pending
// snapshot is pushed immediately, no user action needed.
function queueCloudSync(immediate){
  if(!firebaseReady || !state.user || suppressNextSync) return;
  clearTimeout(cloudSyncTimer);
  const run = async () => {
    if(cloudSyncInFlight) return;
    if(!navigator.onLine){
      // নেটওয়ার্ক কল চেষ্টা করে সময় নষ্ট না করে সরাসরি pending রাখা — 'online'
      // ইভেন্টে নিচের লিসেনার নিজে থেকেই আবার পাঠাবে।
      cloudSyncPending = true;
      if(typeof updateConnStatusPill === 'function') updateConnStatusPill();
      return;
    }
    cloudSyncInFlight = true;
    const wasPending = cloudSyncPending;
    try{
      await fbDb.collection('users').doc(state.user.uid).set({
        progress: buildSyncSnapshot(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      cloudSyncPending = false;
      if(wasPending && typeof showToast === 'function') showToast('✅ আপনার অগ্রগতি আবার সিঙ্ক হয়ে গেছে');
    }catch(e){
      console.warn('Cloud sync failed:', e);
      cloudSyncPending = true; // অস্থায়ী নেটওয়ার্ক/সার্ভার সমস্যা — পরে আবার চেষ্টা হবে
    }
    cloudSyncInFlight = false;
    if(typeof updateConnStatusPill === 'function') updateConnStatusPill();
  };
  if(immediate) run();
  else cloudSyncTimer = setTimeout(run, 2500);
}

// ইন্টারনেট আবার ফিরে এলে, কোনো সিঙ্ক বাকি থাকলে সাথে সাথেই আবার পাঠানো হয় —
// ইউজারকে কিছু করতে হয় না, কোনো অগ্রগতি হারায় না।
window.addEventListener('online', () => {
  if(cloudSyncPending && state.user) queueCloudSync(true);
});

// ---------- Profile modal: view + manage everything about the account ----------
// Opened by tapping the account strip at the top of the পরিসংখ্যান (stats) view
// once a user is signed in. Lets them edit name/position/avatar color, see a
// quick lifetime-stats summary, change password, log out, or delete the account.
const PROFILE_AVATAR_COLORS = ['#2f6f61','#c9973a','#8a4b3b','#4a5a8a','#6b7d3d','#7a4a7a','#3d6b7d'];

// Preset picture-avatars — Font Awesome solid icons (already loaded via
// the cdnjs link in index.html) on a themed color disc. No image uploads
// or hosting needed, works fully offline like the rest of the app.
// user.avatarIcon stores which one is picked (empty string = use initials).
const PROFILE_AVATARS = [
  { icon:'moon',              color:'#2f6f61' },
  { icon:'mosque',            color:'#c9973a' },
  { icon:'book-quran',        color:'#4a5a8a' },
  { icon:'kaaba',             color:'#3d3d3d' },
  { icon:'star-and-crescent', color:'#8a4b3b' },
  { icon:'hands-praying',     color:'#6b7d3d' },
  { icon:'star',              color:'#7a4a7a' },
  { icon:'gem',               color:'#3d6b7d' },
  { icon:'leaf',              color:'#3f7d4a' },
  { icon:'seedling',          color:'#4a8f5c' },
  { icon:'dove',              color:'#5a7a9a' },
  { icon:'feather',           color:'#7a8a5a' },
  { icon:'sun',               color:'#c9862f' },
  { icon:'cloud',             color:'#6a8a9a' },
  { icon:'water',             color:'#2b6a8f' },
  { icon:'fire',              color:'#b5522f' },
  { icon:'mountain',          color:'#5a5a6a' },
  { icon:'compass',           color:'#3a6a7a' },
  { icon:'crown',             color:'#9a7a2f' },
  { icon:'heart',             color:'#b5566f' }
];

// True only for icon names that exist in PROFILE_AVATARS — guards against
// rendering an arbitrary/unexpected value that might end up on user.avatarIcon.
function isKnownAvatarIcon(icon){
  return PROFILE_AVATARS.some(a => a.icon === icon);
}

// Shared by the profile modal preview + the account strip on পরিসংখ্যান —
// returns the icon markup if the user picked one, otherwise the initial letter.
function avatarGlyph(user){
  if(user && user.avatarIcon && isKnownAvatarIcon(user.avatarIcon)){
    return `<i class="fa-solid fa-${user.avatarIcon}"></i>`;
  }
  const initial = ((user && (user.name || user.email)) || '?').trim().charAt(0).toUpperCase();
  return escapeHtml(initial);
}

function formatJoinDateBn(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const months = (typeof BN_MONTHS !== 'undefined') ? BN_MONTHS : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${toBn(d.getDate())} ${months[d.getMonth()]}, ${toBn(d.getFullYear())}`;
}

// Language-aware date formatting for the profile hero/chip — Bengali gets
// the app's own hand-formatted Bengali-numeral style, every other
// interface language gets its own locale's date formatting via the
// browser's Intl support (falls back to English if a locale is unknown).
function formatJoinDate(iso, lang){
  if(!iso) return '';
  lang = lang || state.language;
  if(lang === 'bn') return formatJoinDateBn(iso);
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  try{
    return d.toLocaleDateString(lang, { day:'numeric', month:'short', year:'numeric' });
  }catch(e){
    return d.toLocaleDateString('en', { day:'numeric', month:'short', year:'numeric' });
  }
}

// Optional fields counted toward the "profile completeness" ring — order
// doesn't matter, just used as a denominator + for the view-card chip list.
// labelKey is resolved through tr() at render time so it always matches
// state.language, instead of being frozen in whatever language was active
// when this file first loaded.
const PROFILE_OPTIONAL_FIELDS = [
  { key:'position',      icon:'id-badge',      labelKey:'profile_label_position' },
  { key:'phone',         icon:'phone',         labelKey:'profile_label_phone' },
  { key:'district',      icon:'location-dot',  labelKey:'profile_label_district' },
  { key:'birthDate',     icon:'cake-candles',  labelKey:'profile_label_birthdate', fmt:(v)=>formatJoinDate(v) },
  { key:'favoriteQari',  icon:'microphone',    labelKey:'profile_label_qari' },
  { key:'favoriteSurah', icon:'bookmark',      labelKey:'profile_label_surah' }
];
function profileCompletionPct(u, avatarIconVal){
  const flags = [!!(u.bio && u.bio.trim()), !!avatarIconVal, ...PROFILE_OPTIONAL_FIELDS.map(f => !!(u[f.key] && String(u[f.key]).trim()))];
  const filled = flags.filter(Boolean).length;
  return Math.round((filled / flags.length) * 100);
}

// Counts up a stat number from 0 to target with an eased animation. Digits
// are re-rendered through toBn() every frame so it reads in Bengali numerals
// throughout, not just at the end.
function animateCountUp(el, target, duration){
  duration = duration || 700;
  if(!el) return;
  if(!target || target <= 0){ el.textContent = localNum(0); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
    el.textContent = localNum(Math.round(target * eased));
    if(t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Compact 8-week activity strip for the profile card, same data + level
// logic as the full heatmap on the stats page (buildHeatmapWeeks/heatmapLevel
// in js/stats.js), just fewer columns for a tighter card.
function renderMiniHeatmap(activity){
  if(typeof heatmapLevel !== 'function') return '';
  const weeksBack = 8;
  const today = new Date();
  const endDow = today.getDay();
  const gridEnd = new Date(today); gridEnd.setDate(today.getDate() + (6 - endDow));
  const totalDays = weeksBack * 7;
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
  for(let w=0; w<weeksBack; w++) weeks.push(days.slice(w*7, w*7+7));
  const activeDays = days.filter(d => !d.future && d.min > 0).length;
  return `
    <div class="stats-card heatmap-card profile-mini-heatmap">
      <div class="stats-top-row" style="margin-bottom:8px;">
        <div class="stats-label">${tr('profile_heatmap_title')}</div>
        <div class="stats-label">${localNum(activeDays)} ${tr('profile_heatmap_active_days')}</div>
      </div>
      <div class="heatmap-grid">
        ${weeks.map(week => `<div class="heatmap-col">${week.map(d => {
          if(d.future) return `<div class="heatmap-cell heatmap-future"></div>`;
          const lvl = heatmapLevel(d.min, maxMin);
          return `<div class="heatmap-cell heatmap-lv${lvl}" title="${d.key}: ${d.min}m"></div>`;
        }).join('')}</div>`).join('')}
      </div>
      <div class="heatmap-legend"><span>${tr('profile_heatmap_low')}</span><span class="heatmap-cell heatmap-lv0"></span><span class="heatmap-cell heatmap-lv1"></span><span class="heatmap-cell heatmap-lv2"></span><span class="heatmap-cell heatmap-lv3"></span><span class="heatmap-cell heatmap-lv4"></span><span>${tr('profile_heatmap_high')}</span></div>
    </div>`;
}

// প্রতিটা সোশ্যাল প্রোভাইডারের জন্য একটা আইকনসহ লিস্ট-রো বানায় (একাউন্ট
// লিংক করার মডালে ব্যবহৃত হয়): লিংক করা না থাকলে "লিংক করুন" পিল-বাটন,
// লিংক করা থাকলে ও নিরাপদে আনলিংক করা গেলে "আনলিংক" বাটন, আর সেটাই যদি
// অ্যাকাউন্টে ঢোকার একমাত্র উপায় হয় তাহলে শুধু লক আইকন (যাতে ভুল করে
// নিজেকে লক করে ফেলা না যায়)।
function renderLinkAccountRows(providerIds){
  return SOCIAL_PROVIDERS.map(p => {
    const linked = providerIds.includes(p.id);
    const canUnlink = linked && providerIds.length > 1;
    let action = '';
    let stateText = tr('profile_link_not_connected');
    let stateClass = '';
    if(linked && canUnlink){
      stateText = tr('profile_link_connected'); stateClass = 'is-linked';
      action = `<button type="button" class="link-account-action link-account-action-unlink" data-unlink-provider="${p.id}"><i class="fa-solid fa-link-slash"></i><span>${tr('profile_link_unlink')}</span></button>`;
    } else if(linked && !canUnlink){
      stateText = tr('profile_link_signin_method'); stateClass = 'is-linked is-locked';
      action = `<span class="link-account-locked" title="${tr('profile_link_locked_title')}"><i class="fa-solid fa-lock"></i></span>`;
    } else {
      action = `<button type="button" class="link-account-action link-account-action-link" data-link-provider="${p.id}"><i class="fa-solid fa-plus"></i><span>${tr('profile_link_link')}</span></button>`;
    }
    return `
      <div class="link-account-row ${stateClass}" style="--brand-color:${p.color}">
        <div class="link-account-icon"><i class="${p.icon}"></i></div>
        <div class="link-account-info">
          <span class="link-account-name">${escapeHtml(p.label)}</span>
          <span class="link-account-state">${linked ? '<i class="fa-solid fa-circle-check"></i> ' : ''}${stateText}</span>
        </div>
        ${action}
      </div>`;
  }).join('');
}


// Copies a value (user ID, server address, ...) to the clipboard with a
// toast confirmation. Falls back to the old execCommand trick on browsers/
// contexts where navigator.clipboard isn't available (e.g. non-HTTPS).
async function copyProfileValue(text, btn){
  try{
    await navigator.clipboard.writeText(text);
    showToast(tr('profile_copied'));
  }catch(e){
    try{
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(tr('profile_copied'));
    }catch(e2){
      showToast(tr('profile_copy_failed'));
    }
  }
}

// ---------- সংযুক্ত করা যায় এমন সোশ্যাল/OAuth অ্যাকাউন্ট ----------
// প্রতিটি এন্ট্রি Firebase Auth-এর প্রকৃতভাবে সমর্থিত একটি প্রোভাইডার (এখানে
// শুধু সেগুলোই যোগ করা হয়েছে যেগুলো সত্যিই কাজ করে)। নতুন কোনো প্রোভাইডার
// যোগ করতে হলে শুধু এই তালিকায় একটা এন্ট্রি বসালেই প্রোফাইল মডালে বাটন,
// লিংক/আনলিংক — সবকিছু নিজে থেকেই তৈরি হয়ে যাবে (নিচের কোড জেনেরিক)।
//
// গুরুত্বপূর্ণ সীমাবদ্ধতা: Instagram বা WhatsApp এখানে নেই, কারণ Meta এই
// দুটোর কোনোটার জন্যই তৃতীয়-পক্ষ ওয়েবসাইটে "সাইন-ইন/লিংক করুন" ধরনের কোনো
// পাবলিক OAuth সুবিধা দেয় না (Instagram Basic Display API লগইনের জন্য নয়,
// আর WhatsApp আদৌ কোনো আইডেন্টিটি-প্রোভাইডার নয়, এটা শুধু মেসেজিং অ্যাপ)।
// তাই এই দুটোর জন্য বাটন বসালে সেটা আসলে কখনোই কাজ করবে না — ভুয়া বাটন না
// রেখে সত্যিকারের কাজ-করা অপশনগুলোই (Google + এখন Facebook/X/GitHub/
// Microsoft) দেওয়া হলো।
//
// প্রতিটা প্রোভাইডার ব্যবহারের আগে Firebase কনসোল → Authentication →
// Sign-in method-এ চালু করে সেই প্ল্যাটফর্মের নিজস্ব ডেভেলপার কনসোল থেকে
// App ID/Secret বসাতে হবে — না হলে auth/operation-not-allowed এরর আসবে
// (নিচে সেই এরর ধরে বন্ধুত্বপূর্ণ মেসেজও দেখানো হয়)।
const SOCIAL_PROVIDERS = [
  { id: 'google.com',    label: 'Google',      icon: 'fa-brands fa-google',    color: '#EA4335', factory: () => new firebase.auth.GoogleAuthProvider() },
  { id: 'facebook.com',  label: 'Facebook',    icon: 'fa-brands fa-facebook',  color: '#1877F2', factory: () => new firebase.auth.FacebookAuthProvider() },
  { id: 'twitter.com',   label: 'X (Twitter)', icon: 'fa-brands fa-x-twitter', color: '#000000', factory: () => new firebase.auth.TwitterAuthProvider() },
  { id: 'github.com',    label: 'GitHub',      icon: 'fa-brands fa-github',    color: '#181717', factory: () => new firebase.auth.GithubAuthProvider() },
  { id: 'microsoft.com', label: 'Microsoft',   icon: 'fa-brands fa-microsoft', color: '#00A4EF', factory: () => new firebase.auth.OAuthProvider('microsoft.com') }
];
function getSocialProvider(id){ return SOCIAL_PROVIDERS.find(p => p.id === id); }

// ---------- "একাউন্ট লিংক করুন" মডাল ----------
// প্রোফাইল মডালে আগে সরাসরি একটা গ্রিডে সবগুলো প্ল্যাটফর্ম দেখানো হতো।
// এখন প্রোফাইলে শুধু একটা "একাউন্ট লিংক করুন" বাটন থাকে, আর সেটাতে ট্যাপ
// করলে এই আলাদা মডালে Google/Facebook/X/GitHub/Microsoft-এর একটা স্মার্ট,
// আধুনিক লিস্ট দেখানো হয় — প্রতিটার পাশে লিংক/আনলিংক অ্যাকশন। প্রোফাইল
// মডাল বন্ধ না করেই এটা তার উপরে খোলে, যাতে পেছনে ফিরে গেলে প্রোফাইল
// আবার রিলোড হওয়ার দরকার না পড়ে।
function openLinkAccountsModal(){
  const user = state.user;
  if(!user) return;
  const old = document.getElementById('linkAccountsModal');
  if(old) old.remove();
  const providerIds = user.providerIds || [user.provider || 'password'];

  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'linkAccountsModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal link-accounts-modal-box">
      <div class="app-modal-head">
        <h3><i class="fa-solid fa-link"></i> একাউন্ট লিংক করুন</h3>
        <button class="app-modal-close" id="linkAccountsClose">✕</button>
      </div>
      <div class="app-modal-body">
        <p class="link-accounts-hint">যেকোনো প্ল্যাটফর্ম লিংক করলে সেটা দিয়েও সরাসরি সাইন-ইন করা যাবে — পাসওয়ার্ড ছাড়াই।</p>
        <div class="link-account-list" id="linkAccountList">${renderLinkAccountRows(providerIds)}</div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('linkAccountsClose').onclick = remove;

  wireLinkAccountActions();
}

// মডালটা বন্ধ না করেই ভেতরের লিস্ট রি-রেন্ডার করে (লিংক/আনলিংক হওয়ার পর),
// আর পেছনে খোলা প্রোফাইল মডালের সামারি টেক্সটও একইসাথে আপডেট করে দেয়।
function refreshLinkAccountsModalBody(){
  if(!state.user) return;
  const providerIds = state.user.providerIds || [state.user.provider || 'password'];
  const list = document.getElementById('linkAccountList');
  if(list){ list.innerHTML = renderLinkAccountRows(providerIds); wireLinkAccountActions(); }
  updateLinkAccountSummary(providerIds);
}

function wireLinkAccountActions(){
  const list = document.getElementById('linkAccountList');
  if(!list) return;
  list.querySelectorAll('[data-link-provider]').forEach(btn => {
    btn.onclick = () => {
      const pid = btn.getAttribute('data-link-provider');
      btn.disabled = true; btn.classList.add('is-busy');
      linkSocialAccount(pid, btn, refreshLinkAccountsModalBody).finally(() => {
        if(document.body.contains(btn)) btn.classList.remove('is-busy');
      });
    };
  });
  list.querySelectorAll('[data-unlink-provider]').forEach(btn => {
    btn.onclick = () => confirmUnlinkProvider(btn.getAttribute('data-unlink-provider'), refreshLinkAccountsModalBody);
  });
}

// প্রোফাইল মডালের "একাউন্ট লিংক করুন" বাটনের নিচে কতগুলো প্ল্যাটফর্ম
// সংযুক্ত আছে তার সামারি টেক্সট আপডেট করে (প্রোফাইল মডাল খোলা থাকলে)।
function updateLinkAccountSummary(providerIds){
  const sub = document.getElementById('profLinkAccountsSub');
  if(!sub) return;
  const linkedCount = SOCIAL_PROVIDERS.filter(p => providerIds.includes(p.id)).length;
  sub.textContent = linkedCount ? `${toBn(linkedCount)}টি প্ল্যাটফর্ম সংযুক্ত` : 'কোনো প্ল্যাটফর্ম সংযুক্ত নেই';
}

// লগইন করা অ্যাকাউন্টে যেকোনো একটি সোশ্যাল প্রোভাইডার লিংক করে — একই uid,
// একই Firestore ডেটা, শুধু সাইন-ইন করার আরেকটা উপায় যোগ হয়। প্রোভাইডারের
// ইমেইল আর অ্যাকাউন্টের ইমেইল না মিললে লিংক সাথে সাথে বাতিল করে দেওয়া হয়,
// যাতে ভুল করে অন্য কারও অ্যাকাউন্ট এসে না জোড়ে।
async function linkSocialAccount(providerId, triggerBtn, onDone){
  const fbUser = fbAuth.currentUser;
  const meta = getSocialProvider(providerId);
  if(!fbUser || !meta){ if(triggerBtn) triggerBtn.disabled = false; return; }
  try{
    const provider = meta.factory();
    const result = await fbUser.linkWithPopup(provider);
    const entry = (result.user.providerData || []).find(p => p.providerId === providerId);
    const currentEmail = (fbUser.email || '').toLowerCase();
    if(entry && entry.email && currentEmail && entry.email.toLowerCase() !== currentEmail){
      await fbUser.unlink(providerId);
      showToast(`এই ${meta.label} অ্যাকাউন্টের ইমেইল আপনার প্রোফাইলের ইমেইলের সাথে মিলছে না`);
      return;
    }
    if(state.user){ state.user.providerIds = (result.user.providerData || []).map(p => p.providerId); }
    showToast(`${meta.label} অ্যাকাউন্ট লিংক করা হয়েছে`);
    if(onDone) onDone();
  }catch(e){
    if(e && e.code === 'auth/credential-already-in-use'){
      showToast(`এই ${meta.label} অ্যাকাউন্ট ইতিমধ্যে অন্য একটি অ্যাকাউন্টের সাথে যুক্ত`);
    } else if(e && e.code === 'auth/popup-closed-by-user'){
      // ইউজার নিজেই পপআপ বন্ধ করেছেন — কিছু বলার দরকার নেই
    } else if(e && e.code === 'auth/operation-not-allowed'){
      showToast(`${meta.label} সাইন-ইন এখনো Firebase কনসোলে চালু করা হয়নি`);
    } else {
      showToast('লিংক করতে ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    }
  }finally{
    if(triggerBtn) triggerBtn.disabled = false;
  }
}

// আনলিংক করার আগে কনফার্ম করে নেয়। এটা তখনই দেখানো হয় যখন সেই প্রোভাইডারটা
// বাদ দিলেও অ্যাকাউন্টে ঢোকার অন্তত আরেকটা উপায় (পাসওয়ার্ড বা অন্য প্রোভাইডার)
// থেকে যায় — যাতে ভুল করে নিজেকে নিজের অ্যাকাউন্ট থেকে লক করে ফেলা না যায়
// (js/profile-view.js-এর profileContentHtml() এই শর্ত যাচাই করে বাটন দেখানো হয়)।
function confirmUnlinkProvider(providerId, onDone){
  const meta = getSocialProvider(providerId);
  if(!meta) return;
  const old = document.getElementById('unlinkProviderModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'unlinkProviderModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>${escapeHtml(meta.label)} আনলিংক করবেন?</h3><button class="app-modal-close" id="unlinkPClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">এরপর থেকে ${escapeHtml(meta.label)} দিয়ে আর সাইন-ইন করা যাবে না।</p>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="unlinkPCancel">বাতিল</button>
          <button class="tw-save-btn" id="unlinkPYes">আনলিংক করুন</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('unlinkPClose').onclick = remove;
  document.getElementById('unlinkPCancel').onclick = remove;
  document.getElementById('unlinkPYes').onclick = async () => {
    remove();
    const fbUser = fbAuth.currentUser;
    if(!fbUser) return;
    try{
      await fbUser.unlink(providerId);
      if(state.user){ state.user.providerIds = (state.user.providerIds || []).filter(p => p !== providerId); }
      showToast(`${meta.label} আনলিংক করা হয়েছে`);
      if(onDone) onDone(); else renderProfileView();
    }catch(e){
      showToast('আনলিংক করতে ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    }
  };
}

// Persists name/position/avatarColor to Firebase Auth (displayName) + the
// Firestore profile doc, then updates local state so the whole app reflects
// it immediately (account strip, badges, etc.) without a reload.
async function saveProfileChanges({ name, position, avatarColor, avatarIcon, photoData, phone, district, birthDate, bio, favoriteQari, favoriteSurah }){
  const fbUser = fbAuth.currentUser;
  if(!fbUser) throw new Error('not signed in');
  // "সীমিত" স্ট্যাটাসের অ্যাকাউন্ট নাম/পদবি/বায়ো পরিবর্তন করতে পারবে না —
  // এডমিন প্যানেলে এই অ্যাকাউন্টের moderation স্ট্যাটাস restricted করা আছে।
  if(state.user.status === 'restricted'){
    const changed = name !== state.user.name || position !== state.user.position || bio !== state.user.bio;
    if(changed){
      throw new Error('restricted: প্রোফাইলের নাম/পদবি/বায়ো এখন পরিবর্তন করা যাবে না');
    }
  }
  if(fbUser.displayName !== name){ await fbUser.updateProfile({ displayName: name }); }
  // photoData: null (user removed their photo) vs undefined (untouched —
  // caller always passes pickedPhotoData though, so this is really just
  // null-vs-string) both need to reach Firestore as an explicit null so a
  // previously-set photo actually clears instead of lingering forever.
  await fbDb.collection('users').doc(fbUser.uid).set({
    name, position, avatarColor, avatarIcon, photoData: photoData || null, phone, district, birthDate, bio, favoriteQari, favoriteSurah
  }, { merge: true });
  Object.assign(state.user, { name, position, avatarColor, avatarIcon, photoData: photoData || null, phone, district, birthDate, bio, favoriteQari, favoriteSurah });
  refreshCurrentView();
}

async function handleSendPasswordReset(email){
  if(!email) return;
  try{
    await fbAuth.sendPasswordResetEmail(email, PASSWORD_RESET_ACTION_CODE_SETTINGS);
    showToast('পাসওয়ার্ড রিসেট লিঙ্ক ইমেইলে পাঠানো হয়েছে');
  }catch(e){
    if(e && e.code === 'auth/user-not-found'){
      showToast('পাসওয়ার্ড রিসেট লিঙ্ক ইমেইলে পাঠানো হয়েছে');
    }else{
      showToast('পাঠাতে ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    }
  }
}

// Shown right after OTP verification for "পাসওয়ার্ড পরিবর্তন করুন" — collects
// the new password and applies it via Firebase Auth. If Firebase asks for a
// recent login (e.g. the session is old), we sign out and send the user back
// through the login screen rather than silently failing.
function openNewPasswordModal(){
  const old = document.getElementById('newPassModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'newPassModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>নতুন পাসওয়ার্ড দিন</h3><button class="app-modal-close" id="npClose">✕</button></div>
      <div class="app-modal-body">
        <input class="auth-field" id="npNew" type="password" placeholder="নতুন পাসওয়ার্ড">
        <input class="auth-field" id="npConfirm" type="password" placeholder="পাসওয়ার্ড নিশ্চিত করুন">
        <div class="auth-error" id="npError"></div>
        <button class="auth-cta-btn" id="npSubmit">পাসওয়ার্ড পরিবর্তন করুন</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('npClose').onclick = remove;

  document.getElementById('npSubmit').onclick = async () => {
    const pw = document.getElementById('npNew').value;
    const pw2 = document.getElementById('npConfirm').value;
    const errBox = document.getElementById('npError');
    errBox.textContent = '';
    if(!pw || pw.length < 6){ errBox.textContent = 'অন্তত ৬ অক্ষরের পাসওয়ার্ড দিন।'; return; }
    if(pw !== pw2){ errBox.textContent = 'পাসওয়ার্ড দুটি মিলছে না।'; return; }

    const btn = document.getElementById('npSubmit');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'পরিবর্তন হচ্ছে...';
    try{
      const fbUser = fbAuth.currentUser;
      if(!fbUser) throw new Error('not signed in');
      await fbUser.updatePassword(pw);
      showToast('পাসওয়ার্ড পরিবর্তন হয়েছে');
      remove();
    }catch(e){
      if(e && e.code === 'auth/requires-recent-login'){
        remove();
        showToast('নিরাপত্তার জন্য আবার লগইন করুন, তারপর পাসওয়ার্ড পরিবর্তন করুন');
        try{ await fbAuth.signOut(); }catch(e2){}
        openAuthFlow('login');
      } else {
        errBox.textContent = 'পরিবর্তন ব্যর্থ হয়েছে, আবার চেষ্টা করুন।';
        btn.disabled = false; btn.textContent = original;
      }
    }
  };
}

// Shown when "পাসওয়ার্ড পরিবর্তন করুন" is tapped — asks the user to confirm
// intent before an OTP email goes out (so a stray tap doesn't fire off an
// email). Only on confirm does startOtpFlow() actually send anything.
function confirmPasswordChange(user){
  const old = document.getElementById('passChangeConfirmModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'passChangeConfirmModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>পাসওয়ার্ড পরিবর্তন করবেন?</h3><button class="app-modal-close" id="pcClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">নিশ্চিত করলে <b>${escapeHtml(user.email||'')}</b>-এ একটি যাচাইকরণ কোড (OTP) পাঠানো হবে। কোড দিয়ে যাচাই করার পর নতুন পাসওয়ার্ড সেট করতে পারবেন।</p>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="pcCancel">বাতিল</button>
          <button class="tw-save-btn" id="pcYes">কোড পাঠান</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('pcClose').onclick = remove;
  document.getElementById('pcCancel').onclick = remove;
  document.getElementById('pcYes').onclick = () => {
    remove();
    startOtpFlow({
      email: user.email,
      name: user.name,
      purposeLabel: 'পাসওয়ার্ড পরিবর্তন',
      onVerified: openNewPasswordModal
    });
  };
}

// Permanently deletes the Firebase Auth account + its Firestore profile doc.
// On-device data (bookmarks, notes, history) is left alone, matching the
// same "cloud vs local" split used everywhere else in this file.
function confirmDeleteAccount(){
  const old = document.getElementById('deleteAccountModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'deleteAccountModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>অ্যাকাউন্ট মুছে ফেলবেন?</h3><button class="app-modal-close" id="delAccClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">এটি স্থায়ীভাবে আপনার অ্যাকাউন্ট এবং ক্লাউডে সংরক্ষিত অগ্রগতি মুছে ফেলবে। এই ডিভাইসের স্থানীয় ডেটা (বুকমার্ক, নোট, ইতিহাস) অক্ষত থাকবে।</p>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="delAccCancel">বাতিল</button>
          <button class="tw-save-btn profile-delete-confirm-btn" id="delAccYes">মুছে ফেলুন</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('delAccClose').onclick = remove;
  document.getElementById('delAccCancel').onclick = remove;
  document.getElementById('delAccYes').onclick = () => {
    remove();
    const fbUser = fbAuth.currentUser;
    if(!fbUser) return;
    startOtpFlow({
      email: fbUser.email,
      name: state.user && state.user.name,
      purposeLabel: 'অ্যাকাউন্ট স্থায়ীভাবে মুছে ফেলা',
      onVerified: performAccountDeletion
    });
  };
}

// Runs only after the email OTP above is verified. Deletes the Firestore
// profile doc, then the Firebase Auth account itself — irreversible.
async function performAccountDeletion(){
  const fbUser = fbAuth.currentUser;
  if(!fbUser) return;
  try{
    await deleteAccountEverywhere(fbUser);
  }catch(e){
    if(e && e.code === 'auth/requires-recent-login'){
      // Firebase wants fresh proof of identity before a destructive action
      // like this. Instead of bouncing the user out to the login screen
      // (which would abandon the whole delete flow), reauthenticate right
      // here and retry — the OTP step above already confirmed intent.
      await reauthenticateThenDelete(fbUser);
    } else {
      showToast('মুছতে ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    }
  }
}

// Firestore does NOT remove the sub-collections of a document when the document itself is deleted. Everything the
// account owns below users/{uid} (login sessions with their device / network records, trusted devices, saved
// highlights) and the owner's own status posts (with their view / reaction records) is therefore removed here,
// while the security rules still recognise the signed-in owner. Best effort and never throws: whatever cannot be
// removed here must not block the deletion of the account itself.
async function deleteOwnAccountData(uid){
  if(!uid || typeof fbDb === 'undefined' || !fbDb) return;
  // Batches stay small on purpose: some of these rules look up other documents (the parent post, the admin list)
  // and Firestore caps those lookups per batched write.
  async function wipe(query, maxBatch, maxRounds){
    for(let round = 0; round < maxRounds; round++){
      const snap = await query.limit(maxBatch).get();
      if(snap.empty) return;
      const batch = fbDb.batch();
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
      if(snap.size < maxBatch) return;
    }
  }
  const userRef = fbDb.collection('users').doc(uid);
  for(const name of ['sessions', 'trustedDevices', 'highlights']){
    try{ await wipe(userRef.collection(name), 8, 60); }
    catch(e){ console.warn('account data cleanup skipped:', name, e); }
  }
  try{
    const mine = await fbDb.collection('statuses').where('uid', '==', uid).get();
    for(const s of mine.docs){
      try{ await wipe(s.ref.collection('views'), 8, 60); }catch(e){}
      try{ await wipe(s.ref.collection('reactions'), 8, 60); }catch(e){}
      try{ await s.ref.delete(); }catch(e){ console.warn('status cleanup skipped:', e); }
    }
  }catch(e){ console.warn('status cleanup skipped:', e); }
  // Story moderation records (pending/rejected submissions, counters, audit log) live in server-only collections the
  // browser cannot touch — ask the server to purge them while the user's token is still valid. Best effort.
  try{
    const cu = (typeof fbAuth !== 'undefined' && fbAuth) ? fbAuth.currentUser : null;
    if(cu && cu.uid === uid){
      const token = await cu.getIdToken();
      await fetch('/api/story-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'purge' })
      });
    }
  }catch(e){ console.warn('story moderation cleanup skipped:', e); }
}

// Deletes the Firestore profile doc, then the Firebase Auth account itself.
// The Firestore delete gets one retry — once the Auth account is gone,
// the security rules that allow a user to delete their own doc no longer
// apply, so this is the only real window to clean that data up. If both
// attempts fail we still proceed to remove the Auth account (that's the
// step the user is actually waiting on), but that's the rare case, not
// something silently accepted on the first hiccup.
// Errors from either step (e.g. auth/requires-recent-login) propagate to
// the caller so it can reauthenticate and retry.
async function deleteAccountEverywhere(fbUser){
  try{ if(typeof stopSessionHeartbeat === 'function') stopSessionHeartbeat(); }catch(e){}
  await deleteOwnAccountData(fbUser.uid);
  try{
    await fbDb.collection('users').doc(fbUser.uid).delete();
  }catch(e){
    try{ await fbDb.collection('users').doc(fbUser.uid).delete(); }catch(e2){ /* proceed anyway — Auth delete below still fully removes the account */ }
  }
  await fbUser.delete();
  showToast('অ্যাকাউন্ট স্থায়ীভাবে মুছে ফেলা হয়েছে');
}

// Re-proves identity, then retries the delete — without ever sending the
// user away from this flow. Google accounts reauthenticate via a popup;
// password accounts get an inline "confirm your password" modal.
async function reauthenticateThenDelete(fbUser){
  const providerId = fbUser.providerData && fbUser.providerData[0] && fbUser.providerData[0].providerId;
  const meta = getSocialProvider(providerId);

  if(meta){
    try{
      await fbUser.reauthenticateWithPopup(meta.factory());
      await deleteAccountEverywhere(fbUser);
    }catch(e){
      showToast('যাচাই ব্যর্থ হয়েছে, অ্যাকাউন্ট মুছা যায়নি — আবার চেষ্টা করুন');
    }
    return;
  }

  openReauthPasswordModal(async (password) => {
    try{
      const cred = firebase.auth.EmailAuthProvider.credential(fbUser.email, password);
      await fbUser.reauthenticateWithCredential(cred);
      await deleteAccountEverywhere(fbUser);
      return true;
    }catch(e){
      return false; // wrong password or delete failed — let the modal show an error and retry
    }
  });
}

// Small inline modal used only by reauthenticateThenDelete() above — asks
// for the current password, calls onSubmit(password) which resolves
// true/false, and only closes on success.
function openReauthPasswordModal(onSubmit){
  const old = document.getElementById('reauthPassModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'reauthPassModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>পাসওয়ার্ড দিয়ে নিশ্চিত করুন</h3><button class="app-modal-close" id="raClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">নিরাপত্তার জন্য অ্যাকাউন্ট মুছে ফেলার আগে আপনার বর্তমান পাসওয়ার্ডটি দিন।</p>
        <input class="auth-field" id="raPassword" type="password" placeholder="বর্তমান পাসওয়ার্ড">
        <div class="auth-error" id="raError"></div>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="raCancel">বাতিল</button>
          <button class="tw-save-btn profile-delete-confirm-btn" id="raSubmit">অ্যাকাউন্ট মুছে ফেলুন</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('raClose').onclick = remove;
  document.getElementById('raCancel').onclick = remove;
  document.getElementById('raSubmit').onclick = async () => {
    const pw = document.getElementById('raPassword').value;
    const errBox = document.getElementById('raError');
    errBox.textContent = '';
    if(!pw){ errBox.textContent = 'পাসওয়ার্ড দিন।'; return; }
    const btn = document.getElementById('raSubmit');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'যাচাই হচ্ছে...';
    const ok = await onSubmit(pw);
    if(ok){
      remove();
    } else {
      errBox.textContent = 'পাসওয়ার্ড ভুল অথবা মুছতে ব্যর্থ হয়েছে, আবার চেষ্টা করুন।';
      btn.disabled = false; btn.textContent = original;
    }
  };
}
