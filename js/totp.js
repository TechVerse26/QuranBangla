// ---------- TOTP (Time-based One-Time Password) core — RFC 6238 ----------
// Pure Web Crypto implementation (HMAC-SHA1, 6 digits, 30s step) so it's
// compatible with any standard authenticator app: Google Authenticator,
// Microsoft Authenticator, Authy, 1Password, etc. No server involved —
// the code is generated and checked entirely in the browser (js/mfa.js).
//
// SECURITY NOTE: like js/otp.js, this app has no backend. The TOTP secret
// is stored on the user's own Firestore document (readable/writable only
// by that user, per firestore.rules) so the same device or a re-login can
// re-verify codes. It is not a hardware-secured secret, but it is exactly
// as strong as any client-only TOTP setup: an attacker would need to read
// that specific Firestore document, not just guess a 6-digit code.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes){
  let bits = '';
  for(let i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, '0');
  let output = '';
  for(let i = 0; i + 5 <= bits.length; i += 5){
    output += BASE32_ALPHABET[parseInt(bits.substring(i, i + 5), 2)];
  }
  const rem = bits.length % 5;
  if(rem){
    output += BASE32_ALPHABET[parseInt(bits.substring(bits.length - rem).padEnd(5, '0'), 2)];
  }
  return output;
}

function base32Decode(str){
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for(const ch of clean){
    const idx = BASE32_ALPHABET.indexOf(ch);
    if(idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for(let i = 0; i + 8 <= bits.length; i += 8){
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function hmacSha1(keyBytes, msgBytes){
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

function counterToBytes(counter){
  const bytes = new Uint8Array(8);
  let c = BigInt(Math.floor(counter));
  for(let i = 7; i >= 0; i--){
    bytes[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return bytes;
}

async function totpForCounter(secretBytes, counter){
  const hmac = await hmacSha1(secretBytes, counterToBytes(counter));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

// Generates a fresh random secret (base32), suitable for an otpauth:// URI.
function generateTotpSecret(){
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160-bit, RFC 4226 recommended
  return base32Encode(bytes);
}

// Live 6-digit code for "right now" (mainly used for self-testing / debugging).
async function computeTotp(secretBase32, step = 30){
  const counter = Math.floor(Date.now() / 1000 / step);
  return totpForCounter(base32Decode(secretBase32), counter);
}

// Verifies a user-entered code against a small time window (±1 step, i.e.
// ~30s of clock drift tolerance either side) so slightly-off phone clocks
// still work, without the window being so wide it weakens the code.
async function verifyTotp(secretBase32, token, { window = 1, step = 30 } = {}){
  const clean = String(token || '').trim().replace(/\s+/g, '');
  if(!/^\d{6}$/.test(clean)) return false;
  const secretBytes = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / step);
  for(let w = -window; w <= window; w++){
    const candidate = await totpForCounter(secretBytes, counter + w);
    if(candidate === clean) return true;
  }
  return false;
}

function buildOtpauthUri(secretBase32, accountLabel, issuer){
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30'
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Splits a base32 secret into 4-char groups for easier manual typing —
// e.g. "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP".
function formatSecretForDisplay(secretBase32){
  return String(secretBase32).match(/.{1,4}/g).join(' ');
}

// ---------- One-time backup/recovery codes ----------
// 8 codes of the form XXXX-XXXX (base32 alphabet, so no ambiguous 0/O/1/I).
// Only SHA-256 hashes are ever persisted (see js/mfa.js) — the plaintext
// codes exist only in memory long enough to show the user once.
function generateBackupCodes(count = 8){
  const codes = [];
  for(let i = 0; i < count; i++){
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const raw = base32Encode(bytes).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

async function sha256Hex(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeBackupCodeInput(text){
  return String(text || '').trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
}

// Reconstructs the canonical "XXXX-XXXX" form (whatever the user typed —
// with or without the dash, lowercase, extra spaces) so it can be hashed
// and compared against the stored hash the same way it was generated.
function canonicalizeBackupCode(text){
  const clean = normalizeBackupCodeInput(text);
  if(clean.length !== 8) return null;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
}

// ---------- QR rendering ----------
// Renders an otpauth:// URI as a scannable QR into the given <canvas>.
// The `qrcode` library is loaded lazily (only when 2FA setup is actually
// opened, not on every app load) and with several CDN fallbacks — one CDN
// being blocked/slow/regionally unreachable no longer means "no QR ever".
//
// cdnjs.cloudflare.com is tried FIRST on purpose: it's the only one of the
// three that sw.js actually caches (see the fetch handler there), so once
// it has loaded successfully one time, every future 2FA setup — even fully
// offline — gets the QR instantly from the service-worker cache instead of
// hitting the network again. jsdelivr/unpkg stay as pure-network fallbacks
// for the rare case cdnjs itself is unreachable.
const QR_LIB_CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.5.3/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js',
  'https://unpkg.com/qrcode@1.5.3/build/qrcode.min.js'
];

let qrLibLoadPromise = null;

function loadScriptOnce(url, timeoutMs = 4000){
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    const timer = setTimeout(() => resolve(false), timeoutMs);
    s.onload = () => { clearTimeout(timer); resolve(typeof QRCode !== 'undefined'); };
    s.onerror = () => { clearTimeout(timer); resolve(false); };
    document.head.appendChild(s);
  });
}

// একাধিক CDN একে একে চেষ্টা করে — একটা ব্লকড/স্লো হলেও QR কোড আটকাবে না।
function ensureQrLibLoaded(){
  if(typeof QRCode !== 'undefined') return Promise.resolve(true);
  if(qrLibLoadPromise) return qrLibLoadPromise;
  qrLibLoadPromise = (async () => {
    for(const url of QR_LIB_CDN_URLS){
      if(typeof QRCode !== 'undefined') return true;
      const ok = await loadScriptOnce(url);
      if(ok) return true;
    }
    return typeof QRCode !== 'undefined';
  })();
  return qrLibLoadPromise;
}

async function renderTotpQr(canvasEl, otpauthUri){
  if(!canvasEl) return false;
  const ready = await ensureQrLibLoaded();
  if(!ready || typeof QRCode === 'undefined') return false;
  return new Promise((resolve) => {
    QRCode.toCanvas(canvasEl, otpauthUri, { width: 200, margin: 1 }, (err) => {
      resolve(!err);
    });
  });
}
