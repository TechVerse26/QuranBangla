// ---------- IndexedDB-backed key-value store (replaces localStorage) ----------
// Why: localStorage is capped at ~5-10MB per origin and stores everything as
// UTF-16 strings synchronously on the main thread — fine for a handful of
// small keys, but risky once bookmarks/notes/history/topics-index data grow.
// IndexedDB gives each origin a much larger quota (typically hundreds of MB,
// browser-managed) and does all its work off the main thread.
//
// To avoid rewriting every get/set call across the app into async/await
// chains, this module loads the *entire* store into an in-memory Map once at
// startup (see IDBKV.init(), awaited early in js/app.js) and after that
// exposes a synchronous-looking get/set/remove API — reads come straight from
// the in-memory cache (instant, no await needed), writes update the cache
// immediately and persist to IndexedDB in the background. This mirrors how
// localStorage already behaved (fast, synchronous) while moving the actual
// storage + quota to IndexedDB.
//
// On first run after this update, any pre-existing localStorage data is
// migrated into IndexedDB automatically, then removed from localStorage so
// nothing is duplicated. This is a one-time, best-effort operation guarded by
// a flag stored inside IndexedDB itself.

const IDBKV = (function(){
  const DB_NAME = 'quranBanglaDB';
  const DB_VERSION = 1;
  const STORE = 'kv';

  let db = null;
  const cache = new Map();
  let ready = false;
  let readyPromise = null;

  function openDB(){
    return new Promise((resolve, reject) => {
      if(!('indexedDB' in window)){ reject(new Error('indexeddb-unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        if(!_db.objectStoreNames.contains(STORE)) _db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error('indexeddb-open-failed'));
      req.onblocked = () => { /* another tab holds an older version open; resolve() will still fire once it closes */ };
    });
  }

  function idbGetAll(_db){
    return new Promise((resolve) => {
      try{
        const tx = _db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      }catch(e){ resolve([]); }
    });
  }

  function idbPut(_db, key, value){
    return new Promise((resolve) => {
      try{
        const tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, value });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      }catch(e){ resolve(false); }
    });
  }

  function idbDelete(_db, key){
    return new Promise((resolve) => {
      try{
        const tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      }catch(e){ resolve(false); }
    });
  }

  // One-time copy of every existing localStorage entry into IndexedDB, then
  // wipe localStorage so the same data doesn't live in two places. Guarded by
  // a flag written into IndexedDB (not localStorage), so it can't re-run.
  async function migrateFromLocalStorage(_db){
    if(cache.get('__idb_migrated__') === '1') return;
    try{
      const keys = [];
      for(let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      for(const k of keys){
        if(k == null) continue;
        const v = localStorage.getItem(k);
        if(v === null) continue;
        cache.set(k, v);
        await idbPut(_db, k, v);
      }
      cache.set('__idb_migrated__', '1');
      await idbPut(_db, '__idb_migrated__', '1');
      keys.forEach(k => { try{ localStorage.removeItem(k); }catch(e){} });
    }catch(e){ /* best-effort — app keeps working off whatever made it into the cache */ }
  }

  async function init(){
    if(readyPromise) return readyPromise;
    readyPromise = (async () => {
      try{
        db = await openDB();
        const rows = await idbGetAll(db);
        rows.forEach(r => cache.set(r.key, r.value));
        await migrateFromLocalStorage(db);
      }catch(e){
        // IndexedDB unavailable (private/incognito mode in some browsers,
        // very old browser, storage disabled, etc). Fall back to reading
        // straight from localStorage so the app still works, just without
        // the larger quota — nothing is lost.
        db = null;
        try{
          for(let i = 0; i < localStorage.length; i++){
            const k = localStorage.key(i);
            cache.set(k, localStorage.getItem(k));
          }
        }catch(e2){}
      }
      ready = true;
    })();
    return readyPromise;
  }

  function get(key){
    const v = cache.get(key);
    return v === undefined ? null : v;
  }
  function set(key, value){
    cache.set(key, value);
    if(db) idbPut(db, key, value);
    else{ try{ localStorage.setItem(key, value); }catch(e){} }
  }
  function remove(key){
    cache.delete(key);
    if(db) idbDelete(db, key);
    else{ try{ localStorage.removeItem(key); }catch(e){} }
  }

  return {
    init, get, set, remove,
    get isReady(){ return ready; }
  };
})();
