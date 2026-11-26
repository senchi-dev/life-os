import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exerciseHistoryPage, historyLine, setsForSession, workoutDetailModel, canDeleteWorkout, habitStillChecked, HISTORY_PAGE, isUuid, deleteWarning,
} from '../../js/ui/history-model.js';

const sess = (i, extra = {}) => ({
  workoutId: `w${i}`, weIds: [`we${i}`], name: `Day ${i}`, day: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`,
  startedAt: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(), bestE1rm: 100, workingSets: 3, hasPr: false, ...extra,
});
const indexOf = (n) => ({ exercises: { bench: { sessions: Array.from({ length: n }, (_, i) => sess(i)) } } });
const ST = (we, no, w, r, type = 'normal', extra = {}) => ({ id: `${we}-${no}`, workout_exercise_id: we, set_no: no, weight_kg: w, reps: r, type, done_at: `2026-01-01T10:00:${String(no).padStart(2, '0')}Z`, ...extra });

// ---- paging ----
test('exerciseHistoryPage: 45 sessions page as 20 / 20 / 5, newest first', () => {
  const idx = indexOf(45);
  const p0 = exerciseHistoryPage(idx, 'bench', 0);
  const p1 = exerciseHistoryPage(idx, 'bench', 1);
  const p2 = exerciseHistoryPage(idx, 'bench', 2);
  assert.deepEqual([p0.length, p1.length, p2.length], [20, 20, 5]);
  assert.equal(p0[0].workoutId, 'w44');
  assert.equal(p0[19].workoutId, 'w25');
  assert.equal(p1[0].workoutId, 'w24');
  assert.equal(p2[4].workoutId, 'w0');
  const all = [...p0, ...p1, ...p2].map((s) => s.workoutId);
  assert.equal(new Set(all).size, 45, 'no session twice');
  assert.ok(HISTORY_PAGE === 20);
});

test('exerciseHistoryPage: exact multiple and boundaries', () => {
  assert.deepEqual([0, 1, 2].map((p) => exerciseHistoryPage(indexOf(40), 'bench', p).length), [20, 20, 0]);
  assert.equal(exerciseHistoryPage(indexOf(20), 'bench', 0).length, 20);
  assert.equal(exerciseHistoryPage(indexOf(20), 'bench', 1).length, 0);
  assert.equal(exerciseHistoryPage(indexOf(21), 'bench', 1).length, 1);
  assert.equal(exerciseHistoryPage(indexOf(0), 'bench', 0).length, 0);
});

test('exerciseHistoryPage: sorts by startedAt even when the index is out of order; does not mutate', () => {
  const idx = { exercises: { b: { sessions: [sess(5), sess(1), sess(9)] } } };
  const before = JSON.stringify(idx);
  assert.deepEqual(exerciseHistoryPage(idx, 'b', 0).map((s) => s.workoutId), ['w9', 'w5', 'w1']);
  assert.equal(JSON.stringify(idx), before);
});

test('exerciseHistoryPage: invalid input is guarded', () => {
  const idx = indexOf(45);
  for (const page of [-1, 1.5, NaN, Infinity, '1', null, undefined, {}]) assert.deepEqual(exerciseHistoryPage(idx, 'bench', page), [], `page ${String(page)}`);
  for (const size of [0, -5, 2.5, NaN, Infinity, '20', null]) assert.deepEqual(exerciseHistoryPage(idx, 'bench', 0, size), [], `size ${String(size)}`);
  assert.deepEqual(exerciseHistoryPage(idx, 'nope', 0), []);
  for (const id of ['constructor', '__proto__', 'toString', '', null, undefined, 7]) assert.deepEqual(exerciseHistoryPage(idx, id, 0), [], String(id));
  for (const bad of [null, undefined, {}, { exercises: null }, { exercises: { bench: {} } }, { exercises: { bench: { sessions: 'x' } } }]) assert.deepEqual(exerciseHistoryPage(bad, 'bench', 0), []);
  assert.equal(exerciseHistoryPage(idx, 'bench', 0, 7).length, 7);
  assert.equal(exerciseHistoryPage(idx, 'bench', 6, 7).length, 3);
});

// ---- historyLine ----
test('historyLine: working sets, e1RM one decimal, day label, name', () => {
  const s = sess(0, { day: '2026-11-23', name: 'Upper Force' });
  const sets = [ST('we0', 1, 80, 8), ST('we0', 2, 80, 8), ST('we0', 3, 80, 7)];
  assert.deepEqual(historyLine(s, sets), { day: 'Mon 23 Nov', name: 'Upper Force', sets: '80×8  80×8  80×7', e1rm: '101.3', pr: false });
});

test('historyLine: warm-ups shown with W prefix but excluded from e1RM', () => {
  const sets = [ST('we0', 1, 200, 3, 'warmup'), ST('we0', 2, 80, 8)];
  const l = historyLine(sess(0), sets);
  assert.equal(l.sets, 'W 200×3  80×8');
  assert.equal(l.e1rm, '101.3', 'warm-up 200x3 must not count');
  assert.equal(historyLine(sess(0), [ST('we0', 1, 60, 10, 'warmup')]).e1rm, '—', 'warm-up only');
});

test('historyLine: reps over 12 give no e1RM; 12 reps still do', () => {
  assert.equal(historyLine(sess(0), [ST('we0', 1, 50, 15)]).e1rm, '—');
  assert.equal(historyLine(sess(0), [ST('we0', 1, 50, 12)]).e1rm, '70.0');
  assert.equal(historyLine(sess(0), [ST('we0', 1, 50, 13), ST('we0', 2, 60, 5)]).e1rm, '70.0', 'best of the eligible sets');
  assert.equal(historyLine(sess(0), [ST('we0', 1, 100, 1)]).e1rm, '100.0');
});

test('historyLine: bodyweight, drop and failure labels, orders by done_at then set_no', () => {
  const l = historyLine(sess(0), [ST('we0', 1, 0, 12)]);
  assert.equal(l.sets, 'BW×12');
  assert.equal(l.e1rm, '—', 'bodyweight has no e1RM');
  const m = historyLine(sess(0), [ST('we0', 3, 60, 8, 'dropset'), ST('we0', 2, 80, 6, 'failure'), ST('we0', 1, 82.5, 8)]);
  assert.equal(m.sets, '82.5×8  F 80×6  D 60×8');
});

test('historyLine: empty or bad input never throws', () => {
  assert.equal(historyLine(sess(0), []).sets, '—');
  assert.equal(historyLine(sess(0), undefined).sets, '—');
  assert.equal(historyLine(sess(0), []).e1rm, '—');
  assert.equal(historyLine({ day: 'garbage', startedAt: 'x' }, []).day, '—');
  assert.equal(historyLine({}, null).name, 'Workout');
  assert.equal(historyLine(sess(0, { name: 'A' }), [], 'Passed').name, 'Passed', 'A10: name parameter wins');
  assert.equal(historyLine(sess(0, { hasPr: true }), []).pr, true);
});

test('historyLine: day label uses the stored local day, not a UTC slice', () => {
  // 23:30 UTC on 22 Nov is already the 23rd in Paris/Auckland; the stored local day decides.
  const s = sess(0, { day: '2026-11-23', startedAt: '2026-11-22T23:30:00Z' });
  assert.equal(historyLine(s, []).day, 'Mon 23 Nov');
  const s2 = sess(0, { day: '2026-11-22', startedAt: '2026-11-22T23:30:00Z' });
  assert.equal(historyLine(s2, []).day, 'Sun 22 Nov');
});

test('setsForSession picks only the session entries', () => {
  const s = sess(0, { weIds: ['a', 'b'] });
  const sets = [ST('a', 1, 1, 1), ST('b', 1, 2, 2), ST('c', 1, 3, 3)];
  assert.deepEqual(setsForSession(s, sets).map((x) => x.workout_exercise_id), ['a', 'b']);
  assert.deepEqual(setsForSession(s, null), []);
  assert.deepEqual(setsForSession(null, sets), []);
});

// ---- workout detail ----
const WORKOUT = { id: 'w1', name: 'Upper Force', day: '2026-11-23', started_at: '2026-11-23T08:00:00Z', ended_at: '2026-11-23T09:05:00Z', note: 'Felt good\nsecond line' };
const WES = [{ id: 'e2', workout_id: 'w1', exercise_id: 'row', position: 1, note: '' }, { id: 'e1', workout_id: 'w1', exercise_id: 'bench', position: 0, note: 'Pause reps' }];
const EXS = [{ id: 'bench', name: 'Bench Press' }, { id: 'row', name: 'Row' }];

test('workoutDetailModel: header, ordered entries, PR marks from stored is_pr', () => {
  const sets = [ST('e1', 1, 60, 10, 'warmup'), ST('e1', 2, 80, 8, 'normal', { is_pr: true }), ST('e1', 3, 80, 7), ST('e2', 1, 0, 12, 'normal', { is_pr: false })];
  const m = workoutDetailModel({ workout: WORKOUT, workoutExercises: WES, sets, exercises: EXS });
  assert.equal(m.name, 'Upper Force');
  assert.equal(m.dayLabel, 'Mon 23 Nov');
  assert.equal(m.duration, '1h05');
  assert.equal(m.note, 'Felt good\nsecond line');
  assert.equal(m.inProgress, false);
  assert.deepEqual(m.exercises.map((e) => e.name), ['Bench Press', 'Row']);
  assert.equal(m.exercises[0].note, 'Pause reps');
  const b = m.exercises[0].sets;
  assert.deepEqual(b.map((s) => [s.num, s.text, s.pr, s.code]), [[null, '60 × 10', false, 'W'], [1, '80 × 8', true, null], [2, '80 × 7', false, null]]);
  assert.equal(m.exercises[1].sets[0].text, 'BW × 12');
});

test('workoutDetailModel: imported/unknown shapes display, a warm-up never shows PR, unknown exercise has a name', () => {
  const sets = [ST('e1', 1, 60, 10, 'warmup', { is_pr: true }), ST('e1', 2, 80, 8)];
  const wo = { ...WORKOUT, imported: true, duration_known: false, note: null };
  const m = workoutDetailModel({ workout: wo, workoutExercises: [WES[1], { id: 'e3', workout_id: 'w1', exercise_id: 'gone', position: 5 }], sets, exercises: EXS });
  assert.equal(m.duration, '—');
  assert.equal(m.note, '');
  assert.equal(m.exercises[0].sets[0].pr, false);
  assert.equal(m.exercises[1].name, 'Exercise');
  assert.deepEqual(m.exercises[1].sets, []);
  assert.equal(workoutDetailModel({ workout: { ...WORKOUT, day: 'x' } }).dayLabel, '—');
  assert.deepEqual(workoutDetailModel({ workout: WORKOUT }).exercises, []);
  assert.equal(workoutDetailModel({ workout: { ...WORKOUT, ended_at: null } }).inProgress, true);
});

test('canDeleteWorkout: finished yes, the active (unfinished) one never', () => {
  assert.equal(canDeleteWorkout(WORKOUT), true);
  assert.equal(canDeleteWorkout({ ...WORKOUT, ended_at: null }), false);
  assert.equal(canDeleteWorkout({ ...WORKOUT, ended_at: undefined }), false);
  assert.equal(canDeleteWorkout(null), false);
  assert.equal(canDeleteWorkout({ ended_at: 'x' }), false, 'no id');
  assert.equal(canDeleteWorkout(WORKOUT, { draft: { workout: { id: 'w1' } } }), false, 'open draft of this workout');
  assert.equal(canDeleteWorkout(WORKOUT, { draft: { workout: { id: 'other' } } }), true);
});

// ---- Gym still checked ----
const snap = (over = {}) => ({
  settings: { gym_habit_id: 'g' },
  habitLogs: [{ habit_id: 'g', date: '2026-11-23', status: 'done' }],
  workouts: [WORKOUT],
  ...over,
});
test('habitStillChecked: sole done workout of the day with a ticked Gym habit => notice', () => {
  assert.equal(habitStillChecked({ snapshot: snap(), workout: WORKOUT, index: null }), true);
});
test('habitStillChecked: no notice when there is nothing left to be stale', () => {
  assert.equal(habitStillChecked({ snapshot: snap({ habitLogs: [] }), workout: WORKOUT }), false, 'no log');
  assert.equal(habitStillChecked({ snapshot: snap({ habitLogs: [{ habit_id: 'g', date: '2026-11-23', status: 'skipped' }] }), workout: WORKOUT }), false, 'not done');
  assert.equal(habitStillChecked({ snapshot: snap({ habitLogs: [{ habit_id: 'g', date: '2026-11-22', status: 'done' }] }), workout: WORKOUT }), false, 'other day');
  assert.equal(habitStillChecked({ snapshot: snap({ habitLogs: [{ habit_id: 'x', date: '2026-11-23', status: 'done' }] }), workout: WORKOUT }), false, 'other habit');
  assert.equal(habitStillChecked({ snapshot: snap({ settings: {} }), workout: WORKOUT }), false, 'no gym habit');
  assert.equal(habitStillChecked({ snapshot: null, workout: WORKOUT }), false);
  assert.equal(habitStillChecked({ snapshot: snap(), workout: null }), false);
});
test('habitStillChecked: another done workout with working sets the same day keeps the tick legitimate', () => {
  const other = { id: 'w2', name: 'PM', day: '2026-11-23', started_at: '2026-11-23T17:00:00Z', ended_at: '2026-11-23T18:00:00Z' };
  const s = snap({ workouts: [WORKOUT, other] });
  assert.equal(habitStillChecked({ snapshot: s, workout: WORKOUT, index: null }), false, 'no index: assume it counts');
  const idxWith = { exercises: { bench: { sessions: [{ workoutId: 'w2', workingSets: 3 }] } } };
  assert.equal(habitStillChecked({ snapshot: s, workout: WORKOUT, index: idxWith }), false);
  const idxWarm = { workoutIds: ['w2'], exercises: { bench: { sessions: [{ workoutId: 'w2', workingSets: 0 }] } } };
  assert.equal(habitStillChecked({ snapshot: s, workout: WORKOUT, index: idxWarm }), true, 'other is warm-up only');
  const active = { ...other, ended_at: null };
  assert.equal(habitStillChecked({ snapshot: snap({ workouts: [WORKOUT, active] }), workout: WORKOUT }), true, 'an unfinished workout does not count');
});

test('isUuid: only uuid-shaped ids go to the server', () => {
  assert.equal(isUuid('3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'), true);
  assert.equal(isUuid('3F2B8C1E-5D4A-4E6F-9A7B-1C2D3E4F5A6B'), true);
  for (const v of ['nope', '', null, undefined, 7, '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6', 'x'.repeat(36), '../x']) assert.equal(isUuid(v), false, String(v));
});

test('deleteWarning: imported workouts mention that a Strive re-import restores them', () => {
  assert.match(deleteWarning({ imported: false }), /cannot be undone/);
  assert.doesNotMatch(deleteWarning({ imported: false }), /Strive/);
  assert.match(deleteWarning({ imported: true }), /Strive/);
  assert.match(deleteWarning(null), /cannot be undone/);
});
