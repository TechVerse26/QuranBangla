// tests/helpers/fake-firebase.js
//
// A small in-memory stand-in for the parts of firebase-admin the Story moderation code uses, so the REAL handlers
// (api/story-submit.js, api/story-admin.js) can be exercised offline. It deliberately mimics the behaviours that
// matter for correctness:
//   - transactions are serialised and enforce "all reads before any write" (real Firestore throws otherwise)
//   - create() fails if the document exists, update() fails if it does not (checked atomically at commit)
//   - orderBy() silently excludes documents that lack the field
//   - FieldValue.increment / delete sentinels
// It does NOT emulate security rules (see tests/firestore-rules.static.test.js for what is checked there).

'use strict';

const DELETE = { __sentinel: 'delete' };
class Increment { constructor(n) { this.n = n; } }
const FieldValue = {
  delete: () => DELETE,
  increment: (n) => new Increment(n),
  serverTimestamp: () => ({ __sentinel: 'ts' }),
};

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function applyData(existing, data, mode) {
  const base = (mode.merge || mode.update) ? clone(existing || {}) : {};
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) { if (mode.merge || mode.update) delete base[k]; }
    else if (v instanceof Increment) base[k] = (Number(base[k]) || 0) + v.n;
    else if (v && v.__sentinel === 'ts') base[k] = Date.now();
    else if (v === undefined) { /* dropped, like ignoreUndefinedProperties */ }
    else base[k] = clone(v);
  }
  return base;
}

class FakeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class DocSnap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; }
  get exists() { return this._d !== undefined; }
  data() { return this._d === undefined ? undefined : clone(this._d); }
}

class QuerySnap {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; }
  forEach(fn) { this.docs.forEach(fn); }
}

class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  collection(name) { return new CollectionRef(this.db, `${this.path}/${name}`); }
  async get() { this.db._maybeFail('get', this.path); return new DocSnap(this, this.db._store.get(this.path)); }
  async set(data, opts) { this.db._commit([{ op: 'set', ref: this, data, opts: opts || {} }]); }
  async create(data) { this.db._commit([{ op: 'create', ref: this, data }]); }
  async update(data) { this.db._commit([{ op: 'update', ref: this, data }]); }
  async delete() { this.db._commit([{ op: 'delete', ref: this }]); }
}

class Query {
  constructor(db, colPath, st) {
    this.db = db; this.colPath = colPath;
    this.st = Object.assign({ filters: [], orders: [], lim: null, after: null }, st || {});
  }
  _with(patch) { return new Query(this.db, this.colPath, Object.assign({}, this.st, patch)); }
  where(f, op, v) { return this._with({ filters: [...this.st.filters, { f, op, v }] }); }
  orderBy(f, dir) { return this._with({ orders: [...this.st.orders, { f, dir: dir || 'asc' }] }); }
  limit(n) { return this._with({ lim: n }); }
  startAfter(snap) { return this._with({ after: snap }); }
  select() { return this; }
  _run() {
    this.db._maybeFail('query', this.colPath, this.st);
    let docs = this.db._list(this.colPath);
    docs = docs.filter((d) => this.st.filters.every(({ f, op, v }) => {
      const x = d.data[f];
      if (op === '==') return x === v;
      if (op === 'in') return Array.isArray(v) && v.includes(x);
      if (op === '>=') return x >= v;
      if (op === '<') return x < v;
      throw new Error(`fake firestore: unsupported operator ${op}`);
    }));
    if (this.st.orders.length) {
      docs = docs.filter((d) => this.st.orders.every((o) => d.data[o.f] !== undefined));
      const lastDir = this.st.orders[this.st.orders.length - 1].dir;
      docs.sort((a, b) => {
        for (const o of this.st.orders) {
          const av = a.data[o.f]; const bv = b.data[o.f];
          if (av < bv) return o.dir === 'desc' ? 1 : -1;
          if (av > bv) return o.dir === 'desc' ? -1 : 1;
        }
        const c = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return lastDir === 'desc' ? -c : c;
      });
    }
    if (this.st.after) {
      const idx = docs.findIndex((d) => d.id === this.st.after.id);
      if (idx >= 0) docs = docs.slice(idx + 1);
    }
    return docs;
  }
  async get() {
    let docs = this._run();
    if (this.st.lim != null) docs = docs.slice(0, this.st.lim);
    return new QuerySnap(docs.map((d) => new DocSnap(new DocRef(this.db, `${this.colPath}/${d.id}`), d.data)));
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this._run().length }) }) };
  }
}

class CollectionRef extends Query {
  constructor(db, path) { super(db, path, {}); this.path = path; }
  doc(id) { return new DocRef(this.db, `${this.path}/${id || this.db._autoId()}`); }
}

class FakeDb {
  constructor() {
    this._store = new Map();
    this._n = 0;
    this._lock = Promise.resolve();
    this.queryHook = null; // (kind, path, state) => throw to simulate e.g. a missing index
    this.opLog = [];       // every committed write, for assertions
  }
  _autoId() { this._n += 1; return `auto${String(this._n).padStart(6, '0')}`; }
  _maybeFail(kind, path, st) { if (this.queryHook) this.queryHook(kind, path, st); }
  collection(name) { return new CollectionRef(this, name); }
  doc(path) { return new DocRef(this, path); }
  async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }
  batch() {
    const writes = [];
    const b = {
      set: (ref, data, opts) => { writes.push({ op: 'set', ref, data, opts: opts || {} }); return b; },
      create: (ref, data) => { writes.push({ op: 'create', ref, data }); return b; },
      update: (ref, data) => { writes.push({ op: 'update', ref, data }); return b; },
      delete: (ref) => { writes.push({ op: 'delete', ref }); return b; },
      commit: async () => { this._commit(writes); },
    };
    return b;
  }
  async recursiveDelete(ref) {
    const prefix = `${ref.path}/`;
    for (const k of Array.from(this._store.keys())) if (k === ref.path || k.startsWith(prefix)) this._store.delete(k);
  }
  async runTransaction(fn) {
    const prev = this._lock;
    let release;
    this._lock = new Promise((r) => { release = r; });
    await prev;
    try {
      const writes = [];
      const tx = {
        get: async (ref) => {
          if (writes.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          return ref.get();
        },
        set: (ref, data, opts) => { writes.push({ op: 'set', ref, data, opts: opts || {} }); return tx; },
        create: (ref, data) => { writes.push({ op: 'create', ref, data }); return tx; },
        update: (ref, data) => { writes.push({ op: 'update', ref, data }); return tx; },
        delete: (ref) => { writes.push({ op: 'delete', ref }); return tx; },
      };
      const out = await fn(tx);
      this._commit(writes);
      return out;
    } finally { release(); }
  }

  // ---- internals
  _list(colPath) {
    const depth = colPath.split('/').length + 1;
    const out = [];
    for (const [k, v] of this._store.entries()) {
      if (k.startsWith(`${colPath}/`) && k.split('/').length === depth) out.push({ id: k.split('/').pop(), data: v });
    }
    return out;
  }
  _commit(writes) {
    const seenCreated = new Set();
    for (const w of writes) { // validate atomically first
      const p = w.ref.path;
      if (w.op === 'create') {
        if (this._store.has(p) || seenCreated.has(p)) throw new FakeError(6, `ALREADY_EXISTS: ${p}`);
        seenCreated.add(p);
      }
      if (w.op === 'update' && !this._store.has(p) && !seenCreated.has(p)) throw new FakeError(5, `NOT_FOUND: ${p}`);
    }
    for (const w of writes) {
      const p = w.ref.path;
      if (w.op === 'delete') this._store.delete(p);
      else if (w.op === 'create') this._store.set(p, applyData(undefined, w.data, {}));
      else if (w.op === 'update') this._store.set(p, applyData(this._store.get(p), w.data, { update: true }));
      else this._store.set(p, applyData(this._store.get(p), w.data, { merge: !!(w.opts && w.opts.merge) }));
      this.opLog.push({ op: w.op, path: p });
    }
  }

  // ---- test conveniences
  seed(path, data) { this._store.set(path, clone(data)); }
  read(path) { const v = this._store.get(path); return v === undefined ? undefined : clone(v); }
  has(path) { return this._store.has(path); }
  all(colPath) { return this._list(colPath).map((d) => Object.assign({ id: d.id }, clone(d.data))); }
}

function makeFakeFirebase() {
  const db = new FakeDb();
  const tokens = new Map(); // token -> claims
  const admin = {
    firestore: { FieldValue },
    auth: () => ({
      verifyIdToken: async (token, checkRevoked) => {
        const c = tokens.get(token);
        if (!c) throw new Error('auth/argument-error: invalid token');
        if (checkRevoked && c.revoked) throw new Error('auth/id-token-revoked');
        return Object.assign({}, c);
      },
    }),
  };
  return {
    fb: { ok: true, admin, db },
    db,
    addUser(token, claims) { tokens.set(token, Object.assign({ uid: token, name: `User ${token}`, email: `${token}@example.com` }, claims)); },
  };
}

// Minimal Vercel-style req/res pair.
function mockReqRes({ method = 'POST', headers = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
  const req = { method, headers: Object.assign({}, headers), body };
  return { req, res };
}

module.exports = { makeFakeFirebase, mockReqRes, FakeDb, FieldValue };
