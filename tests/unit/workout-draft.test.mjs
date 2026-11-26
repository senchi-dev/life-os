import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { startDraft, reduce as rawReduce, finishOps as rawFinish, discardOps, untickedWithValues, draftSummary,
  reconcileDraft, draftFromServer } from '../../js/lib/workout-draft.js';

// Every op row must pass the real validator (a rejected row would stall the outbox);
// every reduce call must leave its input draft untouched (deep-frozen + JSON compare).
function checkOps(ops) {
  for (const op of ops) {
    if (op.kind !== 'upsert') continue;
    for (const row of op.rows) assert.equal(validateGymRow(op.table, row), null, `${op.table} row invalid: ${JSON.stringify(row)}`);
  }
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
function reduce(draft, action, c) {
  const before = JSON.stringify(draft);
  deepFreeze(draft);
  const r = rawReduce(draft, action, c);
  assert.equal(JSON.stringify(draft), before, 'input draft mutated by ' + action.kind);
  checkOps(r.ops);
  return r;
}
function finishOps(draft, o) { const r = rawFinish(draft, o); checkOps(r.ops); return r; }

const NOW = new Date(2026, 10, 24, 10, 0, 0);
const iso = (d) => d.toISOString();
const counter = () => { let n = 0; return () => `id${++n}`; };
const exById = { bp: { id: 'bp', equipment: 'barbell' }, sq: { id: 'sq', equipment: 'barbell' }, pu: { id: 'pu', equipment: 'bodyweight' } };
const index = { workoutIds: [], exercises: {
  bp: { last: { sets: [{ weight_kg: 80, reps: 8, type: 'normal' }] } } } };
const routine = { id: 'R1', name: 'Day 1 - Upper' };
const items = [
  { exercise_id: 'sq', position: 1, target_sets: 2, target_reps_min: 5 },
  { exercise_id: 'bp', position: 0, target_sets: 3, target_reps_min: 8 },
];
const ctx = (extra = {}) => ({ now: NOW, newId: counter(), exercisesById: exById, index, ...extra });
const fresh = () => { const r = startDraft({ routine, items, exercisesById: exById, index, userId: 'u1', now: NOW, newId: counter() }); checkOps(r.ops); return r; };

test('startDraft: exact ops, prefill, order, day', () => {
  const { draft, ops } = fresh();
  assert.equal(draft.v, 1);
  assert.equal(draft.workout.name, 'Day 1 - Upper');
  assert.equal(draft.workout.day, '2026-11-24');
  assert.deepEqual(draft.exercises.map((e) => e.exercise_id), ['bp', 'sq']);
  assert.deepEqual(draft.exercises[0].sets.map((s) => [s.kg, s.reps, s.done, s.set_no]), [[80, 8, false, 1], [80, 8, false, 2], [80, 8, false, 3]]);
  assert.deepEqual(draft.exercises[1].sets.map((s) => [s.kg, s.reps]), [[null, 5], [null, 5]]);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0], { kind: 'upsert', table: 'workouts', onConflict: 'id', rows: [{
    id: draft.workout.id, routine_id: 'R1', name: 'Day 1 - Upper', day: '2026-11-24', started_at: iso(NOW),
    ended_at: null, duration_known: true, note: '', imported: false, source_ref: null }] });
  assert.deepEqual(ops[1].rows, draft.exercises.map((e, i) => ({ id: e.id, workout_id: draft.workout.id, exercise_id: e.exercise_id, position: i, note: '' })));
  assert.equal(ops[1].table, 'workout_exercises');
});

test('startDraft: no routine, no items => name Workout, one op', () => {
  const r = startDraft({ routine: null, items: [], exercisesById: exById, index, userId: 'u1', now: NOW, newId: counter() });
  assert.equal(r.draft.workout.name, 'Workout');
  assert.equal(r.draft.workout.routine_id, null);
  assert.equal(r.ops.length, 1);
});

test('tick: kg null => kg-required; reps null => reps-required; valid => upsert', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0], sq = draft.exercises[1];
  let r = reduce(draft, { kind: 'tick', weId: sq.id, setId: sq.sets[0].id }, ctx());
  assert.equal(r.error, 'kg-required'); assert.deepEqual(r.ops, []); assert.equal(r.draft.exercises[1].sets[0].done, false);
  r = reduce(draft, { kind: 'edit', weId: bp.id, setId: bp.sets[0].id, field: 'reps', value: null }, ctx());
  r = reduce(r.draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx());
  assert.equal(r.error, 'reps-required'); assert.deepEqual(r.ops, []);
  r = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx());
  assert.equal(r.error, undefined);
  assert.deepEqual(r.ops, [{ kind: 'upsert', table: 'sets', onConflict: 'id', rows: [{
    id: bp.sets[0].id, workout_exercise_id: bp.id, set_no: 1, reps: 8, weight_kg: 80, type: 'normal', is_pr: false, done_at: iso(NOW) }] }]);
  assert.equal(r.draft.lastTickAt, iso(NOW));
  assert.equal(draft.exercises[0].sets[0].done, false, 'input draft not mutated');
});

test('edit: done set upserts, undone set no op', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0];
  let r = reduce(draft, { kind: 'edit', weId: bp.id, setId: bp.sets[0].id, field: 'kg', value: 82.5 }, ctx());
  assert.deepEqual(r.ops, []); assert.equal(r.draft.exercises[0].sets[0].kg, 82.5);
  r = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx());
  r = reduce(r.draft, { kind: 'edit', weId: bp.id, setId: bp.sets[0].id, field: 'reps', value: 6 }, ctx());
  assert.equal(r.ops.length, 1); assert.equal(r.ops[0].rows[0].reps, 6);
});

test('untick removes the set row; setType upserts only when done', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0], s = bp.sets[0];
  let r = reduce(draft, { kind: 'setType', weId: bp.id, setId: s.id, type: 'warmup' }, ctx());
  assert.deepEqual(r.ops, []); assert.equal(r.draft.exercises[0].sets[0].type, 'warmup');
  r = reduce(draft, { kind: 'tick', weId: bp.id, setId: s.id }, ctx());
  r = reduce(r.draft, { kind: 'setType', weId: bp.id, setId: s.id, type: 'warmup' }, ctx());
  assert.equal(r.ops[0].rows[0].type, 'warmup');
  r = reduce(r.draft, { kind: 'untick', weId: bp.id, setId: s.id }, ctx());
  assert.deepEqual(r.ops, [{ kind: 'remove', table: 'sets', eq: { id: s.id } }]);
  assert.equal(r.draft.exercises[0].sets[0].done, false);
  assert.equal(r.draft.exercises[0].sets[0].done_at, null);
});

test('addSet copies last row, no op', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0];
  const r = reduce(draft, { kind: 'addSet', weId: bp.id }, ctx());
  assert.deepEqual(r.ops, []);
  const sets = r.draft.exercises[0].sets;
  assert.equal(sets.length, 4);
  assert.deepEqual([sets[3].set_no, sets[3].kg, sets[3].reps, sets[3].type, sets[3].done], [4, 80, 8, 'normal', false]);
});

function threeDone() {
  let { draft } = fresh();
  const bp = draft.exercises[0];
  for (const s of bp.sets) draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: s.id }, ctx()).draft;
  return draft;
}

test('removeSet middle then undo: renumber ops both ways', () => {
  const d0 = threeDone();
  const bp = d0.exercises[0];
  const [a, b, c] = bp.sets;
  let r = reduce(d0, { kind: 'removeSet', weId: bp.id, setId: b.id }, ctx());
  assert.equal(r.ops.length, 2);
  assert.deepEqual(r.ops[0], { kind: 'remove', table: 'sets', eq: { id: b.id } });
  assert.equal(r.ops[1].kind, 'upsert');
  assert.deepEqual(r.ops[1].rows.map((x) => [x.id, x.set_no]), [[c.id, 2]]);
  assert.deepEqual(r.draft.exercises[0].sets.map((s) => s.set_no), [1, 2]);
  assert.equal(r.draft.undo.length, 1);
  r = reduce(r.draft, { kind: 'undo' }, ctx());
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.ops[0].rows.map((x) => [x.id, x.set_no]), [[b.id, 2], [c.id, 3]]);
  assert.deepEqual(r.draft.exercises[0].sets.map((s) => s.id), [a.id, b.id, c.id]);
  assert.equal(r.draft.undo.length, 0);
});

test('removeSet last undone set: no ops, renumber untouched; undo restores locally', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0];
  let r = reduce(draft, { kind: 'removeSet', weId: bp.id, setId: bp.sets[2].id }, ctx());
  assert.deepEqual(r.ops, []);
  r = reduce(r.draft, { kind: 'undo' }, ctx());
  assert.deepEqual(r.ops, []);
  assert.equal(r.draft.exercises[0].sets.length, 3);
});

test('undo on empty stack is a no-op', () => {
  const { draft } = fresh();
  const r = reduce(draft, { kind: 'undo' }, ctx());
  assert.deepEqual(r.ops, []);
});

test('removeExercise then undo: remove, then upsert exercise and done sets', () => {
  const d0 = threeDone();
  const bp = d0.exercises[0];
  let r = reduce(d0, { kind: 'removeExercise', weId: bp.id }, ctx());
  assert.deepEqual(r.ops, [{ kind: 'remove', table: 'workout_exercises', eq: { id: bp.id } }]);
  assert.equal(r.draft.exercises.length, 1);
  r = reduce(r.draft, { kind: 'undo' }, ctx());
  assert.equal(r.ops.length, 2);
  assert.equal(r.ops[0].table, 'workout_exercises');
  assert.deepEqual(r.ops[0].rows, [{ id: bp.id, workout_id: d0.workout.id, exercise_id: 'bp', position: 0, note: '' }]);
  assert.equal(r.ops[1].table, 'sets');
  assert.equal(r.ops[1].rows.length, 3);
  assert.equal(r.draft.exercises[0].id, bp.id);
});

test('removeExercise of an exercise with no done sets: undo emits only the exercise upsert', () => {
  const { draft } = fresh();
  const sq = draft.exercises[1];
  let r = reduce(draft, { kind: 'removeExercise', weId: sq.id }, ctx());
  r = reduce(r.draft, { kind: 'undo' }, ctx());
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].table, 'workout_exercises');
});

test('replaceExercise: blocked with done sets, ok without', () => {
  const d0 = threeDone();
  let r = reduce(d0, { kind: 'replaceExercise', weId: d0.exercises[0].id, exercise: exById.sq }, ctx());
  assert.equal(r.error, 'has-done-sets'); assert.deepEqual(r.ops, []);
  const { draft } = fresh();
  const sq = draft.exercises[1];
  r = reduce(draft, { kind: 'replaceExercise', weId: sq.id, exercise: exById.bp }, ctx());
  assert.equal(r.error, undefined);
  assert.deepEqual(r.ops, [{ kind: 'upsert', table: 'workout_exercises', onConflict: 'id',
    rows: [{ id: sq.id, workout_id: draft.workout.id, exercise_id: 'bp', position: 1, note: '' }] }]);
  assert.deepEqual(r.draft.exercises[1].sets.map((s) => [s.kg, s.reps]), [[80, 8], [80, 8]]);
});

test('addExercise: position max+1, 3 prefilled sets, upsert', () => {
  const { draft } = fresh();
  const r = reduce(draft, { kind: 'addExercise', exercise: exById.pu }, ctx());
  const e = r.draft.exercises[2];
  assert.equal(e.position, 2);
  assert.deepEqual(e.sets.map((s) => [s.kg, s.reps]), [[0, 8], [0, 8], [0, 8]]);
  assert.deepEqual(r.ops, [{ kind: 'upsert', table: 'workout_exercises', onConflict: 'id',
    rows: [{ id: e.id, workout_id: draft.workout.id, exercise_id: 'pu', position: 2, note: '' }] }]);
});

test('move: swap positions in one op; edges are no-ops', () => {
  const { draft } = fresh();
  const [a, b] = draft.exercises;
  let r = reduce(draft, { kind: 'move', weId: a.id, dir: 1 }, ctx());
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.ops[0].rows.map((x) => [x.id, x.position]).sort(), [[a.id, 1], [b.id, 0]].sort());
  assert.deepEqual(r.draft.exercises.map((e) => e.id), [b.id, a.id]);
  r = reduce(draft, { kind: 'move', weId: a.id, dir: -1 }, ctx());
  assert.deepEqual(r.ops, []);
  r = reduce(draft, { kind: 'move', weId: b.id, dir: 1 }, ctx());
  assert.deepEqual(r.ops, []);
});

test('notes: exerciseNote upserts, sessionNote local', () => {
  const { draft } = fresh();
  let r = reduce(draft, { kind: 'exerciseNote', weId: draft.exercises[0].id, text: 'tempo' }, ctx());
  assert.equal(r.ops[0].rows[0].note, 'tempo');
  r = reduce(draft, { kind: 'sessionNote', text: 'felt good' }, ctx());
  assert.deepEqual(r.ops, []); assert.equal(r.draft.workout.note, 'felt good');
});

const prOf = (...ids) => new Map(ids.map((i) => [i, true]));
const setsOp = (f) => f.ops.find((o) => o.table === 'sets');

test('finishOps: across midnight keeps start day', () => {
  const start = new Date(2026, 10, 24, 23, 30);
  const end = new Date(2026, 11, 25, 0, 30);
  let { draft } = startDraft({ routine, items, exercisesById: exById, index, userId: 'u1', now: start, newId: counter() });
  const bp = draft.exercises[0];
  draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx({ now: start })).draft;
  const f = finishOps(draft, { end: iso(end), durationKnown: true, prMap: new Map(), gymHabitId: 'H', logUnticked: false, now: end });
  assert.equal(f.workoutRow.day, '2026-11-24');
  assert.equal(f.workoutRow.ended_at, iso(end));
  const habit = f.ops.find((o) => o.table === 'habit_logs');
  assert.deepEqual(habit, { kind: 'upsert', table: 'habit_logs', onConflict: 'habit_id,date', rows: [{ habit_id: 'H', date: '2026-11-24', status: 'done' }] });
});

test('finishOps: logUnticked true vs false; valueless dropped', () => {
  const { draft } = fresh();
  const sq = draft.exercises[1]; // kg null: valueless
  const bp = draft.exercises[0];
  let d = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx()).draft;
  const end = iso(new Date(NOW.getTime() + 3600e3));
  let f = finishOps(d, { end, durationKnown: true, prMap: new Map(), gymHabitId: null, logUnticked: true, now: NOW });
  const sets = setsOp(f).rows;
  assert.equal(sets.length, 3, 'the ticked set is re-sent (I2) with the two logged ones');
  assert.equal(sets[0].id, bp.sets[0].id);
  assert.notEqual(sets[0].done_at, end, 'the ticked set keeps its own done_at');
  assert.deepEqual(sets.slice(1).map((s) => s.done_at), [end, end]);
  assert.deepEqual(f.loggedSets.map((s) => s.id), [bp.sets[1].id, bp.sets[2].id]);
  assert.ok(!sets.some((s) => s.workout_exercise_id === sq.id));
  f = finishOps(d, { end, durationKnown: true, prMap: new Map(), gymHabitId: null, logUnticked: false, now: NOW });
  assert.deepEqual(f.ops.map((o) => o.table), ['workouts', 'workout_exercises', 'sets', 'workouts'], 'unticked not sent; the ticked one is re-sent');
  assert.deepEqual(setsOp(f).rows.map((r) => r.id), [bp.sets[0].id]);
  assert.deepEqual(f.loggedSets, []);
});

test('finishOps: no sets op when nothing to send; workouts row first and last', () => {
  const { draft } = fresh();
  const f = finishOps(draft, { end: iso(NOW), durationKnown: false, prMap: new Map(), gymHabitId: 'H', logUnticked: false, now: NOW });
  assert.deepEqual(f.ops.map((o) => o.table), ['workouts', 'workout_exercises', 'workouts'], 'no sets op; parents still re-sent');
  assert.equal(f.workoutRow.duration_known, false);
  assert.deepEqual(f.loggedSets, []);
});

test('finishOps: warm-up only + gym habit => no habit op', () => {
  let { draft } = fresh();
  const bp = draft.exercises[0];
  draft = reduce(draft, { kind: 'setType', weId: bp.id, setId: bp.sets[0].id, type: 'warmup' }, ctx()).draft;
  draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx()).draft;
  const f = finishOps(draft, { end: iso(NOW), durationKnown: true, prMap: new Map(), gymHabitId: 'H', logUnticked: false, now: NOW });
  assert.deepEqual(f.ops.map((o) => o.table), ['workouts', 'workout_exercises', 'sets', 'workouts'], 'the warm-up is re-sent, no habit op');
});

test('finishOps: op order sets, workouts, habit_logs; is_pr from prMap', () => {
  let { draft } = fresh();
  const bp = draft.exercises[0];
  draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx()).draft;
  draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[1].id }, ctx()).draft;
  const f = finishOps(draft, { end: iso(NOW), durationKnown: true, prMap: prOf(bp.sets[1].id), gymHabitId: 'H', logUnticked: false, now: NOW });
  assert.deepEqual(f.ops.map((o) => o.table), ['workouts', 'workout_exercises', 'sets', 'workouts', 'habit_logs'], 'FK order, finished row last');
  assert.deepEqual(setsOp(f).rows.map((r) => [r.id, r.is_pr]), [[bp.sets[0].id, false], [bp.sets[1].id, true]]);
  assert.deepEqual(f.ops[1].rows, draft.exercises.map((e) => ({ id: e.id, workout_id: draft.workout.id, exercise_id: e.exercise_id, position: e.position, note: e.note })), 'full workout_exercises rows');
  assert.deepEqual(f.ops[0].rows, [f.workoutRow], 'the parent is the finished row (FK-safe, never a second open workout)');
  assert.deepEqual(f.ops[3].rows, [f.workoutRow], 'and it is the last workouts write');
  assert.equal(f.ops[3].rows[0].ended_at, iso(NOW));
  assert.equal(f.ops[3].rows[0].note, '');
  assert.ok(f.ops.every((o) => o.kind === 'upsert' && o.onConflict));
});

test('finishOps: newly logged non-PR sets carry is_pr false', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0];
  const f = finishOps(draft, { end: iso(NOW), durationKnown: true, prMap: new Map(), gymHabitId: null, logUnticked: true, now: NOW });
  const rows = setsOp(f).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.is_pr === false && r.workout_exercise_id === bp.id));
  assert.equal(f.loggedSets.length, 3);
});

test('finishOps (I2): every done set is re-sent as a full row, is_pr from prMap; unticked ones only with logUnticked', () => {
  let { draft } = fresh();
  const bp = draft.exercises[0];
  draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx()).draft;
  draft = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[1].id }, ctx()).draft;
  const f = finishOps(draft, { end: iso(NOW), durationKnown: true, prMap: prOf(bp.sets[1].id), gymHabitId: null, logUnticked: false, now: NOW });
  assert.equal(setsOp(f).onConflict, 'id');
  const done = draft.exercises[0].sets.filter((s) => s.done);
  assert.deepEqual(setsOp(f).rows, done.map((s) => ({
    id: s.id, workout_exercise_id: bp.id, set_no: s.set_no, reps: s.reps, weight_kg: s.kg, type: s.type, is_pr: s.id === bp.sets[1].id, done_at: s.done_at,
  })));
  assert.deepEqual(f.loggedSets, [], 'ticked sets are not "logged at finish"');
});

test('finishOps: a draft with no exercises writes only the finished workout row', () => {
  const r = startDraft({ routine: null, items: [], exercisesById: exById, index, userId: 'u1', now: NOW, newId: counter() });
  const f = finishOps(r.draft, { end: iso(NOW), durationKnown: true, prMap: new Map(), gymHabitId: 'H', logUnticked: false, now: NOW });
  assert.deepEqual(f.ops.map((o) => o.table), ['workouts']);
});

test('discardOps, untickedWithValues, draftSummary', () => {
  const { draft } = fresh();
  assert.deepEqual(discardOps(draft), [{ kind: 'remove', table: 'workouts', eq: { id: draft.workout.id } }]);
  assert.equal(untickedWithValues(draft), 3);
  const bp = draft.exercises[0];
  const d = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[0].id }, ctx()).draft;
  assert.equal(untickedWithValues(d), 2);
  assert.deepEqual(draftSummary(d), { sets: 1, exercisesDone: 1, exercisesTotal: 2 });
});

test('reconcileDraft', () => {
  const { draft } = fresh();
  const id = draft.workout.id;
  const snap = (w) => ({ workouts: w });
  assert.equal(reconcileDraft({ draft, snapshot: snap([{ id, ended_at: '2026-11-24T11:00:00Z' }]), queueEmpty: false }), 'finished-elsewhere');
  assert.equal(reconcileDraft({ draft, snapshot: snap([{ id, ended_at: null }]), queueEmpty: true }), 'keep');
  assert.equal(reconcileDraft({ draft, snapshot: snap([]), queueEmpty: true }), 'discarded-elsewhere');
  assert.equal(reconcileDraft({ draft, snapshot: snap([]), queueEmpty: false }), 'keep');
});

test('draftFromServer: done sets only, lastTickAt = max done_at', () => {
  const workout = { id: 'w', routine_id: 'R1', name: 'N', day: '2026-11-24', started_at: iso(NOW), note: 'n' };
  const workoutExercises = [{ id: 'e2', workout_id: 'w', exercise_id: 'sq', position: 1, note: '' }, { id: 'e1', workout_id: 'w', exercise_id: 'bp', position: 0, note: 'x' }];
  const sets = [
    { id: 's2', workout_exercise_id: 'e1', set_no: 2, reps: 5, weight_kg: '82.5', type: 'normal', done_at: '2026-11-24T10:20:00.000Z' },
    { id: 's1', workout_exercise_id: 'e1', set_no: 1, reps: 8, weight_kg: 80, type: 'normal', done_at: '2026-11-24T10:10:00.000Z' },
    { id: 's3', workout_exercise_id: 'e2', set_no: 1, reps: 5, weight_kg: 100, type: 'normal', done_at: null },
  ];
  const d = draftFromServer({ workout, workoutExercises, sets }, 'u1');
  assert.equal(d.userId, 'u1'); assert.equal(d.v, 1);
  assert.deepEqual(d.exercises.map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(d.exercises[0].sets.map((s) => [s.id, s.kg, s.reps, s.done]), [['s1', 80, 8, true], ['s2', 82.5, 5, true]]);
  assert.deepEqual(d.exercises[1].sets, []);
  assert.equal(d.lastTickAt, '2026-11-24T10:20:00.000Z');
  assert.equal(d.workout.note, 'n');
  assert.deepEqual(d.undo, []);
});

test('edit on a done set: null/NaN/empty/out-of-range => error, no ops, draft unchanged', () => {
  const d0 = threeDone();
  const bp = d0.exercises[0], sid = bp.sets[0].id;
  for (const [field, code] of [['kg', 'kg-required'], ['reps', 'reps-required']]) {
    for (const value of [null, NaN, '', undefined, 'abc', Infinity]) {
      const r = reduce(d0, { kind: 'edit', weId: bp.id, setId: sid, field, value }, ctx());
      assert.equal(r.error, code, `${field}=${String(value)}`);
      assert.deepEqual(r.ops, []);
      assert.deepEqual(r.draft, d0);
    }
  }
  assert.equal(reduce(d0, { kind: 'edit', weId: bp.id, setId: sid, field: 'kg', value: 1000.5 }, ctx()).error, 'kg-required');
  assert.equal(reduce(d0, { kind: 'edit', weId: bp.id, setId: sid, field: 'reps', value: 2.5 }, ctx()).error, 'reps-required');
  assert.equal(reduce(d0, { kind: 'edit', weId: bp.id, setId: sid, field: 'kg', value: 1000 }, ctx()).error, undefined);
  assert.equal(reduce(d0, { kind: 'edit', weId: bp.id, setId: sid, field: 'reps', value: 0 }, ctx()).error, undefined);
});

test('edit on an undone set may be null (no op); bad field name changes nothing', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0], sid = bp.sets[0].id;
  let r = reduce(draft, { kind: 'edit', weId: bp.id, setId: sid, field: 'kg', value: null }, ctx());
  assert.equal(r.error, undefined); assert.deepEqual(r.ops, []); assert.equal(r.draft.exercises[0].sets[0].kg, null);
  r = reduce(draft, { kind: 'edit', weId: bp.id, setId: sid, field: 'done', value: true }, ctx());
  assert.deepEqual(r.ops, []); assert.deepEqual(r.draft, draft);
  const d0 = threeDone();
  r = reduce(d0, { kind: 'edit', weId: bp.id, setId: d0.exercises[0].sets[0].id, field: 'set_no', value: 9 }, ctx());
  assert.deepEqual(r.ops, []); assert.deepEqual(r.draft, d0);
});

test('undo of an exercise keeps positions contiguous and upserts renumbered rows', () => {
  const { draft } = startDraft({ routine, items: [
    { exercise_id: 'bp', position: 5, target_sets: 1, target_reps_min: 8 },
    { exercise_id: 'sq', position: 7, target_sets: 1, target_reps_min: 5 }], exercisesById: exById, index, userId: 'u1', now: NOW, newId: counter() });
  const [a, b] = draft.exercises;
  let r = reduce(draft, { kind: 'removeExercise', weId: a.id }, ctx());
  r = reduce(r.draft, { kind: 'undo' }, ctx());
  assert.deepEqual(r.draft.exercises.map((e) => [e.id, e.position]), [[a.id, 0], [b.id, 1]]);
  const we = r.ops.find((o) => o.table === 'workout_exercises');
  assert.deepEqual(we.rows.map((x) => [x.id, x.position]), [[a.id, 0], [b.id, 1]]);
});

test('replaceExercise drops that exercise\'s set undo entries', () => {
  const { draft } = fresh();
  const sq = draft.exercises[1], bp = draft.exercises[0];
  let r = reduce(draft, { kind: 'removeSet', weId: sq.id, setId: sq.sets[1].id }, ctx());
  r = reduce(r.draft, { kind: 'removeSet', weId: bp.id, setId: bp.sets[2].id }, ctx());
  r = reduce(r.draft, { kind: 'replaceExercise', weId: sq.id, exercise: exById.pu }, ctx());
  assert.deepEqual(r.draft.undo.map((u) => u.weId), [bp.id]);
});

test('edit: marks the set edited (faint flag), tick marks it too; rejected edits leave it alone', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0];
  assert.equal(bp.sets[0].edited, undefined);
  let r = reduce(draft, { kind: 'edit', weId: bp.id, setId: bp.sets[0].id, field: 'kg', value: 80 }, ctx());
  assert.equal(r.draft.exercises[0].sets[0].edited, true);
  assert.equal(r.draft.exercises[0].sets[1].edited, undefined);
  r = reduce(draft, { kind: 'tick', weId: bp.id, setId: bp.sets[1].id }, ctx());
  assert.equal(r.draft.exercises[0].sets[1].edited, true);
  r = reduce(draft, { kind: 'edit', weId: bp.id, setId: bp.sets[0].id, field: 'kg', value: -3 }, ctx());
  assert.equal(r.error, 'bad-value');
  assert.equal(r.draft.exercises[0].sets[0].edited, undefined);
});

test('edit: garbage values never reach an undone set (bad-value), null still clears', () => {
  const { draft } = fresh();
  const bp = draft.exercises[0], s = bp.sets[0];
  for (const [field, value] of [['kg', -1], ['kg', 'abc'], ['kg', NaN], ['kg', 1000.5], ['kg', 82.555], ['reps', 8.5], ['reps', -1], ['reps', '8'], ['reps', 1001]]) {
    const r = reduce(draft, { kind: 'edit', weId: bp.id, setId: s.id, field, value }, ctx());
    assert.equal(r.error, 'bad-value', `${field}=${value}`);
    assert.deepEqual(r.ops, []);
    assert.equal(r.draft.exercises[0].sets[0][field], draft.exercises[0].sets[0][field]);
  }
  const ok = reduce(draft, { kind: 'edit', weId: bp.id, setId: s.id, field: 'kg', value: null }, ctx());
  assert.equal(ok.error, undefined);
  assert.equal(ok.draft.exercises[0].sets[0].kg, null);
  assert.equal(reduce(draft, { kind: 'edit', weId: bp.id, setId: s.id, field: 'kg', value: 1000 }, ctx()).error, undefined);
  assert.equal(reduce(draft, { kind: 'edit', weId: bp.id, setId: s.id, field: 'reps', value: 0 }, ctx()).error, undefined);
});
