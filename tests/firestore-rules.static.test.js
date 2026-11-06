'use strict';
// Static check of firestore.rules (no emulator needed): compares the new rules with the ORIGINAL ones
// (tests/fixtures/firestore.rules.before) block by block and proves that
//   * browsers can no longer create documents in the public `statuses` collection,
//   * every moderation collection is closed to all clients (admins included),
//   * everything else in the rules file is byte-for-byte the same (nothing was weakened to make this feature work).
//
// This is a *text* analysis. The behavioural version of the same checks (run against the Firestore emulator) is
// tests/firestore-rules.emulator.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const AFTER = read('../firestore.rules');
const BEFORE = read('fixtures/firestore.rules.before');

function stripComments(s) {
  let out = ''; let i = 0; let inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; }
      if (c === "'") inStr = false;
      i++; continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return out;
}
const norm = (s) => stripComments(s).replace(/\s+/g, ' ').trim();

function matchingBrace(s, open) {
  let depth = 0; let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === "'") inStr = false; continue; }
    if (c === "'") { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces');
}

// → Map "match /x/{y}" | "function name" → full normalised text, for the direct children of `body`
function children(body) {
  const out = new Map();
  const re = /\b(match\s+\S+|function\s+\w+\s*\([^)]*\))\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(body, open);
    out.set(m[1].replace(/\s+/g, ' ').trim(), { head: m[1], inner: body.slice(open + 1, close) });
    re.lastIndex = close + 1;
  }
  return out;
}

function documentsBody(rules) {
  const clean = stripComments(rules);
  const m = /match\s+\/databases\/\{database\}\/documents\s*\{/.exec(clean);
  assert.ok(m, 'documents block found');
  const open = m.index + m[0].length - 1;
  return clean.slice(open + 1, matchingBrace(clean, open));
}

const before = children(documentsBody(BEFORE));
const after = children(documentsBody(AFTER));
const STATUSES = 'match /statuses/{statusId}';
const NEW_COLLECTIONS = ['story_submissions', 'story_moderation_log', 'story_user_state', 'story_ai_cache', 'story_stats'];

// top-level allow statements of a block (nested match blocks removed)
function allows(inner) {
  let flat = inner;
  for (const [, c] of children(inner)) flat = flat.replace(c.inner, '');
  return flat.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => /\ballow\b/.test(s));
}

test('the parser sees the same set of top-level blocks as before, plus exactly the five new moderation collections', () => {
  assert.ok(before.size >= 8, `baseline parsed (${before.size} blocks)`);
  assert.ok(before.has('match /statuses/{statusId}') && before.has('match /users/{uid}'), 'key blocks present in the baseline');
  for (const key of before.keys()) assert.ok(after.has(key), `existing block kept: ${key}`);
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  assert.deepEqual(added, NEW_COLLECTIONS.map((c) => `match /${c}/{${c === 'story_user_state' ? 'uid' : 'id'}}`).sort());
});

test('NOTHING else in the rules was loosened: every pre-existing block except `statuses` is identical to the original', () => {
  for (const [key, b] of before) {
    if (key === STATUSES) continue;
    assert.equal(norm(after.get(key).inner), norm(b.inner), `block changed unexpectedly: ${key}`);
  }
});

test('public `statuses`: browsers can no longer create documents (create is hard-denied)', () => {
  const a = allows(after.get(STATUSES).inner);
  const creates = a.filter((s) => /^allow\s+create\b/.test(s));
  assert.deepEqual(creates, ['allow create: if false'], 'the only create rule is "if false"');
  assert.ok(!a.some((s) => /^allow\s+(write|create)\b.*\bif\s+true\b/.test(s)));
});

test('public `statuses`: read / update / delete and the views + reactions sub-collections are unchanged from the original', () => {
  const b = allows(before.get(STATUSES).inner);
  const a = allows(after.get(STATUSES).inner);
  const strip = (list) => list.filter((s) => !/^allow\s+create\b/.test(s));
  assert.deepEqual(strip(a), strip(b), 'read/update/delete rules identical');
  const bc = children(before.get(STATUSES).inner); const ac = children(after.get(STATUSES).inner);
  assert.deepEqual([...ac.keys()], [...bc.keys()]);
  for (const [k, v] of bc) assert.equal(norm(ac.get(k).inner), norm(v.inner), `sub-collection unchanged: ${k}`);
});

test('the original create rule really did allow signed-in users to publish (this is the hole that was closed)', () => {
  const b = allows(before.get(STATUSES).inner).find((s) => /^allow\s+create\b/.test(s));
  assert.match(b, /request\.auth != null/);
  assert.match(b, /request\.resource\.data\.uid == request\.auth\.uid/);
});

test('users can never change moderation fields on a public status: update is limited to the two counters', () => {
  const upd = allows(after.get(STATUSES).inner).find((s) => /^allow\s+update\b/.test(s));
  assert.match(upd, /affectedKeys\(\)\.hasOnly\(\['viewCount','reactCount'\]\)/);
  assert.ok(!/moderation|published|approved|reviewedBy|moderatedAt/i.test(upd), 'no moderation field is writable');
});

test('all five moderation collections are closed to every client (read AND write denied, no exceptions)', () => {
  for (const c of NEW_COLLECTIONS) {
    const key = [...after.keys()].find((k) => k.startsWith(`match /${c}/`));
    const inner = norm(after.get(key).inner);
    assert.equal(inner, 'allow read, write: if false;', `${c} is deny-all`);
    assert.ok(!/isAdmin|request\.auth/.test(inner), `${c}: no auth-based exception (admin access goes through the verified server API only)`);
  }
});

test('the new blocks add no open ("if true") rule anywhere', () => {
  const added = [...after.entries()].filter(([k]) => !before.has(k));
  assert.equal(added.length, 5);
  for (const [, v] of added) assert.ok(!/\bif\s+true\b/.test(v.inner), 'no new block ever says "if true"');
  const after_true = (norm(AFTER).match(/if true/g) || []).length;
  const before_true = (norm(BEFORE).match(/if true/g) || []).length;
  assert.equal(after_true, before_true, 'the number of "if true" (open) rules did not grow');
});

test('the isAdmin() helper used by the rest of the rules is still defined exactly as before', () => {
  const key = [...before.keys()].find((k) => k.startsWith('function isAdmin'));
  assert.ok(key, 'isAdmin exists in the original');
  assert.ok(after.has(key));
  assert.equal(norm(after.get(key).inner), norm(before.get(key).inner));
});
