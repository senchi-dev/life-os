import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyActions } from '../../js/ui/history-view.js';
import { dropWorkoutFromIndex, buildIndex } from '../../js/lib/gym-index.js';
import { viewFor } from '../../js/ui/gym-view.js';
import { readFileSync } from 'node:fs';

const W = (id, day, ended = true) => ({ id, name: `W${id}`, day, started_at: `${day}T08:00:00Z`, ended_at: ended ? `${day}T09:00:00Z` : null });
const mk = (over = {}) => {
  const calls = [];
  const w1 = W('w1', '2026-11-23');
  const app = {
    rerendered: 0, rerender() { this.rerendered++; },
    snapshot: { settings: { gym_habit_id: 'g' }, habitLogs: [{ habit_id: 'g', date: '2026-11-23', status: 'done' }], workouts: [w1, W('w2', '2026-11-20'), W('w3', '2026-11-25', false)] },
    ctx: { outbox: { async enqueue(op) { if (over.fail) throw new Error('x'); calls.push(['enqueue', op]); }, async flush() { calls.push(['flush']); if (over.flushFail) throw new Error('offline'); }, pending: () => over.pending ?? 0 } },
    gym: {
      draft: () => over.draft ?? null, index: () => null,
      async rebuildIndex() { calls.push(['rebuild']); if (over.rebuildFail) throw new Error('r'); },
      forgetWorkout(id) { calls.push(['forget', id]); },
    },
  };
  return { app, calls, act: historyActions(app) };
};

test('deleteWorkout: removes the row, patches the snapshot, flushes, then rebuilds the index (in that order)', async () => {
  const { app, calls, act } = mk();
  const r = await act.deleteWorkout('w1');
  assert.equal(r.ok, true);
  assert.equal(r.habitNotice, true, 'sole workout of a ticked Gym day');
  assert.deepEqual(app.snapshot.workouts.map((w) => w.id), ['w2', 'w3']);
  await r.settled;
  // enqueueGym kicks its own flush after the enqueue; ours follows the index bookkeeping
  assert.deepEqual(calls.map((c) => c[0]), ['enqueue', 'flush', 'forget', 'flush', 'rebuild']);
  assert.deepEqual(calls[0][1], { kind: 'remove', table: 'workouts', eq: { id: 'w1' } });
});

test('deleteWorkout resolves even if the flush never finishes (a slow network does not freeze the screen)', async () => {
  const { app, act } = mk();
  app.ctx.outbox.flush = () => new Promise(() => {});
  const r = await act.deleteWorkout('w1');
  assert.equal(r.ok, true);
});

test('deleteWorkout: queued but not flushed (offline) => no rebuild now, index is flagged stale instead', async () => {
  const { calls, act } = mk({ pending: 1 });
  const r = await act.deleteWorkout('w1');
  assert.equal(r.ok, true);
  await r.settled;
  assert.deepEqual(calls.map((c) => c[0]), ['enqueue', 'flush', 'forget', 'flush']);
  assert.ok(!calls.some((c) => c[0] === 'rebuild'));
});

test('deleteWorkout: a rejected flush or rebuild is not a failed delete (the op is queued)', async () => {
  const a = mk({ flushFail: true });
  const ra = await a.act.deleteWorkout('w1');
  assert.equal(ra.ok, true);
  await ra.settled;
  const b = mk({ rebuildFail: true });
  const r = await b.act.deleteWorkout('w1');
  assert.equal(r.ok, true);
  await r.settled;
  assert.deepEqual(b.app.snapshot.workouts.map((w) => w.id), ['w2', 'w3']);
});

test('deleteWorkout: queue failure rolls the snapshot back and reports it', async () => {
  const { app, calls, act } = mk({ fail: true });
  const r = await act.deleteWorkout('w1');
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not delete/);
  assert.deepEqual(app.snapshot.workouts.map((w) => w.id), ['w1', 'w2', 'w3']);
  assert.deepEqual(calls, [], 'index not touched when nothing was queued');
});

test('deleteWorkout: the active (unfinished) workout and an open draft are never deleted', async () => {
  const { app, calls, act } = mk();
  const r = await act.deleteWorkout('w3');
  assert.deepEqual([r.ok, r.error], [false, 'Finish or discard it from the workout screen.']);
  assert.equal(app.snapshot.workouts.length, 3);
  assert.deepEqual(calls, []);
  const d = mk({ draft: { workout: { id: 'w1' } } });
  assert.equal((await d.act.deleteWorkout('w1')).ok, false);
  assert.equal(d.calls.length, 0);
});

test('deleteWorkout: unknown ids and double taps', async () => {
  const { calls, act } = mk();
  assert.equal((await act.deleteWorkout('nope')).ok, false, 'not in the snapshot window: caller passes the fetched row');
  assert.equal((await act.deleteWorkout('')).ok, false);
  assert.equal((await act.deleteWorkout(null)).ok, false);
  assert.deepEqual(calls, []);
  const m = mk();
  const [a, b] = await Promise.all([m.act.deleteWorkout('w1'), m.act.deleteWorkout('w1')]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, 'second tap is ignored while in flight');
  assert.equal(m.calls.filter((c) => c[0] === 'enqueue').length, 1);
});

test('deleteWorkout: an older workout outside the snapshot window can be deleted with its fetched row', async () => {
  const { app, calls, act } = mk();
  const old = W('old', '2026-01-02');
  const r = await act.deleteWorkout('old', old);
  assert.equal(r.ok, true);
  assert.equal(r.habitNotice, false);
  assert.equal(app.snapshot.workouts.length, 3);
  assert.deepEqual(calls[0][1].eq, { id: 'old' });
  assert.equal((await mk().act.deleteWorkout('old', { ...old, ended_at: null })).ok, false);
});

// ---- index: dropWorkoutFromIndex ----
const WE = (id, workout_id, exercise_id = 'bench') => ({ id, workout_id, exercise_id });
const ST = (we, no, w, r) => ({ id: `${we}-${no}`, workout_exercise_id: we, set_no: no, weight_kg: w, reps: r, type: 'normal', done_at: `2026-01-01T10:00:0${no}Z` });
test('dropWorkoutFromIndex removes the sessions of one workout and empty exercises, without mutating', () => {
  const idx = buildIndex({ workouts: [W('a', '2026-01-01'), W('b', '2026-01-08')], workoutExercises: [WE('a1', 'a'), WE('b1', 'b'), WE('b2', 'b', 'row')], sets: [ST('a1', 1, 80, 8), ST('b1', 1, 85, 8), ST('b2', 1, 50, 8)] });
  const before = JSON.stringify(idx);
  const next = dropWorkoutFromIndex(idx, 'b');
  assert.equal(JSON.stringify(idx), before);
  assert.deepEqual(next.workoutIds, ['a']);
  assert.deepEqual(next.exercises.bench.sessions.map((s) => s.workoutId), ['a']);
  assert.equal(next.exercises.row, undefined);
  assert.deepEqual(dropWorkoutFromIndex(idx, 'zzz').workoutIds.sort(), ['a', 'b'], 'unknown id: unchanged content');
  assert.equal(dropWorkoutFromIndex(null, 'a'), null);
});

// ---- routing / wiring ----
test('viewFor: history routes to the history view, odd ids do not crash', () => {
  assert.deepEqual(viewFor(['history', 'abc-123']), { view: 'history', id: 'abc-123' });
  for (const id of ['nope', '%E0%A4%A', 'a b', '../x', '__proto__']) assert.deepEqual(viewFor(['history', id]), { view: 'history', id });
  assert.deepEqual(viewFor(['history', '']), { view: 'home' });
});
test('wiring: gym-view uses the real history view, app.js the real exercise view, both in the SHELL', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(read('js/ui/gym-view.js'), /renderHistory/);
  assert.doesNotMatch(read('js/ui/gym-view.js'), /stub\('Workout'\)/);
  assert.doesNotMatch(read('js/ui/gym-view.js'), /export const renderExercise = page/);
  assert.match(read('js/app.js'), /renderExercise.*exercise-view\.js/);
  const sw = read('sw.js');
  for (const f of ['js/ui/exercise-view.js', 'js/ui/history-view.js', 'js/ui/history-model.js']) assert.ok(sw.includes(`'${f}'`), f);
});
