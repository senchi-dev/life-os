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

test('select honours range [from, to] (inclusive) after ordering', async () => {
  const { createMemoryBackend: mkb } = await import('../../js/data/backend-memory.js');
  const b = mkb({ t: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })) });
  const page = await b.select('t', { order: ['id', true], range: [3, 5] });
  assert.deepEqual(page.map((r) => r.id), ['3', '4', '5']);
});

// ---- phase 2a: gym filters, unique keys, cascades ----
const rejects23 = (p, code) => assert.rejects(p, (e) => e.code === code && typeof e.message === 'string');

test('select supports in and is filters', async () => {
  const { createMemoryBackend: mkb } = await import('../../js/data/backend-memory.js');
  const b = mkb({
    sets: [{ id: 's1', workout_exercise_id: 'a' }, { id: 's2', workout_exercise_id: 'b' }, { id: 's3', workout_exercise_id: 'c' }],
    workouts: [{ id: 'w1', ended_at: null }, { id: 'w2', ended_at: '2026-01-01T00:00:00.000Z' }, { id: 'w3' }],
  });
  assert.deepEqual((await b.select('sets', { in: { workout_exercise_id: ['a', 'b'] } })).map((r) => r.id), ['s1', 's2']);
  assert.deepEqual(await b.select('sets', { in: { workout_exercise_id: [] } }), []);
  assert.deepEqual((await b.select('workouts', { is: { ended_at: null } })).map((r) => r.id), ['w1', 'w3']);
});

test('gym unique keys throw 23505', async () => {
  const { createMemoryBackend: mkb } = await import('../../js/data/backend-memory.js');
  const b = mkb();
  const w = (id, extra = {}) => ({ id, name: 'Push', day: '2026-11-24', started_at: '2026-11-24T10:00:00.000Z', ended_at: null, ...extra });
  await b.upsert('workouts', w('w1'), { onConflict: 'id' });
  await rejects23(b.upsert('workouts', w('w2'), { onConflict: 'id' }), '23505'); // second active workout
  await b.upsert('workouts', w('w2', { ended_at: '2026-11-24T11:00:00.000Z', source_ref: 'r1' }), { onConflict: 'id' });
  await rejects23(b.upsert('workouts', w('w3', { ended_at: '2026-11-24T11:00:00.000Z', source_ref: 'r1' }), { onConflict: 'id' }), '23505');
  assert.equal((await b.select('workouts')).length, 2);
  await b.upsert('exercises', { id: 'e1', name: 'Bench' }, { onConflict: 'id' });
  await rejects23(b.upsert('exercises', { id: 'e2', name: 'Bench' }, { onConflict: 'id' }), '23505');
  await b.upsert('routines', { id: 'r1', name: 'Push' }, { onConflict: 'id' });
  await rejects23(b.upsert('routines', { id: 'r2', name: 'Push' }, { onConflict: 'id' }), '23505');
  await b.upsert('schedule_slots', { id: 'sl1', weekday: 1 }, { onConflict: 'id' });
  await rejects23(b.upsert('schedule_slots', { id: 'sl2', weekday: 1 }, { onConflict: 'id' }), '23505');
  // an update that collides also throws, and a failed batch applies nothing
  await b.upsert('schedule_slots', { id: 'sl3', weekday: 2 }, { onConflict: 'id' });
  await rejects23(b.upsert('schedule_slots', { id: 'sl3', weekday: 1 }, { onConflict: 'id' }), '23505');
  await rejects23(b.upsert('schedule_slots', [{ id: 'sl4', weekday: 5 }, { id: 'sl5', weekday: 1 }], { onConflict: 'id' }), '23505');
  assert.deepEqual((await b.select('schedule_slots', { order: ['weekday', true] })).map((r) => r.weekday), [1, 2]);
});

test('removing a workout cascades to its exercises and sets', async () => {
  const { createMemoryBackend: mkb } = await import('../../js/data/backend-memory.js');
  const b = mkb({
    workouts: [{ id: 'w1', user_id: 'u' }, { id: 'w2', user_id: 'u' }],
    workout_exercises: [{ id: 'a', workout_id: 'w1' }, { id: 'b', workout_id: 'w2' }],
    sets: [{ id: 's1', workout_exercise_id: 'a' }, { id: 's2', workout_exercise_id: 'b' }],
  });
  await b.remove('workouts', { eq: { id: 'w1' } });
  assert.deepEqual((await b.select('workout_exercises')).map((r) => r.id), ['b']);
  assert.deepEqual((await b.select('sets')).map((r) => r.id), ['s2']);
});

test('removing a routine nulls slot and workout refs and deletes its items', async () => {
  const { createMemoryBackend: mkb } = await import('../../js/data/backend-memory.js');
  const b = mkb({
    routines: [{ id: 'r1' }, { id: 'r2' }],
    routine_items: [{ id: 'i1', routine_id: 'r1' }, { id: 'i2', routine_id: 'r2' }],
    schedule_slots: [{ id: 'a', weekday: 1, routine_id: 'r1' }, { id: 'b', weekday: 2, routine_id: 'r2' }],
    workouts: [{ id: 'w1', routine_id: 'r1' }],
  });
  await b.remove('routines', { eq: { id: 'r1' } });
  assert.deepEqual((await b.select('routine_items')).map((r) => r.id), ['i2']);
  assert.equal((await b.select('schedule_slots', { eq: { id: 'a' } }))[0].routine_id, null);
  assert.equal((await b.select('schedule_slots', { eq: { id: 'b' } }))[0].routine_id, 'r2');
  assert.equal((await b.select('workouts'))[0].routine_id, null);
});

test('removing a used exercise throws 23503 and removes nothing', async () => {
  const { createMemoryBackend: mkb } = await import('../../js/data/backend-memory.js');
  const b = mkb({
    exercises: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
    routine_items: [{ id: 'i', exercise_id: 'e1' }],
    workout_exercises: [{ id: 'x', exercise_id: 'e2' }],
  });
  await rejects23(b.remove('exercises', { eq: { id: 'e1' } }), '23503');
  await rejects23(b.remove('exercises', { eq: { id: 'e2' } }), '23503');
  await b.remove('exercises', { eq: { id: 'e3' } });
  assert.deepEqual((await b.select('exercises')).map((r) => r.id), ['e1', 'e2']);
});
