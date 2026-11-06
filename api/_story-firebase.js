// api/_story-firebase.js
//
// Firebase Admin SDK layer for the Story moderation pipeline. Everything privileged happens here, on the server:
// verifying the caller, claiming a submission, publishing to the public `statuses` feed, the audit log, counters.
//
// Collections (ALL of them are closed to browsers by firestore.rules — only this code, via the Admin SDK, touches them):
//   story_submissions/{id}      the moderation record of every submitted story (id = sha256(uid:requestId))
//   story_moderation_log/{auto} append-only audit trail (AI decisions, admin actions, errors)
//   story_user_state/{uid}      per-user counters: rate-limit windows, cooldown, repeat-violation history
//   story_ai_cache/{hash}       validated AI verdicts keyed by content hash (no repeated AI calls for unchanged content)
//   story_stats/{YYYY-MM-DD}_{n} daily counters (5 shards, written after commit) for the dashboard's "AI moderation activity"
//   statuses/{id}               the PUBLIC feed — written only here, and only for approved stories (same id as the submission)

'use strict';

const policy = require('./_story-policy.js');

const C = Object.freeze({
  SUBMISSIONS: 'story_submissions',
  LOG: 'story_moderation_log',
  USER_STATE: 'story_user_state',
  AI_CACHE: 'story_ai_cache',
  STATS: 'story_stats',
  PUBLIC: 'statuses',
  ADMINS: 'admins',
  USERS: 'users',
  MUSIC: 'sharedMusic',
});

const PROCESSING_STALE_MS = 60 * 1000;     // a `processing` claim older than this is considered dead and may be taken over
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Admin SDK init (crash-proof, same env handling as api/ai-tafsir.js)
// ---------------------------------------------------------------------------------------------------------
let _fb = null;
let _override = null;

function getFirebase() {
  if (_override) return _override;
  if (_fb) return _fb;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env variable is missing');
      const svc = JSON.parse(raw);
      // Pasting the key into the Vercel dashboard sometimes turns real newlines into the two characters "\n".
      if (svc && typeof svc.private_key === 'string') svc.private_key = svc.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(svc) });
    }
    const db = admin.firestore();
    try { db.settings({ ignoreUndefinedProperties: true }); } catch (e) { /* already configured */ }
    _fb = { ok: true, admin, db };
  } catch (e) {
    _fb = { ok: false, error: e };
  }
  return _fb;
}

// Tests inject a fake { ok:true, admin, db }.
function setFirebaseForTests(fb) { _override = fb; _fb = null; }

// ---------------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------------
function getJsonBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string' && b.trim()) {
    try { const o = JSON.parse(b); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  return {};
}

function bearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof h === 'string' && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const b = req.body && typeof req.body === 'object' ? req.body.idToken : null;
  return typeof b === 'string' ? b : null;
}

function sendJson(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    const body = Object.assign({ error: err.code }, err.extra || {});
    if (err.extra && err.extra.retryAfterSec) res.setHeader('Retry-After', String(err.extra.retryAfterSec));
    return sendJson(res, err.status, body);
  }
  if (err instanceof policy.ValidationError) {
    return sendJson(res, 400, { error: 'invalid_story', field: err.field, message: err.message });
  }
  console.error('story: unexpected error', err && err.stack ? err.stack : err);
  return sendJson(res, 500, { error: 'server_error' });
}

// ---------------------------------------------------------------------------------------------------------
// Authentication / authorisation (verified on EVERY call — nothing is cached between requests)
// ---------------------------------------------------------------------------------------------------------
async function verifyUser(fb, req, opts) {
  const token = bearerToken(req);
  if (!token || token.length > 4096) throw new HttpError(401, 'unauthenticated');
  try {
    return await fb.admin.auth().verifyIdToken(token, !!(opts && opts.checkRevoked));
  } catch (e) {
    throw new HttpError(401, 'unauthenticated');
  }
}

// Same source of truth as firestore.rules: admins/{uid}.isAdmin === true.
async function requireAdmin(fb, req) {
  const decoded = await verifyUser(fb, req, { checkRevoked: true });
  let snap;
  try { snap = await fb.db.collection(C.ADMINS).doc(decoded.uid).get(); } catch (e) { throw new HttpError(503, 'service_unavailable'); }
  if (!snap.exists || !snap.data() || snap.data().isAdmin !== true) throw new HttpError(403, 'forbidden');
  return { uid: decoded.uid, email: decoded.email || '' };
}

// Canonical name/avatar come from the server, never from the browser (the old client-written documents let any
// user pick any display name).
async function loadProfile(fb, uid, claims) {
  let data = {};
  try {
    const s = await fb.db.collection(C.USERS).doc(uid).get();
    if (s.exists) data = s.data() || {};
  } catch (e) { /* fall back to token claims */ }
  const color = typeof data.avatarColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(data.avatarColor) ? data.avatarColor : '';
  const icon = typeof data.avatarIcon === 'string' && /^[a-z0-9-]{1,40}$/.test(data.avatarIcon) ? data.avatarIcon : '';
  const name = policy.sanitizeText((claims && claims.name) || data.name || '').slice(0, policy.LIMITS.NAME_MAX) || 'ব্যবহারকারী';
  return { status: data.status || 'active', name, avatarColor: color, avatarIcon: icon };
}

// ---------------------------------------------------------------------------------------------------------
// Counters / audit log helpers (used inside transactions)
// ---------------------------------------------------------------------------------------------------------
// Dashboard counters are written AFTER the moderation transaction commits, best effort, and spread over a few shard
// documents — so a busy moment can never make a user's submission fail or retry because of one hot analytics document.
// (The authoritative totals shown on the dashboard come from count() queries on story_submissions; these counters only
// feed the "AI moderation activity" chart.)
const STATS_SHARDS = 5;

async function bumpStats(fb, now, inc) {
  if (!inc || !Object.keys(inc).length) return;
  try {
    const FV = fb.admin.firestore.FieldValue;
    const key = policy.dhakaDayKey(now);
    const shard = Math.floor(Math.random() * STATS_SHARDS);
    const data = { day: key, shard };
    for (const [k, v] of Object.entries(inc)) data[k] = FV.increment(v);
    await fb.db.collection(C.STATS).doc(`${key}_${shard}`).set(data, { merge: true });
  } catch (e) {
    console.error('story: stats update failed:', e && e.message);
  }
}

function logWrite(fb, tx, entry) {
  const clean = {};
  for (const [k, v] of Object.entries(entry)) if (v !== undefined) clean[k] = v;
  tx.set(fb.db.collection(C.LOG).doc(), clean);
}

// ---------------------------------------------------------------------------------------------------------
// Claim a submission (idempotency + rate limiting in ONE transaction)
// ---------------------------------------------------------------------------------------------------------
// → { kind:'new'|'resume', rec }        proceed to moderate (caller owns `token`)
//   { kind:'replay', rec }              already decided — just return the stored result
//   { kind:'in_progress', rec }         another request is moderating this very story right now
//   { kind:'conflict' }                 same requestId, different content (never legitimate)
//   { kind:'limited', reason, retryAfterSec }
//   { kind:'too_many_attempts', rec }
async function beginSubmission(fb, p) {
  const { db } = fb;
  const subRef = db.collection(C.SUBMISSIONS).doc(p.id);
  const stRef = db.collection(C.USER_STATE).doc(p.uid);
  let out;

  await db.runTransaction(async (tx) => {
    out = undefined;
    const subSnap = await tx.get(subRef);

    if (subSnap.exists) {
      const rec = Object.assign({ id: p.id }, subSnap.data());
      if (rec.userId !== p.uid || rec.contentHash !== p.fingerprint) { out = { kind: 'conflict' }; return; }
      if (rec.moderationStatus === policy.STATUS.APPROVED || rec.moderationStatus === policy.STATUS.REJECTED
        || rec.moderationStatus === policy.STATUS.REVIEW) { out = { kind: 'replay', rec }; return; }
      if (rec.moderationStatus === policy.STATUS.PROCESSING && p.now - (rec.processingStartedAt || 0) < PROCESSING_STALE_MS) {
        out = { kind: 'in_progress', rec }; return;
      }
      // pending (AI failed earlier) or a dead `processing` claim → this request takes over and tries again.
      if ((rec.attempts || 0) >= policy.RATE.MAX_AI_ATTEMPTS_PER_STORY) { out = { kind: 'too_many_attempts', rec }; return; }
      tx.update(subRef, { moderationStatus: policy.STATUS.PROCESSING, processingToken: p.token, processingStartedAt: p.now, attempts: (rec.attempts || 0) + 1 });
      out = { kind: 'resume', rec: Object.assign({}, rec, { moderationStatus: policy.STATUS.PROCESSING, processingToken: p.token, processingStartedAt: p.now, attempts: (rec.attempts || 0) + 1 }) };
      return;
    }

    const stSnap = await tx.get(stRef);
    const q = policy.consumeSubmissionQuota(stSnap.exists ? stSnap.data() : null, p.now);
    if (!q.ok) { out = { kind: 'limited', reason: q.reason, retryAfterSec: q.retryAfterSec }; return; }

    const rec = Object.assign({}, p.record, {
      userId: p.uid,
      contentHash: p.fingerprint,
      policyVersion: policy.POLICY_VERSION,
      moderationStatus: policy.STATUS.PROCESSING,
      processingToken: p.token,
      processingStartedAt: p.now,
      attempts: 1,
      aiState: 'none',
      createdAt: p.now,
    });
    tx.create(subRef, rec);
    tx.set(stRef, Object.assign({}, q.state, { updatedAt: p.now }));
    out = { kind: 'new', rec: Object.assign({ id: p.id }, rec) };
  });
  if (out && out.kind === 'new') await bumpStats(fb, p.now, { submitted: 1 });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The one place a submission changes state (AI verdicts AND administrator actions both come through here)
// ---------------------------------------------------------------------------------------------------------
// spec: { id, expect:[statuses], token?, to, now, actorType:'ai'|'system'|'admin', actor, reasonCode, fields,
//         logEvent, note, statsInc, removePublished }
// → { ok:true, rec } | { ok:false, code:'not_found'|'bad_state'|'lost_lock'|'content_unavailable', rec? }
async function applyTransition(fb, spec) {
  const { db, admin } = fb;
  const FV = admin.firestore.FieldValue;
  const subRef = db.collection(C.SUBMISSIONS).doc(spec.id);
  let result;

  await db.runTransaction(async (tx) => {
    result = undefined;
    const subSnap = await tx.get(subRef);
    if (!subSnap.exists) { result = { ok: false, code: 'not_found' }; return; }
    const rec = Object.assign({ id: spec.id }, subSnap.data());

    const isProcessing = rec.moderationStatus === policy.STATUS.PROCESSING;
    const isStale = isProcessing && spec.now - (rec.processingStartedAt || 0) >= PROCESSING_STALE_MS;
    if (!(spec.expect.includes(rec.moderationStatus) || (spec.allowStale && isStale))) { result = { ok: false, code: 'bad_state', rec }; return; }
    if (isProcessing && spec.token && rec.processingToken !== spec.token) { result = { ok: false, code: 'lost_lock', rec }; return; }

    const toCount = spec.to !== policy.STATUS.PENDING;
    const stRef = db.collection(C.USER_STATE).doc(rec.userId);
    const stSnap = toCount ? await tx.get(stRef) : null;
    const pubRef = db.collection(C.PUBLIC).doc(spec.id);
    const pubSnap = (spec.to === policy.STATUS.APPROVED || spec.removePublished) ? await tx.get(pubRef) : null;

    // ---- compute the new record (plain values + keys to delete)
    const plain = Object.assign({}, spec.fields || {}, {
      moderationStatus: spec.to,
      reasonCode: spec.reasonCode || 'none',
      moderatedAt: spec.now,
      moderationSource: spec.actorType === 'admin' ? 'admin' : (spec.fields && spec.fields.moderationSource) || spec.actorType,
    });
    const del = ['processingToken', 'processingStartedAt'];

    if (spec.actorType === 'admin') {
      plain.reviewedBy = spec.actor;
      plain.reviewedAt = spec.now;
      plain.priorStatus = rec.moderationStatus;          // what the AI / system had decided before the human stepped in
      plain.priorReasonCode = rec.reasonCode || 'none';
    }

    if (spec.to === policy.STATUS.APPROVED) {
      const hasContent = rec.type === 'voice' ? !!rec.audioData : rec.type === 'image' ? !!rec.imageData : !!(rec.text || rec.audioData);
      if (!hasContent) { result = { ok: false, code: 'content_unavailable', rec }; return; }
      if (!pubSnap.exists) tx.create(db.collection(C.PUBLIC).doc(spec.id), policy.buildPublishedStatus(rec, spec.now, spec.actorType === 'admin' ? 'admin' : 'ai'));
      plain.publishedAt = spec.now;
      plain.publishedStatusId = spec.id;
      del.push('imageData', 'audioData'); // the media now lives in the public document — no second copy
    } else if (spec.to === policy.STATUS.REJECTED) {
      del.push('imageData', 'audioData'); // blocked media is never kept
      if (spec.removePublished) {
        if (pubSnap && pubSnap.exists) tx.delete(pubRef);
        plain.removedAfterPublish = true;
        plain.unpublishedAt = spec.now;
      }
    }

    for (const k of Object.keys(plain)) if (plain[k] === undefined) delete plain[k];
    const upd = Object.assign({}, plain);
    for (const k of del) upd[k] = FV.delete();
    tx.update(subRef, upd);

    if (toCount) {
      tx.set(stRef, Object.assign({}, policy.recordOutcome(stSnap && stSnap.exists ? stSnap.data() : null, spec.to, spec.now), { updatedAt: spec.now }));
    }
    logWrite(fb, tx, {
      submissionId: spec.id, userId: rec.userId, event: spec.logEvent, from: rec.moderationStatus, status: spec.to,
      reasonCode: spec.reasonCode || 'none',
      confidence: spec.fields && spec.fields.confidence !== undefined ? spec.fields.confidence : undefined,
      model: spec.fields && spec.fields.aiModel ? spec.fields.aiModel : undefined,
      by: spec.actorType === 'admin' ? spec.actor : spec.actorType,
      note: spec.note ? String(spec.note).slice(0, 300) : undefined,
      at: spec.now,
    });

    const merged = Object.assign({}, rec, plain);
    for (const k of del) delete merged[k];
    result = { ok: true, rec: merged };
  });
  if (result && result.ok && spec.statsInc) await bumpStats(fb, spec.now, spec.statsInc);
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Administrator asks for the AI to look again at a story whose first check failed (Gemini outage, quota, …)
// ---------------------------------------------------------------------------------------------------------
async function claimForRecheck(fb, p) {
  const { db } = fb;
  const subRef = db.collection(C.SUBMISSIONS).doc(p.id);
  let out;
  await db.runTransaction(async (tx) => {
    out = undefined;
    const snap = await tx.get(subRef);
    if (!snap.exists) { out = { ok: false, code: 'not_found' }; return; }
    const rec = Object.assign({ id: p.id }, snap.data());
    const stale = rec.moderationStatus === policy.STATUS.PROCESSING && p.now - (rec.processingStartedAt || 0) >= PROCESSING_STALE_MS;
    if (rec.moderationStatus !== policy.STATUS.PENDING && !stale) { out = { ok: false, code: 'bad_state', rec }; return; }
    const attempts = (rec.attempts || 0) + 1;
    tx.update(subRef, { moderationStatus: policy.STATUS.PROCESSING, processingToken: p.token, processingStartedAt: p.now, attempts });
    logWrite(fb, tx, { submissionId: p.id, userId: rec.userId, event: 'admin_recheck', from: rec.moderationStatus, status: policy.STATUS.PROCESSING, by: p.adminUid, at: p.now });
    out = { ok: true, rec: Object.assign({}, rec, { moderationStatus: policy.STATUS.PROCESSING, processingToken: p.token, processingStartedAt: p.now, attempts }) };
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// AI verdict cache ("prevent repeated moderation of unchanged content")
// ---------------------------------------------------------------------------------------------------------
async function getCachedVerdict(fb, key, hasImage, now) {
  try {
    const s = await fb.db.collection(C.AI_CACHE).doc(key).get();
    if (!s.exists) return null;
    const d = s.data() || {};
    if (d.policyVersion !== policy.POLICY_VERSION || !(now - d.createdAt < CACHE_TTL_MS)) return null;
    const v = policy.validateAiResult(d.verdict, { hasImage }); // never trust the cache blindly either
    return v.ok ? { verdict: v.value, model: d.model || 'cache' } : null;
  } catch (e) {
    return null; // a cache problem must never break moderation
  }
}

async function putCachedVerdict(fb, key, verdict, model, now) {
  try {
    await fb.db.collection(C.AI_CACHE).doc(key).set({ verdict, model, policyVersion: policy.POLICY_VERSION, createdAt: now });
  } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------------------------------------------------
// Account deletion: remove the CONTENT and personal fields the moderation pipeline holds about a user
// ---------------------------------------------------------------------------------------------------------
// Any signed-in user can call this, so it must never be a way to wipe one's own moderation record: it therefore
//   - deletes undecided submissions (pending / review_required / processing) completely — nothing was ever established
//   - strips text, media, name, avatar and AI/admin free-text from decided ones (approved / rejected), keeping only the
//     non-content metadata (status, reason code, timestamps, hash)
//   - KEEPS story_user_state (rate-limit windows, cooldown, rejection history) and the audit log (ids/codes/timestamps only)
// so a user cannot "reset" a cooldown or hide repeat violations by purging; once the Auth account is gone the remaining
// rows are an orphaned uid with no personal data.
const PURGE_FIELDS = ['text', 'imageData', 'audioData', 'audioName', 'audioPeaks', 'extractedText', 'moderationReason',
  'adminNote', 'userName', 'avatarColor', 'avatarIcon', 'linkHosts', 'musicTrackId'];

async function purgeUserData(fb, uid) {
  const { db, admin } = fb;
  const FV = admin.firestore.FieldValue;
  const now = Date.now();
  let deleted = 0;
  let anonymized = 0;
  let last = null;
  for (let round = 0; round < 60; round++) {
    let q = db.collection(C.SUBMISSIONS).where('userId', '==', uid);
    if (last) q = q.startAfter(last);
    const snap = await q.limit(100).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.forEach((d) => {
      const st = (d.data() || {}).moderationStatus;
      if (st === policy.STATUS.APPROVED || st === policy.STATUS.REJECTED) {
        const upd = { userPurged: true, purgedAt: now };
        for (const f of PURGE_FIELDS) upd[f] = FV.delete();
        batch.update(d.ref, upd);
        anonymized++;
      } else {
        batch.delete(d.ref);
        deleted++;
      }
    });
    await batch.commit();
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 100) break;
  }
  return { deleted, anonymized };
}

module.exports = {
  C, PROCESSING_STALE_MS, CACHE_TTL_MS, HttpError,
  getFirebase, setFirebaseForTests, getJsonBody, bearerToken, sendJson, sendError,
  verifyUser, requireAdmin, loadProfile,
  STATS_SHARDS, bumpStats, logWrite, beginSubmission, applyTransition, claimForRecheck,
  getCachedVerdict, putCachedVerdict, purgeUserData,
};
