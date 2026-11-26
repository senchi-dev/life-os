import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGymRow, GymValidationError } from '../../js/lib/gym-validate.js';

const T0 = '2026-11-24T10:00:00.000Z';
const T1 = '2026-11-24T11:00:00.000Z';
const ID = '048435f3-8745-81e3-9c32-374df0cc9a5c';
const VALID = {
  exercises: { id: ID, name: 'Bench Press', muscle_group: 'chest', equipment: 'barbell', how_to: 'x', is_custom: false },
  routines: { id: ID, name: 'Push' },
  routine_items: { id: ID, routine_id: ID, exercise_id: ID, position: 0, target_sets: 3, target_reps_min: 6, target_reps_max: 10 },
  schedule_slots: { id: ID, weekday: 1, routine_id: null },
  workouts: { id: ID, name: 'Push', day: '2026-11-24', started_at: T0, ended_at: T1, note: '', imported: false, source_ref: null },
  workout_exercises: { id: ID, workout_id: ID, exercise_id: ID, position: 0, note: '' },
  sets: { id: ID, workout_exercise_id: ID, set_no: 1, reps: 8, weight_kg: 82.5, type: 'normal', is_pr: false, done_at: T0 },
};
const BAD = {
  exercises: [{ name: '' }, { name: 'x'.repeat(61) }, { muscle_group: 'legs' }, { equipment: 'kettlebell' }, { how_to: 'x'.repeat(2001) }, { is_custom: undefined }],
  routines: [{ name: 'x'.repeat(41) }, { name: '' }],
  routine_items: [{ target_sets: 0 }, { target_sets: 11 }, { target_reps_min: 0 }, { target_reps_min: 8, target_reps_max: 7 }, { target_reps_max: 101 }, { position: undefined }],
  schedule_slots: [{ weekday: 0 }, { weekday: 8 }],
  workouts: [{ name: '' }, { day: undefined }, { ended_at: '2026-11-24T09:00:00.000Z' }, { note: 'x'.repeat(2001) },
    { imported: true, source_ref: null }, { imported: true, source_ref: 'strive:1', ended_at: null }, { source_ref: 'x'.repeat(81) }],
  workout_exercises: [{ note: 'x'.repeat(501) }, { position: undefined }],
  sets: [{ set_no: 0 }, { set_no: 51 }, { reps: -1 }, { reps: 1001 }, { reps: 1.5 }, { weight_kg: -0.5 }, { weight_kg: 1000.01 },
    { weight_kg: 82.555 }, { type: 'superset' }, { done_at: undefined }],
};

for (const [table, row] of Object.entries(VALID)) {
  test(`${table}: valid row passes, missing id fails`, () => {
    assert.equal(validateGymRow(table, row), null);
    const { id, ...noId } = row;
    assert.equal(validateGymRow(table, noId), 'id');
  });
  test(`${table}: each bad case is rejected with a reason`, () => {
    for (const patch of BAD[table]) {
      const reason = validateGymRow(table, { ...row, ...patch });
      assert.equal(typeof reason, 'string', JSON.stringify(patch));
      assert.ok(Object.keys(patch).some((k) => reason === k || reason === 'source_ref' || reason === 'ended_at'), `${JSON.stringify(patch)} -> ${reason}`);
    }
  });
}

test('accepted edge values', () => {
  assert.equal(validateGymRow('exercises', { ...VALID.exercises, equipment: null }), null);
  assert.equal(validateGymRow('sets', { ...VALID.sets, weight_kg: 0, reps: 0 }), null);
  assert.equal(validateGymRow('sets', { ...VALID.sets, weight_kg: 1000 }), null);
  assert.equal(validateGymRow('workouts', { ...VALID.workouts, imported: true, source_ref: 'strive:routine_logs:1' }), null);
  assert.equal(validateGymRow('workouts', { ...VALID.workouts, ended_at: null }), null);
});

test('non-gym tables are skipped (null), even without an id', () => {
  assert.equal(validateGymRow('habit_logs', { habit_id: 'x' }), null);
  assert.equal(validateGymRow('settings', {}), null);
});

test('GymValidationError carries table and reason', () => {
  const e = new GymValidationError('sets', 'reps');
  assert.ok(e instanceof Error);
  assert.equal(e.table, 'sets');
  assert.equal(e.reason, 'reps');
});
