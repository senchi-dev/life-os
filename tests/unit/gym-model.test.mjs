import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gymHomeModel, HISTORY_DAYS } from '../../js/ui/gym-model.js';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { demoSeed } from '../../js/data/demo-seed.js';
import { loadSnapshot } from '../../js/data/repo.js';
import { buildIndex } from '../../js/lib/gym-index.js';
import { fetchFinishedHistory } from '../../js/data/gym-repo.js';
import { addDays } from '../../js/lib/dates.js';

const TODAY = '2026-11-25'; // a Wednesday
const ctx = { backend: createMemoryBackend(demoSeed(TODAY)) };
const snap = await loadSnapshot(ctx, TODAY);
const index = buildIndex(await fetchFinishedHistory(ctx));

test('demo seed: routines, counts, schedule string, history newest first', () => {
  const m = gymHomeModel(snap, { draft: null, index, todayKey: TODAY });
  assert.deepEqual(m.routines.map((r) => [r.name, r.count]), [['Upper', 6], ['Lower', 5]]);
  assert.equal(m.schedule, 'U L · U L · ·');
  assert.equal(m.exerciseCount, snap.exercises.length);
  assert.equal(m.empty, false);
  assert.equal(m.start.state, 'start');
  assert.ok(m.start.name);
  assert.equal(m.history.length, 6);
  const days = m.history.map((h) => h.day);
  assert.deepEqual(days, [...days].sort().reverse());
  assert.ok(m.history[0].sets > 0);
  assert.match(m.history[0].duration, /1h|62|min/);
  assert.equal(m.week.plan, 4);
  assert.ok(m.routines.every((r) => r.lastDay));
});

test('imported workouts are listed in history but not counted in week.done', () => {
  const day = addDays(TODAY, -1); // Tuesday of this week
  const s = { ...snap, workouts: [...snap.workouts, { id: 'imp', routine_id: null, name: 'Imported', day, imported: true, source_ref: 'x', started_at: `${day}T08:00:00.000Z`, ended_at: `${day}T09:00:00.000Z`, duration_known: true }] };
  const base = gymHomeModel(snap, { draft: null, index, todayKey: TODAY });
  const m = gymHomeModel(s, { draft: null, index, todayKey: TODAY });
  assert.equal(m.week.done, base.week.done);
  assert.ok(m.history.some((h) => h.id === 'imp'));
  assert.equal(m.history.find((h) => h.id === 'imp').sets, null);
});

const wk = (id, day, over = {}) => ({ id, routine_id: null, name: id, day, imported: false, duration_known: true, started_at: `${day}T10:00:00.000Z`, ended_at: `${day}T11:00:00.000Z`, ...over });

test('history window: day exactly 42 days ago included, 43 excluded; open workout excluded', () => {
  assert.equal(HISTORY_DAYS, 42);
  const s = { ...snap, workouts: [wk('in', addDays(TODAY, -42)), wk('out', addDays(TODAY, -43)), wk('today', TODAY), wk('open', TODAY, { ended_at: null }), wk('future', addDays(TODAY, 1))] };
  const ids = gymHomeModel(s, { draft: null, index: null, todayKey: TODAY }).history.map((h) => h.id);
  assert.deepEqual([...ids].sort(), ['future', 'in', 'today']);
});

test('empty snapshot: empty true, no start name, no schedule, zero counts', () => {
  const m = gymHomeModel({ exercises: [], routines: [], routineItems: [], scheduleSlots: [], workouts: [] }, { draft: null, index: null, todayKey: TODAY });
  assert.equal(m.empty, true);
  assert.equal(m.start.name, null);
  assert.equal(m.start.routineId, null);
  assert.deepEqual(m.routines, []);
  assert.deepEqual(m.history, []);
  assert.equal(m.exerciseCount, 0);
  assert.equal(m.schedule, '');
});

test('missing snapshot arrays do not throw', () => {
  const m = gymHomeModel({}, { todayKey: TODAY });
  assert.equal(m.empty, true);
});

test('routines with 0 items, archived routines, archived exercises', () => {
  const s = {
    exercises: [{ id: 'e1', archived: false }, { id: 'e2', archived: true }],
    routines: [{ id: 'r1', name: 'Day 1 - Push', sort: 0, archived: false }, { id: 'r2', name: 'Gone', sort: 1, archived: true }],
    routineItems: [{ routine_id: 'r2', exercise_id: 'e1' }], scheduleSlots: [{ weekday: 1, routine_id: 'r1' }, { weekday: 3, routine_id: 'r2' }], workouts: [],
  };
  const m = gymHomeModel(s, { draft: null, index: null, todayKey: TODAY });
  assert.deepEqual(m.routines, [{ id: 'r1', name: 'Day 1 - Push', count: 0, lastDay: null }]);
  assert.equal(m.exerciseCount, 1);
  assert.equal(m.schedule, 'P · · · · · ·');
  assert.equal(m.empty, false);
  const onlyArchived = gymHomeModel({ ...s, routines: [s.routines[1]] }, { todayKey: TODAY });
  assert.equal(onlyArchived.empty, true);
});

test('draft means resume', () => {
  const draft = { workout: { id: 'w', routine_id: snap.routines[1].id, name: 'Lower', started_at: 'x' } };
  const m = gymHomeModel(snap, { draft, index, todayKey: TODAY });
  assert.deepEqual(m.start, { state: 'resume', name: 'Lower', routineId: snap.routines[1].id });
});
