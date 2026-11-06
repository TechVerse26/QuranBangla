// ---------- Two-Factor Authentication (js/totp.js এর উপর ভিত্তি করে) ----------
// প্রোফাইল থেকে ঐচ্ছিকভাবে চালু করা যায়, দুইটি পদ্ধতির যেকোনো একটি দিয়ে:
//   'totp'  → অথেনটিকেটর অ্যাপ (Google Authenticator/Authy ইত্যাদি), সম্পূর্ণ
//             ক্লায়েন্ট-সাইড জেনারেট/ভেরিফাই (js/totp.js), + ৮টি ব্যাকআপ কোড
//   'email' → বিদ্যমান ইমেইল-OTP ফ্লো (js/otp.js) পুনর্ব্যবহার করে
// Firestore: users/{uid}.mfa = { enabled, method, totpSecret?, backupCodeHashes?, updatedAt }
// firestore.rules-এ ইতিমধ্যে আছে: শুধু নিজের uid-এর ডক নিজে read/write করতে পারে।
//
// "এই ডিভাইসকে ৩০ দিনের জন্য মনে রাখুন" চেক করলে সেই ব্রাউজারে (localStorage,
// প্রতি uid ভিত্তিক) পরবর্তী ৩০ দিন চ্যালেঞ্জ আর দেখানো হয় না। না থাকলেও একই
// ব্রাউজার-সেশনে (ট্যাব বন্ধ না হওয়া পর্যন্ত, sessionStorage) বারবার জিজ্ঞেস
// করা হয় না — শুধু পেজ রিলোডেই নয়, প্রতিটি নতুন লগইন-এ একবার জিজ্ঞেস হয়।

const MFA_TRUST_PREFIX = 'qc_mfa_trust_';
const MFA_VERIFIED_PREFIX = 'qc_mfa_verified_';
const MFA_TRUST_DAYS = 30;
const MFA_ISSUER = 'আল-কুরআন';

function mfaTrustKey(uid){ return MFA_TRUST_PREFIX + uid; }
function mfaVerifiedKey(uid){ return MFA_VERIFIED_PREFIX + uid; }
function trustedDeviceDocRef(uid, deviceId){
  return fbDb.collection('users').doc(uid).collection('trustedDevices').doc(deviceId);
}

// লোকাল ক্যাশ (দ্রুত, অফলাইনেও কাজ করে) — কিন্তু চূড়ান্ত সিদ্ধান্ত সবসময়
// Firestore-এর `trustedDevices/{deviceId}` ডকুমেন্ট, যাতে প্রোফাইল থেকে অন্য
// কোনো ডিভাইসের বিশ্বস্ততা দূর থেকে বাতিল করা গেলে সেটা কার্যকর হয়।
async function isDeviceTrustedForMfa(uid){
  let localOk = false;
  try{
    const raw = localStorage.getItem(mfaTrustKey(uid));
    localOk = !!raw && Date.now() < parseInt(raw, 10);
  }catch(e){}
  if(!localOk) return false;

  const deviceId = (typeof getDeviceId === 'function') ? getDeviceId() : null;
  if(!deviceId) return true;
  try{
    const doc = await trustedDeviceDocRef(uid, deviceId).get();
    if(!doc.exists) return true; // পুরনো ট্রাস্ট (এই ফিচার আসার আগে সেট হওয়া) — honor করা হলো
    if(doc.data().revoked){ clearMfaDeviceTrust(uid); return false; }
    return true;
  }catch(e){ return localOk; } // অফলাইন — লোকাল ক্যাশই ভরসা
}

async function trustThisDeviceForMfa(uid){
  const expiresAt = Date.now() + MFA_TRUST_DAYS * 86400000;
  try{ localStorage.setItem(mfaTrustKey(uid), String(expiresAt)); }catch(e){}
  try{
    const deviceId = (typeof getDeviceId === 'function') ? getDeviceId() : null;
    if(!deviceId) return;
    const info = (typeof parseDeviceInfo === 'function') ? parseDeviceInfo() : {};
    await trustedDeviceDocRef(uid, deviceId).set({
      deviceId,
      browser: info.browser || '', os: info.os || '', deviceLabel: info.deviceLabel || '',
      trustedAt: firebase.firestore.FieldValue.serverTimestamp(),
      expiresAt, revoked: false
    }, { merge: true });
  }catch(e){}
}
function clearMfaDeviceTrust(uid){
  try{ localStorage.removeItem(mfaTrustKey(uid)); }catch(e){}
}
function isMfaVerifiedThisSession(uid){
  try{ return sessionStorage.getItem(mfaVerifiedKey(uid)) === '1'; }catch(e){ return false; }
}
function markMfaVerifiedThisSession(uid){
  try{ sessionStorage.setItem(mfaVerifiedKey(uid), '1'); }catch(e){}
}

// লগইন-হিস্টোরি মোডালে এই সেশনের পাশে "2FA যাচাইকৃত" ব্যাজ দেখানোর জন্য
// js/session-security.js-এর তৈরি করা সেশন-ডকেই একটা ফ্ল্যাগ বসিয়ে দেয়।
async function markCurrentSessionMfaVerified(uid){
  try{
    if(typeof getOrCreateTabSessionId !== 'function') return;
    const tabSessionId = getOrCreateTabSessionId();
    await fbDb.collection('users').doc(uid).collection('sessions').doc(tabSessionId)
      .set({ mfaVerified: true }, { merge: true });
  }catch(e){}
}

// "এই ডিভাইসকে মনে রাখুন" চালু হলে সেটা জানিয়ে একটা ইমেইল পাঠায় (নতুন-লগইন
// অ্যালার্টের একই EmailJS টেমপ্লেট পুনর্ব্যবহার করে) — কেউ কোড হাতিয়ে নিয়ে
// একটা ডিভাইসকে দীর্ঘমেয়াদী বিশ্বস্ত বানিয়ে ফেললে ব্যবহারকারী টের পাবেন।
async function sendMfaDeviceTrustedEmail(fbUser){
  try{
    if(typeof isLoginAlertEmailConfigured !== 'function' || !isLoginAlertEmailConfigured()) return;
    if(typeof ensureEmailJsReady !== 'function' || !ensureEmailJsReady()) return;
    const email = fbUser.email; if(!email) return;
    const info = (typeof parseDeviceInfo === 'function') ? parseDeviceInfo() : {};
    const loc = (typeof fetchIpLocation === 'function') ? await fetchIpLocation() : {};
    const revokeUrl = window.location.origin + window.location.pathname + '?action=logoutAllDevices';
    await emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.loginAlertTemplateId, {
      to_email: email,
      to_name: fbUser.displayName || email.split('@')[0],
      device_text: `${info.browser || ''} · ${info.os || ''} · ${info.deviceLabel || ''}`,
      location_text: [loc.city, loc.country].filter(Boolean).join(', ') || 'শনাক্ত করা যায়নি',
      isp_text: loc.isp || 'শনাক্ত করা যায়নি',
      ip_text: loc.ip || 'শনাক্ত করা যায়নি',
      login_time: (typeof formatLoginTimeBn === 'function') ? formatLoginTimeBn(new Date()) : new Date().toLocaleString(),
      new_device_text: `উল্লেখ্য: টু-ফ্যাক্টর যাচাইয়ের সময় এই ডিভাইসটিকে ৩০ দিনের জন্য বিশ্বস্ত হিসেবে চিহ্নিত করা হয়েছে — এই সময়ে এই ডিভাইস থেকে আর কোড ছাড়াই ঢোকা যাবে। এটি আপনি না করলে এখনই সব ডিভাইস থেকে লগ-আউট করুন।`,
      revoke_url: revokeUrl
    });
  }catch(e){ console.warn('2FA ডিভাইস-ট্রাস্ট অ্যালার্ট ইমেইল ব্যর্থ:', e); }
}

async function fetchMfaConfig(uid){
  try{
    const doc = await fbDb.collection('users').doc(uid).get();
    const data = doc.exists ? doc.data() : null;
    return (data && data.mfa) || null;
  }catch(e){ return null; }
}

function bnCount(n){ return typeof toBn === 'function' ? toBn(n) : String(n); }

// ---------- লগইন গেট — js/auth.js-এর onAuthStateChanged থেকে কল হয় ----------
// next() তখনই কল হয় যখন সাইন-ইন সম্পন্ন ধরা নিরাপদ: 2FA চালু নেই, এই
// ডিভাইস/সেশন আগে থেকেই বিশ্বস্ত, অথবা নিচের চ্যালেঞ্জ এইমাত্র পাস হয়েছে।
// ব্যবহারকারী বাতিল করলে আবার সাইন-আউট করে দেওয়া হয়।
async function requireMfaIfNeeded(fbUser, next){
  const uid = fbUser.uid;
  const trusted = await isDeviceTrustedForMfa(uid);
  if(trusted || isMfaVerifiedThisSession(uid)){ next(); return; }

  const cfg = await fetchMfaConfig(uid);
  if(!cfg || !cfg.enabled){ next(); return; }

  renderMfaChallengeModal({
    uid, method: cfg.method, email: fbUser.email,
    name: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : ''),
    onVerified: (trustDevice) => {
      markMfaVerifiedThisSession(uid);
      markCurrentSessionMfaVerified(uid);
      if(trustDevice){
        trustThisDeviceForMfa(uid);
        sendMfaDeviceTrustedEmail(fbUser);
      }
      next();
    },
    onCancel: async () => {
      showToast('যাচাই ছাড়া সাইন-ইন সম্পন্ন হয়নি');
      try{ await fbAuth.signOut(); }catch(e){}
    }
  });
}

// ---------- লগইন-সময় চ্যালেঞ্জ মোডাল ----------
function renderMfaChallengeModal({ uid, method, email, name, onVerified, onCancel }){
  const old = document.getElementById('mfaChallengeModal');
  if(old) old.remove();

  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'mfaChallengeModal';
  wrap.style.display = 'flex';
  const isEmail = method === 'email';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3><i class="fa-solid fa-shield-halved"></i> নিরাপত্তা যাচাই</h3></div>
      <div class="app-modal-body">
        <p class="mfa-challenge-hint" id="mfaChallengeHint"></p>
        <div id="mfaChallengeFieldWrap"></div>
        <div class="auth-error" id="mfaChallengeError"></div>
        <label class="mfa-trust-row"><input type="checkbox" id="mfaTrustDevice" checked> এই ডিভাইসকে ৩০ দিনের জন্য মনে রাখুন</label>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="mfaChallengeCancel">সাইন আউট</button>
          <button class="tw-save-btn" id="mfaChallengeSubmit">যাচাই করুন</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap); // ইচ্ছাকৃতভাবে backdrop-click-এ বন্ধ হয় না — এটি একটি বাধ্যতামূলক গেট

  document.getElementById('mfaChallengeCancel').onclick = () => { wrap.remove(); onCancel(); };

  let usingBackupCode = false;

  const paint = () => {
    const hint = document.getElementById('mfaChallengeHint');
    const fieldWrap = document.getElementById('mfaChallengeFieldWrap');
    const submitBtn = document.getElementById('mfaChallengeSubmit');

    if(isEmail){
      hint.innerHTML = `সাইন-ইন সম্পন্ন করতে <b>${escapeHtml(email || '')}</b>-এ একটি কোড পাঠানো হবে।`;
      fieldWrap.innerHTML = `<button type="button" class="tw-save-btn" id="mfaEmailSendBtn" style="width:100%;">কোড পাঠান</button>`;
      submitBtn.style.display = 'none';
      document.getElementById('mfaEmailSendBtn').onclick = () => {
        const trustDevice = document.getElementById('mfaTrustDevice').checked;
        wrap.remove();
        startOtpFlow({
          email, name, purposeLabel: 'লগইন যাচাইকরণ',
          onVerified: () => onVerified(trustDevice)
        });
      };
      return;
    }

    submitBtn.style.display = '';
    if(usingBackupCode){
      hint.textContent = 'আপনার সংরক্ষিত ৮-সংখ্যার ব্যাকআপ কোডগুলোর একটি দিন।';
      fieldWrap.innerHTML = `
        <input class="auth-field mfa-code-input" id="mfaCodeInput" type="text" placeholder="XXXX-XXXX" maxlength="9" style="font-size:16px;letter-spacing:3px;">
        <button type="button" class="mfa-toggle-link" id="mfaModeToggle">এর বদলে অ্যাপের কোড দিন</button>`;
      document.getElementById('mfaModeToggle').onclick = () => { usingBackupCode = false; paint(); };
    } else {
      hint.textContent = 'সাইন-ইন সম্পন্ন করতে আপনার অথেনটিকেটর অ্যাপের ৬-সংখ্যার কোডটি দিন।';
      fieldWrap.innerHTML = `
        <input class="auth-field mfa-code-input" id="mfaCodeInput" type="text" inputmode="numeric" maxlength="6" placeholder="______">
        <button type="button" class="mfa-toggle-link" id="mfaModeToggle">ব্যাকআপ কোড ব্যবহার করুন</button>`;
      document.getElementById('mfaModeToggle').onclick = () => { usingBackupCode = true; paint(); };
      const el = document.getElementById('mfaCodeInput');
      setTimeout(() => { if(el) el.focus(); }, 50);
    }
  };
  paint();

  document.getElementById('mfaChallengeSubmit').onclick = async () => {
    const errBox = document.getElementById('mfaChallengeError');
    errBox.textContent = '';
    const input = document.getElementById('mfaCodeInput');
    const entered = input ? input.value.trim() : '';
    if(!entered){ errBox.textContent = 'কোড দিন।'; return; }

    const btn = document.getElementById('mfaChallengeSubmit');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'যাচাই হচ্ছে...';
    const trustDevice = document.getElementById('mfaTrustDevice').checked;

    try{
      let ok = false;
      if(usingBackupCode){
        ok = await consumeBackupCode(uid, entered);
        if(!ok) errBox.textContent = 'কোডটি সঠিক নয় বা আগেই ব্যবহৃত হয়েছে।';
      } else {
        const cfg = await fetchMfaConfig(uid);
        ok = !!(cfg && cfg.totpSecret && await verifyTotp(cfg.totpSecret, entered));
        if(!ok) errBox.textContent = 'কোডটি সঠিক নয়।';
      }
      if(!ok){ btn.disabled = false; btn.textContent = original; return; }
      wrap.remove();
      onVerified(trustDevice);
    }catch(e){
      errBox.textContent = 'যাচাই ব্যর্থ হয়েছে, আবার চেষ্টা করুন।';
      btn.disabled = false; btn.textContent = original;
    }
  };
}

// একটি ব্যাকআপ কোড ব্যবহার করে — মিলে গেলে সেটির হ্যাশ Firestore থেকে সরিয়ে
// দেয় (একবারই ব্যবহারযোগ্য), তাই দ্বিতীয়বার একই কোড আর কাজ করবে না।
async function consumeBackupCode(uid, entered){
  const canonical = canonicalizeBackupCode(entered);
  if(!canonical) return false;
  const hash = await sha256Hex(canonical);
  const ref = fbDb.collection('users').doc(uid);
  try{
    const doc = await ref.get();
    const mfa = (doc.exists && doc.data().mfa) || {};
    const hashes = mfa.backupCodeHashes || [];
    if(!hashes.includes(hash)) return false;
    const updated = hashes.filter(h => h !== hash);
    await ref.set({ mfa: Object.assign({}, mfa, { backupCodeHashes: updated }) }, { merge: true });
    return true;
  }catch(e){ return false; }
}

// ---------- প্রোফাইল থেকে সেটআপ/বন্ধ করার UI ----------
function openMfaSettingsModal(user){
  const old = document.getElementById('mfaSettingsModal');
  if(old) old.remove();

  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'mfaSettingsModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>টু-ফ্যাক্টর অথেনটিকেশন</h3><button class="app-modal-close" id="mfaSetClose">✕</button></div>
      <div class="app-modal-body" id="mfaSetBody"></div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('mfaSetClose').onclick = remove;

  renderMfaSettingsBody(user, remove);
}

function renderMfaSettingsBody(user, closeParentModal){
  const body = document.getElementById('mfaSetBody');
  if(!body) return;
  const cfg = (user && user.mfa) || null;
  const enabled = !!(cfg && cfg.enabled);

  if(!enabled){
    body.innerHTML = `
      <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">পাসওয়ার্ডের পাশাপাশি লগইনে আরেকটি ধাপ যোগ করুন। যেকোনো একটি পদ্ধতি বেছে নিন —</p>
      <div class="mfa-method-list">
        <button type="button" class="mfa-method-card" id="mfaChooseTotp">
          <span class="mfa-method-icon"><i class="fa-solid fa-mobile-screen-button"></i></span>
          <span class="mfa-method-body">
            <span class="mfa-method-title">অথেনটিকেটর অ্যাপ</span>
            <span class="mfa-method-desc">Google Authenticator, Authy ইত্যাদি অ্যাপের কোড — ইন্টারনেট ছাড়াও কাজ করে, সবচেয়ে দ্রুত ও নিরাপদ।</span>
          </span>
          <span class="mfa-method-badge">সুপারিশকৃত</span>
        </button>
        <button type="button" class="mfa-method-card" id="mfaChooseEmail">
          <span class="mfa-method-icon"><i class="fa-solid fa-envelope"></i></span>
          <span class="mfa-method-body">
            <span class="mfa-method-title">ইমেইল কোড</span>
            <span class="mfa-method-desc">প্রতিবার সাইন-ইনে ইমেইলে কোড পাঠানো হবে — আলাদা কোনো অ্যাপ লাগবে না।</span>
          </span>
        </button>
      </div>`;
    document.getElementById('mfaChooseTotp').onclick = () => startTotpSetup(user, closeParentModal);
    document.getElementById('mfaChooseEmail').onclick = () => startEmailMfaSetup(user, closeParentModal);
    return;
  }

  const methodLabel = cfg.method === 'totp' ? 'অথেনটিকেটর অ্যাপ' : 'ইমেইল কোড';
  const methodIcon = cfg.method === 'totp' ? 'fa-mobile-screen-button' : 'fa-envelope';
  const backupCount = (cfg.backupCodeHashes || []).length;
  const backupLow = cfg.method === 'totp' && backupCount <= 2;
  body.innerHTML = `
    <div class="mfa-method-card" style="cursor:default;">
      <span class="mfa-method-icon"><i class="fa-solid ${methodIcon}"></i></span>
      <span class="mfa-method-body">
        <span class="mfa-method-title">চালু আছে — ${methodLabel}</span>
        <span class="mfa-method-desc${backupLow ? ' mfa-low-text' : ''}">${cfg.method === 'totp' ? `${bnCount(backupCount)}টি ব্যাকআপ কোড অবশিষ্ট আছে${backupLow ? ' — কমে গেছে, নতুন কোড জেনারেট করে নিন' : ''}।` : 'প্রতিবার সাইন-ইনে ইমেইলে কোড পাঠানো হবে।'}</span>
      </span>
      <span class="mfa-status-pill is-on"><i class="fa-solid fa-check"></i> চালু</span>
    </div>
    <div class="input-box-actions" style="margin-top:14px;flex-wrap:wrap;">
      ${cfg.method === 'totp' ? `<button class="tw-cancel-btn${backupLow ? ' mfa-regen-urge' : ''}" id="mfaRegenBackup">নতুন ব্যাকআপ কোড</button>` : ''}
      <button class="tw-cancel-btn profile-delete-confirm-btn" id="mfaDisableBtn">বন্ধ করুন</button>
    </div>`;
  const regenBtn = document.getElementById('mfaRegenBackup');
  if(regenBtn) regenBtn.onclick = () => regenerateBackupCodes(user);
  document.getElementById('mfaDisableBtn').onclick = () => confirmDisableMfa(user, closeParentModal);

  appendTrustedDevicesSection(user);
}

// ---------- বিশ্বস্ত ডিভাইসসমূহ (৩০ দিনের 2FA-বাইপাস) — দেখা ও দূর থেকে বাতিল ----------
async function loadTrustedDevices(uid){
  try{
    const snap = await fbDb.collection('users').doc(uid).collection('trustedDevices')
      .where('revoked', '==', false).get();
    return snap.docs.map(d => d.data())
      .filter(d => (d.expiresAt || 0) > Date.now())
      .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  }catch(e){ return []; }
}

async function appendTrustedDevicesSection(user){
  const body = document.getElementById('mfaSetBody');
  if(!body) return;
  const old = document.getElementById('mfaTrustedDevicesSection');
  if(old) old.remove();

  const holder = document.createElement('div');
  holder.id = 'mfaTrustedDevicesSection';
  body.appendChild(holder);

  const devices = await loadTrustedDevices(user.uid);
  if(!document.getElementById('mfaSetBody') || !document.body.contains(holder)) return; // ততক্ষণে মোডাল বন্ধ হয়ে গেলে
  if(!devices.length) return;

  const currentDeviceId = (typeof getDeviceId === 'function') ? getDeviceId() : null;
  holder.innerHTML = `
    <div class="mfa-trusted-title">বিশ্বস্ত ডিভাইসসমূহ — ৩০ দিন কোড ছাড়াই প্রবেশ করা যাবে</div>
    <div class="mfa-trusted-list">
      ${devices.map(d => `
        <div class="mfa-trusted-row">
          <span class="mfa-trusted-info">
            <i class="fa-solid fa-mobile-screen"></i>
            <span>${escapeHtml(d.deviceLabel || d.os || 'ডিভাইস')} · ${escapeHtml(d.browser || '')}${d.deviceId === currentDeviceId ? ' <span class="mfa-trusted-you">(এই ডিভাইস)</span>' : ''}</span>
          </span>
          <button type="button" class="mfa-trusted-revoke" data-revoke="${escapeHtml(d.deviceId)}" title="বিশ্বস্ততা বাতিল করুন"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('')}
    </div>`;

  holder.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.onclick = async () => {
      const deviceId = btn.getAttribute('data-revoke');
      btn.disabled = true;
      try{
        await trustedDeviceDocRef(user.uid, deviceId).set({ revoked: true }, { merge: true });
        if(deviceId === currentDeviceId) clearMfaDeviceTrust(user.uid);
        showToast('ডিভাইসের বিশ্বস্ততা বাতিল হয়েছে');
        const row = btn.closest('.mfa-trusted-row');
        if(row) row.remove();
      }catch(e){ showToast('বাতিল করা যায়নি, আবার চেষ্টা করুন'); btn.disabled = false; }
    };
  });
}

async function revokeAllTrustedDevices(uid){
  try{
    const snap = await fbDb.collection('users').doc(uid).collection('trustedDevices').get();
    if(snap.empty) return;
    const batch = fbDb.batch();
    snap.docs.forEach(d => batch.update(d.ref, { revoked: true }));
    await batch.commit();
  }catch(e){}
}

async function startTotpSetup(user, closeParentModal){
  const secret = generateTotpSecret();
  const uri = buildOtpauthUri(secret, user.email || user.name || 'ব্যবহারকারী', MFA_ISSUER);

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const body = document.getElementById('mfaSetBody');
  if(!body) return;
  body.innerHTML = `
    <p style="margin:0 0 10px;color:var(--ink-soft);font-size:13.5px;">অথেনটিকেটর অ্যাপ দিয়ে নিচের QR কোডটি স্ক্যান করুন —</p>
    <div class="mfa-qr-box">
      <canvas id="mfaQrCanvas" width="200" height="200" style="display:none;"></canvas>
      <div class="mfa-qr-loading" id="mfaQrLoading"><span class="mfa-spinner"></span> QR কোড তৈরি হচ্ছে...</div>
    </div>
    <div class="mfa-inline-row">
      ${isMobile ? `<a href="${uri}" class="mfa-inline-btn" id="mfaOpenAppBtn"><i class="fa-solid fa-mobile-screen-button"></i> অথেনটিকেটর অ্যাপে যান</a>` : ''}
      <button type="button" class="mfa-inline-btn" id="mfaCopySecret"><i class="fa-solid fa-copy"></i> কপি করুন</button>
    </div>
    <p style="margin:8px 0 6px;color:var(--ink-soft);font-size:12px;text-align:center;">উপরের বাটন/QR কাজ না করলে এই কোডটি অ্যাপে হাতে টাইপ করুন —</p>
    <div class="mfa-secret-key" id="mfaSecretKeyDisplay">${formatSecretForDisplay(secret)}</div>
    <p style="margin:14px 0 6px;color:var(--ink-soft);font-size:13.5px;">এখন অ্যাপে দেখানো ৬-সংখ্যার কোডটি দিয়ে নিশ্চিত করুন —</p>
    <input class="auth-field mfa-code-input" id="mfaSetupCodeInput" type="text" inputmode="numeric" maxlength="6" placeholder="______">
    <div class="auth-error" id="mfaSetupError"></div>
    <div class="input-box-actions">
      <button class="tw-cancel-btn" id="mfaSetupCancel">বাতিল</button>
      <button class="tw-save-btn" id="mfaSetupConfirm">নিশ্চিত করুন</button>
    </div>`;

  const tryRenderQr = () => {
    const loading = document.getElementById('mfaQrLoading');
    const canvas = document.getElementById('mfaQrCanvas');
    if(loading){ loading.innerHTML = '<span class="mfa-spinner"></span> QR কোড তৈরি হচ্ছে...'; loading.style.display = ''; }
    if(canvas) canvas.style.display = 'none';
    renderTotpQr(canvas, uri).then(ok => {
      if(!document.getElementById('mfaQrLoading') || !document.getElementById('mfaQrCanvas')) return; // মোডাল বদলে গেলে
      if(ok){
        loading.remove();
        canvas.style.display = '';
      } else {
        loading.innerHTML = 'QR তৈরি করা যায়নি (ইন্টারনেট সংযোগ পরীক্ষা করুন) — নিচের কোডটি অ্যাপে ম্যানুয়ালি যোগ করুন, অথবা আবার চেষ্টা করুন।<br>';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'mfa-inline-btn';
        retryBtn.style.marginTop = '8px';
        retryBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> আবার চেষ্টা করুন';
        retryBtn.onclick = tryRenderQr;
        loading.appendChild(retryBtn);
      }
    });
  };
  tryRenderQr();

  document.getElementById('mfaCopySecret').onclick = () => {
    navigator.clipboard.writeText(secret).then(() => showToast('কোড কপি হয়েছে')).catch(() => {});
  };
  document.getElementById('mfaSetupCancel').onclick = () => renderMfaSettingsBody(user, closeParentModal);

  document.getElementById('mfaSetupConfirm').onclick = async () => {
    const errBox = document.getElementById('mfaSetupError');
    errBox.textContent = '';
    const code = document.getElementById('mfaSetupCodeInput').value.trim();
    const btn = document.getElementById('mfaSetupConfirm');
    btn.disabled = true; btn.textContent = 'যাচাই হচ্ছে...';

    const ok = await verifyTotp(secret, code);
    if(!ok){
      errBox.textContent = 'কোডটি সঠিক নয়, আবার চেষ্টা করুন।';
      btn.disabled = false; btn.textContent = 'নিশ্চিত করুন';
      return;
    }
    try{
      const codes = generateBackupCodes(8);
      const hashes = await Promise.all(codes.map(sha256Hex));
      await fbDb.collection('users').doc(user.uid).set({
        mfa: { enabled: true, method: 'totp', totpSecret: secret, backupCodeHashes: hashes, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }
      }, { merge: true });
      user.mfa = { enabled: true, method: 'totp', backupCodeHashes: hashes };
      showBackupCodesModal(codes, () => {
        renderMfaSettingsBody(user, closeParentModal);
        showToast('টু-ফ্যাক্টর অথেনটিকেশন চালু হয়েছে');
      });
    }catch(e){
      errBox.textContent = 'সংরক্ষণ ব্যর্থ হয়েছে, আবার চেষ্টা করুন।';
      btn.disabled = false; btn.textContent = 'নিশ্চিত করুন';
    }
  };
}

function startEmailMfaSetup(user, closeParentModal){
  if(!user.email){ showToast('এই অ্যাকাউন্টে ইমেইল যুক্ত নেই'); return; }
  startOtpFlow({
    email: user.email, name: user.name, purposeLabel: 'টু-ফ্যাক্টর অথেনটিকেশন চালু করা',
    onVerified: async () => {
      try{
        await fbDb.collection('users').doc(user.uid).set({
          mfa: { enabled: true, method: 'email', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }
        }, { merge: true });
        user.mfa = { enabled: true, method: 'email' };
        showToast('টু-ফ্যাক্টর অথেনটিকেশন চালু হয়েছে');
        renderMfaSettingsBody(user, closeParentModal);
      }catch(e){ showToast('চালু করা যায়নি, আবার চেষ্টা করুন'); }
    }
  });
}

// একবারই দেখানো হয় — কপি/সংরক্ষণ নিশ্চিত না করা পর্যন্ত এগিয়ে যাওয়া যায় না।
function showBackupCodesModal(codes, onDone){
  const old = document.getElementById('mfaBackupModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'mfaBackupModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>ব্যাকআপ কোড সংরক্ষণ করুন</h3></div>
      <div class="app-modal-body">
        <div class="mfa-backup-warn"><i class="fa-solid fa-triangle-exclamation"></i> এই কোডগুলো শুধু একবারই দেখানো হবে। অথেনটিকেটর অ্যাপ হারিয়ে গেলে এগুলো দিয়ে সাইন-ইন করা যাবে — নিরাপদ জায়গায় রাখুন।</div>
        <div class="mfa-backup-grid">${codes.map(c => `<div class="mfa-backup-code">${escapeHtml(c)}</div>`).join('')}</div>
        <div class="mfa-backup-actions">
          <button type="button" class="tw-cancel-btn" id="mfaCopyAllBackup"><i class="fa-solid fa-copy"></i> কপি করুন</button>
          <button type="button" class="tw-cancel-btn" id="mfaDownloadBackup"><i class="fa-solid fa-download"></i> ডাউনলোড করুন</button>
        </div>
        <label class="mfa-trust-row"><input type="checkbox" id="mfaBackupSavedCheck"> আমি কোডগুলো সংরক্ষণ/ডাউনলোড করেছি</label>
        <div class="input-box-actions">
          <button class="tw-save-btn" id="mfaBackupDone" disabled>সম্পন্ন করুন</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap); // ইচ্ছাকৃতভাবে backdrop-click/✕ নেই — কোড দেখা নিশ্চিত করতেই হবে

  document.getElementById('mfaCopyAllBackup').onclick = () => {
    navigator.clipboard.writeText(codes.join('\n')).then(() => showToast('কোডগুলো কপি হয়েছে')).catch(() => {});
  };

  document.getElementById('mfaDownloadBackup').onclick = () => {
    downloadBackupCodesFile(codes);
    showToast('ফাইল ডাউনলোড হয়েছে');
  };

  const check = document.getElementById('mfaBackupSavedCheck');
  const doneBtn = document.getElementById('mfaBackupDone');
  check.onchange = () => { doneBtn.disabled = !check.checked; };
  doneBtn.onclick = () => { wrap.remove(); onDone(); };
}

// ব্যাকআপ কোডগুলো একটি .txt ফাইলে সাজিয়ে সরাসরি ডিভাইসে ডাউনলোড করে দেয় —
// সম্পূর্ণ ক্লায়েন্ট-সাইড (Blob + object URL), কোনো সার্ভার কল ছাড়াই।
function downloadBackupCodesFile(codes){
  const dateStr = new Date().toLocaleDateString('bn-BD', { year: 'numeric', month: 'long', day: 'numeric' });
  const email = (state.user && state.user.email) || '';
  const lines = ['আল-কুরআন — টু-ফ্যাক্টর অথেনটিকেশন ব্যাকআপ কোড'];
  if(email) lines.push(`অ্যাকাউন্ট: ${email}`);
  lines.push(
    `তৈরি হয়েছে: ${dateStr}`,
    '',
    'প্রতিটি কোড শুধু একবার ব্যবহার করা যাবে। অথেনটিকেটর অ্যাপ হারিয়ে গেলে',
    'সাইন-ইন করার সময় এখান থেকে একটি কোড দিন। এই ফাইলটি নিরাপদ জায়গায় রাখুন —',
    'অন্য কারো হাতে পড়লে সে আপনার অ্যাকাউন্টে ঢুকতে পারবে।',
    '',
    ...codes,
    ''
  );

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'al-quran-backup-codes.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function regenerateBackupCodes(user){
  const codes = generateBackupCodes(8);
  const hashes = await Promise.all(codes.map(sha256Hex));
  try{
    await fbDb.collection('users').doc(user.uid).set({
      mfa: { backupCodeHashes: hashes, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });
    if(user.mfa) user.mfa.backupCodeHashes = hashes;
    showBackupCodesModal(codes, () => showToast('নতুন ব্যাকআপ কোড সংরক্ষিত হয়েছে'));
  }catch(e){ showToast('ব্যর্থ হয়েছে, আবার চেষ্টা করুন'); }
}

// বন্ধ করার আগেও email OTP দিয়ে নিশ্চিত করা হয় (পদ্ধতি TOTP হলেও) — অ্যাপ
// হারিয়ে গেলেও ইমেইল দিয়ে অ্যাকাউন্ট সিকিউরিটি নিয়ন্ত্রণ করা যায়, লক-আউট এড়াতে।
function confirmDisableMfa(user, closeParentModal){
  const old = document.getElementById('mfaDisableConfirmModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'mfaDisableConfirmModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>টু-ফ্যাক্টর বন্ধ করবেন?</h3><button class="app-modal-close" id="mfaDisClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">নিরাপত্তার জন্য <b>${escapeHtml(user.email || '')}</b>-এ একটি কোড পাঠানো হবে। যাচাই হলেই টু-ফ্যাক্টর অথেনটিকেশন বন্ধ হয়ে যাবে।</p>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="mfaDisCancel">বাতিল</button>
          <button class="tw-save-btn profile-delete-confirm-btn" id="mfaDisYes">কোড পাঠান</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('mfaDisClose').onclick = remove;
  document.getElementById('mfaDisCancel').onclick = remove;
  document.getElementById('mfaDisYes').onclick = () => {
    remove();
    startOtpFlow({
      email: user.email, name: user.name, purposeLabel: 'টু-ফ্যাক্টর অথেনটিকেশন বন্ধ করা',
      onVerified: async () => {
        try{
          await fbDb.collection('users').doc(user.uid).set({
            mfa: {
              enabled: false,
              method: firebase.firestore.FieldValue.delete(),
              totpSecret: firebase.firestore.FieldValue.delete(),
              backupCodeHashes: firebase.firestore.FieldValue.delete(),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }
          }, { merge: true });
          user.mfa = { enabled: false };
          clearMfaDeviceTrust(user.uid);
          revokeAllTrustedDevices(user.uid); // fire-and-forget cleanup
          showToast('টু-ফ্যাক্টর অথেনটিকেশন বন্ধ হয়েছে');
          renderMfaSettingsBody(user, closeParentModal);
        }catch(e){ showToast('বন্ধ করা যায়নি, আবার চেষ্টা করুন'); }
      }
    });
  };
}
