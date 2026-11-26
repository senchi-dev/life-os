import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterExercises, validateExerciseForm, canDeleteExercise, moveItem, EXERCISE_NAME_MAX } from '../../js/lib/gym-forms.js';
import { validateGymRow } from '../../js/lib/gym-validate.js';

const ex = (id, name, muscle_group = 'chest', over = {}) => ({ id, name, muscle_group, equipment: 'barbell', how_to: '', is_custom: false, archived: false, ...over });
const LIST = [ex('1', 'Développé couché', 'chest', { is_custom: true }), ex('2', 'Squat', 'quads'), ex('3', 'bench press'), ex('4', 'Old lift', 'back', { archived: true })];

test('filterExercises: accent- and case-insensitive substring, sorted by name, archived hidden', () => {
  assert.deepEqual(filterExercises(LIST, { query: 'developpe' }).map((e) => e.id), ['1']);
  assert.deepEqual(filterExercises(LIST, { query: 'DÉVELOPPÉ' }).map((e) => e.id), ['1']);
  assert.deepEqual(filterExercises(LIST, { query: '  press ' }).map((e) => e.id), ['3']);
  assert.deepEqual(filterExercises(LIST).map((e) => e.name), ['bench press', 'Développé couché', 'Squat']);
  assert.deepEqual(filterExercises(LIST, { includeArchived: true }).map((e) => e.id), ['3', '1', '4', '2']);
  assert.deepEqual(filterExercises(LIST, { muscle: 'quads' }).map((e) => e.id), ['2']);
  assert.deepEqual(filterExercises(LIST, { muscle: 'back' }).map((e) => e.id), []);
  assert.deepEqual(filterExercises(LIST, { muscle: 'back', includeArchived: true }).map((e) => e.id), ['4']);
  assert.deepEqual(filterExercises(LIST, { query: 'zzz' }), []);
  assert.deepEqual(filterExercises([], {}), []);
  assert.deepEqual(filterExercises(null, {}), []);
});

const form = (over = {}) => ({ name: 'Cable Pull', muscle_group: 'back', equipment: 'cable', how_to: 'Pull.', ...over });

test('validateExerciseForm: ok row passes validateGymRow', () => {
  const r = validateExerciseForm(form({ name: '  Cable Pull  ' }), LIST);
  assert.equal(r.ok, true);
  assert.equal(r.row.name, 'Cable Pull');
  assert.equal(validateGymRow('exercises', { id: 'x', is_custom: true, archived: false, ...r.row }), null);
  assert.equal(validateExerciseForm(form({ equipment: '' }), LIST).row.equipment, null);
});

test('name length boundary matches gym-validate (60 ok, 61 too long, trimmed first)', () => {
  assert.equal(EXERCISE_NAME_MAX, 60);
  const ok = validateExerciseForm(form({ name: 'a'.repeat(60) }), []);
  assert.equal(ok.ok, true);
  assert.equal(validateGymRow('exercises', { id: 'x', is_custom: true, ...ok.row }), null);
  assert.deepEqual(validateExerciseForm(form({ name: 'a'.repeat(61) }), []), { ok: false, error: 'Name too long' });
  assert.equal(validateExerciseForm(form({ name: `  ${'a'.repeat(60)}  ` }), []).ok, true);
  assert.deepEqual(validateExerciseForm(form({ name: '' }), []), { ok: false, error: 'Name required' });
  assert.deepEqual(validateExerciseForm(form({ name: '   ' }), []), { ok: false, error: 'Name required' });
  assert.deepEqual(validateExerciseForm(form({ name: undefined }), []), { ok: false, error: 'Name required' });
});

test('duplicates: case and accent folded, archived count, selfId exempt', () => {
  assert.deepEqual(validateExerciseForm(form({ name: 'Bench Press' }), LIST), { ok: false, error: 'Name already used' });
  assert.deepEqual(validateExerciseForm(form({ name: 'developpe COUCHE' }), LIST), { ok: false, error: 'Name already used' });
  assert.deepEqual(validateExerciseForm(form({ name: 'old lift' }), LIST), { ok: false, error: 'Name already used' });
  assert.equal(validateExerciseForm(form({ name: 'Bench Press' }), LIST, '3').ok, true);
  assert.equal(validateExerciseForm(form({ name: 'Bench Press' }), LIST, '1').ok, false);
  assert.equal(validateExerciseForm(form({ name: 'Bench' }), LIST).ok, true);
});

test('muscle, equipment, how-to', () => {
  assert.deepEqual(validateExerciseForm(form({ muscle_group: '' }), []), { ok: false, error: 'Pick a muscle group' });
  assert.deepEqual(validateExerciseForm(form({ muscle_group: 'wings' }), []), { ok: false, error: 'Pick a muscle group' });
  assert.deepEqual(validateExerciseForm(form({ equipment: 'rocket' }), []), { ok: false, error: 'Pick equipment' });
  assert.equal(validateExerciseForm(form({ how_to: 'x'.repeat(2000) }), []).ok, true);
  assert.deepEqual(validateExerciseForm(form({ how_to: 'x'.repeat(2001) }), []), { ok: false, error: 'How-to too long' });
  assert.equal(validateExerciseForm(form({ how_to: undefined }), []).row.how_to, '');
});

test('canDeleteExercise: false in a routine, in the index, in the draft or when the index is not loaded', () => {
  const index = { exercises: { a: { sessions: [] } } };
  const items = [{ exercise_id: 'b' }];
  const draft = { exercises: [{ exercise_id: 'd' }] };
  assert.equal(canDeleteExercise('z', { routineItems: items, index, draft: null }), true);
  assert.equal(canDeleteExercise('a', { routineItems: items, index, draft: null }), false);
  assert.equal(canDeleteExercise('b', { routineItems: items, index, draft: null }), false);
  assert.equal(canDeleteExercise('d', { routineItems: items, index, draft }), false);
  assert.equal(canDeleteExercise('z', { routineItems: items, index: null, draft: null }), false);
  assert.equal(canDeleteExercise('z', { routineItems: items, index: undefined }), false);
  assert.equal(canDeleteExercise('z', { routineItems: undefined, index, draft: null }), true);
});

test('moveItem swaps and renumbers 0..n-1; edges and unknown ids are no-ops', () => {
  const items = [{ id: 'a', position: 5 }, { id: 'b', position: 9 }, { id: 'c', position: 12 }];
  assert.deepEqual(moveItem(items, 'b', -1), [{ id: 'b', position: 0 }, { id: 'a', position: 1 }, { id: 'c', position: 2 }]);
  assert.deepEqual(moveItem(items, 'b', 1), [{ id: 'a', position: 0 }, { id: 'c', position: 1 }, { id: 'b', position: 2 }]);
  assert.deepEqual(moveItem(items, 'a', -1).map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(items, 'c', 1).map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(items, 'a', -1).map((i) => i.position), [0, 1, 2]);
  assert.deepEqual(moveItem(items, 'nope', 1).map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(moveItem([], 'a', 1), []);
  assert.equal(items[0].position, 5, 'input not mutated');
  assert.deepEqual(moveItem([{ id: 'a', position: 3 }], 'a', 1), [{ id: 'a', position: 0 }]);
});

// ---- Task 16: routine and schedule forms ----
import { validateRoutineForm, validateRoutineItem, routineSaveOps, scheduleSaveOps, ROUTINE_NAME_MAX } from '../../js/lib/gym-forms.js';

const R = (id, name, over = {}) => ({ id, name, sort: 0, archived: false, ...over });
const ROUTINES = [R('u', 'Upper'), R('l', 'Lower', { archived: true })];

test('validateRoutineForm: name 0/1/40/41, whitespace, duplicate, selfId', () => {
  assert.equal(ROUTINE_NAME_MAX, 40);
  assert.deepEqual(validateRoutineForm({ name: '' }, ROUTINES), { ok: false, error: 'Name required' });
  assert.deepEqual(validateRoutineForm({ name: '   ' }, ROUTINES), { ok: false, error: 'Name required' });
  assert.deepEqual(validateRoutineForm({}, ROUTINES), { ok: false, error: 'Name required' });
  assert.deepEqual(validateRoutineForm({ name: 'A' }, ROUTINES), { ok: true, row: { name: 'A' } });
  assert.deepEqual(validateRoutineForm({ name: 'x'.repeat(40) }, ROUTINES), { ok: true, row: { name: 'x'.repeat(40) } });
  assert.deepEqual(validateRoutineForm({ name: 'x'.repeat(41) }, ROUTINES), { ok: false, error: 'Name too long' });
  assert.deepEqual(validateRoutineForm({ name: `  ${'x'.repeat(40)}  ` }, ROUTINES).row, { name: 'x'.repeat(40) });
  assert.deepEqual(validateRoutineForm({ name: 'UPPER' }, ROUTINES), { ok: false, error: 'Name already used' });
  assert.deepEqual(validateRoutineForm({ name: ' lower ' }, ROUTINES), { ok: false, error: 'Name already used' }, 'archived names are taken too (DB unique)');
  assert.equal(validateRoutineForm({ name: 'Upper' }, ROUTINES, 'u').ok, true);
  assert.equal(validateRoutineForm({ name: 'Lower' }, ROUTINES, 'u').ok, false);
  assert.equal(validateRoutineForm({ name: 'Push' }, null).ok, true);
});

test('validateRoutineItem: sets 1..10, reps 1..100, min <= max, strings from inputs', () => {
  const ok = (o) => validateRoutineItem({ target_sets: 3, target_reps_min: 8, target_reps_max: 12, ...o });
  assert.deepEqual(ok({}), { ok: true, row: { target_sets: 3, target_reps_min: 8, target_reps_max: 12 } });
  assert.deepEqual(validateRoutineItem({ target_sets: '3', target_reps_min: ' 8', target_reps_max: '12 ' }).row, { target_sets: 3, target_reps_min: 8, target_reps_max: 12 });
  for (const s of [1, 10]) assert.equal(ok({ target_sets: s }).ok, true);
  for (const s of [0, 11, -1, 2.5, NaN, '', null, undefined, 'abc', '3.5', '1e1', Infinity]) assert.equal(ok({ target_sets: s }).ok, false, `sets ${s}`);
  assert.equal(ok({ target_sets: 0 }).error, 'Sets: 1 to 10');
  assert.equal(ok({ target_reps_min: 1, target_reps_max: 1 }).ok, true);
  assert.equal(ok({ target_reps_min: 100, target_reps_max: 100 }).ok, true);
  for (const m of [0, 101, 7.5, NaN, '', null]) assert.equal(ok({ target_reps_min: m, target_reps_max: 100 }).ok, false, `min ${m}`);
  for (const m of [0, 101, 7.5, NaN, '', null]) assert.equal(ok({ target_reps_max: m }).ok, false, `max ${m}`);
  assert.equal(ok({ target_reps_min: 12, target_reps_max: 11 }).error, 'Max reps must be at least min');
  assert.equal(ok({ target_reps_min: 12, target_reps_max: 12 }).ok, true);
  assert.equal(ok({ target_reps_min: 0 }).error, 'Reps: 1 to 100');
  // what validateRoutineItem accepts, validateGymRow accepts too
  const row = ok({}).row;
  assert.equal(validateGymRow('routine_items', { id: 'i', position: 0, ...row }), null);
});

const item = (id, position, over = {}) => ({ id, routine_id: 'r1', exercise_id: `e-${id}`, position, target_sets: 3, target_reps_min: 8, target_reps_max: 12, ...over });

test('routineSaveOps: routine, then items in one op, then one remove per removed item; every row valid', () => {
  const routine = { id: 'r1', name: 'Upper', sort: 0, archived: false };
  const ops = routineSaveOps({ routine, items: [item('a', 0), item('b', 1)], removedItemIds: ['x', 'y'] });
  assert.deepEqual(ops.map((o) => [o.kind, o.table]), [['upsert', 'routines'], ['upsert', 'routine_items'], ['remove', 'routine_items'], ['remove', 'routine_items']]);
  assert.deepEqual(ops[0].rows, [routine]);
  assert.equal(ops[0].onConflict, 'id');
  assert.deepEqual(ops[1].rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(ops.slice(2).map((o) => o.eq), [{ id: 'x' }, { id: 'y' }]);
  for (const op of ops) if (op.kind === 'upsert') for (const r of op.rows) assert.equal(validateGymRow(op.table, r), null, `${op.table} ${JSON.stringify(r)}`);
});

test('routineSaveOps: empty routine has no items op; positions are rewritten 0..n-1; removed ids that are kept are not removed', () => {
  const routine = { id: 'r1', name: 'Empty', sort: 3, archived: false };
  assert.deepEqual(routineSaveOps({ routine, items: [], removedItemIds: [] }).map((o) => o.table), ['routines']);
  assert.deepEqual(routineSaveOps({ routine, items: undefined, removedItemIds: undefined }).map((o) => o.table), ['routines']);
  const ops = routineSaveOps({ routine, items: [item('b', 7), item('a', 2)], removedItemIds: ['a', 'x', 'x'] });
  assert.deepEqual(ops[1].rows.map((r) => [r.id, r.position]), [['a', 0], ['b', 1]]);
  assert.deepEqual(ops.slice(2).map((o) => o.eq.id), ['x']);
  assert.ok(ops[0].rows[0] !== routine, 'rows are copies');
});

const SLOT_USER = 'demo-user';
const slots7 = (ids) => [1, 2, 3, 4, 5, 6, 7].map((weekday, i) => ({ weekday, routine_id: ids[i] ?? null }));

test('scheduleSaveOps: 7 rows, new ids via seedId (A4), onConflict user_id,weekday, habit patch second', async () => {
  const { seedId } = await import('../../js/lib/ids.js');
  const habit = { id: 'h', name: 'Gym', schedule_kind: 'n_per_week', target_n: 3 };
  const ops = await scheduleSaveOps({ slots: slots7(['u', 'l', null, 'u', 'l']), existing: [], gymHabit: habit, userId: SLOT_USER });
  assert.deepEqual(ops.map((o) => o.table), ['schedule_slots', 'habits']);
  assert.equal(ops[0].onConflict, 'user_id,weekday');
  assert.equal(ops[0].rows.length, 7);
  assert.deepEqual(ops[0].rows.map((r) => r.weekday), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(ops[0].rows[2].routine_id, null);
  assert.equal(ops[0].rows[0].id, await seedId(SLOT_USER, 'schedule:1'));
  assert.equal(new Set(ops[0].rows.map((r) => r.id)).size, 7);
  assert.deepEqual(ops[1].rows, [{ ...habit, target_n: 4 }]);
  assert.equal(ops[1].onConflict, 'id');
  for (const r of ops[0].rows) assert.equal(validateGymRow('schedule_slots', r), null);
});

test('scheduleSaveOps: existing ids and extra columns reused; unsorted input sorted; no habit op when target already right', async () => {
  const existing = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ id: `s${weekday}`, user_id: 'real', weekday, routine_id: null }));
  const habit = { id: 'h', schedule_kind: 'n_per_week', target_n: 2 };
  const shuffled = slots7(['u', null, null, 'u']).reverse();
  const ops = await scheduleSaveOps({ slots: shuffled, existing, gymHabit: habit, userId: 'real' });
  assert.deepEqual(ops.map((o) => o.table), ['schedule_slots'], 'two training days = target 2');
  assert.deepEqual(ops[0].rows.map((r) => r.id), ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
  assert.equal(ops[0].rows[0].user_id, 'real');
  assert.equal(ops[0].rows[0].routine_id, 'u');
  // partially existing: only the missing ones are seeded
  const part = await scheduleSaveOps({ slots: slots7([]), existing: existing.slice(0, 3), gymHabit: null, userId: 'real' });
  assert.deepEqual(part[0].rows.slice(0, 3).map((r) => r.id), ['s1', 's2', 's3']);
  assert.notEqual(part[0].rows[3].id, 's4');
  assert.equal(part.length, 1, 'no habit, no habit op');
});

test('scheduleSaveOps: rejects anything but exactly 7 distinct weekdays 1..7', async () => {
  const bad = async (slots) => assert.rejects(() => scheduleSaveOps({ slots, existing: [], gymHabit: null, userId: 'u' }), /slots/);
  await bad(slots7([]).slice(0, 6));
  await bad([...slots7([]), { weekday: 1, routine_id: null }]);
  await bad(slots7([]).map((s) => (s.weekday === 7 ? { ...s, weekday: 8 } : s)));
  await bad(slots7([]).map((s) => (s.weekday === 7 ? { ...s, weekday: 0 } : s)));
  await bad(slots7([]).map((s) => (s.weekday === 7 ? { ...s, weekday: 6 } : s)));
  await bad(slots7([]).map((s) => (s.weekday === 7 ? { ...s, weekday: 1.5 } : s)));
  await bad(null);
  await assert.rejects(() => scheduleSaveOps({ slots: slots7([]), existing: [], gymHabit: null }), /userId/);
});
