'use strict';
// Behavioural test of firestore.rules against the Firestore EMULATOR.
//
// It is skipped automatically unless both the optional package @firebase/rules-unit-testing is installed and the
// emulator is running (FIRESTORE_EMULATOR_HOST is set). Run it with:
//
//   npm i --no-save @firebase/rules-unit-testing
//   npx firebase-tools emulators:exec --only firestore --project demo-quranbangla \
//       "node --test tests/firestore-rules.emulator.test.js"
//
// (The text-level version of these guarantees, which needs no emulator, is tests/firestore-rules.static.test.js.)

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

let rut = null;
try { rut = require('@firebase/rules-unit-testing'); } catch (e) { /* optional */ }
const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST;
const SKIP = (!rut || !HOSTPORT) ? 'needs @firebase/rules-unit-testing and a running Firestore emulator (see header of this file)' : false;

test('firestore.rules on the emulator: story moderation cannot be bypassed from a browser', { skip: SKIP }, async (t) => {
  const [host, port] = HOSTPORT.split(':');
  const env = await rut.initializeTestEnvironment({
    projectId: 'demo-quranbangla',
    firestore: { host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8') },
  });
  const { assertFails, assertSucceeds } = rut;

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('admins/boss').set({ isAdmin: true });
    for (const id of ['s1', 's2']) {
      await db.doc(`statuses/${id}`).set({ uid: 'alice', name: 'Alice', type: 'text', text: 'hello', createdAt: 1, expiresAt: 9e12, viewCount: 0, reactCount: 0, moderationStatus: 'approved' });
    }
    await db.doc('story_submissions/x').set({ userId: 'alice', moderationStatus: 'review_required' });
    await db.doc('story_moderation_log/x').set({ submissionId: 'x' });
    await db.doc('story_user_state/alice').set({ counts: {} });
    await db.doc('story_ai_cache/x').set({ verdict: {} });
    await db.doc('story_stats/2026-11-03').set({ submitted: 1 });
  });

  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const boss = env.authenticatedContext('boss').firestore(); // a real administrator
  const anon = env.unauthenticatedContext().firestore();

  const payload = (uid, extra) => Object.assign({ uid, name: 'Alice', type: 'text', text: 'hi', createdAt: Date.now(), expiresAt: Date.now() + 864e5, viewCount: 0 }, extra || {});

  await t.test('nobody can create a public status from the browser — signed-in user, forged moderation fields, admin, anonymous', async () => {
    await assertFails(alice.doc('statuses/new1').set(payload('alice')));
    await assertFails(alice.doc('statuses/new2').set(payload('alice', { moderationStatus: 'approved', publishedAt: Date.now(), moderatedBy: 'ai' })));
    await assertFails(boss.doc('statuses/new3').set(payload('boss')));
    await assertFails(anon.doc('statuses/new4').set(payload('anon')));
    await assertFails(alice.collection('statuses').add(payload('alice')));
  });

  await t.test('signed-in users can still read the feed; anonymous cannot', async () => {
    await assertSucceeds(alice.doc('statuses/s1').get());
    await assertFails(anon.doc('statuses/s1').get());
  });

  await t.test('view counter still works (+1 only) but moderation fields and content are immutable for everyone', async () => {
    await assertSucceeds(bob.doc('statuses/s1').update({ viewCount: 1 }));
    await assertFails(bob.doc('statuses/s1').update({ viewCount: 50 }));
    await assertFails(bob.doc('statuses/s1').update({ moderationStatus: 'rejected' }));
    await assertFails(alice.doc('statuses/s1').update({ moderationStatus: 'approved', publishedAt: 1 }));
    await assertFails(alice.doc('statuses/s1').update({ text: 'edited after approval' }));
    await assertFails(boss.doc('statuses/s1').update({ text: 'admins cannot edit public stories from the browser either' }));
  });

  await t.test('only the owner can delete their own public status', async () => {
    await assertFails(bob.doc('statuses/s2').delete());
    await assertSucceeds(alice.doc('statuses/s2').delete());
  });

  await t.test('every moderation collection is closed to browsers — users, administrators and anonymous alike', async () => {
    const docs = ['story_submissions/x', 'story_moderation_log/x', 'story_user_state/alice', 'story_ai_cache/x', 'story_stats/2026-11-03'];
    for (const who of [alice, boss, anon]) {
      for (const p of docs) {
        await assertFails(who.doc(p).get());
        await assertFails(who.doc(p).set({ moderationStatus: 'approved' }));
        await assertFails(who.doc(p).update({ moderationStatus: 'approved' }));
        await assertFails(who.doc(p).delete());
      }
      await assertFails(who.collection('story_submissions').get());
      await assertFails(who.collection('story_submissions').add({ userId: 'alice', moderationStatus: 'approved' }));
    }
  });

  await env.cleanup();
});
