// api/_story-policy.js
//
// Pure helpers for the Story moderation pipeline — NO network, NO Firebase.
// (The leading underscore keeps Vercel from exposing this file as an endpoint, and it lives in /api so it is
// never served as a static file either. It is `require`d by api/story-submit.js and api/story-admin.js.)
//
// Everything that decides whether a Story may be published lives here so it can be unit-tested offline
// (tests/story-moderation.test.js):
//   - payload validation + server-side image / audio sniffing (never trust filenames, MIME or the client)
//   - strict validation of the Gemini JSON verdict
//   - the decision engine that turns the AI verdict into approved / rejected / review_required
//   - per-user rate-limit arithmetic
//   - the respectful Bengali messages shown to users (never raw AI text)

'use strict';

const crypto = require('crypto');

// Bump when the prompt / thresholds / rules change: it is part of every content fingerprint, so cached AI
// verdicts from an older policy are never reused.
const POLICY_VERSION = 'sm-2026.11.1';

const STORY_TTL_MS = 24 * 60 * 60 * 1000; // same 24h life the website feed has always used

const LIMITS = Object.freeze({
  TEXT_MAX: 700,               // same cap as the old firestore.rules / composer counter
  IMAGE_DATAURL_MAX: 900000,   // chars — same cap as the old firestore.rules
  AUDIO_DATAURL_MAX: 750000,   // chars — same cap as the old firestore.rules
  TOTAL_MEDIA_MAX: 980000,     // a Firestore document is hard-capped at 1 MiB; keep headroom for metadata
  AUDIO_NAME_MAX: 120,
  AUDIO_PEAKS_MAX: 60,
  AUDIO_DURATION_MAX_MS: 60000,
  IMAGE_MIN_BYTES: 64,
  AUDIO_MIN_BYTES: 64,
  NAME_MAX: 120,
});

// The only backgrounds the composer offers (same allow-list the old firestore.rules enforced).
const BG_ALLOWED = Object.freeze([
  '#2E6F5E', '#7A2E44', '#3D4F8A', '#6B3F8A', '#8A4A2E', '#2E6B8A', '#5A6B2E', '#3A3A46',
  'linear-gradient(135deg,#2E6F5E,#123B2C)', 'linear-gradient(135deg,#7A2E44,#3A0F1E)',
  'linear-gradient(135deg,#3D4F8A,#141B3D)', 'linear-gradient(135deg,#6B3F8A,#24123D)',
  'linear-gradient(135deg,#8A4A2E,#3A2110)', 'linear-gradient(135deg,#2E6B8A,#0F2A38)',
  'linear-gradient(135deg,#5A6B2E,#22280F)', 'linear-gradient(135deg,#3A3A46,#16161C)',
]);
const FONT_IDS = Object.freeze(['sans', 'serif', 'mono', 'script', 'display']);
const ALIGNS = Object.freeze(['left', 'center', 'right']);
const STORY_TYPES = Object.freeze(['text', 'image', 'voice']);

// ---------------------------------------------------------------------------------------------------------
// Statuses & reason codes
// ---------------------------------------------------------------------------------------------------------
// moderationStatus values stored on story_submissions/{id}:
//   processing       transient — the request is being checked right now (never public)
//   pending          the AI could not be used (outage / timeout / bad JSON / quota) — kept private, retry or admin
//   review_required  AI is unsure or religious authenticity cannot be established — waits for an administrator
//   approved         published to the public `statuses` feed
//   rejected         blocked by the AI or by an administrator (also: an admin removed a published story)
const STATUS = Object.freeze({
  PROCESSING: 'processing',
  PENDING: 'pending',
  REVIEW: 'review_required',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});
const ALL_STATUSES = Object.freeze(Object.values(STATUS));

const AI_DECISIONS = Object.freeze(['APPROVED', 'REJECTED', 'REVIEW_REQUIRED']);
const SEVERITIES = Object.freeze(['none', 'low', 'medium', 'high']);
const NUDITY_LEVELS = Object.freeze(['none', 'suggestive', 'explicit']);
const VIOLENCE_LEVELS = Object.freeze(['none', 'mild', 'graphic']);

// Codes the model may return (also the enum in its response schema).
const AI_REASON_CODES = Object.freeze([
  'none',
  'sexual_content', 'nudity', 'profanity_abuse', 'harassment', 'religious_insult',
  'harmful_activity', 'violence_gore', 'spam_scam', 'malicious_link', 'image_text_violation',
  'fabricated_religious_text', 'misleading_religious_claim', 'false_attribution',
  'ambiguous_religious_content', 'unclear_content', 'other_violation',
]);
// Codes only this server generates.
const SYSTEM_REASON_CODES = Object.freeze([
  'low_confidence', 'link_review', 'audio_unverified', 'repeat_check',
  'ai_unavailable', 'ai_safety_block', 'admin_decision', 'removed_by_admin',
]);

// A REJECTED verdict is only honoured automatically for these (clear community-guideline violations).
const CLEAR_VIOLATION_CODES = new Set([
  'sexual_content', 'nudity', 'profanity_abuse', 'harassment', 'religious_insult',
  'harmful_activity', 'violence_gore', 'spam_scam', 'malicious_link', 'image_text_violation', 'other_violation',
]);
// The AI is NOT an Islamic scholar: questions of religious authenticity / interpretation are never auto-rejected,
// they always go to a human administrator.
const RELIGIOUS_REVIEW_CODES = new Set([
  'fabricated_religious_text', 'misleading_religious_claim', 'false_attribution', 'ambiguous_religious_content',
]);

const STATUS_RANK = { approved: 0, review_required: 1, rejected: 2 };

// Reasons an administrator may choose when rejecting a pending story or removing a published one.
const ADMIN_REJECT_CODES = new Set([
  ...CLEAR_VIOLATION_CODES, ...RELIGIOUS_REVIEW_CODES, 'admin_decision', 'removed_by_admin',
]);

// ---------------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------------
class ValidationError extends Error {
  constructor(field, message) {
    super(message || `invalid ${field}`);
    this.name = 'ValidationError';
    this.code = 'invalid_story';
    this.field = field;
  }
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Idempotency key → document id. Includes the uid so two users can never collide or probe each other's ids.
function submissionIdFor(uid, requestId) {
  return sha256Hex(`${uid}:${requestId}`).slice(0, 32);
}

function isValidRequestId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

function isValidSubmissionId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

// "Today" in Bangladesh time — same convention as api/ai-tafsir.js.
function dhakaDayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function clampStr(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

// Remove control characters and the bidi override/isolate controls that are used to disguise text. ZWJ/ZWNJ and the
// plain LRM/RLM marks are kept — Bengali conjuncts and Arabic text need them.
function sanitizeText(raw) {
  let t = String(raw == null ? '' : raw);
  try { t = t.normalize('NFC'); } catch (e) { /* keep as is */ }
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
  t = t.replace(/\r\n?/g, '\n');
  return t.trim();
}

function normalizeForHash(text) {
  return sanitizeText(text).replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------
// Data-URL / media validation (server-side — the browser's checks are never trusted)
// ---------------------------------------------------------------------------------------------------------
const B64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseDataUrl(str, field) {
  if (typeof str !== 'string') throw new ValidationError(field, `${field} must be a data URL string`);
  const marker = ';base64,';
  const idx = str.indexOf(marker);
  if (!str.startsWith('data:') || idx < 6 || idx > 120) throw new ValidationError(field, `${field} is not a base64 data URL`);
  const head = str.slice(5, idx); // e.g. "image/jpeg" or "audio/webm;codecs=opus"
  const m = /^([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9.+=_-]+)*)$/i.exec(head);
  if (!m) throw new ValidationError(field, `${field} has a malformed MIME header`);
  const body = str.slice(idx + marker.length);
  if (body.length < 8 || body.length % 4 !== 0 || !B64_BODY_RE.test(body)) {
    throw new ValidationError(field, `${field} is not valid base64`);
  }
  const bytes = Buffer.from(body, 'base64');
  return { declaredMime: m[1].toLowerCase(), params: m[2] || '', b64: body, bytes };
}

function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function sniffAudioKind(buf) {
  if (buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'mp3';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------------
const LINK_RE = new RegExp(
  '(?:https?:\\/\\/|www\\.)[^\\s<>"\'\u2018\u2019\u201C\u201D\u0964]+' +
  '|(?:[a-z0-9-]+\\.)+(?:com|net|org|info|biz|xyz|top|click|link|shop|site|online|live|vip|bet|club|icu|work|buzz|cc|ly|gl|me|io|co|app|ru|cn|tk|ml|ga|cf|gq|bd|in|pk|to|ws)(?:\\/[^\\s<>"\'\u2018\u2019\u201C\u201D\u0964]*)?',
  'gi'
);

function defaultSafeHosts(env) {
  const raw = (env && env.STORY_SAFE_LINK_HOSTS) || 'quranbangla.vercel.app,quran.com,sunnah.com';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function extractLinks(text, env) {
  const found = String(text || '').match(LINK_RE) || [];
  const hosts = [];
  for (const cand of found.slice(0, 20)) {
    try {
      const u = new URL(/^https?:\/\//i.test(cand) ? cand : `http://${cand}`);
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      if (h && !hosts.includes(h)) hosts.push(h);
    } catch (e) {
      if (!hosts.includes('(unparseable)')) hosts.push('(unparseable)');
    }
  }
  const safe = defaultSafeHosts(env);
  const allSafe = hosts.length > 0 && hosts.every((h) => safe.some((s) => h === s || h.endsWith(`.${s}`)));
  return { present: hosts.length > 0, hosts: hosts.slice(0, 5), allSafe };
}

// ---------------------------------------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------------------------------------
// Returns { story, meta }. `story` only ever contains whitelisted, validated fields. Throws ValidationError.
function sanitizeStory(input, env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('story', 'story must be an object');

  const type = input.type;
  if (!STORY_TYPES.includes(type)) throw new ValidationError('type', 'type must be text, image or voice');

  const story = { type };
  const meta = { hasImage: false, hasAudio: false, imageMime: null, imageBytes: 0, audioKind: null, audioBytes: 0 };

  // ----- text
  const text = sanitizeText(input.text);
  if (text.length > LIMITS.TEXT_MAX) throw new ValidationError('text', `text is longer than ${LIMITS.TEXT_MAX} characters`);
  if (text) story.text = text;

  // ----- style (cosmetic, but still allow-listed: these values end up in inline CSS in other users' browsers)
  if (type === 'text' || type === 'voice') {
    story.bg = BG_ALLOWED.includes(input.bg) ? input.bg : BG_ALLOWED[0];
  }
  if (type === 'text') {
    story.font = FONT_IDS.includes(input.font) ? input.font : 'sans';
    story.align = ALIGNS.includes(input.align) ? input.align : 'center';
    const size = Number(input.size);
    story.size = Number.isFinite(size) ? Math.min(56, Math.max(14, Math.round(size))) : 26;
    story.textColor = (typeof input.textColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(input.textColor)) ? input.textColor : '#ffffff';
    story.highlight = !!input.highlight;
  }

  // ----- image
  if (input.imageData != null && input.imageData !== '') {
    if (type !== 'image') throw new ValidationError('imageData', 'only image stories may carry an image');
    if (typeof input.imageData !== 'string' || input.imageData.length > LIMITS.IMAGE_DATAURL_MAX) {
      throw new ValidationError('imageData', 'image is too large');
    }
    const p = parseDataUrl(input.imageData, 'imageData');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(p.declaredMime)) {
      throw new ValidationError('imageData', 'only JPEG, PNG or WebP images are allowed');
    }
    const sniffed = sniffImageMime(p.bytes);
    if (!sniffed) throw new ValidationError('imageData', 'file content is not a supported image');
    if (sniffed !== p.declaredMime) throw new ValidationError('imageData', 'image content does not match its declared type');
    if (p.bytes.length < LIMITS.IMAGE_MIN_BYTES) throw new ValidationError('imageData', 'image is too small to be valid');
    story.imageData = input.imageData;
    meta.hasImage = true;
    meta.imageMime = sniffed;
    meta.imageBytes = p.bytes.length;
    meta.imageB64 = p.b64;
  }
  if (type === 'image' && !meta.hasImage) throw new ValidationError('imageData', 'an image story needs an image');

  // ----- audio (voice message, or background music)
  if (input.audioData != null && input.audioData !== '') {
    if (typeof input.audioData !== 'string' || input.audioData.length > LIMITS.AUDIO_DATAURL_MAX) {
      throw new ValidationError('audioData', 'audio is too large');
    }
    const p = parseDataUrl(input.audioData, 'audioData');
    if (!p.declaredMime.startsWith('audio/')) throw new ValidationError('audioData', 'audio must have an audio/* type');
    const kind = sniffAudioKind(p.bytes);
    if (!kind) throw new ValidationError('audioData', 'file content is not a supported audio format');
    if (p.bytes.length < LIMITS.AUDIO_MIN_BYTES) throw new ValidationError('audioData', 'audio is too small to be valid');
    story.audioData = input.audioData;
    meta.hasAudio = true;
    meta.audioKind = kind;
    meta.audioBytes = p.bytes.length;

    const dur = Number(input.audioDuration);
    if (!Number.isFinite(dur) || dur <= 0 || dur > LIMITS.AUDIO_DURATION_MAX_MS) {
      throw new ValidationError('audioDuration', 'audio duration is out of range');
    }
    story.audioDuration = Math.round(dur);
    const peaks = Array.isArray(input.audioPeaks) ? input.audioPeaks.slice(0, LIMITS.AUDIO_PEAKS_MAX) : [];
    story.audioPeaks = peaks.map((n) => {
      const v = Number(n);
      return Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 1000) / 1000)) : 0;
    });
    if (input.audioName != null && input.audioName !== '') story.audioName = clampStr(sanitizeText(input.audioName), LIMITS.AUDIO_NAME_MAX);
    if (typeof input.musicTrackId === 'string' && /^shared:[A-Za-z0-9_-]{1,64}$/.test(input.musicTrackId)) {
      story.musicTrackId = input.musicTrackId; // a CLAIM only — the server verifies it byte-for-byte against `sharedMusic`
    }
  }
  if (type === 'voice' && !meta.hasAudio) throw new ValidationError('audioData', 'a voice story needs a recording');

  // ----- something must be there
  if (type === 'text' && !story.text && !meta.hasAudio) throw new ValidationError('text', 'write something first');

  // ----- combined size (Firestore document limit)
  if ((story.imageData ? story.imageData.length : 0) + (story.audioData ? story.audioData.length : 0) > LIMITS.TOTAL_MEDIA_MAX) {
    throw new ValidationError('imageData', 'image and audio together are too large');
  }

  meta.links = extractLinks(story.text || '', env);
  return { story, meta };
}

// Hash of everything that influences moderation OR what gets published. Used for idempotency conflict detection.
function contentFingerprint(story) {
  return sha256Hex([
    POLICY_VERSION, story.type, normalizeForHash(story.text),
    story.imageData ? sha256Hex(story.imageData) : '',
    story.audioData ? sha256Hex(story.audioData) : '',
  ].join('\u0001'));
}

// Hash of only what the AI actually looks at (text + image) → key of the verdict cache, shared across users.
function aiCacheKey(story) {
  return sha256Hex([
    POLICY_VERSION, 'ai', normalizeForHash(story.text), story.imageData ? sha256Hex(story.imageData) : '',
  ].join('\u0001'));
}

// ---------------------------------------------------------------------------------------------------------
// Strict validation of the Gemini verdict
// ---------------------------------------------------------------------------------------------------------
function stripFences(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

function fail(error) { return { ok: false, error }; }

// ctx: { hasImage }. Unknown keys are dropped. Anything off-schema makes the whole verdict INVALID (the caller then
// keeps the story unpublished in the safe `pending` state) — an invalid verdict is never "repaired" into a decision.
function validateAiResult(raw, ctx) {
  const hasImage = !!(ctx && ctx.hasImage);
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(stripFences(raw)); } catch (e) { return fail('invalid_json'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('not_an_object');

  if (!AI_DECISIONS.includes(obj.decision)) return fail('bad_decision');
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) return fail('bad_confidence');
  if (!AI_REASON_CODES.includes(obj.reasonCode)) return fail('bad_reason_code');
  if (!SEVERITIES.includes(obj.severity)) return fail('bad_severity');
  if (typeof obj.adminReason !== 'string' || obj.adminReason.length > 2000) return fail('bad_admin_reason');
  if (typeof obj.religiousContent !== 'boolean') return fail('bad_religious_flag');

  let imageAssessment = null;
  if (hasImage) {
    const ia = obj.imageAssessment;
    if (!ia || typeof ia !== 'object' || Array.isArray(ia)) return fail('missing_image_assessment');
    if (!NUDITY_LEVELS.includes(ia.nudity)) return fail('bad_image_nudity');
    if (!VIOLENCE_LEVELS.includes(ia.violence)) return fail('bad_image_violence');
    if (typeof ia.textFound !== 'boolean') return fail('bad_image_text_flag');
    if (typeof ia.textViolation !== 'boolean') return fail('bad_image_text_violation');
    if (typeof ia.extractedText !== 'string' || ia.extractedText.length > 3000) return fail('bad_image_extracted_text');
    imageAssessment = {
      nudity: ia.nudity,
      violence: ia.violence,
      textFound: ia.textFound,
      textViolation: ia.textViolation,
      extractedText: sanitizeText(ia.extractedText).slice(0, 300),
    };
  }

  return {
    ok: true,
    value: {
      decision: obj.decision,
      confidence: Math.round(obj.confidence * 1000) / 1000,
      reasonCode: obj.reasonCode,
      severity: obj.severity,
      adminReason: sanitizeText(obj.adminReason).slice(0, 500),
      religiousContent: obj.religiousContent,
      imageAssessment,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------------------------------------
function numEnv(env, name, dflt, lo, hi) {
  const v = Number(env && env[name]);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

function getThresholds(env) {
  return {
    approveMin: numEnv(env, 'STORY_APPROVE_MIN_CONFIDENCE', 0.75, 0.5, 0.99),
    rejectMin: numEnv(env, 'STORY_REJECT_MIN_CONFIDENCE', 0.8, 0.5, 0.99),
    explicitImageRejectMin: 0.6,
    graphicViolenceRejectMin: 0.7,
    repeatOffenderApproveMin: 0.9,
    repeatOffenderCount: 3,
  };
}

// ai: output of validateAiResult().value
// ctx: { hasImage, links:{present,allSafe}, hasUntrustedAudio, recentRejections24h }
// Returns { status, reasonCode, confidence, severity, adminReason, imageAssessment, systemNotes[] }.
// The AI proposes, the server disposes: every escalation below can only make the outcome STRICTER.
function decide(ai, ctx, thresholds) {
  const th = thresholds || getThresholds({});
  const c = ctx || {};
  const systemNotes = [];

  let status;
  let reasonCode = ai.reasonCode;

  // ---- 1) the AI's headline verdict
  if (ai.decision === 'APPROVED') {
    if (ai.reasonCode !== 'none') {
      status = 'review_required'; reasonCode = 'low_confidence'; systemNotes.push('inconsistent_ai_output');
    } else if (ai.confidence < th.approveMin) {
      status = 'review_required'; reasonCode = 'low_confidence'; systemNotes.push('low_confidence');
    } else {
      status = 'approved'; reasonCode = 'none';
    }
  } else if (ai.decision === 'REJECTED') {
    if (CLEAR_VIOLATION_CODES.has(ai.reasonCode) && ai.confidence >= th.rejectMin) {
      status = 'rejected';
    } else if (RELIGIOUS_REVIEW_CODES.has(ai.reasonCode)) {
      status = 'review_required'; // authenticity / interpretation is for humans, never auto-rejected
    } else {
      status = 'review_required';
      if (ai.reasonCode === 'none') reasonCode = 'low_confidence';
      systemNotes.push(CLEAR_VIOLATION_CODES.has(ai.reasonCode) ? 'reject_below_threshold' : 'unclassified_rejection');
    }
  } else { // REVIEW_REQUIRED
    status = 'review_required';
    if (ai.reasonCode === 'none') reasonCode = 'unclear_content';
  }

  const escalate = (to, code, note) => {
    if (STATUS_RANK[to] > STATUS_RANK[status]) {
      status = to; reasonCode = code;
      if (note) systemNotes.push(note);
    }
  };

  // ---- 2) independent image findings (defence in depth: do not rely on the headline alone)
  const ia = ai.imageAssessment;
  if (c.hasImage && ia) {
    if (ia.nudity === 'explicit') {
      escalate(ai.confidence >= th.explicitImageRejectMin ? 'rejected' : 'review_required', 'nudity', 'image_nudity');
    } else if (ia.nudity === 'suggestive') {
      escalate('review_required', 'sexual_content', 'image_suggestive');
    }
    if (ia.violence === 'graphic') {
      escalate(ai.confidence >= th.graphicViolenceRejectMin ? 'rejected' : 'review_required', 'violence_gore', 'image_violence');
    }
    if (ia.textViolation) {
      escalate('review_required', 'image_text_violation', 'image_text');
    }
  }

  // ---- 3) things the AI cannot vouch for
  if (c.links && c.links.present && !c.links.allSafe) escalate('review_required', 'link_review', 'links');
  if (c.hasUntrustedAudio) escalate('review_required', 'audio_unverified', 'untrusted_audio');
  if (status === 'approved' && (c.recentRejections24h || 0) >= th.repeatOffenderCount && ai.confidence < th.repeatOffenderApproveMin) {
    escalate('review_required', 'repeat_check', 'repeat_offender');
  }

  return {
    status,
    reasonCode,
    confidence: ai.confidence,
    severity: ai.severity,
    adminReason: ai.adminReason,
    imageAssessment: ia || null,
    systemNotes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Per-user rate limiting & cooldown (pure — the caller persists the returned state in a transaction)
// ---------------------------------------------------------------------------------------------------------
const RATE = Object.freeze({
  WINDOW_MS: 10 * 60 * 1000,
  WINDOW_MAX: 20,          // up to 20 slides per 10 minutes (a full 10-slide post, twice)
  DAY_MAX: 80,             // per Bangladesh day
  COOLDOWN_REJECTIONS: 6,  // this many rejections within an hour …
  COOLDOWN_WINDOW_MS: 60 * 60 * 1000,
  COOLDOWN_MS: 60 * 60 * 1000, // … blocks new submissions for an hour
  MAX_AI_ATTEMPTS_PER_STORY: 5,
});

function emptyUserState() {
  return {
    counts: { approved: 0, rejected: 0, review_required: 0, pending: 0 },
    recentRejections: [],
    rl: { w10Start: 0, w10Count: 0, dayKey: '', dayCount: 0 },
    cooldownUntil: 0,
    lastSubmissionAt: 0,
  };
}

function normalizeUserState(s) {
  const base = emptyUserState();
  if (!s || typeof s !== 'object') return base;
  return {
    counts: Object.assign(base.counts, s.counts || {}),
    recentRejections: Array.isArray(s.recentRejections) ? s.recentRejections.filter(Number.isFinite).slice(-10) : [],
    rl: Object.assign(base.rl, s.rl || {}),
    cooldownUntil: Number(s.cooldownUntil) || 0,
    lastSubmissionAt: Number(s.lastSubmissionAt) || 0,
  };
}

// → { ok:true, state } | { ok:false, reason:'cooldown'|'burst'|'daily', retryAfterSec }
function consumeSubmissionQuota(prev, nowMs, rate) {
  const R = rate || RATE;
  const st = normalizeUserState(prev);
  if (st.cooldownUntil > nowMs) {
    return { ok: false, reason: 'cooldown', retryAfterSec: Math.ceil((st.cooldownUntil - nowMs) / 1000) };
  }
  if (!st.rl.w10Start || nowMs - st.rl.w10Start >= R.WINDOW_MS) { st.rl.w10Start = nowMs; st.rl.w10Count = 0; }
  const dayKey = dhakaDayKey(nowMs);
  if (st.rl.dayKey !== dayKey) { st.rl.dayKey = dayKey; st.rl.dayCount = 0; }

  if (st.rl.w10Count >= R.WINDOW_MAX) {
    return { ok: false, reason: 'burst', retryAfterSec: Math.max(1, Math.ceil((st.rl.w10Start + R.WINDOW_MS - nowMs) / 1000)) };
  }
  if (st.rl.dayCount >= R.DAY_MAX) {
    return { ok: false, reason: 'daily', retryAfterSec: 3600 };
  }
  st.rl.w10Count += 1;
  st.rl.dayCount += 1;
  st.lastSubmissionAt = nowMs;
  return { ok: true, state: st };
}

// Applies a finished moderation outcome to the user's counters (and arms the cooldown after repeated rejections).
function recordOutcome(prev, status, nowMs, rate) {
  const R = rate || RATE;
  const st = normalizeUserState(prev);
  if (st.counts[status] != null) st.counts[status] += 1;
  if (status === 'rejected') {
    st.recentRejections.push(nowMs);
    st.recentRejections = st.recentRejections.slice(-10);
    const lastHour = st.recentRejections.filter((t) => nowMs - t < R.COOLDOWN_WINDOW_MS).length;
    if (lastHour >= R.COOLDOWN_REJECTIONS) st.cooldownUntil = nowMs + R.COOLDOWN_MS;
  }
  return st;
}

function recentRejectionCount(state, nowMs, windowMs) {
  const st = normalizeUserState(state);
  return st.recentRejections.filter((t) => nowMs - t < windowMs).length;
}

// ---------------------------------------------------------------------------------------------------------
// Messages. Users only ever see these fixed, respectful Bengali texts — never raw model output.
// ---------------------------------------------------------------------------------------------------------
const GUIDELINES = Object.freeze({
  sexual_content: { title: 'অশালীন বা যৌন কনটেন্ট', text: 'আপনার স্টোরিতে অশালীন বা যৌনতাপূর্ণ বিষয় পাওয়া গেছে। আমাদের কমিউনিটি নীতিমালা অনুযায়ী এমন কনটেন্ট প্রকাশ করা যায় না।' },
  nudity: { title: 'নগ্নতা বা অনুপযুক্ত ছবি', text: 'ছবিতে নগ্নতা বা অনুপযুক্ত দৃশ্য পাওয়া গেছে। এমন ছবি প্রকাশ করা যায় না।' },
  profanity_abuse: { title: 'অশ্লীল বা আপত্তিকর ভাষা', text: 'স্টোরিতে গালি বা আপত্তিকর ভাষা ব্যবহার করা হয়েছে। অনুগ্রহ করে ভদ্র ও শালীন ভাষা ব্যবহার করুন।' },
  harassment: { title: 'হয়রানি বা অপমান', text: 'স্টোরিতে কাউকে হয়রানি, হেয় বা অপমান করার মতো বিষয় রয়েছে।' },
  religious_insult: { title: 'ধর্মীয় অবমাননা', text: 'স্টোরিতে আল্লাহ, রাসূল ﷺ, কুরআন বা কোনো ধর্ম ও ধর্মীয় বিষয়কে অবমাননা বা কটাক্ষ করা হয়েছে বলে মনে হয়েছে।' },
  harmful_activity: { title: 'ক্ষতিকর বা নিষিদ্ধ কর্মকাণ্ড', text: 'স্টোরিতে সহিংসতা, প্রতারণা বা অন্য কোনো ক্ষতিকর ও নিষিদ্ধ কর্মকাণ্ডকে উৎসাহিত করা হয়েছে বলে মনে হয়েছে।' },
  violence_gore: { title: 'সহিংস বা বীভৎস দৃশ্য', text: 'ছবি বা লেখায় অতিরিক্ত সহিংস বা বীভৎস বিষয় রয়েছে।' },
  spam_scam: { title: 'স্প্যাম বা প্রতারণামূলক বিষয়', text: 'স্টোরিটি স্প্যাম, প্রতারণা বা সন্দেহজনক প্রচারণার মতো মনে হয়েছে।' },
  malicious_link: { title: 'সন্দেহজনক লিংক', text: 'স্টোরিতে সন্দেহজনক বা ক্ষতিকর লিংক রয়েছে।' },
  image_text_violation: { title: 'ছবির লেখায় আপত্তিকর বিষয়', text: 'ছবির ভেতরের লেখায় কমিউনিটি নীতিমালা-বিরোধী বিষয় পাওয়া গেছে।' },
  other_violation: { title: 'কমিউনিটি নীতিমালা লঙ্ঘন', text: 'স্টোরিটি আমাদের কমিউনিটি নীতিমালার সাথে সামঞ্জস্যপূর্ণ নয়।' },
  fabricated_religious_text: { title: 'ধর্মীয় উদ্ধৃতি যাচাই করা যায়নি', text: 'স্টোরির আয়াত বা হাদীসের উদ্ধৃতিটি নির্ভরযোগ্য সূত্রে যাচাই করা যায়নি। সঠিক সূত্রসহ আবার জমা দিতে পারেন।' },
  misleading_religious_claim: { title: 'বিভ্রান্তিকর ধর্মীয় বক্তব্য', text: 'স্টোরির ধর্মীয় বক্তব্যটি বিভ্রান্তিকর হতে পারে, তাই প্রকাশ করা যায়নি।' },
  false_attribution: { title: 'ভুল সূত্রে উদ্ধৃতি', text: 'আল্লাহ, রাসূল ﷺ বা আলেমদের নামে এমন কথা উল্লেখ আছে, যার নির্ভরযোগ্য সূত্র পাওয়া যায়নি।' },
  ambiguous_religious_content: { title: 'অস্পষ্ট ধর্মীয় বিষয়', text: 'স্টোরির ধর্মীয় বিষয়টি প্রকাশের জন্য যথেষ্ট স্পষ্ট ও নির্ভরযোগ্য মনে হয়নি।' },
  ai_safety_block: { title: 'অনুপযুক্ত কনটেন্ট', text: 'স্বয়ংক্রিয় নিরাপত্তা যাচাইয়ে স্টোরিটি অনুপযুক্ত হিসেবে চিহ্নিত হয়েছে।' },
  admin_decision: { title: 'অ্যাডমিনের সিদ্ধান্ত', text: 'অ্যাডমিন রিভিউ শেষে স্টোরিটি কমিউনিটি নীতিমালার সাথে সামঞ্জস্যপূর্ণ মনে হয়নি।' },
  removed_by_admin: { title: 'অ্যাডমিন কর্তৃক সরানো হয়েছে', text: 'পুনরায় যাচাইয়ের পর অ্যাডমিন স্টোরিটি সরিয়ে দিয়েছেন, কারণ এটি কমিউনিটি নীতিমালার সাথে সামঞ্জস্যপূর্ণ নয়।' },
});

const REVIEW_HINTS = Object.freeze({
  fabricated_religious_text: 'স্টোরিতে ধর্মীয় উদ্ধৃতি আছে, যেটি প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।',
  misleading_religious_claim: 'স্টোরিতে ধর্মীয় বক্তব্য আছে, যেটি প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।',
  false_attribution: 'স্টোরিতে ধর্মীয় উদ্ধৃতি আছে, যেটি প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।',
  ambiguous_religious_content: 'স্টোরির ধর্মীয় বিষয়টি প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।',
  link_review: 'স্টোরিতে লিংক থাকায় প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।',
  audio_unverified: 'অডিও থাকায় প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।',
});

// Short labels for the admin dashboard (admin-facing, may be more specific than the user-facing text).
const REASON_LABELS = Object.freeze({
  none: 'সমস্যা পাওয়া যায়নি',
  sexual_content: 'অশালীন/যৌন কনটেন্ট',
  nudity: 'নগ্নতা/অনুপযুক্ত ছবি',
  profanity_abuse: 'অশ্লীল/আপত্তিকর ভাষা',
  harassment: 'হয়রানি/অপমান',
  religious_insult: 'ধর্মীয় অবমাননা',
  harmful_activity: 'ক্ষতিকর/নিষিদ্ধ কর্মকাণ্ড',
  violence_gore: 'সহিংস/বীভৎস দৃশ্য',
  spam_scam: 'স্প্যাম/প্রতারণা',
  malicious_link: 'সন্দেহজনক লিংক',
  image_text_violation: 'ছবির লেখায় আপত্তিকর বিষয়',
  fabricated_religious_text: 'সম্ভাব্য বানোয়াট আয়াত/হাদীস',
  misleading_religious_claim: 'বিভ্রান্তিকর ধর্মীয় দাবি',
  false_attribution: 'ভুল সূত্র/অপবাদ আরোপ',
  ambiguous_religious_content: 'অস্পষ্ট/বিতর্কিত ধর্মীয় বিষয়',
  unclear_content: 'বিষয়বস্তু অস্পষ্ট',
  other_violation: 'নীতিমালা লঙ্ঘন',
  low_confidence: 'AI-এর আত্মবিশ্বাস কম',
  link_review: 'লিংক যাচাই প্রয়োজন',
  audio_unverified: 'অডিও যাচাই করা যায়নি',
  repeat_check: 'বারবার লঙ্ঘনকারী — অতিরিক্ত যাচাই',
  ai_unavailable: 'AI যাচাই ব্যর্থ/অনুপলব্ধ',
  ai_safety_block: 'AI সেফটি ফিল্টার ব্লক করেছে',
  admin_decision: 'অ্যাডমিনের সিদ্ধান্ত',
  removed_by_admin: 'প্রকাশের পর অ্যাডমিন সরিয়েছেন',
});

function reasonLabel(code) {
  return REASON_LABELS[code] || REASON_LABELS.other_violation;
}

// What the person who submitted the story is told. `rec` = a story_submissions document (or equivalent).
function publicResult(rec) {
  const status = rec.moderationStatus;
  const base = { status, submissionId: rec.id || null, statusId: rec.publishedStatusId || null };
  if (status === STATUS.APPROVED) {
    return Object.assign(base, {
      title: 'আপনার স্টোরি অনুমোদিত হয়েছে',
      message: 'আপনার স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।',
      guideline: null, retryable: false,
    });
  }
  if (status === STATUS.REJECTED) {
    const g = GUIDELINES[rec.reasonCode] || GUIDELINES.other_violation;
    return Object.assign(base, {
      title: 'আপনার স্টোরি অনুমোদিত হয়নি',
      message: `${g.text} আপনি স্টোরিটি সম্পাদনা করে আবার জমা দিতে পারেন।`,
      guideline: g.title, retryable: false,
    });
  }
  if (status === STATUS.REVIEW) {
    const hint = REVIEW_HINTS[rec.reasonCode] || 'স্টোরিটি প্রকাশের আগে অ্যাডমিনের যাচাই প্রয়োজন।';
    return Object.assign(base, {
      title: 'আপনার স্টোরি অ্যাডমিনের রিভিউয়ের অপেক্ষায় আছে',
      message: `আপনার স্টোরি অ্যাডমিনের রিভিউয়ের অপেক্ষায় আছে। ${hint} অনুমোদনের আগে এটি শুধু আপনার কাছেই থাকবে — অন্য কেউ দেখতে পাবে না।`,
      guideline: null, retryable: false,
    });
  }
  if (status === STATUS.PENDING) {
    return Object.assign(base, {
      title: 'এখন স্টোরি যাচাই করা যাচ্ছে না',
      message: 'এই মুহূর্তে স্টোরি যাচাই করা যাচ্ছে না, তাই এটি প্রকাশ করা হয়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।',
      guideline: null, retryable: true,
    });
  }
  return Object.assign(base, {
    title: 'স্টোরি যাচাই চলছে',
    message: 'আপনার স্টোরি যাচাই করা হচ্ছে। একটু অপেক্ষা করুন।',
    guideline: null, retryable: true,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Published document
// ---------------------------------------------------------------------------------------------------------
// The exact shape js/status.js has always read from `statuses` (+ a few server-set moderation fields).
function buildPublishedStatus(sub, now, moderatedBy) {
  const doc = {
    uid: sub.userId,
    name: sub.userName || 'ব্যবহারকারী',
    avatarColor: sub.avatarColor || '',
    avatarIcon: sub.avatarIcon || '',
    type: sub.type,
    createdAt: now,
    expiresAt: now + STORY_TTL_MS,
    viewCount: 0,
    reactCount: 0,
    moderationStatus: 'approved',
    moderatedAt: now,
    publishedAt: now,
    moderatedBy,
    submissionId: sub.id,
  };
  for (const k of ['text', 'bg', 'font', 'align', 'size', 'textColor', 'highlight',
    'imageData', 'audioData', 'audioDuration', 'audioPeaks', 'audioName']) {
    if (sub[k] !== undefined && sub[k] !== null) doc[k] = sub[k];
  }
  return doc;
}

module.exports = {
  POLICY_VERSION, STORY_TTL_MS, LIMITS, BG_ALLOWED, FONT_IDS, ALIGNS, STORY_TYPES,
  STATUS, ALL_STATUSES, AI_DECISIONS, SEVERITIES, NUDITY_LEVELS, VIOLENCE_LEVELS,
  AI_REASON_CODES, SYSTEM_REASON_CODES, CLEAR_VIOLATION_CODES, RELIGIOUS_REVIEW_CODES, ADMIN_REJECT_CODES,
  ValidationError, RATE, GUIDELINES, REVIEW_HINTS, REASON_LABELS,
  sha256Hex, submissionIdFor, isValidRequestId, isValidSubmissionId, dhakaDayKey,
  sanitizeText, normalizeForHash, parseDataUrl, sniffImageMime, sniffAudioKind,
  extractLinks, sanitizeStory, contentFingerprint, aiCacheKey,
  stripFences, validateAiResult, getThresholds, decide,
  emptyUserState, normalizeUserState, consumeSubmissionQuota, recordOutcome, recentRejectionCount,
  reasonLabel, publicResult, buildPublishedStatus,
};
