// api/story-admin.js  —  POST /api/story-admin
//
// Moderation back-office for the website Admin Panel ("স্টোরি মডারেশন" tab, js/admin-moderation.js).
// Every call re-verifies the Firebase ID token (revocation checked) AND admins/{uid}.isAdmin === true — the same source
// of truth firestore.rules uses. The moderation collections are closed to browsers, so this is the only door.
//
// Body: { action, ...params }
//   stats                                   totals, daily AI activity, recently moderated
//   list        { tab, limit, cursor }      tab: all | approved | rejected | pending ; cursor = last id of previous page
//   get         { id }                      full story (incl. media), AI decision, history, the user's previous records
//   userHistory { userId }                  one user's recent moderation records + counters
//   approve     { id, note? }               publish a pending / review_required story
//   reject      { id, reasonCode?, note? }  block a pending / review_required story
//   remove      { id, reasonCode?, note? }  take down an already published story
//   remoderate  { id }                      ask the AI again for a story whose first check failed

'use strict';

const crypto = require('crypto');
const policy = require('./_story-policy.js');
const store = require('./_story-firebase.js');
const { runPipeline } = require('./_story-pipeline.js');

const { HttpError, C } = store;

const PAGE_DEFAULT = 15;
const PAGE_MAX = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REPEAT_WINDOW_MS = 30 * DAY_MS;
const REPEAT_THRESHOLD = 3;

const TABS = ['all', 'approved', 'rejected', 'pending'];

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------
function isIndexError(e) {
  const m = String((e && e.message) || '');
  return !!e && /index/i.test(m) && (e.code === 9 || /FAILED_PRECONDITION/.test(m));
}

function indexUrlFrom(e) {
  const m = /(https:\/\/console\.firebase\.google\.com\/[^\s"']+)/.exec(String((e && e.message) || ''));
  return m ? m[1] : null;
}

function wrapQueryError(e) {
  if (isIndexError(e)) return new HttpError(503, 'index_required', { indexUrl: indexUrlFrom(e) });
  return e;
}

async function countOf(q) {
  if (typeof q.count === 'function') {
    const s = await q.count().get();
    return s.data().count;
  }
  const s = await q.select().get(); // older SDKs: slower, same result
  return s.size;
}

function pickNote(v) {
  return policy.sanitizeText(v == null ? '' : v).slice(0, 300);
}

function requireId(body) {
  if (!policy.isValidSubmissionId(body.id)) throw new HttpError(400, 'invalid_id');
  return body.id;
}

function adminReasonCode(v, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v !== 'string' || !policy.ADMIN_REJECT_CODES.has(v)) throw new HttpError(400, 'invalid_reason_code');
  return v;
}

async function userStatsFor(fb, uids, now) {
  const unique = Array.from(new Set(uids.filter(Boolean)));
  const out = {};
  if (!unique.length) return out;
  const snaps = await fb.db.getAll(...unique.map((u) => fb.db.collection(C.USER_STATE).doc(u)));
  snaps.forEach((s, i) => {
    const st = policy.normalizeUserState(s.exists ? s.data() : null);
    const recent = policy.recentRejectionCount(st, now, REPEAT_WINDOW_MS);
    out[unique[i]] = {
      approved: st.counts.approved, rejected: st.counts.rejected, reviewRequired: st.counts.review_required,
      recentRejections30d: recent, repeat: recent >= REPEAT_THRESHOLD, cooldownUntil: st.cooldownUntil || 0,
    };
  });
  return out;
}

async function namesFor(fb, uids) {
  const unique = Array.from(new Set(uids.filter(Boolean)));
  const out = {};
  if (!unique.length) return out;
  try {
    const snaps = await fb.db.getAll(...unique.map((u) => fb.db.collection(C.USERS).doc(u)));
    snaps.forEach((s, i) => { out[unique[i]] = s.exists && s.data() && s.data().name ? String(s.data().name).slice(0, 80) : ''; });
  } catch (e) { /* names are cosmetic */ }
  return out;
}

// Admin-facing view of a submission. Media is NOT included (see `get`).
function toAdminItem(rec, ctx) {
  const c = ctx || {};
  const now = c.now || Date.now();
  const stale = rec.moderationStatus === policy.STATUS.PROCESSING && now - (rec.processingStartedAt || 0) >= store.PROCESSING_STALE_MS;
  return {
    id: rec.id,
    userId: rec.userId,
    userName: rec.userName || '',
    type: rec.type,
    text: rec.text || '',
    hasImage: !!rec.hasImage,
    hasAudio: !!rec.hasAudio,
    linkHosts: rec.linkHosts || [],
    status: rec.moderationStatus,
    stale,
    reasonCode: rec.reasonCode || 'none',
    reasonLabel: policy.reasonLabel(rec.reasonCode || 'none'),
    aiReason: rec.moderationReason || '',
    adminNote: rec.adminNote || '',
    decision: rec.decision || null,
    confidence: typeof rec.confidence === 'number' ? rec.confidence : null,
    severity: rec.severity || null,
    aiState: rec.aiState || 'none',
    aiError: rec.aiError || null,
    aiModel: rec.aiModel || null,
    source: rec.moderationSource || null,
    systemNotes: rec.systemNotes || [],
    flags: rec.flags || [],
    religiousContent: rec.religiousContent === true,
    imageNudity: rec.imageNudity || null,
    imageViolence: rec.imageViolence || null,
    extractedText: rec.extractedText || '',
    attempts: rec.attempts || 0,
    createdAt: rec.createdAt || 0,
    moderatedAt: rec.moderatedAt || 0,
    publishedAt: rec.publishedAt || 0,
    reviewedAt: rec.reviewedAt || 0,
    reviewedBy: rec.reviewedBy || null,
    reviewedByName: (c.names && rec.reviewedBy && c.names[rec.reviewedBy]) || '',
    removedAfterPublish: !!rec.removedAfterPublish,
    unpublishedAt: rec.unpublishedAt || 0,
    priorStatus: rec.priorStatus || null,
    priorReasonCode: rec.priorReasonCode || null,
    userStats: (c.userStats && c.userStats[rec.userId]) || null,
    style: { bg: rec.bg || null, font: rec.font || null, align: rec.align || null, size: rec.size || null, textColor: rec.textColor || null, highlight: !!rec.highlight },
  };
}

async function itemsFromDocs(fb, docs, now) {
  const recs = docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const [userStats, names] = await Promise.all([
    userStatsFor(fb, recs.map((r) => r.userId), now),
    namesFor(fb, recs.map((r) => r.reviewedBy)),
  ]);
  return recs.map((r) => toAdminItem(r, { now, userStats, names }));
}

// ---------------------------------------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------------------------------------
const ACTIVITY_FIELDS = ['submitted', 'ai_calls', 'ai_cache_hits', 'ai_failed', 'auto_approved', 'auto_rejected', 'auto_review',
  'admin_approved', 'admin_rejected', 'admin_removed'];

async function actionStats(fb, now) {
  const col = fb.db.collection(C.SUBMISSIONS);
  const by = (s) => countOf(col.where('moderationStatus', '==', s));
  let counts;
  try {
    counts = await Promise.all([countOf(col), by('approved'), by('rejected'), by('pending'), by('review_required'), by('processing')]);
  } catch (e) { throw wrapQueryError(e); }
  const [total, approved, rejected, pending, review, processing] = counts;

  const days = [];
  for (let i = 0; i < 7; i++) days.push(policy.dhakaDayKey(now - i * DAY_MS));
  const refs = [];
  for (const d of days) for (let n = 0; n < store.STATS_SHARDS; n++) refs.push(fb.db.collection(C.STATS).doc(`${d}_${n}`));
  const shardSnaps = await fb.db.getAll(...refs);
  const activity = days.map((d) => {
    const row = { day: d };
    for (const f of ACTIVITY_FIELDS) row[f] = 0;
    return row;
  });
  shardSnaps.forEach((s, i) => {
    if (!s.exists) return;
    const row = activity[Math.floor(i / store.STATS_SHARDS)];
    const data = s.data() || {};
    for (const f of ACTIVITY_FIELDS) row[f] += Number(data[f]) || 0;
  });

  let recent = [];
  try {
    const snap = await col.orderBy('moderatedAt', 'desc').limit(8).get();
    recent = await itemsFromDocs(fb, snap.docs, now);
  } catch (e) { throw wrapQueryError(e); }

  return {
    ok: true,
    totals: { total, approved, rejected, pendingReview: pending + review, pending, reviewRequired: review, processing },
    activity,
    recent,
  };
}

async function actionList(fb, body, now) {
  const tab = TABS.includes(body.tab) ? body.tab : 'all';
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(body.limit, 10) || PAGE_DEFAULT));
  const col = fb.db.collection(C.SUBMISSIONS);

  let q = col;
  if (tab === 'approved') q = q.where('moderationStatus', '==', 'approved');
  else if (tab === 'rejected') q = q.where('moderationStatus', '==', 'rejected');
  else if (tab === 'pending') q = q.where('moderationStatus', 'in', ['pending', 'review_required', 'processing']);
  q = q.orderBy('createdAt', 'desc');

  if (body.cursor != null && body.cursor !== '') {
    if (!policy.isValidSubmissionId(body.cursor)) throw new HttpError(400, 'invalid_cursor');
    const cs = await col.doc(body.cursor).get();
    if (cs.exists) q = q.startAfter(cs);
  }

  let snap;
  try { snap = await q.limit(limit + 1).get(); } catch (e) { throw wrapQueryError(e); }
  const docs = snap.docs.slice(0, limit);
  const items = await itemsFromDocs(fb, docs, now);
  return { ok: true, tab, items, hasMore: snap.docs.length > limit, nextCursor: docs.length ? docs[docs.length - 1].id : null };
}

async function previousRecords(fb, userId, excludeId, limit, now) {
  try {
    const snap = await fb.db.collection(C.SUBMISSIONS).where('userId', '==', userId).orderBy('createdAt', 'desc').limit(limit + 1).get();
    const docs = snap.docs.filter((d) => d.id !== excludeId).slice(0, limit);
    return { items: await itemsFromDocs(fb, docs, now), warning: null };
  } catch (e) {
    if (isIndexError(e)) return { items: [], warning: 'index_required', indexUrl: indexUrlFrom(e) };
    throw e;
  }
}

async function actionGet(fb, id, now) {
  const snap = await fb.db.collection(C.SUBMISSIONS).doc(id).get();
  if (!snap.exists) throw new HttpError(404, 'not_found');
  const rec = Object.assign({ id }, snap.data());
  const [item] = await itemsFromDocs(fb, [{ id, data: () => snap.data() }], now);

  let media = { imageData: rec.imageData || null, audioData: rec.audioData || null, audioDuration: rec.audioDuration || null, audioName: rec.audioName || null };
  let live = null;
  if (rec.moderationStatus === policy.STATUS.APPROVED && rec.publishedStatusId) {
    const ps = await fb.db.collection(C.PUBLIC).doc(rec.publishedStatusId).get();
    live = ps.exists;
    if (ps.exists) {
      const d = ps.data() || {};
      media = { imageData: d.imageData || null, audioData: d.audioData || null, audioDuration: d.audioDuration || null, audioName: d.audioName || null };
    }
  }

  // history (single equality filter → no composite index needed; sorted here)
  const logSnap = await fb.db.collection(C.LOG).where('submissionId', '==', id).limit(50).get();
  const history = [];
  const actorIds = [];
  logSnap.forEach((d) => { const v = d.data(); history.push(v); if (v.by && !['ai', 'system'].includes(v.by)) actorIds.push(v.by); });
  history.sort((a, b) => (a.at || 0) - (b.at || 0));
  const names = await namesFor(fb, actorIds);
  const historyOut = history.map((h) => ({
    event: h.event, from: h.from || null, status: h.status || null, reasonCode: h.reasonCode || 'none',
    reasonLabel: policy.reasonLabel(h.reasonCode || 'none'), confidence: typeof h.confidence === 'number' ? h.confidence : null,
    model: h.model || null, by: h.by || null, byName: names[h.by] || '', note: h.note || '', at: h.at || 0,
  }));

  const previous = await previousRecords(fb, rec.userId, id, 8, now);
  return { ok: true, item, media, live, history: historyOut, previous: previous.items, previousWarning: previous.warning, indexUrl: previous.indexUrl || null };
}

async function actionUserHistory(fb, userId, now) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new HttpError(400, 'invalid_user');
  const [stats, prev, names] = await Promise.all([
    userStatsFor(fb, [userId], now),
    previousRecords(fb, userId, null, 20, now),
    namesFor(fb, [userId]),
  ]);
  return { ok: true, userId, userName: names[userId] || '', stats: stats[userId], items: prev.items, warning: prev.warning, indexUrl: prev.indexUrl || null };
}

async function transitionAction(fb, admin, body, kind, now) {
  const id = requireId(body);
  const note = pickNote(body.note);
  let spec;
  if (kind === 'approve') {
    spec = { to: policy.STATUS.APPROVED, reasonCode: 'none', logEvent: 'admin_approve', statsInc: { admin_approved: 1 }, expect: ['pending', 'review_required'] };
  } else if (kind === 'reject') {
    spec = { to: policy.STATUS.REJECTED, reasonCode: adminReasonCode(body.reasonCode, 'admin_decision'), logEvent: 'admin_reject', statsInc: { admin_rejected: 1 }, expect: ['pending', 'review_required'] };
  } else { // remove
    spec = { to: policy.STATUS.REJECTED, reasonCode: adminReasonCode(body.reasonCode, 'removed_by_admin'), logEvent: 'admin_remove', statsInc: { admin_removed: 1 }, expect: ['approved'], removePublished: true };
  }
  const out = await store.applyTransition(fb, Object.assign({
    id, now, actorType: 'admin', actor: admin.uid, allowStale: true, note,
    fields: note ? { adminNote: note } : {},
  }, spec));

  if (!out.ok) {
    if (out.code === 'not_found') throw new HttpError(404, 'not_found');
    if (out.code === 'content_unavailable') throw new HttpError(409, 'content_unavailable');
    throw new HttpError(409, 'bad_state', { current: out.rec ? out.rec.moderationStatus : null });
  }

  if (kind === 'remove' && typeof fb.db.recursiveDelete === 'function') {
    // views / reactions sub-collections of the removed public document (best effort — they are invisible without it)
    try { await fb.db.recursiveDelete(fb.db.collection(C.PUBLIC).doc(id)); } catch (e) { console.error('story-admin: sub-collection cleanup failed:', e && e.message); }
  }
  const [item] = await itemsFromDocs(fb, [{ id, data: () => out.rec }], now);
  return { ok: true, item };
}

async function actionRemoderate(fb, admin, body, now) {
  const id = requireId(body);
  const token = crypto.randomBytes(12).toString('hex');
  const claim = await store.claimForRecheck(fb, { id, token, now, adminUid: admin.uid });
  if (!claim.ok) {
    if (claim.code === 'not_found') throw new HttpError(404, 'not_found');
    throw new HttpError(409, 'bad_state', { current: claim.rec ? claim.rec.moderationStatus : null });
  }
  const out = await runPipeline(fb, claim.rec, token, { env: process.env });
  if (!out.ok) throw new HttpError(409, 'bad_state', { current: out.rec ? out.rec.moderationStatus : null });
  const [item] = await itemsFromDocs(fb, [{ id, data: () => out.rec }], now);
  return { ok: true, item };
}

// ---------------------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------------------
async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(204).end(); }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return store.sendJson(res, 405, { error: 'method_not_allowed' }); }

  try {
    const fb = store.getFirebase();
    if (!fb.ok) {
      console.error('story-admin: Firebase Admin is not configured:', fb.error && fb.error.message);
      throw new HttpError(503, 'not_configured');
    }
    const admin = await store.requireAdmin(fb, req); // 401 / 403 before anything else happens
    const body = store.getJsonBody(req);
    const now = Date.now();

    switch (body.action) {
      case 'stats': return store.sendJson(res, 200, await actionStats(fb, now));
      case 'list': return store.sendJson(res, 200, await actionList(fb, body, now));
      case 'get': return store.sendJson(res, 200, await actionGet(fb, requireId(body), now));
      case 'userHistory': return store.sendJson(res, 200, await actionUserHistory(fb, body.userId, now));
      case 'approve':
      case 'reject':
      case 'remove': return store.sendJson(res, 200, await transitionAction(fb, admin, body, body.action, now));
      case 'remoderate': return store.sendJson(res, 200, await actionRemoderate(fb, admin, body, now));
      default: throw new HttpError(400, 'bad_request');
    }
  } catch (err) {
    return store.sendError(res, err);
  }
}

module.exports = handler;
module.exports._internals = { toAdminItem, actionStats, actionList, actionGet, TABS };
