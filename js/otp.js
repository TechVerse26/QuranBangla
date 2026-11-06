// ---------- Email OTP verification (EmailJS) ----------
// A reusable "email me a 6-digit code, then type it back in" flow, used
// before two sensitive account actions in js/auth.js: changing the
// password and permanently deleting the account. Runs entirely from the
// browser via EmailJS — see js/emailjs-config.js for setup.
//
// Includes a 10-minute resend cooldown per (email + purpose): once a code
// is emailed, another one can't be requested for 10 minutes — whether the
// user hits "আবার পাঠান" or backs out and re-triggers the same flow. If a
// still-valid code (< 5 min old) already exists for this request, we just
// reopen the entry modal instead of sending a second email.
//
// SECURITY NOTE: like the rest of this app, this is a client-only project
// with no backend. The code is generated and checked in the browser, so
// this isn't a server-verified OTP — but it does confirm the person can
// read the email on that account before something irreversible happens,
// which is the actual goal here.

let _otpState = null; // { code, expiresAt, email, purpose }

const OTP_CODE_TTL_MS = 5 * 60 * 1000;      // how long a code stays valid
const OTP_RESEND_COOLDOWN_MS = 10 * 60 * 1000; // how long before another can be sent

function isEmailJsConfigured(){
  return typeof EMAILJS_CONFIG !== 'undefined'
    && EMAILJS_CONFIG.publicKey
    && !/PASTE_YOUR/.test(EMAILJS_CONFIG.publicKey);
}

function ensureEmailJsReady(){
  if(typeof emailjs === 'undefined' || !isEmailJsConfigured()) return false;
  if(!ensureEmailJsReady._inited){
    emailjs.init({ publicKey: EMAILJS_CONFIG.publicKey });
    ensureEmailJsReady._inited = true;
  }
  return true;
}

function generateOtpCode(){
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

function sendOtpEmail(toEmail, toName, code, purposeLabel){
  return emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.templateId, {
    to_email: toEmail,
    to_name: toName || 'ব্যবহারকারী',
    otp_code: code,
    purpose: purposeLabel
  });
}

// ---------- Resend cooldown bookkeeping (localStorage, per email+purpose) ----------
function otpCooldownKey(email, purposeLabel){
  return `otpLastSent::${email}::${purposeLabel}`;
}

function getOtpCooldownRemainingMs(email, purposeLabel){
  try{
    const raw = localStorage.getItem(otpCooldownKey(email, purposeLabel));
    if(!raw) return 0;
    const remain = OTP_RESEND_COOLDOWN_MS - (Date.now() - parseInt(raw, 10));
    return remain > 0 ? remain : 0;
  }catch(e){ return 0; }
}

function markOtpSentNow(email, purposeLabel){
  try{ localStorage.setItem(otpCooldownKey(email, purposeLabel), String(Date.now())); }catch(e){}
}

// Formats a millisecond countdown as m:ss (e.g. "9:47") for a live,
// second-by-second ticking display rather than a rounded minute count.
function formatCooldownClock(ms){
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// Kicks off an OTP flow: emails a code (unless one was already sent
// recently — see cooldown notes above) and opens a modal asking the user
// to type it back in. Calls opts.onVerified() only once the entered code
// matches and hasn't expired.
//   opts = { email, name, purposeLabel, onVerified }
async function startOtpFlow(opts){
  const { email, name, purposeLabel, onVerified } = opts;
  if(!email){ showToast('ইমেইল পাওয়া যায়নি'); return; }
  if(!ensureEmailJsReady()){
    showToast('OTP পাঠানোর সিস্টেম এখনো সেটআপ করা হয়নি');
    return;
  }

  const cooldownRemaining = getOtpCooldownRemainingMs(email, purposeLabel);
  const hasUsableCode = _otpState && _otpState.email === email
    && _otpState.purpose === purposeLabel && Date.now() < _otpState.expiresAt;

  if(cooldownRemaining > 0 && !hasUsableCode){
    // Still inside the 10-minute window and no live code to fall back on —
    // don't send another email, just tell the user how long to wait.
    renderOtpModal({ email, purposeLabel, onVerified, onResend: () => startOtpFlow(opts), locked: true, cooldownRemainingMs: cooldownRemaining });
    return;
  }

  if(cooldownRemaining > 0 && hasUsableCode){
    // A still-valid code was already emailed recently — just reopen the
    // entry modal, don't send a second one.
    renderOtpModal({ email, purposeLabel, onVerified, onResend: () => startOtpFlow(opts), cooldownRemainingMs: cooldownRemaining });
    return;
  }

  const code = generateOtpCode();
  _otpState = { code, expiresAt: Date.now() + OTP_CODE_TTL_MS, email, purpose: purposeLabel };
  markOtpSentNow(email, purposeLabel);

  renderOtpModal({
    email, purposeLabel, onVerified,
    onResend: () => startOtpFlow(opts),
    cooldownRemainingMs: OTP_RESEND_COOLDOWN_MS
  });

  try{
    await sendOtpEmail(email, name, code, purposeLabel);
    showToast('যাচাইকরণ কোড ইমেইলে পাঠানো হয়েছে');
  }catch(e){
    console.warn('OTP send failed:', e);
    showToast('OTP ইমেইল পাঠাতে ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    const modal = document.getElementById('otpModal');
    if(modal) modal.remove();
  }
}

function renderOtpModal({ email, purposeLabel, onVerified, onResend, locked, cooldownRemainingMs }){
  const old = document.getElementById('otpModal');
  if(old) old.remove();

  const bodyMsg = locked
    ? `${escapeHtml(purposeLabel)}-এর জন্য একটু আগেই <b>${escapeHtml(email)}</b>-এ কোড পাঠানো হয়েছে। নতুন কোড চাওয়ার আগে একটু অপেক্ষা করুন, অথবা আগের কোডটি থাকলে সেটি ব্যবহার করুন।`
    : `${escapeHtml(purposeLabel)}-এর জন্য <b>${escapeHtml(email)}</b>-এ একটি ৬-সংখ্যার কোড পাঠানো হয়েছে। নিচে কোডটি দিন। কোডের মেয়াদ ৫ মিনিট।`;

  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'otpModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head"><h3>যাচাইকরণ কোড দিন</h3><button class="app-modal-close" id="otpClose">✕</button></div>
      <div class="app-modal-body">
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">${bodyMsg}</p>
        ${locked ? '' : `<input class="auth-field" id="otpInput" type="text" inputmode="numeric" maxlength="6" placeholder="৬-সংখ্যার কোড">`}
        <div class="auth-error" id="otpError"></div>
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="otpResend">আবার পাঠান</button>
          ${locked ? '' : `<button class="tw-save-btn" id="otpVerify">যাচাই করুন</button>`}
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  let tickHandle = null;
  const remove = () => { if(tickHandle) clearInterval(tickHandle); wrap.remove(); };
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('otpClose').onclick = remove;

  // ---- resend button + live countdown ----
  const resendBtn = document.getElementById('otpResend');
  let remaining = cooldownRemainingMs || 0;

  const paintResend = () => {
    if(remaining > 0){
      resendBtn.disabled = true;
      resendBtn.textContent = `আবার পাঠান (${formatCooldownClock(remaining)})`;
    } else {
      resendBtn.disabled = false;
      resendBtn.textContent = 'আবার পাঠান';
    }
  };
  paintResend();
  tickHandle = setInterval(() => {
    remaining -= 1000;
    if(remaining <= 0){ remaining = 0; clearInterval(tickHandle); tickHandle = null; }
    paintResend();
  }, 1000);

  resendBtn.onclick = () => {
    if(resendBtn.disabled) return;
    onResend();
  };

  // ---- verify (not shown at all in the locked/wait state) ----
  if(!locked){
    document.getElementById('otpVerify').onclick = () => {
      const entered = document.getElementById('otpInput').value.trim();
      const errBox = document.getElementById('otpError');
      errBox.textContent = '';
      if(!_otpState || _otpState.email !== email || _otpState.purpose !== purposeLabel){ errBox.textContent = 'আবার চেষ্টা করুন।'; return; }
      if(Date.now() > _otpState.expiresAt){ errBox.textContent = 'কোডের মেয়াদ শেষ হয়ে গেছে, নতুন কোড চান।'; return; }
      if(!entered || entered !== _otpState.code){ errBox.textContent = 'কোড সঠিক নয়।'; return; }
      _otpState = null;
      remove();
      onVerified();
    };
  }
}
