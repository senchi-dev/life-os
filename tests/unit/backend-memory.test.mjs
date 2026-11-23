import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';

test('upsert merges only provided columns on conflict', async () => {
  const b = createMemoryBackend();
  await b.upsert('daily', { date: '2026-11-23', pages: 10 }, { onConflict: 'user_id,date' });
  await b.upsert('daily', { date: '2026-11-23', mood: 4 }, { onConflict: 'user_id,date' });
  const rows = await b.select('daily');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pages, 10);
  assert.equal(rows[0].mood, 4);
  assert.equal(rows[0].user_id, 'demo-user');
  assert.ok(rows[0].id && rows[0].created_at && rows[0].updated_at);
});

test('ignoreDuplicates leaves existing row untouched', async () => {
  const b = createMemoryBackend();
  await b.upsert('daily', { date: 'd', pages: 1 }, { onConflict: 'user_id,date' });
  await b.upsert('daily', { date: 'd', pages: 99 }, { onConflict: 'user_id,date', ignoreDuplicates: true });
  assert.equal((await b.select('daily'))[0].pages, 1);
});

test('select filters, orders and returns copies', async () => {
  const b = createMemoryBackend();
  await b.upsert('water', [{ at: '2026-11-01', ml: 1 }, { at: '2026-11-03', ml: 3 }, { at: '2026-11-02', ml: 2 }]);
  const r = await b.select('water', { gte: { at: '2026-11-02' }, lte: { at: '2026-11-03' }, order: ['at', false] });
  assert.deepEqual(r.map(x => x.ml), [3, 2]);
  r[0].ml = 999;
  assert.equal((await b.select('water', { eq: { at: '2026-11-03' } }))[0].ml, 3);
});

test('remove by eq; default conflict target is id', async () => {
  const b = createMemoryBackend();
  await b.upsert('water', { id: 'a', ml: 1 });
  await b.upsert('water', { id: 'a', ml: 2 });
  await b.upsert('water', { id: 'b', ml: 3 });
  assert.equal((await b.select('water')).length, 2);
  await b.remove('water', { eq: { id: 'a' } });
  assert.deepEqual((await b.select('water')).map(x => x.id), ['b']);
});

test('seed and dump', async () => {
  const b = createMemoryBackend({ habits: [{ id: 'h', name: 'x' }] }, 'u1');
  assert.equal((await b.select('habits'))[0].name, 'x');
  assert.ok(Array.isArray(b.dump().habits));
});
