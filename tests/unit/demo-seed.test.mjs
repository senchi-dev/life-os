import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSeed } from '../../js/data/demo-seed.js';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { GYM_TABLES } from '../../js/data/tables.js';

const seed = demoSeed('2026-11-24');

test('every demo gym row validates', () => {
  for (const t of GYM_TABLES) for (const r of seed[t] ?? []) assert.equal(validateGymRow(t, r), null, `${t} ${JSON.stringify(r)}`);
});
test('library, routines and references', () => {
  assert.equal(seed.exercises.length, 72);
  const ex = new Set(seed.exercises.map((e) => e.id));
  assert.equal(seed.routines.length, 2);
  assert.deepEqual(seed.routines.map((r) => [r.name, r.sort]), [['Upper', 0], ['Lower', 1]]);
  const items = (n) => seed.routine_items.filter((i) => i.routine_id === seed.routines.find((r) => r.name === n).id);
  assert.equal(items('Upper').length, 6);
  assert.equal(items('Lower').length, 5);
  assert.ok(seed.routine_items.every((i) => ex.has(i.exercise_id)));
  assert.ok(seed.workout_exercises.every((x) => ex.has(x.exercise_id)));
});
test('schedule slots U L - U L - -', () => {
  assert.deepEqual(seed.schedule_slots.map((s) => s.weekday), [1, 2, 3, 4, 5, 6, 7]);
  const withRoutine = seed.schedule_slots.filter((s) => s.routine_id).map((s) => s.weekday);
  assert.deepEqual(withRoutine, [1, 2, 4, 5]);
  assert.ok(seed.schedule_slots.every((s) => s.user_id === 'demo-user'));
});
test('workouts: 6 finished + 1 imported, none active, sets 3-4 per exercise', () => {
  assert.equal(seed.workouts.filter((w) => w.imported).length, 1);
  assert.equal(seed.workouts.find((w) => w.imported).source_ref, 'demo:1');
  assert.equal(seed.workouts.filter((w) => !w.imported).length, 6);
  assert.ok(seed.workouts.every((w) => w.ended_at != null));
  const native = seed.workouts.filter((w) => !w.imported);
  assert.deepEqual(native.map((w) => w.name), ['Upper', 'Lower', 'Upper', 'Lower', 'Upper', 'Lower']);
  assert.equal(seed.sets.filter((s) => s.type === 'dropset').length, 1);
  assert.equal(seed.sets.filter((s) => s.type === 'warmup').length, 1);
  const weIds = new Set(seed.workout_exercises.map((x) => x.id));
  assert.ok(seed.sets.every((s) => weIds.has(s.workout_exercise_id)));
});
test('settings and French how-to', () => {
  const gym = seed.habits.find((h) => h.name === 'Gym');
  assert.ok(seed.settings[0].gym_seeded_at);
  assert.equal(seed.settings[0].gym_habit_id, gym.id);
  assert.equal(seed.exercises.find((e) => e.name === 'Lateral Raise').how_to,
    'Exécution : poulie à hauteur de visage, coudes légèrement fléchis.\nNe pas balancer le buste.');
});
