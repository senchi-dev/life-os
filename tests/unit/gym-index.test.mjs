import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, applyWorkouts, missingWorkoutIds, prevFor } from '../../js/lib/gym-index.js';

const W = (id, day, ended = true) => ({ id, name: `W${id}`, day, started_at: `${day}T08:00:00Z`,
  ended_at: ended ? `${day}T09:00:00Z` : null });
const WE = (id, workout_id, exercise_id = 'bench') => ({ id, workout_id, exercise_id });
let n = 0;
const ST = (we, no, w, r, type = 'normal') => ({ id: `s${++n}`, workout_exercise_id: we, set_no: no,
  weight_kg: w, reps: r, type, done_at: `2026-01-01T10:00:${String(no).padStart(2, '0')}Z` });

const rows = () => ({
  workouts: [W('a', '2026-01-01'), W('b', '2026-01-08'), W('c', '2026-01-15', false)],
  workoutExercises: [WE('a1', 'a'), WE('b1', 'b'), WE('c1', 'c')],
  sets: [ST('a1', 1, 80, 8), ST('a1', 2, 82.5, 8), ST('a1', 3, 85, 5), ST('a1', 4, 80, 10),
    ST('b1', 2, 80, 8), ST('b1', 1, 60, 5, 'warmup'), ST('b1', 3, 82.5, 9),
    ST('c1', 1, 200, 1)],
});

test('buildIndex: finished only, last, front, sessions', () => {
  const idx = buildIndex(rows());
  assert.equal(idx.version, 1);
  assert.deepEqual(idx.workoutIds.sort(), ['a', 'b']);
  const ex = idx.exercises.bench;
  assert.deepEqual(ex.last.sets, [{ weight_kg: 80, reps: 8, type: 'normal' }, { weight_kg: 82.5, reps: 9, type: 'normal' }]);
  assert.equal(ex.last.workoutId, 'b');
  assert.deepEqual(ex.sessions.map((s) => s.workoutId), ['a', 'b']);
  assert.equal(ex.sessions[0].hasPr, false);
  assert.equal(ex.sessions[1].hasPr, true);
  assert.equal(ex.sessions[1].name, 'Wb');
  assert.deepEqual(ex.sessions[0].top, { w: 85, r: 5 });
  assert.equal(ex.sessions[0].workingSets, 4);
  assert.deepEqual(ex.sessions[0].weIds, ['a1']);
});

test('front for (80,8),(82.5,8),(85,5),(80,10)', () => {
  const r = rows();
  r.workouts = [r.workouts[0]];
  const idx = buildIndex(r);
  assert.deepEqual(idx.exercises.bench.front, [{ w: 85, r: 5 }, { w: 82.5, r: 8 }, { w: 80, r: 10 }]);
});

test('applyWorkouts adds newer workout; missingWorkoutIds', () => {
  const base = rows();
  const idx = buildIndex({ ...base, workouts: base.workouts.slice(0, 1) });
  assert.deepEqual(missingWorkoutIds(idx, base.workouts), ['b']);
  const next = applyWorkouts(idx, base);
  assert.deepEqual(next.exercises.bench.sessions.map((s) => s.workoutId), ['a', 'b']);
  assert.equal(next.exercises.bench.last.workoutId, 'b');
  assert.equal(next.exercises.bench.sessions[1].hasPr, true);
  assert.deepEqual(missingWorkoutIds(next, base.workouts), []);
  assert.equal(idx.exercises.bench.sessions.length, 1, 'input not mutated');
  assert.deepEqual(prevFor(next, 'bench'), next.exercises.bench.last.sets);
  assert.deepEqual(prevFor(next, 'zzz'), []);
});

test('applyWorkouts replaces an already indexed workout', () => {
  const base = rows();
  const idx = buildIndex(base);
  const edited = { workouts: [W('b', '2026-01-08')], workoutExercises: [WE('b1', 'b')],
    sets: [ST('b1', 1, 82.5, 9)] };
  const next = applyWorkouts(idx, edited);
  assert.equal(next.exercises.bench.sessions.length, 2);
  assert.deepEqual(next.exercises.bench.last.sets, [{ weight_kg: 82.5, reps: 9, type: 'normal' }]);
});

import { canApplyIncrementally } from '../../js/lib/gym-index.js';

test('canApplyIncrementally: newer true, older false, replaced false', () => {
  const base = rows();
  const idx = buildIndex({ ...base, workouts: base.workouts.slice(0, 2) });
  const newer = W('d', '2026-02-01');
  const older = W('z', '2025-12-01');
  const wes = [WE('d1', 'd'), WE('z1', 'z')];
  assert.equal(canApplyIncrementally(idx, [newer], wes), true);
  assert.equal(canApplyIncrementally(idx, [older], wes), false);
  assert.equal(canApplyIncrementally(idx, [W('b', '2026-01-08')], wes), false);
  assert.equal(canApplyIncrementally(idx, [W('e', '2026-02-02', false)], wes), true, 'active ignored');
});

test('buildIndex is correct for out-of-order and downward edits', () => {
  const r = {
    workouts: [W('a', '2026-01-01'), W('b', '2026-01-08'), W('z', '2025-12-01')],
    workoutExercises: [WE('a1', 'a'), WE('b1', 'b'), WE('z1', 'z')],
    sets: [ST('a1', 1, 80, 8), ST('b1', 1, 82.5, 8), ST('z1', 1, 70, 8)],
  };
  const ex = buildIndex(r).exercises.bench;
  assert.deepEqual(ex.sessions.map((s) => [s.workoutId, s.hasPr]), [['z', false], ['a', true], ['b', true]]);
  assert.equal(ex.last.workoutId, 'b');
  assert.deepEqual(ex.front, [{ w: 82.5, r: 8 }]);
  // edit b down to warm-up only: last falls back to a
  const edited = { ...r, sets: [ST('a1', 1, 80, 8), ST('b1', 1, 82.5, 8, 'warmup'), ST('z1', 1, 70, 8)] };
  const ex2 = buildIndex(edited).exercises.bench;
  assert.equal(ex2.last.workoutId, 'a');
  assert.deepEqual(ex2.front, [{ w: 80, r: 8 }]);
});
