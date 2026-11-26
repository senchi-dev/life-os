import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { createMemoryKv } from '../../js/data/kv.js';
import { GymValidationError } from '../../js/lib/gym-validate.js';
import { addDays, parseDateKey } from '../../js/lib/dates.js';
import * as repo from '../../js/data/repo.js';
import * as gym from '../../js/data/gym-repo.js';

async function mk(seed = {}, storage = createMemoryStorage()) {
  const backend = createMemoryBackend(seed);
  const outbox = createOutbox({ backend, storage });
  await outbox.init();
  return { ctx: { backend, outbox }, backend, outbox };
}
const TODAY = '2026-11-24';
const daysAgo = (n) => parseDateKey(addDays(TODAY, -n)).toISOString();
const T0 = '2026-11-24T10:00:00.000Z';
const wk = (id, extra = {}) => ({ id, name: 'Push', day: '2026-11-01', started_at: daysAgo(10), ended_at: daysAgo(10), ...extra });

test('normalizeTs and normalizeGymRow', () => {
  assert.equal(repo.normalizeTs('2026-11-24T18:52:00+00:00'), '2026-11-24T18:52:00.000Z');
  assert.equal(repo.normalizeTs('2026-11-24T19:52:00.123456+01:00'), '2026-11-24T18:52:00.123Z');
  assert.equal(repo.normalizeTs(null), null);
  const r = repo.normalizeGymRow('sets', { weight_kg: '82.50', done_at: '2026-11-24T18:00:00+00:00' });
  assert.equal(r.weight_kg, 82.5);
  assert.equal(r.done_at, '2026-11-24T18:00:00.000Z');
  assert.equal('created_at' in r, false);
});

test('loadSnapshot: 42-day window for workout headers, active workout always, children only for the active one', async () => {
  const { ctx } = await mk({
    exercises: [{ id: 'e1', name: 'Bench' }], routines: [{ id: 'r1', name: 'Push' }],
    routine_items: [{ id: 'i1', routine_id: 'r1' }], schedule_slots: [{ id: 'sl', weekday: 1 }],
    workouts: [
      wk('old', { started_at: daysAgo(43), ended_at: daysAgo(43) }),
      wk('recent', { started_at: daysAgo(41), ended_at: daysAgo(41) }),
      wk('active', { started_at: daysAgo(60), ended_at: null }),
    ],
    workout_exercises: [{ id: 'we-a', workout_id: 'active', exercise_id: 'e1', position: 0 }, { id: 'we-r', workout_id: 'recent', exercise_id: 'e1', position: 0 }],
    sets: [{ id: 's-a', workout_exercise_id: 'we-a', weight_kg: '80.00' }, { id: 's-r', workout_exercise_id: 'we-r' }],
  });
  const snap = await repo.loadSnapshot(ctx, TODAY);
  assert.deepEqual(snap.workouts.map((w) => w.id), ['active', 'recent']);
  assert.equal(snap.activeWorkout.workout.id, 'active');
  assert.deepEqual(snap.activeWorkout.workoutExercises.map((x) => x.id), ['we-a']);
  assert.deepEqual(snap.activeWorkout.sets.map((x) => x.id), ['s-a']);
  assert.equal(snap.activeWorkout.sets[0].weight_kg, 80);
  assert.equal(snap.exercises.length, 1);
  assert.equal(snap.routines.length, 1);
  assert.equal(snap.routineItems.length, 1);
  assert.equal(snap.scheduleSlots.length, 1);
});

test('loadSnapshot: no active workout gives null; dedupes an active workout inside the window', async () => {
  const none = await mk({ workouts: [wk('recent', { started_at: daysAgo(5), ended_at: daysAgo(5) })] });
  assert.equal((await repo.loadSnapshot(none.ctx, TODAY)).activeWorkout, null);
  const act = await mk({ workouts: [wk('a', { started_at: daysAgo(1), ended_at: null })] });
  const snap = await repo.loadSnapshot(act.ctx, TODAY);
  assert.equal(snap.workouts.length, 1);
  assert.equal(snap.activeWorkout.workout.id, 'a');
});

test('enqueueGym validates everything first: one bad row enqueues nothing', async () => {
  const { ctx, outbox } = await mk();
  const good = { id: 'a1', name: 'Push' };
  const ops = [gym.upsertRows('routines', [good]), gym.upsertRows('routines', [{ id: 'a2', name: '' }])];
  await assert.rejects(gym.enqueueGym(ctx, ops), (e) => e instanceof GymValidationError && e.table === 'routines');
  assert.equal(outbox.pending(), 0);
});

test('enqueueGym enqueues in order, flushes, and skips non-gym tables', async () => {
  const { ctx, backend, outbox } = await mk();
  await gym.enqueueGym(ctx, [
    gym.upsertRows('routines', [{ id: 'r1', name: 'Push' }]),
    gym.upsertRows('habit_logs', [{ habit_id: 'h', date: '2026-11-24', status: 'done' }]),
    gym.removeRow('routines', 'nope'),
  ]);
  await outbox.flush();
  assert.equal(outbox.pending(), 0);
  assert.equal(backend.dump().routines.length, 1);
  assert.equal(backend.dump().habit_logs.length, 1);
});

test('upsertRows / removeRow / batchUpserts shapes', () => {
  assert.deepEqual(gym.upsertRows('sets', [{ id: 'x' }]), { kind: 'upsert', table: 'sets', rows: [{ id: 'x' }], onConflict: 'id' });
  assert.equal(gym.upsertRows('sets', [], { ignoreDuplicates: true }).ignoreDuplicates, true);
  assert.deepEqual(gym.removeRow('sets', 'x'), { kind: 'remove', table: 'sets', eq: { id: 'x' } });
  const ops = gym.batchUpserts('sets', Array.from({ length: 628 }, (_, i) => ({ id: String(i) })), { ignoreDuplicates: true });
  assert.deepEqual(ops.map((o) => o.rows.length), [200, 200, 200, 28]);
  assert.ok(ops.every((o) => o.ignoreDuplicates && o.table === 'sets' && o.onConflict === 'id'));
});

test('fetchFinishedHistory pages 2,500 sets and excludes the active workout', async () => {
  const sets = Array.from({ length: 2500 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, workout_exercise_id: i < 2400 ? 'we-f' : 'we-a', weight_kg: '60' }));
  const { ctx } = await mk({
    workouts: [wk('done'), wk('act', { ended_at: null })],
    workout_exercises: [{ id: 'we-f', workout_id: 'done' }, { id: 'we-a', workout_id: 'act' }],
    sets,
  });
  const h = await gym.fetchFinishedHistory(ctx, { pageSize: 1000 });
  assert.deepEqual(h.workouts.map((w) => w.id), ['done']);
  assert.deepEqual(h.workoutExercises.map((w) => w.id), ['we-f']);
  assert.equal(h.sets.length, 2400);
  assert.equal(new Set(h.sets.map((s) => s.id)).size, 2400);
  assert.equal(h.sets[0].weight_kg, 60);
});

test('fetchWorkoutsByIds and fetchSetsFor', async () => {
  const { ctx } = await mk({
    workouts: [wk('a'), wk('b', { started_at: daysAgo(9), ended_at: daysAgo(9) })],
    workout_exercises: [{ id: 'xa', workout_id: 'a' }, { id: 'xb', workout_id: 'b' }],
    sets: [{ id: 'sa', workout_exercise_id: 'xa' }, { id: 'sb', workout_exercise_id: 'xb' }],
  });
  const h = await gym.fetchWorkoutsByIds(ctx, ['b']);
  assert.deepEqual([h.workouts.map((w) => w.id), h.workoutExercises.map((w) => w.id), h.sets.map((w) => w.id)], [['b'], ['xb'], ['sb']]);
  assert.deepEqual((await gym.fetchSetsFor(ctx, ['xa'])).map((s) => s.id), ['sa']);
  assert.deepEqual(await gym.fetchSetsFor(ctx, []), []);
});

test('fetchImportState: refs, native days, per-workout child counts (A1)', async () => {
  const { ctx } = await mk({
    workouts: [
      wk('i', { imported: true, source_ref: 'strive:routine_logs:x' }),
      wk('i2', { imported: true, source_ref: 'strive:routine_logs:y' }),
      wk('i3', { imported: true, source_ref: 'strive:routine_logs:z' }),
      wk('n', { imported: false, day: '2026-11-20', source_ref: null }),
    ],
    workout_exercises: [
      { id: 'a', workout_id: 'i', exercise_id: 'e', position: 0 }, { id: 'b', workout_id: 'i', exercise_id: 'e', position: 1 },
      { id: 'c', workout_id: 'i2', exercise_id: 'e', position: 0 }, { id: 'd', workout_id: 'n', exercise_id: 'e', position: 0 },
    ],
    sets: [
      { id: 's1', workout_exercise_id: 'a' }, { id: 's2', workout_exercise_id: 'a' }, { id: 's3', workout_exercise_id: 'b' },
      { id: 's4', workout_exercise_id: 'd' },
    ],
  });
  const s = await gym.fetchImportState(ctx);
  assert.deepEqual([...s.importedRefs].sort(), ['strive:routine_logs:x', 'strive:routine_logs:y', 'strive:routine_logs:z']);
  assert.deepEqual([...s.nativeDays], ['2026-11-20']);
  assert.deepEqual([...s.childCounts].sort(), [
    ['strive:routine_logs:x', { entries: 2, sets: 3 }],
    ['strive:routine_logs:y', { entries: 1, sets: 0 }],
    ['strive:routine_logs:z', { entries: 0, sets: 0 }],
  ]);
});

test('fetchImportState: child counts are exact across id-chunk and page boundaries', async () => {
  const workouts = [], wes = [], sets = [];
  for (let i = 0; i < 60; i++) {
    workouts.push(wk(`w${i}`, { imported: true, source_ref: `strive:routine_logs:${i}` }));
    wes.push({ id: `we${i}`, workout_id: `w${i}`, exercise_id: 'e', position: 0 });
    for (let k = 0; k < 3; k++) sets.push({ id: `s${i}-${k}`, workout_exercise_id: `we${i}` });
  }
  const { ctx } = await mk({ workouts, workout_exercises: wes, sets });
  const s = await gym.fetchImportState(ctx, { pageSize: 7 });
  assert.equal(s.importedRefs.size, 60);
  assert.ok([...s.childCounts.values()].every((c) => c.entries === 1 && c.sets === 3));
  assert.equal(s.childCounts.size, 60);
});

test('fetchImportState: no imported workouts -> empty child counts', async () => {
  const { ctx } = await mk({ workouts: [wk('n', { imported: false, day: '2026-11-20' })] });
  const s = await gym.fetchImportState(ctx);
  assert.equal(s.childCounts.size, 0);
});

test('addWater returns { row, saved } and saved rejects when the enqueue fails', async () => {
  const ok = await mk();
  const r = repo.addWater(ok.ctx, 0.5);
  assert.ok(r.row.id && r.row.liters === 0.5);
  await r.saved;
  const storage = { load: async () => [], save: async () => { throw new Error('disk full'); }, clear: async () => {} };
  const bad = await mk({}, storage);
  const b = repo.addWater(bad.ctx, 0.5);
  await assert.rejects(b.saved, /disk full/);
});

test('memory kv: get/set/del/delPrefix', async () => {
  const kv = createMemoryKv();
  await kv.set('active-workout:1', { a: 1 });
  await kv.set('active-workout:2', 2);
  await kv.set('other', 3);
  assert.deepEqual(await kv.get('active-workout:1'), { a: 1 });
  assert.equal(await kv.get('missing'), undefined);
  await kv.delPrefix('active-workout:');
  assert.equal(await kv.get('active-workout:1'), undefined);
  assert.equal(await kv.get('active-workout:2'), undefined);
  assert.equal(await kv.get('other'), 3);
  await kv.del('other');
  assert.equal(await kv.get('other'), undefined);
});
