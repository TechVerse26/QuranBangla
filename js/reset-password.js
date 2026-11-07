// ---------- Password reset landing flow (pure JS, no separate HTML page) ----------
// When a user clicks the reset link in their email, Firebase sends them back
// to THIS SAME index.html with ?mode=resetPassword&oobCode=XXXX in the URL
// (set via actionCodeSettings.url in js/auth.js). This file detects that on
// load, builds a small overlay purely with JS (same pattern as ensureAuthOverlay
// in js/auth.js), verifies the code with Firebase, and lets the user set a
// new password — all without ever leaving index.html.
//
// Security note: the oobCode is generated and verified entirely by Firebase
// server-side (verifyPasswordResetCode / confirmPasswordReset). This file
// never trusts the URL by itself — an invalid/expired/reused code always
// fails verification before any password field is even shown.

function isPasswordResetLink(){
  const params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'resetPassword' && !!params.get('oobCode');
}

// Keep in sync with Firebase Console → Authentication → Settings → Password policy.
function isStrongPassword(pw){
  return pw.length >= 8
    && /[A-Z]/.test(pw)
    && /[a-z]/.test(pw)
    && /[0-9]/.test(pw)
    && /[^A-Za-z0-9]/.test(pw);
}

function buildResetOverlay(){
  let overlay = document.getElementById('resetPwOverlay');
  if(overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'resetPwOverlay';
  overlay.className = 'auth-overlay'; // reuse existing auth overlay CSS (css/auth.css)
  overlay.innerHTML = `
    <div class="auth-screen" id="resetPwScreen">
      <div class="auth-topbar">
        <span>পাসওয়ার্ড রিসেট</span>
      </div>
      <div class="auth-body">
        <h2 class="auth-title" id="resetPwTitle">যাচাই করা হচ্ছে...</h2>
        <div id="resetPwContent"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

async function initPasswordResetFlow(){
  if(!isPasswordResetLink()) return;
  if(typeof firebase === 'undefined' || typeof isFirebaseConfigured !== 'function' || !isFirebaseConfigured()) return;

  // Make sure Firebase Auth is initialized even if initAuth() hasn't run yet.
  if(!fbAuth){
    try{
      fbApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      fbAuth = firebase.auth();
    }catch(e){ console.warn('Firebase init failed:', e); return; }
  }

  const params = new URLSearchParams(window.location.search);
  const oobCode = params.get('oobCode');

  const overlay = buildResetOverlay();
  overlay.classList.add('open');
  const titleEl = document.getElementById('resetPwTitle');
  const contentEl = document.getElementById('resetPwContent');

  try{
    const email = await fbAuth.verifyPasswordResetCode(oobCode);
    titleEl.textContent = 'নতুন পাসওয়ার্ড দিন';
    contentEl.innerHTML = `
      <p class="auth-sub">অ্যাকাউন্ট: <strong>${email}</strong></p>
      <input class="auth-field" id="rpNewPass" type="password" placeholder="নতুন পাসওয়ার্ড">
      <input class="auth-field" id="rpConfirmPass" type="password" placeholder="পাসওয়ার্ড নিশ্চিত করুন">
      <p class="auth-sub" style="font-size:.8rem;">কমপক্ষে ৮ অক্ষর, বড়/ছোট হাতের অক্ষর, সংখ্যা ও একটি বিশেষ চিহ্ন থাকতে হবে।</p>
      <div class="auth-error" id="rpError"></div>
      <button class="auth-cta-btn" id="rpSubmit">পাসওয়ার্ড পরিবর্তন করুন</button>
    `;
    document.getElementById('rpSubmit').onclick = () => submitNewPassword(oobCode, overlay);
  }catch(e){
    titleEl.textContent = 'লিঙ্কের মেয়াদ শেষ';
    contentEl.innerHTML = `
      <p class="auth-sub">এই লিঙ্কের মেয়াদ শেষ হয়ে গেছে অথবা আগে ব্যবহার হয়ে গেছে। নতুন করে "পাসওয়ার্ড ভুলে গেছেন" থেকে আবার চেষ্টা করুন।</p>
      <button class="auth-cta-btn" id="rpClose">ঠিক আছে</button>
    `;
    document.getElementById('rpClose').onclick = () => closeResetOverlay(overlay);
  }
}

async function submitNewPassword(oobCode, overlay){
  const pw = document.getElementById('rpNewPass').value;
  const cpw = document.getElementById('rpConfirmPass').value;
  const errBox = document.getElementById('rpError');
  errBox.textContent = '';

  if(!isStrongPassword(pw)){
    errBox.textContent = 'পাসওয়ার্ড যথেষ্ট শক্তিশালী নয়। উপরের নিয়ম মেনে দিন।';
    return;
  }
  if(pw !== cpw){
    errBox.textContent = 'দুটি পাসওয়ার্ড মিলছে না।';
    return;
  }

  const btn = document.getElementById('rpSubmit');
  btn.disabled = true; btn.textContent = 'অপেক্ষা করুন...';
  try{
    await fbAuth.confirmPasswordReset(oobCode, pw);
    document.getElementById('resetPwTitle').textContent = 'সম্পন্ন হয়েছে ✓';
    document.getElementById('resetPwContent').innerHTML = `
      <p class="auth-sub">আপনার পাসওয়ার্ড পরিবর্তন হয়েছে। এখন নতুন পাসওয়ার্ড দিয়ে লগইন করুন।</p>
      <button class="auth-cta-btn" id="rpDone">লগইন করুন</button>
    `;
    document.getElementById('rpDone').onclick = () => {
      closeResetOverlay(overlay);
      if(typeof openAuthFlow === 'function') openAuthFlow('login');
    };
  }catch(e){
    errBox.textContent = 'পরিবর্তন করা যায়নি, আবার চেষ্টা করুন।';
    btn.disabled = false; btn.textContent = 'পাসওয়ার্ড পরিবর্তন করুন';
  }
}

function closeResetOverlay(overlay){
  overlay.remove();
  // URL থেকে ?mode=&oobCode= মুছে ফেলা, যাতে রিফ্রেশ করলে আবার overlay না খোলে
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
}
