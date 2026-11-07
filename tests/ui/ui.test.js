'use strict';
// Real-browser (Chromium) tests of the client side of the Story moderation feature, wired end to end to the REAL
// server handlers (in-memory Firestore + scripted Gemini). Skipped automatically when Playwright is not installed.
//
//   npm run test:ui            (needs `playwright` + a Chromium build; set PLAYWRIGHT_MODULE=/path/to/playwright if it is global)
//
// Screenshots (mobile / desktop / dark theme) are written to $UI_SHOTS_DIR (default /tmp/ui-shots).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch (e) { /* optional */ }
const SKIP = pw ? false : 'Playwright is not installed (set PLAYWRIGHT_MODULE or run npm i --no-save playwright)';

const fx = require('../helpers/fixtures.js');
const { startServer } = require('./server.js');

let sharp = null;
try { sharp = require(process.env.SHARP_MODULE || 'sharp'); } catch (e) { /* optional: only used to make a decodable test picture */ }
async function makeImage() {
  if (sharp) {
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2E6F5E"/><stop offset="1" stop-color="#123B2C"/></linearGradient></defs><rect width="360" height="240" fill="url(#g)"/><circle cx="270" cy="70" r="34" fill="#E8D6A8"/><text x="24" y="190" font-size="30" fill="#fff" font-family="sans-serif">Sample Story Image</text></svg>';
      const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 72 }).toBuffer();
      return 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (e) { /* fall through */ }
  }
  return fx.jpegDataUrl(2500, 'ui-review-image');
}

const SHOTS = process.env.UI_SHOTS_DIR || '/tmp/ui-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bn = (n) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);

// Gemini scripted by markers inside the story text (same idea as the admin tests)
const mode = { failMe: true };
function scripted() {
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

test('browser: client UI + admin dashboard against the real server code', { skip: SKIP, timeout: 180000 }, async (t) => {
  const server = await startServer();
  const env = server.env;
  const gemini = scripted();
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'bn-BD', deviceScaleFactor: 2 });
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort()); // no external fonts / CDNs
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) problems.push('console: ' + m.text()); });
  await page.goto(server.url + '/harness');
  const imgUrl = await makeImage();

  const apiAs = (endpoint, token, body) => page.evaluate(async ({ endpoint, token, body }) => {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  }, { endpoint, token, body });
  const submitAs = (token, story) => apiAs('/api/story-submit', token, { action: 'submit', requestId: fx.newRequestId(), story });
  const textStory = (text) => ({ type: 'text', text, bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false });
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  // ============================================================================================ client: StoryModeration
  await t.test('rejected story → clear warning sheet with the violated guideline, edit/resubmit button, accessible dialog', async () => {
    const out = await page.evaluate(async () => {
      const SM = window.StoryModeration;
      const slide = { mode: 'text', textValue: 'REJECT-ME নোংরা কথা' };
      return SM.submit({ type: 'text', text: slide.textValue, bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false }, SM.requestIdFor(slide), {});
    });
    assert.equal(out.status, 'rejected');
    assert.equal(out.guideline, 'হয়রানি বা অপমান');
    assert.ok(!JSON.stringify(out).includes('হয়রানিমূলক ভাষা'), 'raw AI reasoning never reaches the browser');

    await page.evaluate((o) => { window.__edited = null; window.StoryModeration.showResults([{ index: 0, out: o }], { onEdit: (i) => { window.__edited = i; } }); }, out);
    const dlg = page.locator('.smod-sheet');
    await dlg.waitFor();
    assert.equal(await dlg.getAttribute('role'), 'dialog');
    assert.equal(await dlg.getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('.smod-title').innerText(), 'আপনার স্টোরি অনুমোদিত হয়নি');
    assert.match(await page.locator('.smod-msg').innerText(), /আবার জমা দিতে পারেন/);
    assert.equal(await page.locator('.smod-guideline-title').innerText(), 'হয়রানি বা অপমান');
    const primary = page.locator('.smod-btn-primary');
    assert.equal(await primary.innerText(), 'সম্পাদনা করে আবার জমা দিন');
    assert.ok(await primary.evaluate((b) => b === document.activeElement), 'focus moves into the dialog');
    await sleep(300); await shot('01-rejected-mobile');
    await primary.click();
    assert.equal(await page.evaluate(() => window.__edited), 0);
    assert.equal(await page.locator('.smod-sheet').count(), 0, 'sheet is gone');
  });

  await t.test('keyboard: Escape closes, Tab stays inside the dialog, focus returns to the opener', async () => {
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button id="opener">open</button>'); document.getElementById('opener').focus(); window.StoryModeration.showResults([{ index: 0, out: { status: 'rejected', title: 'T', message: 'M', guideline: 'G', retryable: false } }], { onEdit() {} }); });
    await page.locator('.smod-sheet').waitFor();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => !!document.activeElement.closest('.smod-sheet')), 'focus never leaves the dialog');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.smod-sheet').count(), 0);
    assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'opener'));
  });

  await t.test('pending-review story → "waiting for administrator", stays private (note + no edit button)', async () => {
    const out = await page.evaluate(async () => {
      const SM = window.StoryModeration; const slide = { mode: 'text', textValue: 'REVIEW-ME আল্লাহ বলেছেন...' };
      return SM.submit({ type: 'text', text: slide.textValue, bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false }, SM.requestIdFor(slide), {});
    });
    assert.equal(out.status, 'review_required');
    await page.evaluate((o) => window.StoryModeration.showResults([{ index: 0, out: o }], { onMine() {} }), out);
    await page.locator('.smod-sheet').waitFor();
    assert.equal(await page.locator('.smod-title').innerText(), 'আপনার স্টোরি অ্যাডমিনের রিভিউয়ের অপেক্ষায় আছে');
    assert.match(await page.locator('.smod-note').innerText(), /শুধু আপনার কাছে থাকবে/);
    assert.equal(await page.locator('.smod-btn-primary').innerText(), 'ঠিক আছে');
    assert.equal(await page.locator('.smod-link').count(), 1, 'link to "my recent stories"');
    await sleep(300); await shot('02-review-mobile');
    await page.locator('.smod-btn-primary').click();
  });

  await t.test('AI outage → friendly retry message, retry button re-runs the submit', async () => {
    mode.failMe = true;
    const out = await page.evaluate(async () => {
      const SM = window.StoryModeration; const slide = { mode: 'text', textValue: 'FAIL-ME এআই বন্ধ' };
      return SM.submit({ type: 'text', text: slide.textValue, bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false }, SM.requestIdFor(slide), {});
    });
    assert.equal(out.status, 'pending'); assert.equal(out.retryable, true);
    await page.evaluate((o) => { window.__retried = 0; window.StoryModeration.showResults([{ index: 0, out: o }], { onRetry: () => { window.__retried++; } }); }, out);
    await page.locator('.smod-sheet').waitFor();
    assert.match(await page.locator('.smod-msg').innerText(), /কিছুক্ষণ পর আবার চেষ্টা করুন/);
    assert.equal(await page.locator('.smod-btn-primary').innerText(), 'আবার চেষ্টা করুন');
    await page.locator('.smod-btn-primary').click();
    assert.equal(await page.evaluate(() => window.__retried), 1);
    assert.equal(env.db.all('statuses').length, 0, 'nothing published during the outage');
  });

  await t.test('several slides → summary + one row per slide', async () => {
    await page.evaluate(() => window.StoryModeration.showResults([
      { index: 0, out: { status: 'approved', title: 'ok', message: 'ok', guideline: null } },
      { index: 1, out: { status: 'rejected', title: 'r', message: 'r', guideline: 'ধর্মীয় অবমাননা', retryable: false } },
      { index: 2, out: { status: 'review_required', title: 'v', message: 'v', guideline: null } },
    ], { onEdit() {} }));
    await page.locator('.smod-sheet').waitFor();
    assert.equal(await page.locator('.smod-title').innerText(), '১টি প্রকাশিত · ১টি রিভিউয়ের অপেক্ষায় · ১টি অনুমোদিত হয়নি');
    assert.equal(await page.locator('.smod-item').count(), 3);
    assert.deepEqual(await page.locator('.smod-chip').allInnerTexts(), ['প্রকাশিত', 'অনুমোদিত হয়নি', 'রিভিউয়ের অপেক্ষায়']);
    await sleep(300); await shot('03-multi-mobile');
    await page.keyboard.press('Escape');
  });

  await t.test('progress pill shows the two required messages and is announced politely', async () => {
    await page.evaluate(() => { const SM = window.StoryModeration; SM.progress.show(SM.phaseText('check', 0, 1)); });
    const pill = page.locator('.smod-progress');
    await pill.waitFor();
    assert.equal(await pill.getAttribute('aria-live'), 'polite');
    assert.equal(await pill.locator('.smod-progress-text').innerText(), 'আপনার স্টোরি যাচাই করা হচ্ছে...');
    await page.evaluate(() => { const SM = window.StoryModeration; SM.progress.show(SM.phaseText('ai', 1, 3)); });
    assert.equal(await pill.locator('.smod-progress-text').innerText(), '২/৩ · AI মডারেশন চলছে...');
    await sleep(250); await shot('04-progress-mobile');
    await page.evaluate(() => window.StoryModeration.progress.hide());
    await sleep(250);
    assert.ok(!(await pill.evaluate((e) => e.classList.contains('show'))));
  });

  await t.test('network failure → fatal retryable error, nothing sent twice; 401 → token refreshed once; 409 in_progress → polled; 429 → wait message', async () => {
    // offline
    await ctx.route('**/api/story-submit', (r) => r.abort());
    let out = await page.evaluate(() => window.StoryModeration.submit({ type: 'text', text: 'hi', bg: '#2E6F5E' }, 'net-fail-request-id-0001', {}));
    assert.equal(out.status, 'error'); assert.equal(out.retryable, true); assert.equal(out.fatal, true);
    assert.match(out.message, /ইন্টারনেট সংযোগ/);
    await ctx.unroute('**/api/story-submit');

    // 401 once, then success: the client must refresh the ID token (force=true) and retry
    let hits = 0;
    await ctx.route('**/api/story-submit', (r) => { hits++; return hits === 1 ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }) : r.continue(); });
    await page.evaluate(() => { window.__tokenCalls.length = 0; });
    out = await page.evaluate(() => window.StoryModeration.submit({ type: 'text', text: 'আসসালামু আলাইকুম', bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false }, 'refresh-request-id-0002', {}));
    assert.equal(out.status, 'approved');
    assert.deepEqual(await page.evaluate(() => window.__tokenCalls), [false, true], 'second attempt force-refreshes the token');
    await ctx.unroute('**/api/story-submit');

    // 409 in_progress twice, then the real answer
    hits = 0;
    await ctx.route('**/api/story-submit', (r) => { hits++; return hits <= 2 ? r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"in_progress","retryAfterSec":0.05}' }) : r.continue(); });
    out = await page.evaluate(() => window.StoryModeration.submit({ type: 'text', text: 'জুমার শুভেচ্ছা', bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false }, 'poll-request-id-00003', {}));
    assert.equal(out.status, 'approved'); assert.equal(hits, 3);
    await ctx.unroute('**/api/story-submit');

    // 429
    await ctx.route('**/api/story-submit', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate_limited","reason":"burst","retryAfterSec":420}' }));
    out = await page.evaluate(() => window.StoryModeration.submit({ type: 'text', text: 'x', bg: '#2E6F5E' }, 'rate-request-id-00004', {}));
    assert.equal(out.status, 'rate_limited'); assert.equal(out.fatal, true);
    assert.match(out.message, /প্রায় ৭ মিনিট পর/);
    await ctx.unroute('**/api/story-submit');
  });

  await t.test('invalid upload (server-side validation) → clear message, not fatal for the other slides', async () => {
    const out = await page.evaluate(() => window.StoryModeration.submit({ type: 'image', imageData: 'data:image/jpeg;base64,AAAAAAAA' }, 'invalid-request-id-0005', {}));
    assert.equal(out.status, 'invalid'); assert.equal(out.fatal, false);
    assert.match(out.message, /ছবিটি গ্রহণযোগ্য নয়/);
  });

  await t.test('same slide content → same request id (retry is deduplicated); edited content → a new one', async () => {
    const r = await page.evaluate(() => {
      const SM = window.StoryModeration; const s = { mode: 'text', textValue: 'abc', bg: '#2E6F5E' };
      const a = SM.requestIdFor(s), b = SM.requestIdFor(s); s.textValue = 'abc edited'; const c = SM.requestIdFor(s);
      return { same: a === b, changed: a !== c, valid: /^[A-Za-z0-9_-]{16,64}$/.test(a) };
    });
    assert.deepEqual(r, { same: true, changed: true, valid: true });
  });

  await t.test('composer banner marks the slide that was not approved and can be dismissed', async () => {
    await page.evaluate(() => {
      window.__slide = {};
      window.StoryModeration.setSlideNote(window.__slide, { status: 'rejected', guideline: 'ধর্মীয় অবমাননা', title: 'x' });
      window.StoryModeration.renderSlideBanner();
    });
    const b = page.locator('#storyModBanner');
    await b.waitFor();
    assert.match(await b.innerText(), /এই স্লাইড অনুমোদিত হয়নি/);
    assert.match(await b.innerText(), /ধর্মীয় অবমাননা/);
    await shot('05-banner-mobile');
    await b.locator('.smod-banner-x').click();
    assert.equal(await page.locator('#storyModBanner').count(), 0);
  });

  await t.test('a decision that arrives later (admin approves/rejects) is shown once, then forgotten', async () => {
    const a = await submitAs('alice', textStory('REVIEW-ME কিছু উদ্ধৃতি আছে এখানে'));
    assert.equal(a.json.status, 'review_required');
    const id = a.json.submissionId;
    await page.evaluate((id) => { localStorage.clear(); window.StoryModeration.watchAdd('alice', [id]); }, id);
    // administrator rejects it
    const r = await apiAs('/api/story-admin', 'boss', { action: 'reject', id, reasonCode: 'fabricated_religious_text' });
    assert.equal(r.status, 200);
    // new page session → checkWatch runs once (2.5 s delay in the client)
    await page.reload();
    await page.evaluate(() => window.StoryModeration.checkWatch({ onApproved() {} }));
    await page.locator('.smod-sheet').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('.smod-chip').first().innerText(), 'অনুমোদিত হয়নি');
    assert.equal(await page.locator('.smod-item-sub').first().innerText(), 'ধর্মীয় উদ্ধৃতি যাচাই করা যায়নি');
    await sleep(300); await shot('06-later-decision-mobile');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qr_story_watch_v1')).alice.length), 0, 'forgotten after being shown');
    await page.keyboard.press('Escape');
  });

  // ============================================================================================ admin panel (real admin.js)
  await t.test('admin panel: moderation tab appears for a verified admin with the waiting-for-review badge', async () => {
    await page.reload();
    mode.failMe = true;
    // a realistic mix: approved, rejected, review (text), review (image), AI-failed
    await submitAs('alice', textStory('APPROVE-ME সুন্দর একটি দিন, আলহামদুলিল্লাহ'));
    await sleep(5);
    await submitAs('alice', textStory('REJECT-ME নোংরা কথা'));
    await sleep(5);
    await submitAs('bob', textStory('FAIL-ME এআই বন্ধ থাকলে এই স্টোরি পেন্ডিং থাকবে'));
    await sleep(5);
    const imgSub = await submitAs('bob', { type: 'image', imageData: imgUrl, text: 'REVIEW-ME ছবির সাথে একটি উদ্ধৃতি' });
    await sleep(5);
    await page.evaluate(() => { window.__token = 'boss'; AdminPanel.open(); });
    const tab = page.locator('#apTabStories');
    await tab.waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(() => !document.getElementById('apStoriesBadge').hidden, null, { timeout: 8000 });
    // pending review = AI-failed (1) + review_required: alice's earlier ones from the other subtests + this image one
    const totals = (await apiAs('/api/story-admin', 'boss', { action: 'stats' })).json.totals;
    assert.equal(await page.locator('#apStoriesBadge').innerText(), bn(totals.pendingReview));
    assert.ok(totals.pendingReview >= 3);
    t.imgSubmission = imgSub.json.submissionId;
  });

  await t.test('admin dashboard: stats cards, AI activity, recently moderated, four tabs, list cards', async () => {
    await page.locator('#apTabStories').click();
    await page.locator('#apPanelStories .apm-stat').first().waitFor();
    const totals = (await apiAs('/api/story-admin', 'boss', { action: 'stats' })).json.totals;
    const vals = await page.locator('#apPanelStories .apm-stat-val').allInnerTexts();
    assert.deepEqual(vals, [bn(totals.total), bn(totals.approved), bn(totals.rejected), bn(totals.pendingReview)]);
    assert.equal(await page.locator('#apmActivity details.apm-fold').count(), 1);
    assert.match(await page.locator('#apmActivity').innerText(), /AI মডারেশন কার্যক্রম/);
    assert.ok(await page.locator('#apmActivity .apm-bar').count() === 7, '7 days of activity');
    assert.ok(await page.locator('#apmRecent .apm-rrow').count() >= 3);
    // collapsed by default (the work queue comes first) …
    assert.equal(await page.locator('#apmActivity details').evaluate((d) => d.open), false);
    // … opens on demand and stays open across a refresh
    await page.locator('#apmActivity summary').click();
    await page.locator('#apmRecent summary').click();
    assert.ok(await page.locator('#apmActivity details').evaluate((d) => d.open));
    await page.locator('#apPanelStories .apm-head button').click();
    await page.waitForFunction(() => !document.querySelector('#apmList .apm-skel'));
    assert.ok(await page.locator('#apmActivity details').evaluate((d) => d.open), 'fold state survives re-render');
    // the queue is above the reference cards
    const order = await page.evaluate(() => ['apmStats', 'apmTabs', 'apmList', 'apmActivity', 'apmRecent'].map((id) => document.getElementById(id).getBoundingClientRect().top));
    assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'stats → tabs → queue → activity → recent');
    assert.deepEqual((await page.locator('#apmTabs .apm-tab').allInnerTexts()).map((s) => s.split('\n')[0]), ['রিভিউ বাকি', 'সব স্টোরি', 'অনুমোদিত', 'প্রত্যাখ্যাত']);
    assert.equal(await page.locator('#apmTabs .apm-tab[aria-selected="true"]').count(), 1);
    // default tab = pending review: only review_required / AI-failed cards, each with a decision path
    const cards = page.locator('#apmList .apm-story');
    await cards.first().waitFor();
    const n = await cards.count();
    assert.equal(n, totals.pendingReview);
    for (let i = 0; i < n; i++) {
      const chipText = await cards.nth(i).locator('.apm-chip').first().innerText();
      assert.ok(['রিভিউ প্রয়োজন', 'AI যাচাই বাকি'].includes(chipText), chipText);
    }
    await sleep(400); await shot('07-admin-dashboard-mobile');

    await page.locator('#apmTabs .apm-tab', { hasText: 'অনুমোদিত' }).click();
    await page.waitForFunction((c) => document.querySelectorAll('#apmList .apm-story').length === c, totals.approved);
    assert.ok(await page.locator('#apmList .apm-story .apm-chip', { hasText: 'অনুমোদিত' }).count() >= 1);
    await page.locator('#apmTabs .apm-tab', { hasText: 'প্রত্যাখ্যাত' }).click();
    await page.waitForFunction((c) => document.querySelectorAll('#apmList .apm-story').length === c, totals.rejected);
    const rej = page.locator('#apmList .apm-story').first();
    assert.match(await rej.innerText(), /হয়রানি\/অপমান/, 'reason is shown');
    assert.match(await rej.innerText(), /AI আত্মবিশ্বাস/, 'confidence is shown');
    await page.locator('#apmTabs .apm-tab', { hasText: 'সব স্টোরি' }).click();
    await page.waitForFunction((c) => document.querySelectorAll('#apmList .apm-story').length === Math.min(15, c), totals.total);
    await page.locator('#apmTabs .apm-tab', { hasText: 'রিভিউ বাকি' }).click();
    await page.waitForFunction((c) => document.querySelectorAll('#apmList .apm-story').length === c, totals.pendingReview);
  });

  await t.test('admin: quick-approve a text-only story → it is published; the lists + counters refresh', async () => {
    const card = page.locator('#apmList .apm-story', { hasText: 'FAIL-ME এআই বন্ধ থাকলে' });
    await card.waitFor();
    assert.match(await card.innerText(), /ত্রুটি:/, 'AI failure type is shown');
    const id = (await card.getAttribute('data-id'));
    assert.equal(env.db.has(`statuses/${id}`), false);
    const before = (await apiAs('/api/story-admin', 'boss', { action: 'stats' })).json.totals;
    await card.locator('.apm-btn-ok', { hasText: 'অনুমোদন' }).click();
    await page.waitForFunction((id) => !document.querySelector(`#apmList .apm-story[data-id="${id}"]`), id);
    assert.equal(env.db.has(`statuses/${id}`), true, 'published by the server');
    assert.equal(env.db.read(`story_submissions/${id}`).reviewedBy, 'boss');
    const after = (await apiAs('/api/story-admin', 'boss', { action: 'stats' })).json.totals;
    assert.equal(after.pendingReview, before.pendingReview - 1);
    assert.equal(after.approved, before.approved + 1);
    assert.equal(await page.locator('#apPanelStories .apm-stat-val').nth(3).innerText(), bn(after.pendingReview), 'card updated without a reload');
  });

  await t.test('admin: story with an image → must open the detail sheet; sees the full image, AI reasoning, history; rejects with a reason', async () => {
    const card = page.locator('#apmList .apm-story', { hasText: 'REVIEW-ME ছবির সাথে একটি উদ্ধৃতি' });
    await card.waitFor();
    assert.equal(await card.locator('.apm-btn-ok').count(), 0, 'no one-click approve for stories with media');
    await card.locator('.apm-btn-gold', { hasText: 'দেখুন ও সিদ্ধান্ত নিন' }).click();
    const sheet = page.locator('#apmSheet');
    await sheet.waitFor();
    assert.equal(await sheet.getAttribute('role'), 'dialog');
    const img = sheet.locator('img.apm-media');
    await img.waitFor();
    assert.equal(await img.getAttribute('src'), imgUrl, 'the administrator sees the complete image');
    assert.ok(await img.evaluate((i) => i.complete && i.naturalWidth > 0) || !sharp, 'the picture actually decodes and renders');
    const txt = await sheet.innerText();
    assert.match(txt, /উদ্ধৃতিটি যাচাই করা যায়নি/, "AI's explanation");
    assert.match(txt, /সম্ভাব্য বানোয়াট আয়াত\/হাদীস/, 'reason label');
    assert.match(txt, /মডারেশন ইতিহাস/);
    assert.match(txt, /AI সিদ্ধান্ত/);
    assert.match(txt, /ধর্মীয় বিষয়|এ পর্যন্ত/);
    await sleep(300); await shot('08-admin-detail-mobile');
    await sheet.locator('#apmReason').selectOption('fabricated_religious_text');
    await sheet.locator('#apmNote').fill('আয়াতের উদ্ধৃতি কুরআনে পাওয়া যায়নি');
    await sheet.locator('.apm-btn-bad', { hasText: 'প্রত্যাখ্যান করুন' }).click();
    await page.waitForFunction(() => !document.getElementById('apmSheet'));
    const rec = env.db.read(`story_submissions/${t.imgSubmission}`);
    assert.equal(rec.moderationStatus, 'rejected'); assert.equal(rec.reasonCode, 'fabricated_religious_text');
    assert.equal(rec.adminNote, 'আয়াতের উদ্ধৃতি কুরআনে পাওয়া যায়নি');
    assert.equal(rec.imageData, undefined, 'image deleted on rejection');
    assert.equal(env.db.has(`statuses/${t.imgSubmission}`), false);
  });

  await t.test('admin: remove an already published story (asks for confirmation) → gone from the public feed', async () => {
    await page.locator('#apmTabs .apm-tab', { hasText: 'অনুমোদিত' }).click();
    const card = page.locator('#apmList .apm-story', { hasText: 'APPROVE-ME সুন্দর একটি দিন' });
    await card.waitFor();
    const id = await card.getAttribute('data-id');
    assert.ok(env.db.has(`statuses/${id}`));
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); d.accept(); });
    await card.locator('.apm-btn-bad', { hasText: 'সরিয়ে ফেলুন' }).click();
    await page.waitForFunction((id) => !document.querySelector(`#apmList .apm-story[data-id="${id}"]`), id);
    assert.match(asked, /সরিয়ে ফেলবেন/);
    assert.equal(env.db.has(`statuses/${id}`), false, 'removed from the public collection');
    assert.equal(env.db.read(`story_submissions/${id}`).removedAfterPublish, true);
  });

  await t.test('admin: repeat violations are flagged on cards', async () => {
    for (let i = 0; i < 3; i++) await submitAs('alice', textStory(`REJECT-ME again ${i}`));
    await page.locator('#apmTabs .apm-tab', { hasText: 'প্রত্যাখ্যাত' }).click();
    await page.locator('#apPanelStories .apm-head button').click(); // refresh
    await page.locator('#apmList .apm-story', { hasText: 'REJECT-ME again' }).first().waitFor();
    assert.ok(await page.locator('#apmList .apm-badge-bad', { hasText: 'বারবার লঙ্ঘন' }).count() >= 1);
    await sleep(300); await shot('09-admin-rejected-mobile');
  });

  await t.test('admin: a non-admin token is refused by the server and the UI degrades gracefully (no crash)', async () => {
    await page.evaluate(() => { window.__token = 'alice'; });
    await page.locator('#apPanelStories .apm-head button').click();
    await page.waitForFunction(() => document.querySelector('#apmList .apm-err'), null, { timeout: 8000 });
    assert.match(await page.locator('#apmList .apm-err').innerText(), /অনুমতি নেই/);
    await page.evaluate(() => { window.__token = 'boss'; });
  });

  await t.test('desktop + dark theme screenshots render without layout errors', async () => {
    await page.evaluate(() => { window.__token = 'boss'; });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.locator('#apPanelStories .apm-head button').click();
    await page.locator('#apmTabs .apm-tab', { hasText: 'রিভিউ বাকি' }).click();
    await sleep(500); await shot('10-admin-desktop');
    await page.evaluate(() => { document.body.setAttribute('data-theme', 'night'); });
    await sleep(200); await shot('11-admin-desktop-night');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, 'no horizontal overflow');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { window.StoryModeration.showResults([{ index: 0, out: { status: 'rejected', title: 'আপনার স্টোরি অনুমোদিত হয়নি', message: 'স্টোরিতে গালি বা আপত্তিকর ভাষা ব্যবহার করা হয়েছে। অনুগ্রহ করে ভদ্র ও শালীন ভাষা ব্যবহার করুন। আপনি স্টোরিটি সম্পাদনা করে আবার জমা দিতে পারেন।', guideline: 'অশ্লীল বা আপত্তিকর ভাষা', retryable: false } }], { onEdit() {} }); });
    await sleep(400); await shot('12-rejected-night-mobile');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.body.setAttribute('data-theme', 'emerald'); });
  });

  await t.test('closing the admin panel stops the moderation tab and removes the detail sheet', async () => {
    await page.evaluate(() => AdminPanel.close());
    await sleep(400);
    assert.equal(await page.locator('#apmSheet').count(), 0);
  });

  assert.deepEqual(problems, [], 'no uncaught exceptions / console errors in the page');
  await browser.close();
  gemini.restore();
  await server.close();
});
