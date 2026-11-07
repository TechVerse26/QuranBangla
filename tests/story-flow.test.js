'use strict';
// End-to-end tests of POST /api/story-submit — the real handler, the real pipeline, the real policy code; only
// Firestore (in-memory fake) and Gemini (scripted fake fetch) are replaced.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-key';
delete process.env.STORY_SAFE_LINK_HOSTS;

const store = require('../api/_story-firebase.js');
const policy = require('../api/_story-policy.js');
const submit = require('../api/story-submit.js');
const { makeFakeFirebase, mockReqRes } = require('./helpers/fake-firebase.js');
const fx = require('./helpers/fixtures.js');

function setup() {
  const env = makeFakeFirebase();
  store.setFirebaseForTests(env.fb);
  env.addUser('alice', { uid: 'alice', name: 'Alice' });
  env.addUser('bob', { uid: 'bob', name: 'Bob' });
  env.db.seed('users/alice', { name: 'Alice Rahman', avatarColor: '#3D4F8A', avatarIcon: 'moon', status: 'active' });
  env.db.seed('users/bob', { name: 'Bob', status: 'active' });
  return env;
}

async function post(handler, token, body, method) {
  const { req, res } = mockReqRes({ method: method || 'POST', headers: token ? fx.bearer(token) : {}, body });
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const send = (token, story, requestId) => post(submit, token, fx.submitBody(story, requestId));

// Gemini that always answers with the given verdict (image stories get a clean image assessment unless overridden).
function aiSays(v) {
  return ({ body }) => {
    const hasImg = body.contents[0].parts.length > 1;
    const merged = Object.assign({}, v);
    if (hasImg && !merged.imageAssessment) merged.imageAssessment = fx.imageOk;
    return fx.geminiOk(fx.verdict(merged));
  };
}

const statusDocs = (env) => env.db.all('statuses');
// dashboard counters are sharded — add the shards of today up
const statsToday = (env) => env.db.all('story_stats').reduce((acc, d) => { for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && k !== 'shard') acc[k] = (acc[k] || 0) + v; return acc; }, {});
const submissions = (env) => env.db.all('story_submissions');

// ================================================================================================ 1-2. approved
test('1. a normal, acceptable Islamic story is approved and published automatically', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.98 }));
  try {
    const r = await send('alice', fx.textStory('আল্লাহ আমাদের সবাইকে হেদায়াত দান করুন। আমিন।'));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'approved');
    assert.equal(r.body.message, 'আপনার স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।');

    const pub = statusDocs(env);
    assert.equal(pub.length, 1, 'exactly one public status');
    const s = pub[0];
    assert.equal(s.id, r.body.submissionId, 'public id = submission id (1:1, idempotent)');
    assert.equal(s.uid, 'alice');
    assert.equal(s.name, 'Alice', 'name comes from the verified token, not the browser');
    assert.equal(s.avatarColor, '#3D4F8A'); assert.equal(s.avatarIcon, 'moon');
    assert.equal(s.type, 'text'); assert.equal(s.text, 'আল্লাহ আমাদের সবাইকে হেদায়াত দান করুন। আমিন।');
    assert.equal(s.viewCount, 0); assert.equal(s.reactCount, 0);
    assert.equal(s.expiresAt - s.createdAt, 24 * 60 * 60 * 1000, '24h life starts at publication');
    assert.equal(s.moderationStatus, 'approved'); assert.equal(s.moderatedBy, 'ai');

    const rec = env.db.read(`story_submissions/${r.body.submissionId}`);
    assert.equal(rec.moderationStatus, 'approved');
    assert.equal(rec.publishedStatusId, r.body.submissionId);
    assert.equal(rec.moderationSource, 'ai');
    assert.ok(rec.publishedAt && rec.moderatedAt);
    assert.equal(rec.processingToken, undefined, 'lock cleared');

    const logs = env.db.all('story_moderation_log');
    assert.equal(logs.length, 1); assert.equal(logs[0].event, 'ai_decision'); assert.equal(logs[0].status, 'approved');
    const day = statsToday(env);
    assert.equal(day.submitted, 1); assert.equal(day.ai_calls, 1); assert.equal(day.auto_approved, 1);
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
});

test('2. educational Quran & Hadith content is approved — and the AI is explicitly told not to flag religious vocabulary', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.95, religiousContent: true }));
  try {
    const r = await send('alice', fx.textStory('إِنَّ مَعَ الْعُسْرِ يُسْرًا — নিশ্চয়ই কষ্টের সাথেই স্বস্তি আছে। (সূরা আল-ইনশিরাহ ৯৪:৬)  জিহাদুন নফস বা আত্মসংযমের গুরুত্ব নিয়ে একটি হাদীস স্মরণ করি।'));
    assert.equal(r.body.status, 'approved');
    assert.equal(statusDocs(env).length, 1);
    const sys = g.calls[0].body.system_instruction.parts[0].text;
    assert.match(sys, /Do NOT reject or flag content merely because it contains words such as Allah, Quran, Hadith, Jihad/);
    assert.match(sys, /not an Islamic scholar/);
    assert.equal(env.db.read(`story_submissions/${r.body.submissionId}`).religiousContent, true);
  } finally { g.restore(); }
});

// ================================================================================================ 3-4. rejected
test('3. explicitly inappropriate content is rejected, never published, with a respectful guideline message', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'sexual_content', confidence: 0.97, severity: 'high', adminReason: 'স্পষ্ট যৌন কনটেন্ট।' }));
  try {
    const r = await send('alice', fx.textStory('(explicit sexual text)'));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'rejected');
    assert.equal(r.body.title, 'আপনার স্টোরি অনুমোদিত হয়নি');
    assert.equal(r.body.guideline, policy.GUIDELINES.sexual_content.title);
    assert.match(r.body.message, /আবার জমা দিতে পারেন/);
    assert.equal(statusDocs(env).length, 0, 'nothing public');
    const rec = env.db.read(`story_submissions/${r.body.submissionId}`);
    assert.equal(rec.moderationStatus, 'rejected');
    assert.equal(rec.reasonCode, 'sexual_content');
    assert.equal(rec.moderationReason, 'স্পষ্ট যৌন কনটেন্ট।', 'decision + reason saved for administrators');
    assert.ok(!JSON.stringify(r.body).includes('স্পষ্ট যৌন কনটেন্ট'), 'raw AI reasoning is not shown to the user');
    assert.equal(env.db.read('story_user_state/alice').counts.rejected, 1);
  } finally { g.restore(); }
});

test('4. religious insults are rejected', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'religious_insult', confidence: 0.94, severity: 'high' }));
  try {
    const r = await send('alice', fx.textStory('(insult)'));
    assert.equal(r.body.status, 'rejected');
    assert.equal(r.body.guideline, 'ধর্মীয় অবমাননা');
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
});

// ================================================================================================ 5-6. human review
test('5. a fabricated religious quotation is held for human review — even if the AI "rejects" it — and is NOT published', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'fabricated_religious_text', confidence: 0.99, severity: 'high', religiousContent: true, adminReason: 'আয়াতটি কুরআনে পাওয়া যায়নি।' }));
  try {
    const r = await send('alice', fx.textStory('আল্লাহ বলেছেন: "(বানোয়াট আয়াত)"'));
    assert.equal(r.body.status, 'review_required');
    assert.match(r.body.message, /অ্যাডমিনের রিভিউয়ের অপেক্ষায়/);
    assert.match(r.body.message, /ধর্মীয় উদ্ধৃতি/);
    assert.equal(statusDocs(env).length, 0, 'kept private');
    const rec = env.db.read(`story_submissions/${r.body.submissionId}`);
    assert.equal(rec.moderationStatus, 'review_required');
    assert.equal(rec.reasonCode, 'fabricated_religious_text');
    assert.equal(rec.text, 'আল্লাহ বলেছেন: "(বানোয়াট আয়াত)"', 'content retained for the administrator');
  } finally { g.restore(); }
});

test('6. ambiguous religious discussion goes to the admin queue; a low-confidence approval does too', async () => {
  const env = setup();
  let g = fx.installFakeGemini(aiSays({ decision: 'REVIEW_REQUIRED', reasonCode: 'ambiguous_religious_content', confidence: 0.55, religiousContent: true }));
  try {
    const r = await send('alice', fx.textStory('(বিতর্কিত ব্যাখ্যা)'));
    assert.equal(r.body.status, 'review_required');
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
  g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.6 }));
  try {
    const r = await send('alice', fx.textStory('(অনিশ্চিত)'));
    assert.equal(r.body.status, 'review_required');
    assert.equal(env.db.read(`story_submissions/${r.body.submissionId}`).reasonCode, 'low_confidence');
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
});

// ================================================================================================ 7. images
test('7a. an inappropriate image is rejected before publication; the image went to the AI; the blocked image is not kept', async () => {
  const env = setup();
  const img = fx.jpegDataUrl(2000, 'nsfw');
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'nudity', confidence: 0.96, severity: 'high', imageAssessment: Object.assign({}, fx.imageOk, { nudity: 'explicit' }) }));
  try {
    const r = await send('alice', fx.imageStory(img));
    assert.equal(r.body.status, 'rejected');
    assert.equal(r.body.guideline, policy.GUIDELINES.nudity.title);
    assert.equal(statusDocs(env).length, 0);
    const part = g.calls[0].body.contents[0].parts[1].inline_data;
    assert.equal(part.mime_type, 'image/jpeg');
    assert.equal(part.data, img.split(',')[1], 'the real image bytes were sent for analysis');
    const rec = env.db.read(`story_submissions/${r.body.submissionId}`);
    assert.equal(rec.imageData, undefined, 'rejected media is not retained');
    assert.equal(rec.imageNudity, 'explicit');
  } finally { g.restore(); }
});

test('7b. the server enforces image findings even when the AI headline says APPROVED', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.97, imageAssessment: Object.assign({}, fx.imageOk, { nudity: 'explicit' }) }));
  try {
    const r = await send('alice', fx.imageStory(fx.jpegDataUrl(1500, 'sneaky')));
    assert.equal(r.body.status, 'rejected');
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
});

test('7c. inappropriate text embedded in an image (OCR) → held for review with the image kept for the admin', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.9, imageAssessment: { nudity: 'none', violence: 'none', textFound: true, extractedText: 'call 01700-000000 win prize', textViolation: true } }));
  try {
    const r = await send('alice', fx.imageStory(fx.jpegDataUrl(1500, 'ocr')));
    assert.equal(r.body.status, 'review_required');
    const rec = env.db.read(`story_submissions/${r.body.submissionId}`);
    assert.equal(rec.reasonCode, 'image_text_violation');
    assert.equal(rec.extractedText, 'call 01700-000000 win prize');
    assert.ok(rec.imageData, 'kept so an administrator can decide');
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
});

test('7d. a clean image story is approved and the image reaches the public document', async () => {
  const env = setup();
  const img = fx.jpegDataUrl(1800, 'clean');
  const g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.98 }));
  try {
    const r = await send('alice', fx.imageStory(img, { text: 'মসজিদে নববী' }));
    assert.equal(r.body.status, 'approved');
    const pub = statusDocs(env)[0];
    assert.equal(pub.imageData, img); assert.equal(pub.type, 'image'); assert.equal(pub.text, 'মসজিদে নববী');
    assert.equal(env.db.read(`story_submissions/${r.body.submissionId}`).imageData, undefined, 'no second copy of the image');
  } finally { g.restore(); }
});

test('7e. upload validation is server-side: spoofed MIME / non-image bytes / oversize never reach the AI', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const bad = [
      fx.imageStory(fx.jpegDataUrl(300).replace('image/jpeg', 'image/png')),
      fx.imageStory(`data:image/jpeg;base64,${Buffer.from('MZ-this-is-an-exe-not-a-jpeg-file-at-all-padding-padding').toString('base64')}`),
      fx.imageStory(`data:image/jpeg;base64,${'A'.repeat(900001)}`),
      fx.imageStory('javascript:alert(1)'),
    ];
    for (const s of bad) {
      const r = await send('alice', s);
      assert.equal(r.status, 400, 'rejected with 400');
      assert.equal(r.body.error, 'invalid_story');
    }
    assert.equal(g.calls.length, 0, 'no AI call was spent');
    assert.equal(submissions(env).length, 0, 'nothing stored');
  } finally { g.restore(); }
});

test('7f. if the AI skips the image assessment the story is NOT published (safe fallback)', async () => {
  const env = setup();
  const g = fx.installFakeGemini(() => fx.geminiOk(fx.verdict({ decision: 'APPROVED' }))); // no imageAssessment
  try {
    const r = await send('alice', fx.imageStory(fx.jpegDataUrl(1500, 'noassess')));
    assert.equal(r.body.status, 'pending');
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
});

// ================================================================================================ 8. direct publication
test('8. a browser cannot mark its own story approved / published / reviewed — extra fields are ignored and moderation still decides', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'profanity_abuse', confidence: 0.95 }));
  try {
    const body = fx.submitBody(fx.textStory('(abusive)', { moderationStatus: 'approved', publishedAt: 1, reviewedBy: 'admin', uid: 'bob', userId: 'bob', published: true }));
    body.moderationStatus = 'approved'; body.status = 'approved'; body.userId = 'bob';
    const r = await post(submit, 'alice', body);
    assert.equal(r.body.status, 'rejected');
    assert.equal(statusDocs(env).length, 0);
    const rec = submissions(env)[0];
    assert.equal(rec.userId, 'alice', 'owner is the verified caller, never a client-supplied uid');
    assert.equal(rec.reviewedBy, undefined);
  } finally { g.restore(); }
});

test('8b. the name/avatar of a published story come from the server, never from the payload', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const story = fx.textStory('হ্যালো', { name: 'অ্যাডমিন (অফিসিয়াল)', avatarIcon: 'crown', avatarColor: 'red' });
    const r = await send('alice', story);
    assert.equal(r.body.status, 'approved');
    const s = statusDocs(env)[0];
    assert.equal(s.name, 'Alice'); assert.equal(s.avatarIcon, 'moon');
  } finally { g.restore(); }
});

// ================================================================================================ authn / authz / validation
test('auth: missing / invalid token → 401, blocked account → 403, wrong method → 405, nothing stored, no AI call', async () => {
  const env = setup();
  env.addUser('mallory', { uid: 'mallory', name: 'Mallory' });
  env.db.seed('users/mallory', { name: 'Mallory', status: 'blocked' });
  const g = fx.installFakeGemini(aiSays({}));
  try {
    assert.equal((await send(null, fx.textStory('x'))).status, 401);
    assert.equal((await send('forged-token', fx.textStory('x'))).status, 401);
    const blocked = await send('mallory', fx.textStory('x'));
    assert.equal(blocked.status, 403); assert.equal(blocked.body.error, 'account_blocked');
    assert.equal((await post(submit, 'alice', {}, 'GET')).status, 405);
    assert.equal((await post(submit, 'alice', { action: 'nuke', requestId: fx.newRequestId() })).status, 400);
    assert.equal(g.calls.length, 0);
    assert.equal(submissions(env).length, 0);
    assert.equal(statusDocs(env).length, 0);
  } finally { g.restore(); }
});

test('auth: a token passed in the body (like /api/ai-tafsir) works too', async () => {
  setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const body = Object.assign({ idToken: 'alice' }, fx.submitBody(fx.textStory('হ্যালো')));
    const { req, res } = mockReqRes({ body });
    await submit(req, res);
    assert.equal(res.statusCode, 200);
  } finally { g.restore(); }
});

test('validation: bad requestId / bad story → 400 before anything is stored', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    assert.equal((await post(submit, 'alice', { requestId: 'short', story: fx.textStory('x') })).status, 400);
    assert.equal((await post(submit, 'alice', { requestId: fx.newRequestId(), story: { type: 'text', text: 'ক'.repeat(701) } })).status, 400);
    assert.equal((await post(submit, 'alice', { requestId: fx.newRequestId() })).status, 400);
    assert.equal(submissions(env).length, 0);
  } finally { g.restore(); }
});

test('Firebase not configured → 503, never a crash', async () => {
  store.setFirebaseForTests({ ok: false, error: new Error('FIREBASE_SERVICE_ACCOUNT env variable is missing') });
  const r = await send('alice', fx.textStory('x'));
  assert.equal(r.status, 503);
  setup();
});

// ================================================================================================ 10. Gemini failures
const FAILURES = {
  'HTTP 500 on every model': () => fx.geminiHttp(500, 'internal'),
  'quota exceeded (429)': () => fx.geminiHttp(429, 'RESOURCE_EXHAUSTED'),
  'invalid API key': () => fx.geminiHttp(400, 'API key not valid. Please pass a valid API key.'),
  'garbage instead of JSON': () => fx.geminiOk('Sorry, I cannot help with that.'),
  'JSON that violates the schema': () => fx.geminiOk({ decision: 'MAYBE', confidence: 5 }),
  'empty candidate list': () => ({ status: 200, json: { candidates: [] } }),
  'network error': () => new Error('fetch failed'),
};

for (const [name, handler] of Object.entries(FAILURES)) {
  test(`10. Gemini failure (${name}) → story is NOT published, kept in the safe pending state with a friendly retry message`, async () => {
    const env = setup();
    const g = fx.installFakeGemini(handler);
    try {
      const r = await send('alice', fx.textStory('একটি সাধারণ স্টোরি'));
      assert.equal(r.status, 200, 'the request itself succeeded');
      assert.equal(r.body.status, 'pending');
      assert.equal(r.body.retryable, true);
      assert.match(r.body.message, /কিছুক্ষণ পর আবার চেষ্টা করুন/);
      assert.equal(statusDocs(env).length, 0, 'unchecked content is never published');
      const rec = submissions(env)[0];
      assert.equal(rec.moderationStatus, 'pending');
      assert.equal(rec.aiState, 'failed');
      assert.ok(rec.aiError);
      assert.equal(rec.reasonCode, 'ai_unavailable');
      assert.equal(rec.text, 'একটি সাধারণ স্টোরি', 'kept for retry / admin');
      assert.equal(env.db.all('story_moderation_log')[0].event, 'ai_error');
      assert.equal(statsToday(env).ai_failed, 1);
    } finally { g.restore(); }
  });
}

test('10b. a hung Gemini call hits the hard timeout and also ends in pending (never hangs the function)', async () => {
  const env = setup();
  process.env.STORY_AI_TIMEOUT_MS = '40'; process.env.STORY_AI_BUDGET_MS = '160';
  const g = fx.installFakeGemini(() => new Promise(() => {}));
  try {
    const t0 = Date.now();
    const r = await send('alice', fx.textStory('timeout please'));
    assert.equal(r.body.status, 'pending');
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(statusDocs(env).length, 0);
    assert.equal(submissions(env)[0].aiError, 'timeout');
  } finally { g.restore(); delete process.env.STORY_AI_TIMEOUT_MS; delete process.env.STORY_AI_BUDGET_MS; }
});

test('10c. after an outage the SAME request can be retried: same record, now moderated, published exactly once', async () => {
  const env = setup();
  const requestId = fx.newRequestId();
  const story = fx.textStory('ঈদ মুবারক');
  let g = fx.installFakeGemini(() => fx.geminiHttp(503, 'unavailable'));
  let first;
  try { first = await send('alice', story, requestId); } finally { g.restore(); }
  assert.equal(first.body.status, 'pending');

  g = fx.installFakeGemini(aiSays({ decision: 'APPROVED' }));
  try {
    const second = await send('alice', story, requestId);
    assert.equal(second.body.status, 'approved');
    assert.equal(second.body.submissionId, first.body.submissionId, 'same record, no duplicate');
    assert.equal(submissions(env).length, 1);
    assert.equal(statusDocs(env).length, 1);
    assert.equal(submissions(env)[0].attempts, 2);
  } finally { g.restore(); }
});

test('10d. a provider-side hard block (PROHIBITED_CONTENT) is treated as a rejection, with nothing retained', async () => {
  const env = setup();
  const g = fx.installFakeGemini(() => fx.geminiBlocked('PROHIBITED_CONTENT'));
  try {
    const r = await send('alice', fx.imageStory(fx.jpegDataUrl(1200, 'blocked')));
    assert.equal(r.body.status, 'rejected');
    assert.equal(statusDocs(env).length, 0);
    assert.equal(submissions(env)[0].imageData, undefined);
    assert.equal(submissions(env)[0].reasonCode, 'ai_safety_block');
  } finally { g.restore(); }
});

test('10e. after 5 failed attempts the story stops retrying and waits for an administrator', async () => {
  const env = setup();
  const requestId = fx.newRequestId();
  const story = fx.textStory('retry forever?');
  const g = fx.installFakeGemini(() => fx.geminiHttp(500, 'down'));
  try {
    for (let i = 0; i < 5; i++) assert.equal((await send('alice', story, requestId)).body.status, 'pending');
    const callsBefore = g.calls.length;
    const sixth = await send('alice', story, requestId);
    assert.equal(sixth.body.status, 'pending');
    assert.equal(sixth.body.retryable, false);
    assert.match(sixth.body.message, /অ্যাডমিনের রিভিউয়ের জন্য রাখা হয়েছে/);
    assert.equal(g.calls.length, callsBefore, 'no further AI spend');
  } finally { g.restore(); }
});

// ================================================================================================ 11. duplicates
test('11a. the same request replayed returns the stored result — one AI call, one public story', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const requestId = fx.newRequestId();
    const story = fx.textStory('জুমার শুভেচ্ছা');
    const a = await send('alice', story, requestId);
    const b = await send('alice', story, requestId);
    const c = await send('alice', story, requestId);
    assert.deepEqual([a.body.status, b.body.status, c.body.status], ['approved', 'approved', 'approved']);
    assert.equal(g.calls.length, 1);
    assert.equal(statusDocs(env).length, 1);
    assert.equal(submissions(env).length, 1);
    assert.equal(env.db.read('story_user_state/alice').counts.approved, 1, 'counted once');
    assert.equal(env.db.read('story_user_state/alice').rl.w10Count, 1, 'replays do not burn the rate limit');
  } finally { g.restore(); }
});

test('11b. truly concurrent duplicates: only one is moderated/published, the other is told it is in progress (or replayed)', async () => {
  const env = setup();
  const g = fx.installFakeGemini(async () => { await new Promise((r) => setTimeout(r, 40)); return fx.geminiOk(fx.verdict({})); });
  try {
    const requestId = fx.newRequestId();
    const story = fx.textStory('একই সময়ে দুইবার');
    const [a, b] = await Promise.all([send('alice', story, requestId), send('alice', story, requestId)]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 409), `got ${statuses}`);
    assert.equal(g.calls.length, 1, 'one AI call');
    assert.equal(statusDocs(env).length, 1, 'one public story');
    assert.equal(submissions(env).length, 1);
  } finally { g.restore(); }
});

test('11c. unchanged content is not moderated again: a new submission with identical content reuses the cached AI verdict', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'harassment', confidence: 0.95 }));
  try {
    const story = fx.textStory('(same abusive text)');
    const a = await send('alice', story);
    const b = await send('alice', story); // brand-new requestId, identical content
    assert.equal(a.body.status, 'rejected'); assert.equal(b.body.status, 'rejected');
    assert.equal(g.calls.length, 1, 'second check was served from the cache');
    assert.equal(env.db.all('story_ai_cache').length, 1);
    assert.equal(statsToday(env).ai_cache_hits, 1);
    // …and a different user posting the same text benefits too
    const c = await send('bob', story);
    assert.equal(c.body.status, 'rejected');
    assert.equal(g.calls.length, 1);
    // while an EDITED text is moderated afresh
    await send('alice', fx.textStory('(edited text)'));
    assert.equal(g.calls.length, 2);
  } finally { g.restore(); }
});

test('11d. the same requestId with DIFFERENT content is refused (409) and changes nothing', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'harassment', confidence: 0.95 }));
  try {
    const requestId = fx.newRequestId();
    const a = await send('alice', fx.textStory('first text'), requestId);
    assert.equal(a.body.status, 'rejected');
    const b = await send('alice', fx.textStory('a totally different text'), requestId);
    assert.equal(b.status, 409); assert.equal(b.body.error, 'request_conflict');
    assert.equal(submissions(env).length, 1);
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
});

test('11e. a request id captured from another user cannot be replayed to read or hijack their record', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const requestId = fx.newRequestId();
    const story = fx.textStory('alice only');
    const a = await send('alice', story, requestId);
    const b = await send('bob', story, requestId); // bob replays alice's request id
    assert.notEqual(b.body.submissionId, a.body.submissionId, 'ids are namespaced by uid');
    assert.equal(submissions(env).length, 2);
  } finally { g.restore(); }
});

// ================================================================================================ 12. edit + resubmit
test('12. a rejected story can be edited and resubmitted; the old record stays as history', async () => {
  const env = setup();
  let g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'profanity_abuse', confidence: 0.96 }));
  let first;
  try { first = await send('alice', fx.textStory('(bad words)')); } finally { g.restore(); }
  assert.equal(first.body.status, 'rejected');

  g = fx.installFakeGemini(aiSays({ decision: 'APPROVED' }));
  try {
    const second = await send('alice', fx.textStory('(polite rewrite)')); // new content → new requestId
    assert.equal(second.body.status, 'approved');
    assert.equal(statusDocs(env).length, 1);
    assert.equal(statusDocs(env)[0].text, '(polite rewrite)');
    assert.equal(submissions(env).length, 2);
    assert.equal(env.db.read(`story_submissions/${first.body.submissionId}`).moderationStatus, 'rejected');
    const st = env.db.read('story_user_state/alice');
    assert.equal(st.counts.rejected, 1); assert.equal(st.counts.approved, 1);
  } finally { g.restore(); }
});

// ================================================================================================ visibility invariant
test('only approved stories ever become publicly visible (mixed batch)', async () => {
  const env = setup();
  const plan = [
    ['APPROVED', 'none', 0.97], ['REJECTED', 'sexual_content', 0.97], ['REVIEW_REQUIRED', 'ambiguous_religious_content', 0.6],
    ['APPROVED', 'none', 0.97], ['REJECTED', 'fabricated_religious_text', 0.99], ['APPROVED', 'none', 0.4],
  ];
  let i = 0;
  const g = fx.installFakeGemini(() => { const [d, c, conf] = plan[i++]; return fx.geminiOk(fx.verdict({ decision: d, reasonCode: c, confidence: conf })); });
  try {
    for (let n = 0; n < plan.length; n++) await send('alice', fx.textStory(`story #${n}`));
    const pub = statusDocs(env);
    assert.equal(pub.length, 2);
    assert.ok(pub.every((p) => p.moderationStatus === 'approved'));
    const subs = submissions(env);
    assert.equal(subs.filter((s) => s.moderationStatus === 'approved').length, 2);
    assert.equal(subs.filter((s) => s.moderationStatus === 'rejected').length, 1);
    assert.equal(subs.filter((s) => s.moderationStatus === 'review_required').length, 3);
    for (const p of pub) assert.equal(env.db.read(`story_submissions/${p.id}`).moderationStatus, 'approved', 'every public story has an approved moderation record');
  } finally { g.restore(); }
});

// ================================================================================================ audio / links
test('voice stories can never be auto-published: straight to admin review, with NO AI call', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const r = await send('alice', { type: 'voice', bg: '#2E6F5E', audioData: fx.audioDataUrl('webm', 'voice1'), audioDuration: 9000, audioPeaks: [0.2, 0.5] });
    assert.equal(r.body.status, 'review_required');
    assert.match(r.body.message, /অডিও/);
    assert.equal(g.calls.length, 0);
    assert.equal(statusDocs(env).length, 0);
    const rec = submissions(env)[0];
    assert.equal(rec.reasonCode, 'audio_unverified'); assert.equal(rec.aiState, 'skipped');
    assert.ok(rec.audioData, 'recording kept so the admin can listen');
  } finally { g.restore(); }
});

test('background music: library tracks (byte-identical to sharedMusic) are trusted; custom audio is held for review', async () => {
  const env = setup();
  const lib = fx.audioDataUrl('ogg', 'library-track');
  env.db.seed('sharedMusic/track1', { title: 'নাশীদ ১', audioData: lib, duration: 12000 });
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const trusted = await send('alice', fx.textStory('সুন্দর দিন', { audioData: lib, audioDuration: 12000, musicTrackId: 'shared:track1' }));
    assert.equal(trusted.body.status, 'approved');
    assert.equal(statusDocs(env)[0].audioData, lib, 'music is published with the story');

    const custom = await send('alice', fx.textStory('নিজের মিউজিক', { audioData: fx.audioDataUrl('webm', 'mine'), audioDuration: 9000 }));
    assert.equal(custom.body.status, 'review_required');

    const spoof = await send('alice', fx.textStory('জাল দাবি', { audioData: fx.audioDataUrl('webm', 'spoofed'), audioDuration: 9000, musicTrackId: 'shared:track1' }));
    assert.equal(spoof.body.status, 'review_required', 'claiming a library id is not enough — bytes must match');
    assert.equal(statusDocs(env).length, 1);
  } finally { g.restore(); }
});

test('a text story that is only trusted library music (no text, no image) is approved without an AI call', async () => {
  const env = setup();
  const lib = fx.audioDataUrl('ogg', 'lib2');
  env.db.seed('sharedMusic/t2', { title: 'x', audioData: lib });
  const g = fx.installFakeGemini(aiSays({}));
  try {
    const r = await send('alice', { type: 'text', text: '', bg: '#2E6F5E', audioData: lib, audioDuration: 8000, musicTrackId: 'shared:t2' });
    assert.equal(r.body.status, 'approved');
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); }
});

test('links: unknown hosts are held for review even if the AI approves; whitelisted hosts are fine', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'APPROVED', confidence: 0.99 }));
  try {
    const bad = await send('alice', fx.textStory('এই লিংকে ক্লিক করুন https://free-money.xyz/win'));
    assert.equal(bad.body.status, 'review_required');
    assert.equal(submissions(env).find((s) => s.id === bad.body.submissionId).reasonCode, 'link_review');
    const good = await send('alice', fx.textStory('পড়ুন https://quran.com/2/255'));
    assert.equal(good.body.status, 'approved');
    assert.ok(g.calls[0].body.contents[0].parts[0].text.includes('free-money.xyz'), 'AI is told which hosts the text links to');
  } finally { g.restore(); }
});

// ================================================================================================ rate limiting / abuse
test('rate limit: the 21st story inside ten minutes gets 429 with Retry-After, and costs no AI call', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({}));
  try {
    for (let i = 0; i < policy.RATE.WINDOW_MAX; i++) assert.equal((await send('alice', fx.textStory(`msg ${i}`))).status, 200);
    const callsBefore = g.calls.length;
    const r = await send('alice', fx.textStory('one too many'));
    assert.equal(r.status, 429); assert.equal(r.body.error, 'rate_limited'); assert.equal(r.body.reason, 'burst');
    assert.ok(Number(r.headers['retry-after']) > 0);
    assert.equal(g.calls.length, callsBefore);
    // another user is unaffected
    assert.equal((await send('bob', fx.textStory('bob is fine'))).status, 200);
  } finally { g.restore(); }
});

test('abuse: repeated rejections trigger a cooldown', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'profanity_abuse', confidence: 0.97 }));
  try {
    for (let i = 0; i < policy.RATE.COOLDOWN_REJECTIONS; i++) assert.equal((await send('alice', fx.textStory(`bad ${i}`))).body.status, 'rejected');
    const r = await send('alice', fx.textStory('bad again'));
    assert.equal(r.status, 429); assert.equal(r.body.reason, 'cooldown');
  } finally { g.restore(); }
});

test('repeat offenders: a borderline approval after several rejections is escalated to a human', async () => {
  const env = setup();
  let call = 0;
  const g = fx.installFakeGemini(() => {
    call += 1;
    return call <= 3 ? fx.geminiOk(fx.verdict({ decision: 'REJECTED', reasonCode: 'harassment', confidence: 0.95 })) : fx.geminiOk(fx.verdict({ decision: 'APPROVED', confidence: 0.82 }));
  });
  try {
    for (let i = 0; i < 3; i++) await send('alice', fx.textStory(`mean ${i}`));
    const r = await send('alice', fx.textStory('now polite'));
    assert.equal(r.body.status, 'review_required');
    assert.equal(env.db.read(`story_submissions/${r.body.submissionId}`).reasonCode, 'repeat_check');
  } finally { g.restore(); }
});

// ================================================================================================ robustness
test('a dead `processing` claim (crashed function) is taken over by the retry; a fresh one answers "in progress"', async () => {
  const env = setup();
  const requestId = fx.newRequestId();
  const story = fx.textStory('stuck story');
  const { story: clean } = policy.sanitizeStory(story, {});
  const id = policy.submissionIdFor('alice', requestId);
  const mk = (startedAgo) => ({
    userId: 'alice', userName: 'Alice', type: 'text', text: clean.text, bg: clean.bg, font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false,
    contentHash: policy.contentFingerprint(clean), moderationStatus: 'processing', processingToken: 'old', processingStartedAt: Date.now() - startedAgo, attempts: 1, aiState: 'none', createdAt: Date.now() - startedAgo,
  });
  const g = fx.installFakeGemini(aiSays({}));
  try {
    env.db.seed(`story_submissions/${id}`, mk(5_000));
    const fresh = await send('alice', story, requestId);
    assert.equal(fresh.status, 409); assert.equal(fresh.body.error, 'in_progress');
    env.db.seed(`story_submissions/${id}`, mk(5 * 60_000));
    const takeover = await send('alice', story, requestId);
    assert.equal(takeover.body.status, 'approved');
    assert.equal(statusDocs(env).length, 1);
  } finally { g.restore(); }
});

test('if an administrator decides a story while the AI is still working, the AI result does not overwrite it (lock lost)', async () => {
  const env = setup();
  const g = fx.installFakeGemini(async () => {
    // simulate a take-over while Gemini is "thinking": another worker re-claims the record
    const rec = submissions(env)[0];
    env.db.seed(`story_submissions/${rec.id}`, Object.assign({}, rec, { processingToken: 'someone-else' }));
    return fx.geminiOk(fx.verdict({}));
  });
  try {
    const r = await send('alice', fx.textStory('race me'));
    assert.equal(r.status, 409); assert.equal(r.body.error, 'in_progress');
    assert.equal(statusDocs(env).length, 0, 'the stale worker published nothing');
  } finally { g.restore(); }
});

test('"mine" returns the caller\'s own submissions with safe fields only', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'spam_scam', confidence: 0.97, adminReason: 'INTERNAL-NOTE' }));
  try {
    await send('alice', fx.textStory('buy now!!!'));
    await send('bob', fx.textStory("bob's story"));
    const r = await post(submit, 'alice', { action: 'mine' });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    const it = r.body.items[0];
    assert.equal(it.status, 'rejected'); assert.equal(it.guideline, policy.GUIDELINES.spam_scam.title);
    const dump = JSON.stringify(r.body);
    assert.ok(!dump.includes('INTERNAL-NOTE') && !dump.includes('aiModel') && !dump.includes('confidence'));
    assert.equal((await post(submit, null, { action: 'mine' })).status, 401);
  } finally { g.restore(); }
});

test('"purge" (account deletion): content and personal fields go, undecided stories vanish, other users are untouched', async () => {
  const env = setup();
  let g = fx.installFakeGemini(aiSays({}));
  let a1, rev, rej;
  try {
    a1 = await send('alice', fx.textStory('a1 — approved story'));
    await send('bob', fx.textStory('b1'));
  } finally { g.restore(); }
  g = fx.installFakeGemini(aiSays({ decision: 'REVIEW_REQUIRED', reasonCode: 'ambiguous_religious_content', confidence: 0.5 }));
  try { rev = await send('alice', fx.imageStory(fx.jpegDataUrl(1500, 'purge-review'))); } finally { g.restore(); }
  g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'harassment', confidence: 0.95, adminReason: 'internal explanation' }));
  try { rej = await send('alice', fx.textStory('a3 — rejected story')); } finally { g.restore(); }
  assert.equal(rev.body.status, 'review_required'); assert.equal(rej.body.status, 'rejected');

  const r = await post(submit, 'alice', { action: 'purge' });
  assert.equal(r.status, 200); assert.equal(r.body.deleted, 1); assert.equal(r.body.anonymized, 2);

  assert.equal(env.db.has(`story_submissions/${rev.body.submissionId}`), false, 'the undecided (review_required) submission is deleted entirely');
  for (const id of [a1.body.submissionId, rej.body.submissionId]) {
    const rec = env.db.read(`story_submissions/${id}`);
    assert.ok(rec, 'decided records keep their non-content metadata');
    assert.equal(rec.userPurged, true);
    for (const f of ['text', 'imageData', 'audioData', 'userName', 'avatarColor', 'avatarIcon', 'moderationReason', 'adminNote', 'extractedText']) assert.equal(rec[f], undefined, `${f} was erased`);
    assert.ok(rec.moderationStatus && rec.contentHash && rec.createdAt, 'status / hash / timestamps remain');
  }
  assert.equal(env.db.all('story_submissions').filter((x) => x.userId === 'bob')[0].text, 'b1', 'other users are untouched');
  assert.equal((await post(submit, null, { action: 'purge' })).status, 401);
});

test('"purge" can NOT be used to escape a cooldown or wipe one\'s violation history', async () => {
  const env = setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'profanity_abuse', confidence: 0.97 }));
  try {
    for (let i = 0; i < policy.RATE.COOLDOWN_REJECTIONS; i++) await send('alice', fx.textStory(`bad ${i}`));
    assert.equal((await send('alice', fx.textStory('still blocked'))).status, 429);
    const before = env.db.read('story_user_state/alice');
    assert.ok(before.cooldownUntil > Date.now());

    assert.equal((await post(submit, 'alice', { action: 'purge' })).status, 200);

    assert.deepEqual(env.db.read('story_user_state/alice'), before, 'rate-limit + rejection history are kept');
    const again = await send('alice', fx.textStory('try again after purge'));
    assert.equal(again.status, 429); assert.equal(again.body.reason, 'cooldown', 'cooldown still applies');
    assert.equal(env.db.all('story_moderation_log').filter((l) => l.userId === 'alice').length, policy.RATE.COOLDOWN_REJECTIONS, 'audit log kept');
  } finally { g.restore(); }
});

test('secrets: the API key and the moderation prompt never appear in any response', async () => {
  setup();
  const g = fx.installFakeGemini(aiSays({ decision: 'REJECTED', reasonCode: 'harassment', confidence: 0.95 }));
  try {
    const dumps = [];
    dumps.push(JSON.stringify((await send('alice', fx.textStory('x1'))).body));
    dumps.push(JSON.stringify((await send('alice', { type: 'text' })).body));
    dumps.push(JSON.stringify((await send(null, fx.textStory('x2'))).body));
    for (const d of dumps) {
      assert.ok(!d.includes('test-key'));
      assert.ok(!d.includes('not an Islamic scholar'));
      assert.ok(!d.includes('SECURITY'));
    }
  } finally { g.restore(); }
});
