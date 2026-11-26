// IndexedDB storage adapter for the outbox (browser only, not unit-tested).
// The whole queue is stored under one key, so save() is a single atomic put.
const KEY = 'ops';

function open(dbName, store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeTx(dbName, store) {
  return async (mode, fn) => {
    const db = await open(dbName, store);
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
}

export function createIdbStorage(dbName = 'lifeos', store = 'outbox') {
  const tx = makeTx(dbName, store);
  return {
    async load() { return (await tx('readonly', (s) => s.get(KEY))) ?? []; },
    async save(ops) { await tx('readwrite', (s) => s.put(ops, KEY)); },
    async clear() { await tx('readwrite', (s) => s.delete(KEY)); },
  };
}

// Key-value store in the same DB and store as the outbox (no version bump); keys must not be 'ops'.
export function createIdbKv(dbName = 'lifeos', store = 'outbox') {
  const tx = makeTx(dbName, store);
  return {
    async get(key) { return tx('readonly', (s) => s.get(key)); },
    async set(key, value) { await tx('readwrite', (s) => s.put(value, key)); },
    async del(key) { await tx('readwrite', (s) => s.delete(key)); },
    async delPrefix(prefix) { await tx('readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`))); },
  };
}
