import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineActions } from '../../js/ui/routine-view.js';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { createMemoryBackend } from '../../js/data/backend-memory.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const base = () => ({
  settings: { user_id: 'demo-user' },
  habits: [{ id: 'h', name: 'Gym', schedule_kind: 'n_per_week', target_n: 4, archived: false }],
  exercises: [{ id: 'e1', name: 'Bench' }, { id: 'e2', name: 'Row' }],
  routines: [{ id: 'U', name: 'Upper', sort: 0, archived: false }, { id: 'L', name: 'Lower', sort: 1, archived: false }],
  routineItems: [
    { id: 'i1', routine_id: 'U', exercise_id: 'e1', position: 0, target_sets: 3, target_reps_min: 8, target_reps_max: 12 },
    { id: 'i2', routine_id: 'U', exercise_id: 'e2', position: 1, target_sets: 3, target_reps_min: 8, target_reps_max: 12 },
  ],
  scheduleSlots: [[1, 'U'], [2, 'L'], [3, null], [4, 'U'], [5, 'L'], [6, null], [7, null]].map(([weekday, routine_id]) => ({ id: `s${weekday}`, weekday, routine_id })),
});
const mk = (over = {}) => {
  const ops = [];
  const app = {
    rerendered: 0, rerender() { this.rerendered++; }, refresh: async () => {},
    snapshot: base(),
    ctx: { outbox: { async enqueue(op) { if (over.fail) throw new Error('x'); ops.push(op); }, async flush() {} } },
  };
  let n = 0;
  return { app, ops, act: routineActions(app, { newId: () => `new-${++n}` }) };
};
const it = (over = {}) => ({ id: 'i1', exercise_id: 'e1', target_sets: '3', target_reps_min: '8', target_reps_max: '12', ...over });
const allValid = (ops) => { for (const op of ops) if (op.kind === 'upsert') for (const r of op.rows) assert.equal(validateGymRow(op.table, r), null, `${op.table} ${JSON.stringify(r)}`); };

test('save existing: optimistic snapshot, ops in FK order, removed item removed, Saved.', async () => {
  const { app, ops, act } = mk();
  const r = await act.save('U', { name: 'Upper 2', items: [it({ id: 'i2', exercise_id: 'e2', target_sets: '4' })] });
  assert.deepEqual(r, { ok: true, saved: true });
  assert.deepEqual(ops.map((o) => `${o.kind}:${o.table}`), ['upsert:routines', 'upsert:routine_items', 'remove:routine_items']);
  assert.equal(ops[2].eq.id, 'i1');
  allValid(ops);
  assert.equal(app.snapshot.routines.find((x) => x.id === 'U').name, 'Upper 2');
  assert.deepEqual(app.snapshot.routineItems.map((i) => [i.id, i.position, i.target_sets]), [['i2', 0, 4]]);
  assert.equal(act.ui.notice, 'Saved.');
});

test('save new: new id, sort after the last, items get new ids and routine_id', async () => {
  const { app, ops, act } = mk();
  const r = await act.save(null, { name: 'Push', items: [{ exercise_id: 'e1', target_sets: '3', target_reps_min: '5', target_reps_max: '5' }] });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'new-1');
  assert.deepEqual(ops[0].rows[0], { id: 'new-1', name: 'Push', sort: 2, archived: false });
  assert.equal(ops[1].rows[0].routine_id, 'new-1');
  assert.equal(ops[1].rows[0].id, 'new-2');
  allValid(ops);
  assert.equal(app.snapshot.routines.length, 3);
});

test('save: an empty routine is allowed (no items op)', async () => {
  const { ops, act } = mk();
  assert.equal((await act.save(null, { name: 'Blank', items: [] })).ok, true);
  assert.deepEqual(ops.map((o) => o.table), ['routines']);
});

test('save: invalid name or targets write nothing and leave the snapshot alone', async () => {
  const { app, ops, act } = mk();
  const before = JSON.stringify(app.snapshot);
  assert.deepEqual(await act.save('U', { name: 'lower', items: [it()] }), { ok: false, error: 'Name already used' });
  assert.deepEqual(await act.save('U', { name: '', items: [it()] }), { ok: false, error: 'Name required' });
  const bad = await act.save('U', { name: 'Upper', items: [it({ target_sets: '11' })] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^Bench: Sets: 1 to 10/);
  assert.equal(bad.itemId, 'i1');
  assert.equal((await act.save('U', { name: 'Upper', items: [it({ target_reps_min: '9', target_reps_max: '8' })] })).ok, false);
  assert.equal((await act.save('U', { name: 'Upper', items: [it({ target_sets: '' })] })).ok, false);
  assert.equal((await act.save('zzz', { name: 'Upper', items: [] })).error, 'Routine not found');
  assert.equal(ops.length, 0);
  assert.equal(JSON.stringify(app.snapshot), before);
});

test('save: failed write rolls back routines and items and says so', async () => {
  const { app, act } = mk({ fail: true });
  const before = JSON.stringify(app.snapshot);
  const r = await act.save('U', { name: 'Renamed', items: [] });
  assert.deepEqual(r, { ok: true, saved: false });
  assert.equal(JSON.stringify(app.snapshot), before);
  assert.equal(act.ui.notice, 'Could not save. Try again.');
});

test('archive: routine archived, its slots become rest, habit target follows; ops FK-safe and valid', async () => {
  const { app, ops, act } = mk();
  const r = await act.archive('U');
  assert.equal(r.ok, true);
  assert.deepEqual(ops.map((o) => o.table), ['routines', 'schedule_slots', 'habits']);
  assert.equal(ops[0].rows[0].archived, true);
  assert.equal(ops[1].onConflict, 'user_id,weekday');
  assert.deepEqual(ops[1].rows.map((x) => x.routine_id), [null, 'L', null, null, 'L', null, null]);
  assert.equal(ops[2].rows[0].target_n, 2);
  allValid(ops);
  assert.equal(app.snapshot.routines.find((x) => x.id === 'U').archived, true);
  assert.equal(app.snapshot.scheduleSlots.filter((s) => s.routine_id === 'U').length, 0);
  assert.equal(app.snapshot.habits[0].target_n, 2);
  assert.equal(act.ui.notice, 'Saved.');
});

test('archive: routine not in the schedule writes only the routine; unknown id fails; failure rolls everything back', async () => {
  const a = mk();
  a.app.snapshot.scheduleSlots = [];
  assert.equal((await a.act.archive('U')).ok, true);
  assert.deepEqual(a.ops.map((o) => o.table), ['routines']);
  assert.deepEqual(await a.act.archive('nope'), { ok: false, error: 'Routine not found' });
  const f = mk({ fail: true });
  const before = JSON.stringify(f.app.snapshot);
  assert.deepEqual(await f.act.archive('U'), { ok: true, saved: false });
  assert.equal(JSON.stringify(f.app.snapshot), before);
});

test('saveSchedule: optimistic slots + habit, one upsert of 7 rows; rollback on failure', async () => {
  const { app, ops, act } = mk();
  const slots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, routine_id: weekday === 3 ? 'U' : app.snapshot.scheduleSlots[weekday - 1].routine_id }));
  const r = await act.saveSchedule(slots);
  assert.equal(r.ok, true);
  assert.deepEqual(ops.map((o) => o.table), ['schedule_slots', 'habits']);
  assert.deepEqual(ops[0].rows.map((x) => x.id), ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], 'existing ids reused');
  assert.equal(ops[1].rows[0].target_n, 5);
  assert.equal(app.snapshot.scheduleSlots.find((s) => s.weekday === 3).routine_id, 'U');
  assert.equal(app.snapshot.habits[0].target_n, 5);
  const f = mk({ fail: true });
  const before = JSON.stringify(f.app.snapshot);
  assert.deepEqual(await f.act.saveSchedule(slots), { ok: true, saved: false });
  assert.equal(JSON.stringify(f.app.snapshot), before);
  assert.equal(f.act.ui.notice, 'Could not save. Try again.');
});

test('saveSchedule: an archived or unknown routine id is stored as rest; bad input rejected', async () => {
  const { app, ops, act } = mk();
  app.snapshot.routines[1].archived = true;
  const slots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, routine_id: weekday === 2 ? 'L' : weekday === 3 ? 'ghost' : null }));
  assert.equal((await act.saveSchedule(slots)).ok, true);
  assert.ok(ops[0].rows.every((x) => x.routine_id === null));
  assert.equal((await act.saveSchedule(slots.slice(0, 6))).ok, false);
});

test('saveSchedule on an empty schedule seeds ids and survives a real memory backend round trip (no duplicates)', async () => {
  const backend = createMemoryBackend({ routines: [{ id: 'U', user_id: 'demo-user', name: 'Upper', sort: 0, archived: false }] });
  const app = { rerender() {}, refresh: async () => {}, snapshot: { settings: { user_id: 'demo-user' }, habits: [], routines: [{ id: 'U', name: 'Upper', sort: 0, archived: false }], routineItems: [], scheduleSlots: [] },
    ctx: { outbox: { async enqueue(op) { await backend.upsert(op.table, op.rows, { onConflict: op.onConflict }); }, async flush() {} } } };
  const act = routineActions(app);
  const slots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, routine_id: weekday === 1 ? 'U' : null }));
  await act.saveSchedule(slots);
  await act.saveSchedule(slots.map((s) => (s.weekday === 2 ? { ...s, routine_id: 'U' } : s)));
  await tick();
  const rows = await backend.select('schedule_slots', {});
  assert.equal(rows.length, 7);
  assert.equal(rows.find((x) => x.weekday === 2).routine_id, 'U');
  assert.equal(app.snapshot.scheduleSlots.length, 7);
});
