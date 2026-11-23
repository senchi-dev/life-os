import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';

function fakeBackend() {
  const f = { down: false, serverFail: new Set(), applied: [], calls: 0 };
  f.upsert = async (table, rows) => {
    f.calls++;
    const tag = rows[0].tag;
    if (f.down) throw Object.assign(new TypeError('Load failed'));
    if (f.serverFail.has(tag)) throw Object.assign(new Error('bad'), { kind: 'server' });
    f.applied.push(tag);
  };
  f.remove = async () => { f.calls++; if (f.down) throw new TypeError('Load failed'); };
  return f;
}
const A = { kind: 'upsert', table: 't', rows: [{ tag: 'A' }] };
const B = { kind: 'upsert', table: 't', rows: [{ tag: 'B' }] };

test('network failure keeps ops; recovery flushes in order once', async () => {
  const backend = fakeBackend(), storage = createMemoryStorage();
  const counts = [];
  const ob = createOutbox({ backend, storage, onChange: (n) => counts.push(n) });
  await ob.init();
  backend.down = true;
  await ob.enqueue(A); await ob.enqueue(B);
  const r1 = await ob.flush();
  assert.equal(r1.sent, 0); assert.equal(r1.remaining, 2);
  assert.equal((await storage.load()).length, 2);
  backend.down = false;
  const r2 = await ob.flush();
  assert.equal(r2.sent, 2); assert.equal(r2.remaining, 0);
  assert.deepEqual(backend.applied, ['A', 'B']);
  assert.equal((await storage.load()).length, 0);
  assert.deepEqual(counts, [0, 1, 2, 1, 0]);
  const r3 = await ob.flush();
  assert.equal(r3.sent, 0);
  assert.deepEqual(backend.applied, ['A', 'B']);
});

test('ops get an id and survive reload', async () => {
  const backend = fakeBackend(), storage = createMemoryStorage();
  backend.down = true;
  const ob = createOutbox({ backend, storage });
  await ob.enqueue(A);
  const [saved] = await storage.load();
  assert.ok(saved.id);
  const ob2 = createOutbox({ backend, storage });
  await ob2.init();
  assert.equal(ob2.pending(), 1);
  backend.down = false;
  assert.equal((await ob2.flush()).sent, 1);
});

test('server error drops op into failed and continues', async () => {
  const backend = fakeBackend(), storage = createMemoryStorage();
  backend.serverFail.add('A');
  const ob = createOutbox({ backend, storage });
  await ob.enqueue(A); await ob.enqueue(B);
  const r = await ob.flush();
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].rows[0].tag, 'A');
  assert.equal(r.sent, 1); assert.equal(r.remaining, 0);
  assert.deepEqual(backend.applied, ['B']);
  assert.equal((await storage.load()).length, 0);
});

test('auth error stops the queue', async () => {
  const backend = fakeBackend(), storage = createMemoryStorage();
  backend.upsert = async () => { throw Object.assign(new Error('jwt expired'), { kind: 'auth' }); };
  const ob = createOutbox({ backend, storage });
  await ob.enqueue(A); await ob.enqueue(B);
  const r = await ob.flush();
  assert.equal(r.remaining, 2); assert.equal(r.failed.length, 0);
});

test('concurrent flushes apply each op once', async () => {
  const backend = fakeBackend(), storage = createMemoryStorage();
  const ob = createOutbox({ backend, storage });
  await ob.enqueue(A); await ob.enqueue(B);
  const [r1, r2] = await Promise.all([ob.flush(), ob.flush()]);
  assert.deepEqual(backend.applied, ['A', 'B']);
  assert.equal(r1, r2);
});

test('enqueue during flush is picked up, not lost', async () => {
  const backend = fakeBackend(), storage = createMemoryStorage();
  const orig = backend.upsert;
  let injected = false;
  backend.upsert = async (...a) => { await orig(...a); if (!injected) { injected = true; await ob.enqueue(B); } };
  const ob = createOutbox({ backend, storage });
  await ob.enqueue(A);
  const r = await ob.flush();
  assert.deepEqual(backend.applied, ['A', 'B']);
  assert.equal(r.remaining, 0);
});

test('clear empties queue and storage', async () => {
  const storage = createMemoryStorage(), counts = [];
  const ob = createOutbox({ backend: fakeBackend(), storage, onChange: (n) => counts.push(n) });
  await ob.enqueue(A);
  await ob.clear();
  assert.equal(ob.pending(), 0);
  assert.equal((await storage.load()).length, 0);
  assert.equal(counts.at(-1), 0);
});

test('clear() during in-flight apply does not lose a newly enqueued op', async () => {
  const storage = createMemoryStorage();
  const applied = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const backend = {
    upsert: async (t, rows) => { if (rows[0].tag === 'OLD') await gate; applied.push(rows[0].tag); },
    remove: async () => {},
  };
  const ob = createOutbox({ backend, storage });
  await ob.enqueue({ ...A, rows: [{ tag: 'OLD' }] });
  const f1 = ob.flush();
  await new Promise((r) => setImmediate(r));
  await ob.clear();
  await ob.enqueue(B);
  release();
  await f1;
  assert.equal(ob.pending(), 1);
  assert.equal((await storage.load()).length, 1);
  const r = await ob.flush();
  assert.equal(r.remaining, 0);
  assert.equal(applied.filter((t) => t === 'B').length, 1);
});

test('after clear(), storage holds only ops enqueued afterwards', async () => {
  const storage = createMemoryStorage();
  const ob = createOutbox({ backend: fakeBackend(), storage });
  await ob.enqueue(A);
  const c = ob.clear();
  const e = ob.enqueue(B);
  await Promise.all([c, e]);
  const saved = await storage.load();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].rows[0].tag, 'B');
  assert.equal(ob.pending(), 1);
});
