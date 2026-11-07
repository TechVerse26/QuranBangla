// tests/helpers/fixtures.js — shared helpers for the Story moderation tests (no network, no real Firebase).

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------- fake Gemini (patches global fetch)
function installFakeGemini(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      throw new Error(`unexpected network call in test: ${url}`);
    }
    const body = JSON.parse(init.body);
    const model = decodeURIComponent(/models\/([^:]+):/.exec(String(url))[1]);
    calls.push({ url: String(url), model, headers: init.headers, body });
    const aborted = new Promise((_, reject) => {
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e);
        });
      }
    });
    const r = await Promise.race([Promise.resolve(handler({ body, model, n: calls.length })), aborted]);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function verdict(over) {
  return Object.assign({
    decision: 'APPROVED', confidence: 0.97, reasonCode: 'none', severity: 'none',
    adminReason: 'কোনো সমস্যা পাওয়া যায়নি।', religiousContent: false,
  }, over || {});
}

const imageOk = { nudity: 'none', violence: 'none', textFound: false, extractedText: '', textViolation: false };
function geminiOk(v) {
  return { status: 200, json: { candidates: [{ content: { parts: [{ text: typeof v === 'string' ? v : JSON.stringify(v) }] }, finishReason: 'STOP' }] } };
}
const geminiHttp = (status, message) => ({ status, json: { error: { code: status, message: message || 'error' } } });
const geminiBlocked = (reason) => ({ status: 200, json: { promptFeedback: { blockReason: reason }, candidates: [] } });

// ---------------------------------------------------------------- media
function jpegDataUrl(size, seed) {
  const body = crypto.createHash('sha256').update(String(seed || size || 1)).digest();
  const buf = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00]), body, Buffer.alloc(Math.max(0, (size || 300) - 43), 7)]);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
function pngDataUrl() {
  const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200, 3)]);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
function audioDataUrl(kind, seed) {
  const head = {
    webm: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
    ogg: Buffer.from('OggS', 'ascii'),
    mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'ascii')]),
  }[kind || 'webm'];
  const mime = { webm: 'audio/webm;codecs=opus', ogg: 'audio/ogg;codecs=opus', mp4: 'audio/mp4' }[kind || 'webm'];
  const buf = Buffer.concat([head, crypto.createHash('sha256').update(String(seed || 1)).digest(), Buffer.alloc(200, 9)]);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---------------------------------------------------------------- requests
let rid = 0;
function newRequestId() { rid += 1; return `req-${String(rid).padStart(6, '0')}-${crypto.randomBytes(6).toString('hex')}`; }

function textStory(text, extra) { return Object.assign({ type: 'text', text, bg: '#2E6F5E', font: 'sans', align: 'center', size: 26, textColor: '#ffffff', highlight: false }, extra || {}); }
function imageStory(imageData, extra) { return Object.assign({ type: 'image', imageData }, extra || {}); }

function submitBody(story, requestId) { return { action: 'submit', requestId: requestId || newRequestId(), story }; }
function bearer(token) { return { authorization: `Bearer ${token}` }; }

module.exports = {
  installFakeGemini, verdict, imageOk, geminiOk, geminiHttp, geminiBlocked,
  jpegDataUrl, pngDataUrl, audioDataUrl, newRequestId, textStory, imageStory, submitBody, bearer,
};
