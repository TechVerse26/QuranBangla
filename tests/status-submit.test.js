'use strict';
// Tests the REAL submitStatus() / buildStoryPayload() source taken from js/status.js (and the real
// js/story-moderation.js module) inside a Node `vm` sandbox with a stubbed composer — covering the client-side rules:
//   * the browser no longer writes to Firestore at all
//   * published / queued-for-review slides leave the composer; rejected / unsent ones stay for editing
//   * the loop stops when it cannot continue (offline, AI down, rate limit)
//   * no identity / counter / timestamp fields are ever sent (the server owns them)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const statusSrc = fs.readFileSync(path.join(__dirname, '../js/status.js'), 'utf8');
const moderationSrc = fs.readFileSync(path.join(__dirname, '../js/story-moderation.js'), 'utf8');

function extractSubmitCode() {
  const a = statusSrc.indexOf('async function buildStoryPayload(s){');
  const b = statusSrc.indexOf('// ==================================================================\n// Full-screen story viewer');
  assert.ok(a > 0 && b > a, 'submitStatus block found in js/status.js');
  return statusSrc.slice(a, b);
}

function makeSandbox(slides, scripted) {
  const calls = { submit: [], results: [], toasts: [], draft: [], cleared: 0, rendered: 0, rowRefresh: 0, counter: 0, retry: 0, progress: [], progressHidden: 0 };
  const store = {};
  const els = {
    statusCompSend: { disabled: false, classList: { add() {}, remove() {} }, innerHTML: '' },
    statusCompCounter: { textContent: '' },
    statusComposerOverlay: { classList: { remove() { calls.overlayClosed = true; } } },
  };
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, Set, Map, Number, String, Error, Uint8Array,
    document: { getElementById: (id) => els[id] || null, body: { style: {}, appendChild() {} }, createElement: () => ({}), querySelector: () => null },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    state: { user: { uid: 'u1', name: 'Rahim' } },
    statusComposerState: { slides, activeIndex: 0, sending: false },
    STATUS_BG_SWATCHES: ['#2E6F5E', '#7A2E44'],
    STATUS_FONTS: [{ id: 'sans' }, { id: 'serif' }],
    statusRowFetchedAt: 123,
    toBn: (n) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]), // same helper the real page provides
    showToast: (m) => calls.toasts.push(m),
    finalizeActiveOverlayIfAny() {},
    renderSlideToImageDataUrl: async (s) => { if (s.explode) throw new Error('canvas failed'); return `data:image/jpeg;base64,${Buffer.from('IMG' + s.id).toString('base64')}`; },
    clamp: (n, lo, hi) => Math.min(hi, Math.max(lo, n)),
    clearComposerDraft() { calls.cleared++; },
    saveComposerDraft() { calls.draft.push(sandbox.statusComposerState.slides.map((s) => s.id)); },
    renderComposerStage() { calls.rendered++; },
    renderComposerCounter() { calls.counter++; },
    renderStatusRow() { calls.rowRefresh++; },
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(moderationSrc, sandbox, { filename: 'story-moderation.js' }); // the REAL module (no QR_PLATFORM → active)
  // replace only the network + the sheet; keep the real notes / watch-list logic
  const SM = sandbox.window.StoryModeration;
  SM.submit = async (payload, rid, opts) => { calls.submit.push({ payload, rid }); if (opts && opts.onPhase) { opts.onPhase('check'); opts.onPhase('ai'); } return scripted(payload, rid, calls.submit.length - 1); };
  SM.showResults = (items, handlers) => calls.results.push({ items, handlers });
  SM.progress = { show: (t) => calls.progress.push(t), hide: () => { calls.progressHidden++; } }; // the real DOM pill is covered by tests/ui
  vm.runInContext(extractSubmitCode() + '\nthis.__submitStatus = submitStatus; this.__buildStoryPayload = buildStoryPayload;', sandbox, { filename: 'status.js(excerpt)' });
  return { sandbox, calls, SM, submitStatus: sandbox.__submitStatus, buildStoryPayload: sandbox.__buildStoryPayload, store };
}

const slide = (id, extra) => Object.assign({ id, mode: 'text', textValue: `story ${id}`, bg: '#2E6F5E', fontIndex: 0, align: 'center', size: 26, textColor: '#ffffff', highlight: false, musicData: null }, extra || {});
const out = (status, extra) => Object.assign({ status, title: status, message: `${status} msg`, guideline: null, retryable: false, fatal: false, submissionId: null }, extra || {});

test('payload: only content is sent — never uid / name / avatar / timestamps / counters / moderation fields', async () => {
  const lib = 'data:audio/ogg;base64,T2dnUw==';
  const { buildStoryPayload } = makeSandbox([], () => out('approved'));
  const t = await buildStoryPayload(slide('a', { textValue: 'x'.repeat(900), fontIndex: 1, musicData: lib, musicDuration: 9000, musicPeaks: [0.1], musicName: 'নাশীদ', musicTrackId: 'shared:abc' }));
  assert.deepEqual(Object.keys(t).sort(), ['align', 'audioData', 'audioDuration', 'audioName', 'audioPeaks', 'bg', 'font', 'highlight', 'musicTrackId', 'size', 'text', 'textColor', 'type'].sort());
  assert.equal(t.text.length, 700); assert.equal(t.font, 'serif'); assert.equal(t.musicTrackId, 'shared:abc');
  const img = await buildStoryPayload(slide('b', { mode: 'image', imageRawDataUrl: 'raw' }));
  assert.deepEqual(Object.keys(img), ['type', 'imageData']);
  const v = await buildStoryPayload(slide('c', { mode: 'voice', voiceData: 'data:audio/webm;base64,AAAA', voiceDuration: 5000, voicePeaks: [0.5] }));
  assert.deepEqual(Object.keys(v).sort(), ['audioData', 'audioDuration', 'audioPeaks', 'bg', 'type']);
  for (const p of [t, img, v]) {
    for (const forbidden of ['uid', 'name', 'avatarColor', 'avatarIcon', 'createdAt', 'expiresAt', 'viewCount', 'reactCount', 'moderationStatus', 'publishedAt', 'approved']) {
      assert.ok(!(forbidden in p), `${forbidden} is never sent by the browser`);
    }
  }
  const noTrack = await buildStoryPayload(slide('d', { musicData: lib, musicDuration: 1000, musicTrackId: null }));
  assert.ok(!('musicTrackId' in JSON.parse(JSON.stringify(noTrack))), 'a custom (non-library) track carries no id');
});

test('all slides approved → composer closes, draft cleared, feed refreshed, one confirmation toast, no blocking sheet', async () => {
  const slides = [slide('1'), slide('2'), slide('3')];
  const { submitStatus, sandbox, calls } = makeSandbox(slides, (p, rid, i) => out('approved', { submissionId: 'sub' + i, message: 'আপনার স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।' }));
  await submitStatus();
  assert.equal(calls.submit.length, 3);
  assert.equal(sandbox.statusComposerState.slides.length, 0);
  assert.equal(calls.cleared, 1); assert.equal(calls.overlayClosed, true); assert.equal(calls.rowRefresh, 1);
  assert.deepEqual(calls.toasts, ['আপনার সব স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।']);
  assert.equal(calls.results.length, 0);
  assert.equal(sandbox.statusComposerState.sending, false);
  assert.equal(calls.progressHidden, 1, 'the progress pill is always hidden afterwards');
  // the exact wording the product asked for, with a slide counter when several slides are sent
  assert.deepEqual(calls.progress.slice(0, 3), ['১/৩ · আপনার স্টোরি যাচাই করা হচ্ছে...', '১/৩ · আপনার স্টোরি যাচাই করা হচ্ছে...', '১/৩ · AI মডারেশন চলছে...']);
  assert.equal(sandbox.document.getElementById('statusCompCounter').textContent, '৩/৩ · AI মডারেশন চলছে...');
});

test('single approved slide → the server\'s own confirmation message is shown as a toast', async () => {
  const { submitStatus, calls } = makeSandbox([slide('1')], () => out('approved', { message: 'আপনার স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।', submissionId: 's1' }));
  await submitStatus();
  assert.deepEqual(calls.toasts, ['আপনার স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।']);
});

test('mixed outcome: approved + review leave the composer, the rejected slide stays with a note and is selected for editing', async () => {
  const slides = [slide('ok'), slide('bad'), slide('wait')];
  const plan = { ok: out('approved', { submissionId: 'sA' }), bad: out('rejected', { guideline: 'ধর্মীয় অবমাননা', submissionId: 'sB' }), wait: out('review_required', { submissionId: 'sC' }) };
  const { submitStatus, sandbox, calls, store } = makeSandbox(slides, (p) => plan[p.text.replace('story ', '')]);
  store.qr_story_watch_v1 = JSON.stringify({ u1: [{ id: 'sA', at: Date.now() }] }); // sA was being watched; it is approved now
  await submitStatus();

  const remaining = sandbox.statusComposerState.slides;
  assert.equal(JSON.stringify(remaining.map((s) => s.id)), JSON.stringify(['bad']));
  assert.equal(remaining[0]._modNote.title, 'ধর্মীয় অবমাননা');
  assert.equal(sandbox.statusComposerState.activeIndex, 0);
  assert.equal(calls.cleared, 0, 'draft is kept because something is left to edit');
  assert.equal(JSON.stringify(calls.draft.at(-1)), JSON.stringify(['bad']), 'draft re-saved with only the remaining slide');
  assert.ok(calls.rendered >= 1);
  assert.equal(calls.rowRefresh, 1, 'feed refreshed because one story was published');
  assert.equal(calls.toasts.length, 0);
  assert.equal(sandbox.statusComposerState.sending, false);

  assert.equal(calls.results.length, 1);
  assert.equal(JSON.stringify(calls.results[0].items.map((i) => [i.index, i.out.status])), JSON.stringify([[0, 'approved'], [1, 'rejected'], [2, 'review_required']]));
  const watch = JSON.parse(store.qr_story_watch_v1).u1.map((w) => w.id);
  assert.equal(JSON.stringify(watch), JSON.stringify(['sC']), 'review-queued story is watched for a later decision; the approved one is not');

  calls.results[0].handlers.onEdit(1); // "edit and resubmit" jumps to the rejected slide
  assert.equal(sandbox.statusComposerState.activeIndex, 0);
});

test('AI outage on the first slide → the loop STOPS (no 10× timeouts), every slide stays, retry is offered', async () => {
  const slides = [slide('1'), slide('2'), slide('3')];
  const { submitStatus, sandbox, calls } = makeSandbox(slides, () => out('pending', { retryable: true, title: 'এখন স্টোরি যাচাই করা যাচ্ছে না' }));
  await submitStatus();
  assert.equal(calls.submit.length, 1, 'only the first slide was attempted');
  assert.equal(sandbox.statusComposerState.slides.length, 3, 'nothing is lost');
  assert.equal(calls.results[0].items.length, 1);
  assert.equal(typeof calls.results[0].handlers.onRetry, 'function');
  assert.equal(calls.rowRefresh, 0);
});

test('offline in the middle: slides already published are removed, the failed one and the untouched ones remain', async () => {
  const slides = [slide('1'), slide('2'), slide('3')];
  const { submitStatus, sandbox, calls } = makeSandbox(slides, (p, rid, i) => (i === 0 ? out('approved', { submissionId: 'x' }) : out('error', { retryable: true, fatal: true })));
  await submitStatus();
  assert.equal(JSON.stringify(sandbox.statusComposerState.slides.map((s) => s.id)), JSON.stringify(['2', '3']));
  assert.equal(calls.submit.length, 2);
  assert.equal(calls.rowRefresh, 1);
});

test('a slide that cannot even be prepared (e.g. canvas error) does not block the others', async () => {
  const slides = [slide('1', { mode: 'image', imageRawDataUrl: 'r', explode: true }), slide('2')];
  const { submitStatus, sandbox, calls } = makeSandbox(slides, () => out('approved', { submissionId: 's2' }));
  await submitStatus();
  assert.equal(calls.submit.length, 1, 'only slide 2 reached the network');
  assert.equal(JSON.stringify(sandbox.statusComposerState.slides.map((s) => s.id)), JSON.stringify(['1']), 'the broken slide stays for the user to fix');
  assert.equal(calls.results[0].items[0].out.status, 'error');
});

test('duplicate-submit guard: a second tap while sending is ignored; same content keeps the same request id', async () => {
  const slides = [slide('1')];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { submitStatus, sandbox, calls } = makeSandbox(slides, async () => { await gate; return out('approved', { submissionId: 's' }); });
  const first = submitStatus();
  await new Promise((r) => setImmediate(r));
  assert.equal(sandbox.statusComposerState.sending, true);
  await submitStatus(); // second tap
  assert.equal(calls.submit.length, 1, 'ignored');
  release(); await first;
  assert.equal(calls.submit.length, 1);

  // retry of an unchanged slide re-uses the idempotency key (server de-duplicates); an edit gets a new one
  const s = slide('9');
  const SM = sandbox.window.StoryModeration;
  const id1 = SM.requestIdFor(s); const id2 = SM.requestIdFor(s); s.textValue = 'edited'; const id3 = SM.requestIdFor(s);
  assert.equal(id1, id2); assert.notEqual(id1, id3);
});

test('validation before sending: empty slide → toast, nothing sent; Android shell / missing module → refused politely', async () => {
  let r = makeSandbox([slide('1', { textValue: '   ' })], () => out('approved'));
  await r.submitStatus();
  assert.deepEqual(r.calls.toasts, ['কিছু লিখুন']); assert.equal(r.calls.submit.length, 0); assert.equal(r.sandbox.statusComposerState.sending, false);

  r = makeSandbox([slide('1', { mode: 'image', imageRawDataUrl: null })], () => out('approved'));
  await r.submitStatus(); assert.deepEqual(r.calls.toasts, ['একটি ছবি বাছুন']);

  r = makeSandbox([slide('1')], () => out('approved'));
  r.sandbox.window.StoryModeration = { disabled: true };
  await r.submitStatus();
  assert.match(r.calls.toasts[0], /শুধু ওয়েবসাইট/); assert.equal(r.calls.submit.length, 0);

  r = makeSandbox([slide('1')], () => out('approved'));
  r.sandbox.state.user = null;
  await r.submitStatus(); assert.equal(r.calls.submit.length, 0);
});

test('the browser contains NO direct Firestore write to the public feed any more', () => {
  const direct = statusSrc.match(/collection\('statuses'\)\s*\.\s*(add|set)\s*\(|collection\('statuses'\)\.doc\([^)]*\)\.set\(/g);
  assert.equal(direct, null, 'js/status.js never creates a `statuses` document');
  const all = fs.readdirSync(path.join(__dirname, '../js')).filter((f) => f.endsWith('.js'));
  for (const f of all) {
    const src = fs.readFileSync(path.join(__dirname, '../js', f), 'utf8');
    assert.ok(!/collection\('statuses'\)\s*\.\s*add\s*\(/.test(src), `${f} does not add to statuses`);
  }
});
