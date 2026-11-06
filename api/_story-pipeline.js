// api/_story-pipeline.js
//
// Runs ONE claimed submission through moderation and records the outcome:
//
//   claimed record (status `processing`)
//     → nothing the AI can read?  (voice message / music-only)      → admin review / auto-approve, no AI call
//     → cached verdict for identical content?                         → reuse it (no AI call)
//     → Gemini (timeouts + model fallback + strict schema)            → validated verdict
//     → AI unavailable / invalid / over quota                         → status `pending` (private, retry or admin)
//     → decision engine (server policy may only make the verdict stricter)
//     → applyTransition(): approved → published to `statuses`; rejected → media dropped; review → kept private
//
// Used by api/story-submit.js (new submissions and retries) and api/story-admin.js ("re-check with AI").

'use strict';

const policy = require('./_story-policy.js');
const gemini = require('./_story-gemini.js');
const store = require('./_story-firebase.js');

const { C } = store;

// Background music is trusted ONLY when it is byte-for-byte one of the administrator-curated tracks in `sharedMusic`
// (the browser merely names the track; the server compares the actual audio). A user's own upload or recording
// cannot be inspected reliably (browsers produce webm/opus or mp4, which the Gemini API does not list as supported
// audio formats), so it is never published without a human looking at it.
async function isTrustedLibraryAudio(fb, rec) {
  if (rec.type === 'voice' || !rec.audioData || typeof rec.musicTrackId !== 'string') return false;
  const docId = rec.musicTrackId.replace(/^shared:/, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(docId)) return false;
  try {
    const s = await fb.db.collection(C.MUSIC).doc(docId).get();
    return !!(s.exists && s.data() && s.data().audioData === rec.audioData);
  } catch (e) {
    return false;
  }
}

async function recentRejections(fb, uid, now) {
  try {
    const s = await fb.db.collection(C.USER_STATE).doc(uid).get();
    return policy.recentRejectionCount(s.exists ? s.data() : null, now, 24 * 60 * 60 * 1000);
  } catch (e) {
    return 0;
  }
}

function imageParts(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const m = /^data:(image\/[a-z0-9.+-]+)/i.exec(dataUrl);
  return { mime: m ? m[1].toLowerCase() : 'image/jpeg', b64: dataUrl.slice(comma + 1) };
}

// opts: { env, now(), gemini:{...moderateStory opts} }
// → { ok:true, rec } with the final stored record, or { ok:false, code, rec? } when someone else changed it meanwhile.
async function runPipeline(fb, rec, token, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const clock = o.now || Date.now;
  const th = policy.getThresholds(env);

  const hasImage = !!rec.imageData;
  const hasText = !!(rec.text && rec.text.trim());
  const trustedAudio = await isTrustedLibraryAudio(fb, rec);
  const hasUntrustedAudio = !!rec.audioData && !trustedAudio;
  const links = policy.extractLinks(rec.text || '', env);

  const spec = (extra) => Object.assign({
    id: rec.id, expect: [policy.STATUS.PROCESSING], token, now: clock(), actorType: 'ai', actor: 'ai',
  }, extra);

  const flags = [];
  if (links.present) flags.push(links.allSafe ? 'links_safe' : 'links');
  if (rec.audioData) flags.push(trustedAudio ? 'library_audio' : 'untrusted_audio');

  // ---- 1) nothing for the AI to read
  if (rec.type === 'voice' || (!hasText && !hasImage)) {
    const needsHuman = hasUntrustedAudio;
    return store.applyTransition(fb, spec({
      to: needsHuman ? policy.STATUS.REVIEW : policy.STATUS.APPROVED,
      reasonCode: needsHuman ? 'audio_unverified' : 'none',
      actorType: 'system',
      actor: 'system',
      logEvent: needsHuman ? 'system_review' : 'system_approve',
      fields: {
        aiState: 'skipped', moderationSource: 'system', flags,
        moderationReason: needsHuman
          ? 'অডিও (ভয়েস/নিজস্ব মিউজিক) স্বয়ংক্রিয়ভাবে যাচাই করা যায় না — অ্যাডমিনের শোনা প্রয়োজন।'
          : 'শুধু অ্যাডমিন-নির্বাচিত মিউজিক — যাচাইযোগ্য কোনো লেখা/ছবি নেই।',
      },
      statsInc: needsHuman ? { auto_review: 1 } : { auto_approved: 1 },
    }));
  }

  // ---- 2) cached verdict, or ask Gemini
  const cacheKey = policy.aiCacheKey(rec);
  let verdict = null;
  let model = null;
  let source = 'ai';
  let aiState = 'ok';
  const statsInc = {};

  const cached = await store.getCachedVerdict(fb, cacheKey, hasImage, clock());
  if (cached) {
    verdict = cached.verdict; model = cached.model; source = 'ai_cache'; aiState = 'cached';
    statsInc.ai_cache_hits = 1;
  } else {
    const r = await gemini.moderateStory(
      { text: rec.text || '', image: hasImage ? imageParts(rec.imageData) : null, links },
      Object.assign({ apiKey: env.GEMINI_API_KEY }, o.gemini || {})
    );
    statsInc.ai_calls = 1;

    if (!r.ok) {
      statsInc.ai_failed = 1;
      return store.applyTransition(fb, spec({
        to: policy.STATUS.PENDING,
        reasonCode: 'ai_unavailable',
        logEvent: 'ai_error',
        note: r.error,
        fields: { aiState: 'failed', aiError: String(r.error).slice(0, 80), moderationSource: 'system', flags,
          moderationReason: 'AI যাচাই সম্পন্ন হয়নি (কারিগরি সমস্যা) — অ্যাডমিন সিদ্ধান্ত নিতে পারেন বা আবার AI দিয়ে যাচাই করতে পারেন।' },
        statsInc,
      }));
    }

    if (r.blocked) {
      // The provider itself refused to analyse the content (its non-adjustable filters). Treat as a clear violation.
      statsInc.auto_rejected = 1;
      return store.applyTransition(fb, spec({
        to: policy.STATUS.REJECTED,
        reasonCode: 'ai_safety_block',
        logEvent: 'ai_decision',
        note: `provider_block:${r.blockReason}`,
        fields: { decision: 'BLOCKED', confidence: 0.9, severity: 'high', aiState: 'ok', aiModel: r.model, moderationSource: 'ai', flags,
          moderationReason: `Gemini-এর নিরাপত্তা ফিল্টার কনটেন্ট ব্লক করেছে (${r.blockReason})।` },
        statsInc,
      }));
    }

    verdict = r.value; model = r.model;
    await store.putCachedVerdict(fb, cacheKey, verdict, model, clock());
  }

  // ---- 3) decision engine (the AI proposes, the server policy disposes)
  const decision = policy.decide(verdict, {
    hasImage, links, hasUntrustedAudio, recentRejections24h: await recentRejections(fb, rec.userId, clock()),
  }, th);

  if (decision.status === 'approved') statsInc.auto_approved = 1;
  else if (decision.status === 'rejected') statsInc.auto_rejected = 1;
  else statsInc.auto_review = 1;

  return store.applyTransition(fb, spec({
    to: decision.status,
    reasonCode: decision.reasonCode,
    logEvent: source === 'ai_cache' ? 'ai_cache_hit' : 'ai_decision',
    note: decision.systemNotes.join(','),
    fields: {
      decision: verdict.decision,
      confidence: decision.confidence,
      severity: decision.severity,
      moderationReason: decision.adminReason,
      aiState,
      aiModel: model,
      moderationSource: source,
      systemNotes: decision.systemNotes,
      religiousContent: verdict.religiousContent,
      imageNudity: decision.imageAssessment ? decision.imageAssessment.nudity : undefined,
      imageViolence: decision.imageAssessment ? decision.imageAssessment.violence : undefined,
      extractedText: decision.imageAssessment ? decision.imageAssessment.extractedText : undefined,
      flags,
    },
    statsInc,
  }));
}

module.exports = { runPipeline, isTrustedLibraryAudio, imageParts };
