'use strict';
// Tests of POST /api/story-admin (moderation dashboard back-end) against in-memory Firestore + scripted Gemini.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-key';
delete process.env.STORY_SAFE_LINK_HOSTS;

const store = require('../api/_story-firebase.js');
const policy = require('../api/_story-policy.js');
const submit = require('../api/story-submit.js');
const adminApi = require('../api/story-admin.js');
const { makeFakeFirebase, mockReqRes } = require('./helpers/fake-firebase.js');
const fx = require('./helpers/fixtures.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const env = makeFakeFirebase();
  store.setFirebaseForTests(env.fb);
  for (const u of ['alice', 'bob', 'boss', 'eve', 'revoked-boss']) env.addUser(u, { uid: u, name: u[0].toUpperCase() + u.slice(1) });
  env.db.seed('users/alice', { name: 'Alice', status: 'active' });
  env.db.seed('users/bob', { name: 'Bob', status: 'active' });
  env.db.seed('users/boss', { name: 'প্রধান অ্যাডমিন', status: 'active' });
  env.db.seed('admins/boss', { isAdmin: true });
  env.db.seed('admins/eve', { isAdmin: false });
  env.db.seed('admins/revoked-boss', { isAdmin: true });
  return env;
}

async function post(handler, token, body, method) {
  const { req, res } = mockReqRes({ method: method || 'POST', headers: token ? fx.bearer(token) : {}, body });
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const send = (token, story) => post(submit, token, fx.submitBody(story));
const adm = (body, token) => post(adminApi, token === undefined ? 'boss' : token, body);

// Gemini scripted by markers inside the story text.
const mode = { failMe: true };
function scriptedGemini() {
  return fx.installFakeGemini(({ body }) => {
    const text = body.contents[0].parts[0].text;
    const hasImg = body.contents[0].parts.length > 1;
    const v = (o) => fx.geminiOk(fx.verdict(Object.assign({}, o, hasImg ? { imageAssessment: fx.imageOk } : {})));
    if (text.includes('FAIL-ME')) return mode.failMe ? fx.geminiHttp(503, 'unavailable') : v({});
    if (text.includes('REJECT-ME')) return v({ decision: 'REJECTED', reasonCode: 'harassment', confidence: 0.96, severity: 'high', adminReason: 'হয়রানিমূলক ভাষা।' });
    if (text.includes('REVIEW-ME')) return v({ decision: 'REVIEW_REQUIRED', reasonCode: 'fabricated_religious_text', confidence: 0.7, religiousContent: true, adminReason: 'উদ্ধৃতিটি যাচাই করা যায়নি।' });
    return v({});
  });
}

// alice: approved + rejected + pending(AI failed); bob: review_required (with an image)
async function seedScenario(env) {
  mode.failMe = true;
  const ids = {};
  const img = fx.jpegDataUrl(2500, 'review-image');
  let r = await send('alice', fx.textStory('APPROVE-ME সুন্দর একটি দিন')); ids.approved = r.body.submissionId; await sleep(4);
  r = await send('alice', fx.textStory('REJECT-ME নোংরা কথা')); ids.rejected = r.body.submissionId; await sleep(4);
  r = await send('alice', fx.textStory('FAIL-ME এআই বন্ধ থাকলে')); ids.pending = r.body.submissionId; await sleep(4);
  r = await send('bob', fx.imageStory(img, { text: 'REVIEW-ME আল্লাহ বলেছেন...' })); ids.review = r.body.submissionId; ids.reviewImage = img;
  assert.equal(env.db.read(`story_submissions/${ids.approved}`).moderationStatus, 'approved');
  assert.equal(env.db.read(`story_submissions/${ids.rejected}`).moderationStatus, 'rejected');
  assert.equal(env.db.read(`story_submissions/${ids.pending}`).moderationStatus, 'pending');
  assert.equal(env.db.read(`story_submissions/${ids.review}`).moderationStatus, 'review_required');
  return ids;
}

const statsToday = (env) => env.db.all('story_stats').reduce((acc, d) => { for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && k !== 'shard') acc[k] = (acc[k] || 0) + v; return acc; }, {});

const ACTIONS_NEEDING_ID = ['get', 'approve', 'reject', 'remove', 'remoderate'];

// ================================================================================================ 9. unauthorised admin actions
test('9. unauthorised admin actions: no token / normal user / non-admin record / revoked token are all refused and change NOTHING', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const snapshot = () => JSON.stringify([env.db.all('story_submissions'), env.db.all('statuses'), env.db.all('story_moderation_log'), env.db.all('story_user_state')]);
    const before = snapshot();
    const callsBefore = g.calls.length;

    const attempts = [
      { action: 'stats' }, { action: 'list', tab: 'all' }, { action: 'userHistory', userId: 'alice' },
      ...ACTIONS_NEEDING_ID.map((a) => ({ action: a, id: ids.review })),
      { action: 'approve', id: ids.review, isAdmin: true, adminUid: 'boss' }, // attempts to self-assert admin rights in the body
    ];
    const tokens = [
      [null, 401], ['not-a-token', 401], ['alice', 403], ['eve', 403], ['revoked-boss', 'revoked'],
    ];
    // mark one admin's token as revoked
    env.fb.admin.auth = () => ({
      verifyIdToken: async (token, checkRevoked) => {
        if (token === 'revoked-boss') { if (checkRevoked) throw new Error('auth/id-token-revoked'); return { uid: 'revoked-boss' }; }
        const known = { alice: 'alice', bob: 'bob', boss: 'boss', eve: 'eve' };
        if (!known[token]) throw new Error('bad token');
        return { uid: known[token], name: token };
      },
    });
    for (const body of attempts) {
      for (const [token, expect] of tokens) {
        const r = await post(adminApi, token, body);
        const want = expect === 'revoked' ? 401 : expect;
        assert.equal(r.status, want, `${body.action} with token=${token} → ${r.status}`);
        assert.deepEqual(Object.keys(r.body), ['error'], 'no data leaks in the refusal');
      }
    }
    assert.equal(snapshot(), before, 'database untouched');
    assert.equal(g.calls.length, callsBefore, 'no AI call triggered by unauthorised users');
    assert.equal(env.db.all('statuses').length, 1, 'only the originally approved story is public');
  } finally { g.restore(); }
});

test('admin: wrong method → 405; unknown action / bad ids → 400 (after authorisation)', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    assert.equal((await post(adminApi, 'boss', {}, 'GET')).status, 405);
    assert.equal((await adm({ action: 'launch-missiles' })).status, 400);
    assert.equal((await adm({ action: 'approve' })).status, 400);
    assert.equal((await adm({ action: 'approve', id: '../../admins/boss' })).status, 400);
    assert.equal((await adm({ action: 'approve', id: 'a'.repeat(32) })).status, 404);
    assert.equal((await adm({ action: 'list', tab: 'all', cursor: 'not-an-id' })).status, 400);
    assert.equal((await adm({ action: 'userHistory', userId: '../x' })).status, 400);
    assert.equal((await adm({ action: 'reject', id: 'a'.repeat(32), reasonCode: 'made_up' })).status, 400);
  } finally { g.restore(); }
});

// ================================================================================================ dashboard data
test('stats: totals, per-day AI activity and recently moderated stories', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const r = await adm({ action: 'stats' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.totals, { total: 4, approved: 1, rejected: 1, pendingReview: 2, pending: 1, reviewRequired: 1, processing: 0 });
    assert.equal(r.body.activity.length, 7);
    const today = r.body.activity[0];
    assert.equal(today.day, policy.dhakaDayKey(Date.now()));
    assert.equal(today.submitted, 4); assert.equal(today.ai_calls, 4); assert.equal(today.ai_failed, 1);
    assert.equal(today.auto_approved, 1); assert.equal(today.auto_rejected, 1); assert.equal(today.auto_review, 1);
    assert.equal(r.body.recent.length, 4);
    assert.ok(r.body.recent.every((it, i, a) => i === 0 || a[i - 1].moderatedAt >= it.moderatedAt), 'newest decision first');
    assert.ok(r.body.recent.every((it) => !('imageData' in it) && !('audioData' in it)), 'no media in list payloads');
    assert.ok(ids.pending);
  } finally { g.restore(); }
});

test('list: tabs, pagination, safe item shape, repeat-violation flag', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const tab = async (t, extra) => (await adm(Object.assign({ action: 'list', tab: t }, extra || {}))).body;

    const all = await tab('all');
    assert.equal(all.items.length, 4);
    assert.ok(all.items.every((it, i, a) => i === 0 || a[i - 1].createdAt >= it.createdAt), 'newest first');
    assert.deepEqual((await tab('approved')).items.map((i) => i.id), [ids.approved]);
    assert.deepEqual((await tab('rejected')).items.map((i) => i.id), [ids.rejected]);
    const pending = await tab('pending');
    assert.deepEqual(pending.items.map((i) => i.id).sort(), [ids.pending, ids.review].sort(), 'pending tab = AI-failed + awaiting review');

    // pagination without overlap or gaps
    const p1 = await tab('all', { limit: 3 });
    assert.equal(p1.items.length, 3); assert.equal(p1.hasMore, true);
    const p2 = await tab('all', { limit: 3, cursor: p1.nextCursor });
    assert.equal(p2.items.length, 1); assert.equal(p2.hasMore, false);
    assert.deepEqual([...p1.items, ...p2.items].map((i) => i.id), all.items.map((i) => i.id));

    const rejected = (await tab('rejected')).items[0];
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reasonCode, 'harassment');
    assert.equal(rejected.reasonLabel, policy.reasonLabel('harassment'));
    assert.equal(rejected.aiReason, 'হয়রানিমূলক ভাষা।');
    assert.equal(rejected.confidence, 0.96);
    assert.equal(rejected.userName, 'Alice');
    assert.equal(rejected.userStats.rejected, 1);
    assert.equal(rejected.userStats.repeat, false);
    assert.ok(rejected.text.includes('REJECT-ME'), 'full story text is visible to the admin');
    const review = (await tab('pending')).items.find((i) => i.id === ids.review);
    assert.equal(review.hasImage, true); assert.equal(review.reasonCode, 'fabricated_religious_text'); assert.equal(review.religiousContent, true);
    const failed = (await tab('pending')).items.find((i) => i.id === ids.pending);
    assert.equal(failed.aiState, 'failed'); assert.ok(failed.aiError);

    // repeat violations are surfaced
    env.db.seed('story_user_state/alice', Object.assign(policy.emptyUserState(), { counts: { approved: 1, rejected: 4, review_required: 0, pending: 0 }, recentRejections: [Date.now() - 1000, Date.now() - 2000, Date.now() - 3000, Date.now() - 4000] }));
    const again = (await tab('rejected')).items[0];
    assert.equal(again.userStats.repeat, true);
    assert.equal(again.userStats.recentRejections30d, 4);
    const hist = (await adm({ action: 'userHistory', userId: 'alice' })).body;
    assert.equal(hist.stats.repeat, true); assert.equal(hist.items.length, 3); assert.equal(hist.userName, 'Alice');
  } finally { g.restore(); }
});

test('get: complete story incl. media, AI decision, history, previous records — media of published stories comes from the public copy', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const rev = (await adm({ action: 'get', id: ids.review })).body;
    assert.equal(rev.item.status, 'review_required');
    assert.equal(rev.media.imageData, ids.reviewImage, 'administrator sees the whole image');
    assert.ok(rev.item.text.includes('আল্লাহ বলেছেন'));
    assert.equal(rev.history.length, 1); assert.equal(rev.history[0].event, 'ai_decision'); assert.equal(rev.history[0].by, 'ai');
    assert.equal(rev.history[0].status, 'review_required');

    const app = (await adm({ action: 'get', id: ids.approved })).body;
    assert.equal(app.live, true);
    assert.equal(app.previous.length, 2, 'alice\'s other records');
    env.db.seed(`statuses/${ids.approved}`, undefined); env.db._store.delete(`statuses/${ids.approved}`); // the user deleted their own story
    assert.equal((await adm({ action: 'get', id: ids.approved })).body.live, false);
    assert.equal((await adm({ action: 'get', id: 'f'.repeat(32) })).status, 404);
  } finally { g.restore(); }
});

// ================================================================================================ approve / reject / remove
test('approve a review_required story → published, media moved to the public doc, fully audited', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const r = await adm({ action: 'approve', id: ids.review, note: 'সূরা যাচাই করেছি — সঠিক।' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.status, 'approved');
    assert.equal(r.body.item.reviewedBy, 'boss'); assert.equal(r.body.item.reviewedByName, 'প্রধান অ্যাডমিন');
    assert.equal(r.body.item.priorStatus, 'review_required'); assert.equal(r.body.item.priorReasonCode, 'fabricated_religious_text');
    assert.equal(r.body.item.source, 'admin');

    const pub = env.db.read(`statuses/${ids.review}`);
    assert.ok(pub, 'now public');
    assert.equal(pub.uid, 'bob'); assert.equal(pub.imageData, ids.reviewImage); assert.equal(pub.moderatedBy, 'admin');
    assert.equal(pub.expiresAt - pub.createdAt, 24 * 3600 * 1000, 'the 24h life starts when it is approved, not when it was submitted');
    const rec = env.db.read(`story_submissions/${ids.review}`);
    assert.equal(rec.imageData, undefined); assert.equal(rec.moderationStatus, 'approved'); assert.equal(rec.adminNote, 'সূরা যাচাই করেছি — সঠিক।');
    const logs = env.db.all('story_moderation_log').filter((l) => l.submissionId === ids.review);
    assert.deepEqual(logs.map((l) => l.event).sort(), ['admin_approve', 'ai_decision']);
    assert.equal(logs.find((l) => l.event === 'admin_approve').by, 'boss');
    assert.equal(statsToday(env).admin_approved, 1);
    assert.equal(env.db.read('story_user_state/bob').counts.approved, 1);

    // cannot approve twice, cannot approve a rejected story
    const again = await adm({ action: 'approve', id: ids.review });
    assert.equal(again.status, 409); assert.equal(again.body.error, 'bad_state'); assert.equal(again.body.current, 'approved');
    assert.equal((await adm({ action: 'approve', id: ids.rejected })).status, 409);
    assert.equal(env.db.all('statuses').filter((s) => s.id === ids.review).length, 1, 'published once');
    assert.equal(env.db.has(`statuses/${ids.rejected}`), false);
  } finally { g.restore(); }
});

test('approve works for an AI-failed (pending) story too', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const r = await adm({ action: 'approve', id: ids.pending });
    assert.equal(r.body.item.status, 'approved');
    assert.ok(env.db.has(`statuses/${ids.pending}`));
    assert.equal(env.db.read(`story_submissions/${ids.pending}`).aiState, 'failed', 'history of the AI failure is preserved');
  } finally { g.restore(); }
});

test('reject a pending story → blocked, media deleted, reason + note stored, the author is told respectfully', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const bad = await adm({ action: 'reject', id: ids.review, reasonCode: 'not-a-code' });
    assert.equal(bad.status, 400);

    const r = await adm({ action: 'reject', id: ids.review, reasonCode: 'fabricated_religious_text', note: 'আয়াতটি কুরআনে নেই' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.status, 'rejected'); assert.equal(r.body.item.reasonCode, 'fabricated_religious_text');
    assert.equal(r.body.item.adminNote, 'আয়াতটি কুরআনে নেই');
    const rec = env.db.read(`story_submissions/${ids.review}`);
    assert.equal(rec.imageData, undefined, 'blocked media is deleted');
    assert.equal(env.db.has(`statuses/${ids.review}`), false);
    assert.equal(env.db.read('story_user_state/bob').counts.rejected, 1);
    assert.equal(statsToday(env).admin_rejected, 1);

    // default reason + what the author sees
    const r2 = await adm({ action: 'reject', id: ids.pending });
    assert.equal(r2.body.item.reasonCode, 'admin_decision');
    const mine = (await post(submit, 'alice', { action: 'mine' })).body.items.find((i) => i.id === ids.pending);
    assert.equal(mine.status, 'rejected'); assert.equal(mine.guideline, policy.GUIDELINES.admin_decision.title);
    assert.equal((await adm({ action: 'reject', id: ids.approved })).status, 409, 'an already published story is removed, not rejected');
  } finally { g.restore(); }
});

test('remove an already published story → public copy + its views/reactions are deleted; the record becomes rejected', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    env.db.seed(`statuses/${ids.approved}/views/bob`, { viewedAt: 1 });
    env.db.seed(`statuses/${ids.approved}/reactions/bob`, { emoji: '❤' });
    const r = await adm({ action: 'remove', id: ids.approved, note: 'পুনর্যাচাইয়ে সমস্যা পাওয়া গেছে' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.status, 'rejected'); assert.equal(r.body.item.removedAfterPublish, true);
    assert.equal(r.body.item.reasonCode, 'removed_by_admin'); assert.equal(r.body.item.priorStatus, 'approved');
    assert.equal(env.db.has(`statuses/${ids.approved}`), false, 'gone from the public feed');
    assert.equal(env.db.has(`statuses/${ids.approved}/views/bob`), false);
    assert.equal(env.db.has(`statuses/${ids.approved}/reactions/bob`), false);
    assert.equal(env.db.read('story_user_state/alice').counts.rejected, 2, 'a removal counts as a violation');
    assert.equal(statsToday(env).admin_removed, 1);
    assert.ok(env.db.all('story_moderation_log').some((l) => l.event === 'admin_remove' && l.by === 'boss'));
    assert.equal((await adm({ action: 'remove', id: ids.approved })).status, 409, 'cannot remove twice');
    assert.equal((await adm({ action: 'remove', id: ids.review })).status, 409, 'only published stories can be removed');
    const totals = (await adm({ action: 'stats' })).body.totals;
    assert.equal(totals.approved, 0); assert.equal(totals.rejected, 2);
  } finally { g.restore(); }
});

test('remoderate: an administrator can send an AI-failed story back to the AI once it is available again', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    // AI still down → stays pending, attempt recorded
    let r = await adm({ action: 'remoderate', id: ids.pending });
    assert.equal(r.status, 200); assert.equal(r.body.item.status, 'pending'); assert.equal(r.body.item.attempts, 2);
    assert.equal(env.db.has(`statuses/${ids.pending}`), false);

    mode.failMe = false; // Gemini is back
    r = await adm({ action: 'remoderate', id: ids.pending });
    assert.equal(r.body.item.status, 'approved'); assert.equal(r.body.item.attempts, 3);
    assert.ok(env.db.has(`statuses/${ids.pending}`));
    const events = env.db.all('story_moderation_log').filter((l) => l.submissionId === ids.pending).map((l) => l.event);
    assert.ok(events.includes('admin_recheck') && events.includes('ai_decision') && events.includes('ai_error'));

    assert.equal((await adm({ action: 'remoderate', id: ids.review })).status, 409, 'only AI-failed stories can be re-checked');
    assert.equal((await adm({ action: 'remoderate', id: ids.pending })).status, 409, 'not twice');
  } finally { g.restore(); }
});

test('a story stuck in `processing` (crashed worker) can be decided by an administrator once the claim is stale', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const mk = (age) => ({
      userId: 'alice', userName: 'Alice', type: 'text', text: 'stuck', bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false,
      moderationStatus: 'processing', processingToken: 't', processingStartedAt: Date.now() - age, attempts: 1, createdAt: Date.now() - age, contentHash: 'x',
    });
    const fresh = 'a'.repeat(32); const stale = 'b'.repeat(32);
    env.db.seed(`story_submissions/${fresh}`, mk(3_000));
    env.db.seed(`story_submissions/${stale}`, mk(10 * 60_000));
    assert.equal((await adm({ action: 'approve', id: fresh })).status, 409, 'a live claim is not stolen');
    const ok = await adm({ action: 'approve', id: stale });
    assert.equal(ok.status, 200); assert.equal(ok.body.item.status, 'approved');
    const list = (await adm({ action: 'list', tab: 'pending' })).body.items;
    assert.ok(list.find((i) => i.id === fresh && i.status === 'processing' && i.stale === false));
  } finally { g.restore(); }
});

test('a missing Firestore composite index is reported clearly (with the console link) instead of a crash — and `get` still works', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    const indexErr = () => Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/demo/firestore/indexes?create_composite=abc123'), { code: 9 });
    env.db.queryHook = (kind, path, st) => {
      if (kind === 'query' && st && st.filters.length && st.orders.length) throw indexErr();
    };
    const r = await adm({ action: 'list', tab: 'approved' });
    assert.equal(r.status, 503); assert.equal(r.body.error, 'index_required');
    assert.match(r.body.indexUrl, /^https:\/\/console\.firebase\.google\.com\/.*create_composite=abc123$/);

    // `get` degrades gracefully when only the "previous records" query needs the index
    env.db.queryHook = (kind, path, st) => { if (kind === 'query' && st && st.filters.some((f) => f.f === 'userId') && st.orders.length) throw indexErr(); };
    const g2 = await adm({ action: 'get', id: ids.review });
    assert.equal(g2.status, 200); assert.equal(g2.body.previousWarning, 'index_required'); assert.deepEqual(g2.body.previous, []);
    assert.ok(g2.body.indexUrl);
    env.db.queryHook = null;
  } finally { g.restore(); }
});

test('admin responses never contain secrets or the moderation prompt', async () => {
  const env = setup();
  const g = scriptedGemini();
  try {
    const ids = await seedScenario(env);
    for (const body of [{ action: 'stats' }, { action: 'list', tab: 'all' }, { action: 'get', id: ids.review }]) {
      const d = JSON.stringify((await adm(body)).body);
      assert.ok(!d.includes('test-key') && !d.includes('SECURITY') && !d.includes('processingToken'));
    }
  } finally { g.restore(); }
});
