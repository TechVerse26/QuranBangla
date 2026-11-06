// api/story-submit.js  —  POST /api/story-submit
//
// The ONLY way a website Story can reach the public `statuses` feed. The browser can no longer write to `statuses`
// (see firestore.rules), so every Story goes through here:
//
//   browser ──(Firebase ID token + story)──► this function
//     1. verify the Firebase ID token and the account (blocked accounts are refused)
//     2. validate everything server-side (sizes, types, image/audio magic bytes, allow-listed style values)
//     3. claim the submission atomically: idempotency key (replay-safe), per-user rate limit, cooldown
//     4. moderate: cached verdict, or Gemini (timeouts, model fallback, strict JSON schema) — see _story-pipeline.js
//     5. decide: APPROVED → published here with the Admin SDK │ REJECTED → blocked │ REVIEW_REQUIRED / AI down → private
//     6. answer with a respectful, fixed Bengali message (raw model output is never sent to the browser)
//
// Body: { action?: 'submit'|'mine'|'purge', requestId, story:{ type, text, imageData?, audioData?, ... } }
// Auth: Authorization: Bearer <Firebase ID token>   (a body field `idToken` is also accepted, like /api/ai-tafsir)
//
// Environment (same as api/ai-tafsir.js): GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT.
// Optional: STORY_SAFE_LINK_HOSTS, STORY_APPROVE_MIN_CONFIDENCE, STORY_REJECT_MIN_CONFIDENCE, GEMINI_MODERATION_MODELS.

'use strict';

const crypto = require('crypto');
const policy = require('./_story-policy.js');
const store = require('./_story-firebase.js');
const { runPipeline } = require('./_story-pipeline.js');

const { HttpError, C } = store;

function respond(res, rec, overrides) {
  const pub = policy.publicResult(rec);
  return store.sendJson(res, 200, Object.assign({ ok: true }, pub, overrides || {}));
}

function buildRecord(story, meta, profile) {
  const rec = {
    userName: profile.name,
    avatarColor: profile.avatarColor,
    avatarIcon: profile.avatarIcon,
    type: story.type,
    hasImage: meta.hasImage,
    hasAudio: meta.hasAudio,
    imageBytes: meta.imageBytes,
    audioBytes: meta.audioBytes,
    linkHosts: meta.links.hosts,
  };
  for (const k of ['text', 'bg', 'font', 'align', 'size', 'textColor', 'highlight', 'imageData',
    'audioData', 'audioDuration', 'audioPeaks', 'audioName', 'musicTrackId']) {
    if (story[k] !== undefined) rec[k] = story[k];
  }
  return rec;
}

async function handleSubmit(fb, req, res, body, claims) {
  if (!policy.isValidRequestId(body.requestId)) throw new HttpError(400, 'invalid_request_id');
  const { story, meta } = policy.sanitizeStory(body.story, process.env); // throws ValidationError → 400

  const uid = claims.uid;
  const profile = await store.loadProfile(fb, uid, claims);
  if (profile.status === 'blocked') throw new HttpError(403, 'account_blocked');

  const id = policy.submissionIdFor(uid, body.requestId);
  const now = Date.now();
  const token = crypto.randomBytes(12).toString('hex');

  const begun = await store.beginSubmission(fb, {
    id, uid, now, token,
    fingerprint: policy.contentFingerprint(story),
    record: buildRecord(story, meta, profile),
  });

  switch (begun.kind) {
    case 'conflict': throw new HttpError(409, 'request_conflict');
    case 'in_progress': throw new HttpError(409, 'in_progress', { retryAfterSec: 3 });
    case 'limited': throw new HttpError(429, 'rate_limited', { reason: begun.reason, retryAfterSec: begun.retryAfterSec });
    case 'replay': return respond(res, begun.rec);
    case 'too_many_attempts':
      return respond(res, begun.rec, {
        retryable: false,
        title: 'আপনার স্টোরি অ্যাডমিনের রিভিউয়ের অপেক্ষায় আছে',
        message: 'স্বয়ংক্রিয় যাচাই এখনো সম্ভব হয়নি, তাই স্টোরিটি অ্যাডমিনের রিভিউয়ের জন্য রাখা হয়েছে। অনুমোদনের আগে এটি প্রকাশিত হবে না।',
      });
    default: break; // 'new' | 'resume'
  }

  const out = await runPipeline(fb, begun.rec, token, { env: process.env });
  if (out.ok) return respond(res, out.rec);

  if (out.code === 'lost_lock') throw new HttpError(409, 'in_progress', { retryAfterSec: 3 });
  if (out.code === 'bad_state' && out.rec) return respond(res, out.rec); // an administrator got there first
  throw new HttpError(500, 'server_error');
}

// The caller's own recent submissions — safe fields only (no AI reasoning, no media).
async function handleMine(fb, res, uid) {
  const snap = await fb.db.collection(C.SUBMISSIONS).where('userId', '==', uid).orderBy('createdAt', 'desc').limit(20).get();
  const items = [];
  snap.forEach((d) => {
    const r = d.data();
    const pub = policy.publicResult(Object.assign({ id: d.id }, r));
    items.push({
      id: d.id, type: r.type, preview: String(r.text || '').slice(0, 80), status: r.moderationStatus,
      title: pub.title, message: pub.message, guideline: pub.guideline,
      hasImage: !!r.hasImage, hasAudio: !!r.hasAudio, createdAt: r.createdAt || 0,
    });
  });
  return store.sendJson(res, 200, { ok: true, items });
}

// Called while a user deletes their account (js/auth.js): removes the content/personal fields of their submissions.
// (Abuse-tracking counters and the id/code-only audit log are deliberately kept — see purgeUserData.)
async function handlePurge(fb, res, uid) {
  const r = await store.purgeUserData(fb, uid);
  return store.sendJson(res, 200, { ok: true, deleted: r.deleted, anonymized: r.anonymized });
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(204).end(); }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return store.sendJson(res, 405, { error: 'method_not_allowed' }); }

  try {
    const fb = store.getFirebase();
    if (!fb.ok) {
      console.error('story-submit: Firebase Admin is not configured:', fb.error && fb.error.message);
      throw new HttpError(503, 'not_configured');
    }
    const body = store.getJsonBody(req);
    const action = body.action == null ? 'submit' : body.action;
    if (!['submit', 'mine', 'purge'].includes(action)) throw new HttpError(400, 'bad_request');

    const claims = await store.verifyUser(fb, req);

    if (action === 'mine') return await handleMine(fb, res, claims.uid);
    if (action === 'purge') return await handlePurge(fb, res, claims.uid);
    return await handleSubmit(fb, req, res, body, claims);
  } catch (err) {
    return store.sendError(res, err);
  }
}

module.exports = handler;
module.exports._internals = { buildRecord, handleSubmit };
