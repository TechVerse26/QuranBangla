'use strict';
// Tiny test server for the browser (Playwright) tests:
//   * serves the repository root as static files (like Vercel does)
//   * serves tests/ui/harness.html at /harness
//   * bridges POST /api/story-submit and /api/story-admin to the REAL Vercel handlers, backed by the in-memory
//     Firestore fake — so the real client JS talks to the real server code end to end.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const ROOT = path.join(__dirname, '..', '..');
const store = require('../../api/_story-firebase.js');
const submit = require('../../api/story-submit.js');
const adminApi = require('../../api/story-admin.js');
const { makeFakeFirebase } = require('../helpers/fake-firebase.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

function makeEnv() {
  const env = makeFakeFirebase();
  store.setFirebaseForTests(env.fb);
  for (const [uid, name] of [['alice', 'Alice Rahman'], ['bob', 'Bob'], ['boss', 'প্রধান অ্যাডমিন']]) {
    env.addUser(uid, { uid, name });
    env.db.seed(`users/${uid}`, { name, status: 'active' });
  }
  env.db.seed('admins/boss', { isAdmin: true });
  return env;
}

function startServer() {
  const env = makeEnv();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && (url.pathname === '/api/story-submit' || url.pathname === '/api/story-admin')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* empty */ }
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
        const r = { method: 'POST', headers, body };
        const out = { code: 200, headers: { 'content-type': 'application/json' } };
        const s = {
          setHeader(k, v) { out.headers[k.toLowerCase()] = String(v); },
          status(c) { out.code = c; return s; },
          json(b) { res.writeHead(out.code, out.headers); res.end(JSON.stringify(b)); return s; },
          end() { res.writeHead(out.code, out.headers); res.end(); return s; },
        };
        try { await (url.pathname === '/api/story-submit' ? submit : adminApi)(r, s); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); }
      });
      return;
    }
    let p = url.pathname === '/harness' ? path.join(__dirname, 'harness.html') : path.join(ROOT, decodeURIComponent(url.pathname));
    if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, env, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startServer, makeEnv };
