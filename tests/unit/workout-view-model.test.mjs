import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workoutViewModel, staleSheetModel, minibarText, parseKgInput, parseRepsInput, removeStep, opensTypePicker,
  LONG_PRESS_MS, TYPE_OPTIONS, typeCode,
} from '../../js/ui/workout-model.js';
import { startDraft, reduce } from '../../js/lib/workout-draft.js';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { demoSeed } from '../../js/data/demo-seed.js';
import { loadSnapshot } from '../../js/data/repo.js';
import { buildIndex } from '../../js/lib/gym-index.js';
import { fetchFinishedHistory } from '../../js/data/gym-repo.js';

const TODAY = '2026-11-25';
const ctx = { backend: createMemoryBackend(demoSeed(TODAY)) };
const snap = await loadSnapshot(ctx, TODAY);
const index = buildIndex(await fetchFinishedHistory(ctx));
const exercisesById = Object.fromEntries(snap.exercises.map((e) => [e.id, e]));
const routine = snap.routines.find((r) => r.name === 'Upper');
const routineItems = snap.routineItems.filter((i) => i.routine_id === routine.id);
const NOW = new Date(2026, 10, 25, 18, 0, 0);
let n = 0;
const newId = () => `id${++n}`;
const mk = () => startDraft({ routine, items: routineItems, exercisesById, index, userId: 'demo-user', now: NOW, newId }).draft;
const ctxOf = (draft, extra = {}) => ({ exercisesById, index, routineItems, activeWeId: null, ...extra });
const act = (d, a) => { const r = reduce(d, a, { now: NOW, newId, index }); assert.equal(r.error, undefined, JSON.stringify(a)); return r.draft; };
const nameOf = (m, i) => m.exercises[i].name;

test('summary text is exact: sets ticked and exercises touched', () => {
  let d = mk();
  assert.equal(workoutViewModel(d, ctxOf(d)).summary, '0 sets · 0 of 6 exercises');
  const [a, b] = d.exercises;
  for (const s of a.sets) d = act(d, { kind: 'tick', weId: a.id, setId: s.id });
  d = act(d, { kind: 'tick', weId: b.id, setId: b.sets[0].id });
  d = act(d, { kind: 'tick', weId: d.exercises[2].id, setId: d.exercises[2].sets[0].id });
  assert.equal(workoutViewModel(d, ctxOf(d)).summary, '5 sets · 3 of 6 exercises');
});

test('summary singular forms', () => {
  let d = mk();
  d = { ...d, exercises: [d.exercises[0]] };
  d = act(d, { kind: 'tick', weId: d.exercises[0].id, setId: d.exercises[0].sets[0].id });
  assert.equal(workoutViewModel(d, ctxOf(d)).summary, '1 set · 1 of 1 exercise');
});

test('title, start and exercise names/how-to/targets come from the inputs', () => {
  const d = mk();
  const m = workoutViewModel(d, ctxOf(d));
  assert.equal(m.title, 'Upper');
  assert.equal(m.startedAt, d.workout.started_at);
  assert.equal(nameOf(m, 0), 'Bench Press');
  assert.equal(m.exercises[0].target, '3 × 5–8');
  assert.equal(typeof m.exercises[0].howTo, 'string');
  const ex = m.exercises.find((e) => e.name === 'Lateral Raise');
  assert.match(ex.howTo, /\n/);
});

test('target: equal min/max collapses, missing max, and null without routine item', () => {
  const d = mk();
  const items = routineItems.map((i, k) => (k === 0 ? { ...i, target_reps_max: i.target_reps_min } : k === 1 ? { ...i, target_reps_max: null } : i));
  const m = workoutViewModel(d, ctxOf(d, { routineItems: items }));
  assert.equal(m.exercises[0].target, '3 × 5');
  assert.equal(m.exercises[1].target, '3 × 6');
  const none = workoutViewModel(d, ctxOf(d, { routineItems: [] }));
  assert.equal(none.exercises[0].target, null);
});

test('prev column: row 1 and later come from the last session; "—" beyond its length', () => {
  const d = mk();
  const m = workoutViewModel(d, ctxOf(d));
  const prevSets = index.exercises[d.exercises[0].exercise_id].last.sets;
  const rows = m.exercises[0].rows;
  assert.equal(rows[0].prev, `${prevSets[0].weight_kg} × ${prevSets[0].reps}`);
  assert.match(rows[0].prev, /^\d+(\.\d+)? × \d+$/);
  let d2 = d;
  const we = d2.exercises[0];
  for (let i = we.sets.length; i < prevSets.length + 2; i++) d2 = act(d2, { kind: 'addSet', weId: we.id });
  const rows2 = workoutViewModel(d2, ctxOf(d2)).exercises[0].rows;
  assert.equal(rows2[prevSets.length].prev, '—');
  assert.equal(rows2[prevSets.length + 1].prev, '—');
});

test('prev column is "—" for every row when the exercise has no history', () => {
  const d = mk();
  const m = workoutViewModel(d, { exercisesById, index: null, routineItems, activeWeId: null });
  assert.ok(m.exercises.every((e) => e.rows.every((r) => r.prev === '—')));
  assert.ok(m.exercises.every((e) => e.lastTop === null));
});

test('labels: W warm-up, D drop, F failure; normal sets count 1.. skipping the others; warm-up has no prev alignment', () => {
  let d = mk();
  const we = d.exercises[0];
  d = act(d, { kind: 'addSet', weId: we.id });
  d = act(d, { kind: 'addSet', weId: we.id });
  const ids = d.exercises[0].sets.map((s) => s.id);
  d = act(d, { kind: 'setType', weId: we.id, setId: ids[0], type: 'warmup' });
  d = act(d, { kind: 'setType', weId: we.id, setId: ids[3], type: 'dropset' });
  d = act(d, { kind: 'setType', weId: we.id, setId: ids[4], type: 'failure' });
  const rows = workoutViewModel(d, ctxOf(d)).exercises[0].rows;
  assert.deepEqual(rows.map((r) => r.label), ['W', '1', '2', 'D', 'F']);
  const prev = index.exercises[we.exercise_id].last.sets;
  assert.equal(rows[0].prev, '—');
  assert.equal(rows[1].prev, `${prev[0].weight_kg} × ${prev[0].reps}`);
  assert.equal(rows[2].prev, `${prev[1].weight_kg} × ${prev[1].reps}`);
});

test('faint: unedited prefilled rows are faint; edit or tick clears it; untick does not bring it back', () => {
  let d = mk();
  const we = d.exercises[0];
  let rows = workoutViewModel(d, ctxOf(d)).exercises[0].rows;
  assert.ok(rows.every((r) => r.faint === true));
  d = act(d, { kind: 'edit', weId: we.id, setId: we.sets[0].id, field: 'kg', value: 82.5 });
  rows = workoutViewModel(d, ctxOf(d)).exercises[0].rows;
  assert.deepEqual(rows.map((r) => r.faint), [false, true, true]);
  d = act(d, { kind: 'tick', weId: we.id, setId: we.sets[1].id });
  rows = workoutViewModel(d, ctxOf(d)).exercises[0].rows;
  assert.deepEqual(rows.map((r) => r.faint), [false, false, true]);
  d = act(d, { kind: 'untick', weId: we.id, setId: we.sets[1].id });
  rows = workoutViewModel(d, ctxOf(d)).exercises[0].rows;
  assert.equal(rows[1].faint, false);
  assert.equal(rows[1].done, false);
});

test('editing to the same value still counts as edited', () => {
  let d = mk();
  const we = d.exercises[0];
  const same = we.sets[0].kg;
  d = act(d, { kind: 'edit', weId: we.id, setId: we.sets[0].id, field: 'kg', value: same });
  assert.equal(workoutViewModel(d, ctxOf(d)).exercises[0].rows[0].faint, false);
});

test('a row with nothing prefilled is not faint', () => {
  const d = mk();
  const bare = { ...d, exercises: d.exercises.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s, kg: null, reps: null })) })) };
  assert.ok(workoutViewModel(bare, ctxOf(bare)).exercises[0].rows.every((r) => r.faint === false));
});

test('canTick: false when kg or reps is null, true when both set', () => {
  let d = mk();
  const we = d.exercises[0];
  d = act(d, { kind: 'edit', weId: we.id, setId: we.sets[0].id, field: 'kg', value: null });
  d = act(d, { kind: 'edit', weId: we.id, setId: we.sets[1].id, field: 'reps', value: null });
  const rows = workoutViewModel(d, ctxOf(d)).exercises[0].rows;
  assert.deepEqual(rows.map((r) => r.canTick), [false, false, true]);
  assert.equal(rows[0].kg, null);
  assert.equal(rows[1].reps, null);
});

test('canTick: bodyweight kg 0 counts as a value', () => {
  const d = mk();
  const bw = { ...d, exercises: d.exercises.map((e, i) => (i ? e : { ...e, sets: e.sets.map((s) => ({ ...s, kg: 0 })) })) };
  assert.ok(workoutViewModel(bw, ctxOf(bw)).exercises[0].rows.every((r) => r.canTick));
});

test('lastTop comes from the newest indexed session top set', () => {
  const d = mk();
  const m = workoutViewModel(d, ctxOf(d));
  const ex = index.exercises[d.exercises[1].exercise_id];
  const top = ex.sessions[ex.sessions.length - 1].top;
  assert.equal(m.exercises[1].lastTop, `${top.w} × ${top.r}`);
});

test('lastTop: bodyweight top shows BW', () => {
  const d = mk();
  const id = d.exercises[0].exercise_id;
  const idx = { ...index, exercises: { ...index.exercises, [id]: { ...index.exercises[id], sessions: [{ top: { w: 0, r: 12 } }] } } };
  assert.equal(workoutViewModel(d, { exercisesById, index: idx, routineItems }).exercises[0].lastTop, 'BW × 12');
});

test('expanded: first exercise with an undone set; moves on when it is complete', () => {
  let d = mk();
  assert.deepEqual(workoutViewModel(d, ctxOf(d)).exercises.map((e) => e.expanded), [true, false, false, false, false, false]);
  const a = d.exercises[0];
  for (const s of a.sets) d = act(d, { kind: 'tick', weId: a.id, setId: s.id });
  assert.deepEqual(workoutViewModel(d, ctxOf(d)).exercises.map((e) => e.expanded), [false, true, false, false, false, false]);
});

test('expanded: the user-tapped exercise wins; an unknown id falls back; everything done expands the last', () => {
  let d = mk();
  const third = d.exercises[2].id;
  assert.equal(workoutViewModel(d, ctxOf(d, { activeWeId: third })).exercises[2].expanded, true);
  assert.equal(workoutViewModel(d, ctxOf(d, { activeWeId: third })).exercises.filter((e) => e.expanded).length, 1);
  assert.equal(workoutViewModel(d, ctxOf(d, { activeWeId: 'gone' })).exercises[0].expanded, true);
  for (const e of d.exercises) for (const s of e.sets) d = act(d, { kind: 'tick', weId: e.id, setId: s.id });
  const m = workoutViewModel(d, ctxOf(d));
  assert.deepEqual(m.exercises.map((e) => e.expanded), [false, false, false, false, false, true]);
});

test('empty draft: no exercises, empty-workout summary', () => {
  const d = startDraft({ routine: null, items: [], exercisesById, index, userId: 'u', now: NOW, newId }).draft;
  const m = workoutViewModel(d, { exercisesById, index, routineItems: [] });
  assert.equal(m.title, 'Workout');
  assert.deepEqual(m.exercises, []);
  assert.equal(m.summary, '0 sets · 0 of 0 exercises');
});

test('unknown exercise id and missing fields never throw', () => {
  const d = mk();
  const m = workoutViewModel(d, { exercisesById: {}, index: null, routineItems: null });
  assert.equal(m.exercises[0].name, 'Exercise');
  assert.equal(m.exercises[0].howTo, '');
  assert.equal(m.exercises[0].target, null);
});

test('exercises are ordered by position', () => {
  const d = mk();
  const swapped = { ...d, exercises: d.exercises.slice().reverse() };
  const m = workoutViewModel(swapped, ctxOf(swapped));
  assert.equal(m.exercises[0].name, 'Bench Press');
});

// --- input parsing -----------------------------------------------------------------------------
test('parseKgInput: comma decimal, empty, partial and invalid text', () => {
  assert.deepEqual(parseKgInput('82,5'), { kind: 'ok', value: 82.5 });
  assert.deepEqual(parseKgInput('82.5'), { kind: 'ok', value: 82.5 });
  assert.deepEqual(parseKgInput(' 80 '), { kind: 'ok', value: 80 });
  assert.deepEqual(parseKgInput('0'), { kind: 'ok', value: 0 });
  assert.deepEqual(parseKgInput('82,'), { kind: 'ok', value: 82 });
  assert.deepEqual(parseKgInput('.5'), { kind: 'ok', value: 0.5 });
  assert.deepEqual(parseKgInput(''), { kind: 'empty', value: null });
  assert.deepEqual(parseKgInput('   '), { kind: 'empty', value: null });
  for (const bad of ['abc', '-5', '8a', '1e3', '82,5,1', '1001', '1000.01', '--', '+5', '82..5', ',', '.']) {
    assert.equal(parseKgInput(bad).kind, 'invalid', bad);
  }
  assert.deepEqual(parseKgInput('1000'), { kind: 'ok', value: 1000 });
});

test('parseRepsInput: whole numbers only', () => {
  assert.deepEqual(parseRepsInput('8'), { kind: 'ok', value: 8 });
  assert.deepEqual(parseRepsInput('0'), { kind: 'ok', value: 0 });
  assert.deepEqual(parseRepsInput(''), { kind: 'empty', value: null });
  for (const bad of ['8.5', '8,5', '-1', 'x', '1001', '1e2', '+3']) assert.equal(parseRepsInput(bad).kind, 'invalid', bad);
  assert.deepEqual(parseRepsInput('1000'), { kind: 'ok', value: 1000 });
});

// --- remove flow -------------------------------------------------------------------------------
test('removeStep: undone set removes at once; done set needs a second tap on the same set', () => {
  assert.equal(removeStep(null, null), 'none');
  assert.equal(removeStep({ id: 'a', done: false }, null), 'remove');
  assert.equal(removeStep({ id: 'a', done: false }, 'a'), 'remove');
  assert.equal(removeStep({ id: 'a', done: true }, null), 'arm');
  assert.equal(removeStep({ id: 'a', done: true }, 'b'), 'arm');
  assert.equal(removeStep({ id: 'a', done: true }, 'a'), 'remove');
});

// --- long press / type picker --------------------------------------------------------------------
test('long-press threshold is 500 ms and the picker opens for hold, mouse click and keyboard, not a touch tap', () => {
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(opensTypePicker('hold', 'touch'), true);
  assert.equal(opensTypePicker('hold', 'mouse'), true);
  assert.equal(opensTypePicker('tap', 'touch'), false);
  assert.equal(opensTypePicker('tap', 'pen'), false);
  assert.equal(opensTypePicker('tap', 'mouse'), true);
  assert.equal(opensTypePicker('key', ''), true);
  assert.equal(opensTypePicker('swipe', 'touch'), false);
});

test('type options map to reducer type values and codes', () => {
  assert.deepEqual(TYPE_OPTIONS.map((o) => o.type), ['normal', 'warmup', 'dropset', 'failure']);
  assert.deepEqual(TYPE_OPTIONS.map((o) => o.name), ['Normal', 'Warm-up', 'Drop set', 'Failure']);
  assert.equal(typeCode('warmup'), 'W');
  assert.equal(typeCode('dropset'), 'D');
  assert.equal(typeCode('failure'), 'F');
  assert.equal(typeCode('normal'), null);
});

// --- minibar -------------------------------------------------------------------------------------
test('minibarText: name and elapsed clock; clamps negative; survives midnight', () => {
  const d = { workout: { name: 'Upper Force', started_at: new Date(2026, 10, 24, 23, 30, 0).toISOString() } };
  assert.equal(minibarText(d, new Date(2026, 10, 25, 0, 12, 18).getTime()), 'Upper Force · 00:42:18');
  assert.equal(minibarText(d, new Date(2026, 10, 24, 23, 0, 0).getTime()), 'Upper Force · 00:00:00');
  assert.equal(minibarText(null, 0), '');
  assert.equal(minibarText({ workout: { name: '', started_at: 'junk' } }, 5), 'Workout · 00:00:00');
});

// --- stale sheet ---------------------------------------------------------------------------------
const stale = (extra = {}) => ({
  workout: { name: 'Upper', started_at: new Date(2026, 10, 24, 17, 0, 0).toISOString() },
  lastTickAt: new Date(2026, 10, 24, 18, 47, 0).toISOString(), exercises: [{ sets: [{ done: true }] }], ...extra,
});

test('staleSheetModel: null while the workout is fresh, boundary 6 h exactly is not stale', () => {
  const d = stale();
  const last = Date.parse(d.lastTickAt);
  assert.equal(staleSheetModel(d, new Date(last + 6 * 3600000).toISOString()), null);
  assert.notEqual(staleSheetModel(d, new Date(last + 6 * 3600000 + 1000).toISOString()), null);
  assert.equal(staleSheetModel(null, new Date().toISOString()), null);
});

test('staleSheetModel: title uses the start weekday, End at is last tick + 5 min', () => {
  const m = staleSheetModel(stale(), new Date(2026, 10, 25, 9, 0, 0).toISOString());
  assert.equal(m.title, 'Workout from Tue still open');
  assert.equal(m.endLabel, 'End at 18:52');
  assert.equal(m.endIso, new Date(2026, 10, 24, 18, 52, 0).toISOString());
  assert.equal(m.canEnd, true);
});

test('staleSheetModel: no ticked set means nothing to end (canEnd false, label from start)', () => {
  const d = stale({ lastTickAt: null, exercises: [{ sets: [{ done: false }] }] });
  const m = staleSheetModel(d, new Date(2026, 10, 25, 9, 0, 0).toISOString());
  assert.equal(m.canEnd, false);
  assert.equal(m.endLabel, 'End at 17:00');
});

test('staleSheetModel: weekday follows the device-local start day, not UTC', () => {
  const d = stale({ workout: { name: 'x', started_at: new Date(2026, 10, 24, 0, 30, 0).toISOString() }, lastTickAt: null });
  assert.equal(staleSheetModel(d, new Date(2026, 10, 25, 9, 0, 0).toISOString()).title, 'Workout from Tue still open');
});

// --- review round 1 -------------------------------------------------------------------------------
import { needsStalePrompt, stillCheckedText, createEditCommitter } from '../../js/ui/workout-model.js';

const H = 3600000;
const staleDraft = () => stale();
const lastTickMs = Date.parse(stale().lastTickAt);

test('needsStalePrompt: no draft never prompts; fresh draft never prompts', () => {
  assert.equal(needsStalePrompt({ draft: null, now: new Date().toISOString(), route: 'today' }), null);
  assert.equal(needsStalePrompt({ draft: undefined, now: new Date().toISOString(), route: 'workout' }), null);
  assert.equal(needsStalePrompt({ draft: staleDraft(), now: new Date(lastTickMs + 2 * H).toISOString(), route: 'today' }), null);
});

test('needsStalePrompt: exactly 6 h is not stale, +1 s is; off the workout route it navigates, on it it shows', () => {
  const at = (ms) => new Date(lastTickMs + ms).toISOString();
  assert.equal(needsStalePrompt({ draft: staleDraft(), now: at(6 * H), route: 'today' }), null);
  assert.equal(needsStalePrompt({ draft: staleDraft(), now: at(6 * H + 1000), route: 'today' }), 'navigate');
  assert.equal(needsStalePrompt({ draft: staleDraft(), now: at(6 * H + 1000), route: 'gym' }), 'navigate');
  assert.equal(needsStalePrompt({ draft: staleDraft(), now: at(6 * H + 1000), route: 'workout' }), 'show');
});

test('needsStalePrompt: a Resume acknowledgement counts as activity until it is 6 h old', () => {
  const now = new Date(lastTickMs + 8 * H).toISOString();
  const recent = new Date(lastTickMs + 8 * H - 60000).toISOString();
  assert.equal(needsStalePrompt({ draft: staleDraft(), now, route: 'today', ackedAt: recent }), null);
  const old = new Date(lastTickMs + 1 * H).toISOString();
  assert.equal(needsStalePrompt({ draft: staleDraft(), now, route: 'today', ackedAt: old }), 'navigate');
});

test('stillCheckedText: weekday of the workout day, device-local', () => {
  assert.equal(stillCheckedText('2026-11-23'), 'Gym is still checked for Mon.');
  assert.equal(stillCheckedText('2026-11-29'), 'Gym is still checked for Sun.');
  assert.equal(stillCheckedText('bad'), 'Gym is still checked for that day.');
});

function fakeTimers() {
  let id = 0;
  const live = new Map();
  return {
    setTimer: (fn, ms) => { live.set(++id, { fn, ms }); return id; },
    clearTimer: (h) => { live.delete(h); },
    fire: () => { for (const [k, t] of [...live]) { live.delete(k); t.fn(); } },
    count: () => live.size,
    ms: () => [...live.values()].map((t) => t.ms),
  };
}
function committer(initial = 80) {
  const t = fakeTimers();
  const calls = [];
  let cur = initial;
  const c = createEditCommitter({
    setTimer: t.setTimer, clearTimer: t.clearTimer,
    current: () => cur,
    dispatch: async (key, value) => { calls.push([key, value]); cur = value; return {}; },
  });
  return { c, t, calls, setCur: (v) => { cur = v; } };
}

test('edit committer: keystrokes 8, 82, 82,, 82,5 on a done set make exactly one dispatch of 82.5 after 600 ms', () => {
  const { c, t, calls } = committer();
  for (const v of [8, 82, 82, 82.5]) c.input('s1:kg', v);
  assert.equal(calls.length, 0);
  assert.deepEqual(t.ms(), [600]);
  assert.equal(t.count(), 1, 'each keystroke replaces the timer');
  t.fire();
  assert.deepEqual(calls, [['s1:kg', 82.5]]);
});

test('edit committer: flush (blur/Enter) commits at once and the timer never fires a second dispatch', async () => {
  const { c, t, calls } = committer();
  c.input('s1:kg', 82.5);
  await c.flush();
  assert.deepEqual(calls, [['s1:kg', 82.5]]);
  assert.equal(t.count(), 0);
  t.fire();
  assert.equal(calls.length, 1);
});

test('edit committer: an edit followed at once by untick commits the edit first', async () => {
  const order = [];
  const t = fakeTimers();
  const c = createEditCommitter({ setTimer: t.setTimer, clearTimer: t.clearTimer, current: () => 80, dispatch: async (k, v) => { order.push(`edit ${v}`); return {}; } });
  c.input('s1:reps', 6);
  const flushed = c.flush(); // what onTick does before dispatching untick
  order.push('untick');
  await flushed;
  assert.deepEqual(order, ['edit 6', 'untick']);
});

test('edit committer: same value as the draft dispatches nothing; keys are independent; cancel drops', async () => {
  const a = committer(80);
  a.c.input('s1:kg', 80);
  a.t.fire();
  await a.c.flush();
  assert.equal(a.calls.length, 0);
  const b = committer(80);
  b.c.input('s1:kg', 82.5);
  b.c.input('s1:reps', 6);
  assert.equal(b.t.count(), 2);
  await b.c.flush();
  assert.deepEqual(b.calls.map((x) => x[0]).sort(), ['s1:kg', 's1:reps']);
  const d = committer(80);
  d.c.input('s1:kg', 90);
  d.c.cancel();
  d.t.fire();
  assert.equal(d.calls.length, 0);
});

test('edit committer: typing back to the draft value before the timer fires dispatches nothing', () => {
  const { c, t, calls } = committer(80);
  c.input('s1:kg', 82);
  c.input('s1:kg', 80);
  t.fire();
  assert.equal(calls.length, 0);
});

// ===================== Task 18: finish sheet, end time, exercise menu, notes =====================
import {
  finishSheetModel, endFromTimeInput, endTimeMessage, resolveFinishEnd, finishDuration, untickedPrompt, habitCheckedText,
  exerciseMenuModel, applyFinishToSnapshot, applyDiscardToSnapshot, howToRow, customExerciseRow, noteError, finishVsStale, SESSION_NOTE_MAX, EXERCISE_NOTE_MAX,
} from '../../js/ui/workout-model.js';
import { validateGymRow } from '../../js/lib/gym-validate.js';
import { nowHHMM } from '../../js/lib/dates.js';

const min = (n) => n * 60000;
const at = (base, deltaMin) => new Date(base.getTime() + min(deltaMin));
// A draft started at `startedAt` with `ticks` ticked sets, the last one at `lastTick`; extra unticked rows via `extra`.
function draftWith({ startedAt, lastTick, ticks = 1, extra = [] }) {
  const d = mk();
  d.workout.started_at = startedAt.toISOString();
  d.lastTickAt = lastTick ? lastTick.toISOString() : null;
  for (const e of d.exercises) e.sets = [];
  d.exercises[0].sets = Array.from({ length: ticks }, (_, i) => ({
    id: `t${i}`, set_no: i + 1, kg: 80, reps: 8, type: 'normal', done: true, done_at: (lastTick ?? startedAt).toISOString(),
  }));
  d.exercises[0].sets.push(...extra.map((x, i) => ({ id: `x${i}`, set_no: ticks + i + 1, type: 'normal', done: false, done_at: null, ...x })));
  return d;
}

test('finishSheetModel: 0 ticked is empty, only Discard and Back', () => {
  const d = draftWith({ startedAt: at(NOW, -20), lastTick: null, ticks: 0 });
  const m = finishSheetModel(d, { now: NOW, prLines: [] });
  assert.equal(m.kind, 'empty');
  assert.equal(m.sets, 0);
  assert.equal(m.primary.label, 'Discard (nothing logged)');
  assert.equal(m.secondary.label, 'Back');
});

test('finishSheetModel: normal save, duration and sets', () => {
  const d = draftWith({ startedAt: at(NOW, -50), lastTick: at(NOW, -2), ticks: 3 });
  const m = finishSheetModel(d, { now: NOW, prLines: [] });
  assert.equal(m.kind, 'normal');
  assert.equal(m.primary.label, 'Save workout');
  assert.equal(m.primary.end, NOW.toISOString());
  assert.equal(m.secondary, undefined);
  assert.equal(m.sets, 3);
  assert.equal(m.duration, '50 min');
});

test('finishSheetModel: gap boundary, 30 min is normal, 31 min is guarded (labels pinned)', () => {
  const d30 = draftWith({ startedAt: at(NOW, -60), lastTick: at(NOW, -30) });
  assert.equal(finishSheetModel(d30, { now: NOW }).kind, 'normal');
  assert.equal(finishSheetModel(d30, { now: NOW }).primary.label, 'Save workout');
  const d31 = draftWith({ startedAt: at(NOW, -60), lastTick: at(NOW, -31) });
  const m = finishSheetModel(d31, { now: NOW });
  assert.equal(m.kind, 'guarded');
  assert.equal(m.primary.label, `End at ${nowHHMM(at(NOW, -26))} (last set + 5 min)`);
  assert.equal(m.primary.end, at(NOW, -26).toISOString());
  assert.deepEqual(m.secondary, { label: 'End now', end: NOW.toISOString() });
});

test('finishSheetModel: 45 min ago guarded with end = last tick + 5 min in local time', () => {
  const last = at(NOW, -45);
  const m = finishSheetModel(draftWith({ startedAt: at(NOW, -90), lastTick: last }), { now: NOW });
  assert.equal(m.kind, 'guarded');
  assert.equal(m.primary.label, 'End at 17:20 (last set + 5 min)'); // NOW 18:00, tick 17:15, +5
  assert.equal(m.primary.end, at(last, 5).toISOString());
  assert.equal(m.duration, '50 min'); // 16:30 to 17:20
  assert.equal(finishDuration(at(NOW, -90).toISOString(), m.primary.end), '50 min');
});

test('finishSheetModel: elapsed boundary, 4 h is normal (recent tick), 4 h 01 is guarded', () => {
  const s4 = at(NOW, -240);
  const a = finishSheetModel(draftWith({ startedAt: s4, lastTick: at(NOW, -1) }), { now: NOW });
  assert.equal(a.kind, 'normal');
  const b = finishSheetModel(draftWith({ startedAt: at(NOW, -241), lastTick: at(NOW, -1) }), { now: NOW });
  assert.equal(b.kind, 'guarded');
  // last set only 1 min ago: last + 5 min would be in the future, so the end is now and the two choices coincide
  assert.equal(b.primary.end, NOW.toISOString());
  assert.equal(b.primary.label, `End at ${nowHHMM(NOW)}`);
  assert.equal(b.secondary, undefined);
});

test('finishSheetModel: duration never lies, over 4 h shows a dash', () => {
  const m = finishSheetModel(draftWith({ startedAt: at(NOW, -600), lastTick: at(NOW, -1) }), { now: NOW });
  assert.equal(m.duration, '—'); // guarded end = now, 10 h long: unknown
});

test('finishSheetModel: PR lines text is exact and unticked values are counted, bare unticked rows are not', () => {
  const d = draftWith({ startedAt: at(NOW, -40), lastTick: at(NOW, -1), extra: [
    { kg: 60, reps: 10 }, { kg: 60, reps: null }, { kg: null, reps: 10 }, { kg: null, reps: null }, { kg: 0, reps: 12 },
  ] });
  const m = finishSheetModel(d, { now: NOW, prLines: [{ name: 'Bench Press', weight_kg: 82.5, reps: 8 }, { name: 'Pull-up', weight_kg: 0, reps: 9 }] });
  assert.deepEqual(m.prs, ['Bench Press 82.5 × 8 · PR', 'Pull-up BW × 9 · PR']);
  assert.equal(m.unticked, 2); // kg 60 reps 10, and kg 0 reps 12 (bodyweight is a value)
});

test('finishSheetModel: accepts an ISO string for now', () => {
  const d = draftWith({ startedAt: at(NOW, -30), lastTick: at(NOW, -1) });
  assert.equal(finishSheetModel(d, { now: NOW.toISOString() }).primary.end, NOW.toISOString());
});

test('untickedPrompt: wording, singular, none', () => {
  assert.equal(untickedPrompt(0), null);
  assert.equal(untickedPrompt(1).text, '1 unticked set');
  assert.equal(untickedPrompt(3).text, '3 unticked sets');
  assert.deepEqual(untickedPrompt(3).choices.map((c) => c.label), ['Log them', 'Discard']);
  assert.deepEqual(untickedPrompt(3).choices.map((c) => c.logUnticked), [true, false]);
});

test('endTimeMessage: every code has a distinct human message, null has none', () => {
  const codes = ['before-start', 'before-last-set', 'in-future', 'invalid'];
  const texts = codes.map((c) => endTimeMessage(c));
  for (const t of texts) assert.ok(t && t.length > 10, t);
  assert.equal(new Set(texts).size, 4);
  assert.equal(endTimeMessage(null), '');
  assert.ok(endTimeMessage('something-else'));
});

test('endFromTimeInput: same day, now, and invalid text', () => {
  const now = new Date(2026, 10, 25, 18, 52, 40);
  const started = new Date(2026, 10, 25, 17, 30);
  assert.equal(endFromTimeInput('18:10', now, started.toISOString()), new Date(2026, 10, 25, 18, 10).toISOString());
  assert.equal(endFromTimeInput('18:52', now, started.toISOString()), new Date(2026, 10, 25, 18, 52).toISOString());
  for (const bad of ['', null, undefined, '24:00', '12:60', '9:5', 'ab:cd', '18:10:30', '1810']) {
    assert.equal(endFromTimeInput(bad, now, started.toISOString()), null, String(bad));
  }
  // Started today and a later time typed: that time today, so the validator says in-future (not a confusing before-start)
  const later = endFromTimeInput('23:59', now, started.toISOString());
  assert.equal(later, new Date(2026, 10, 25, 23, 59).toISOString());
  assert.equal(validateEndTime(later, { startedAt: started.toISOString(), lastTickAt: null, now: now.toISOString() }), 'in-future');
});

test('endFromTimeInput: workout started 23:30 ends 00:20 across midnight', () => {
  const started = new Date(2026, 10, 24, 23, 30);
  const now = new Date(2026, 10, 25, 0, 40);
  assert.equal(endFromTimeInput('00:20', now, started.toISOString()), new Date(2026, 10, 25, 0, 20).toISOString());
  assert.equal(endFromTimeInput('23:50', now, started.toISOString()), new Date(2026, 10, 24, 23, 50).toISOString());
  // 23:10 is before the start on either day: returned on the day that is not in the future, so validation says before-start
  const e = endFromTimeInput('23:10', now, started.toISOString());
  assert.equal(e, new Date(2026, 10, 24, 23, 10).toISOString());
  assert.equal(validateEndTime(e, { startedAt: started.toISOString(), lastTickAt: null, now: now.toISOString() }), 'before-start');
});

test('endFromTimeInput: now just after midnight', () => {
  const started = new Date(2026, 10, 24, 23, 40);
  const now = new Date(2026, 10, 25, 0, 1, 5);
  assert.equal(endFromTimeInput('00:01', now, started.toISOString()), new Date(2026, 10, 25, 0, 1).toISOString());
  assert.equal(endFromTimeInput('00:02', now, started.toISOString()), new Date(2026, 10, 24, 0, 2).toISOString()); // a minute in the future: yesterday
  assert.equal(validateEndTime(endFromTimeInput('00:02', now, started.toISOString()), { startedAt: started.toISOString(), now: now.toISOString() }), 'before-start');
  assert.equal(endFromTimeInput('23:59', now, started.toISOString()), new Date(2026, 10, 24, 23, 59).toISOString());
});

import { validateEndTime } from '../../js/lib/workout.js';

test('resolveFinishEnd: untouched keeps the exact planned end; edited goes through the time parser and validation', () => {
  const started = at(NOW, -60);
  const last = at(NOW, -20);
  const d = draftWith({ startedAt: started, lastTick: last });
  const planEnd = at(last, 5);
  planEnd.setSeconds(30);
  const base = { draft: d, now: NOW.toISOString(), planEnd: planEnd.toISOString() };
  assert.deepEqual(resolveFinishEnd({ ...base, touched: false, hhmm: '17:45' }), { end: planEnd.toISOString(), code: null });
  const ok = resolveFinishEnd({ ...base, touched: true, hhmm: nowHHMM(at(NOW, -10)) });
  assert.equal(ok.code, null);
  assert.equal(resolveFinishEnd({ ...base, touched: true, hhmm: nowHHMM(at(started, -5)) }).code, 'before-start');
  assert.equal(resolveFinishEnd({ ...base, touched: true, hhmm: nowHHMM(at(last, -5)) }).code, 'before-last-set');
  assert.equal(resolveFinishEnd({ ...base, touched: true, hhmm: '' }).code, 'invalid');
  assert.equal(resolveFinishEnd({ ...base, touched: true, hhmm: 'zz' }).end, null);
});

test('resolveFinishEnd: a later time than now on a session started today is in-future', () => {
  const d = draftWith({ startedAt: at(NOW, -3), lastTick: at(NOW, -1) });
  const r = resolveFinishEnd({ draft: d, now: NOW.toISOString(), planEnd: NOW.toISOString(), touched: true, hhmm: nowHHMM(at(NOW, 30)) });
  assert.equal(r.code, 'in-future');
  assert.equal(resolveFinishEnd({ draft: d, now: NOW.toISOString(), planEnd: NOW.toISOString(), touched: true, hhmm: nowHHMM(at(NOW, -30)) }).code, 'before-start');
});

test('habitCheckedText and stillChecked wording', () => {
  assert.equal(habitCheckedText('2026-11-24'), 'Gym checked for Tue 24 Nov');
  assert.equal(habitCheckedText('junk'), 'Gym checked');
});

test('exerciseMenuModel: items, edge disabling and reasons', () => {
  let d = mk();
  const ids = d.exercises.slice().sort((a, b) => a.position - b.position).map((e) => e.id);
  const first = exerciseMenuModel(d, ids[0]);
  const byId = (m, id) => m.items.find((i) => i.id === id);
  assert.deepEqual(first.items.map((i) => i.id), ['howto', 'replace', 'up', 'down', 'remove']);
  assert.equal(byId(first, 'up').disabled, true);
  assert.ok(byId(first, 'up').reason);
  assert.equal(byId(first, 'down').disabled, false);
  assert.equal(byId(first, 'replace').disabled, false);
  const last = exerciseMenuModel(d, ids[ids.length - 1]);
  assert.equal(byId(last, 'down').disabled, true);
  assert.ok(byId(last, 'down').reason);
  assert.equal(byId(last, 'up').disabled, false);
  // done sets disable Replace with a visible reason
  const we = d.exercises.find((e) => e.id === ids[1]);
  d = act(d, { kind: 'tick', weId: we.id, setId: we.sets[0].id });
  const m = exerciseMenuModel(d, ids[1]);
  assert.equal(byId(m, 'replace').disabled, true);
  assert.match(byId(m, 'replace').reason, /set/i);
  assert.equal(byId(m, 'remove').danger, true);
  assert.equal(exerciseMenuModel(d, 'nope'), null);
  // a single exercise: both moves disabled
  const one = { ...d, exercises: [d.exercises[0]] };
  const o = exerciseMenuModel(one, one.exercises[0].id);
  assert.equal(byId(o, 'up').disabled && byId(o, 'down').disabled, true);
});

test('view model exposes the per-exercise session note', () => {
  let d = mk();
  assert.equal(workoutViewModel(d, ctxOf(d)).exercises[0].note, '');
  d = act(d, { kind: 'exerciseNote', weId: d.exercises[0].id, text: 'felt heavy' });
  assert.equal(workoutViewModel(d, ctxOf(d)).exercises[0].note, 'felt heavy');
});

test('howToRow: full row, both sides of the 2000 limit, French text kept', () => {
  const ex = snap.exercises.find((e) => !e.is_custom);
  const fr = 'Dos droit, omoplates serrées. Descendre la barre jusqu’à la poitrine.';
  const ok = howToRow(ex, fr);
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.row).sort(), ['archived', 'equipment', 'how_to', 'id', 'is_custom', 'muscle_group', 'name']);
  assert.equal(ok.row.how_to, fr);
  assert.equal(ok.row.id, ex.id);
  assert.equal(validateGymRow('exercises', ok.row), null);
  assert.equal(howToRow(ex, 'x'.repeat(2000)).ok, true);
  assert.equal(validateGymRow('exercises', howToRow(ex, 'x'.repeat(2000)).row), null);
  const big = howToRow(ex, 'x'.repeat(2001));
  assert.equal(big.ok, false);
  assert.equal(big.error, 'How-to too long');
  assert.equal(howToRow(ex, '').ok, true); // clearing is allowed
  assert.equal(howToRow(null, 'x').ok, false);
});

test('customExerciseRow: valid, duplicate, missing muscle, empty and over-long names', () => {
  const ok = customExerciseRow({ name: '  Landmine Press ', muscle_group: 'shoulders' }, snap.exercises, () => 'new-id');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.row, { id: 'new-id', name: 'Landmine Press', muscle_group: 'shoulders', equipment: null, how_to: '', is_custom: true, archived: false });
  assert.equal(validateGymRow('exercises', ok.row), null);
  const dupe = customExerciseRow({ name: snap.exercises[0].name.toUpperCase(), muscle_group: 'chest' }, snap.exercises, () => 'x');
  assert.equal(dupe.error, 'Name already used');
  assert.equal(customExerciseRow({ name: 'Foo', muscle_group: '' }, snap.exercises, () => 'x').error, 'Pick a muscle group');
  assert.equal(customExerciseRow({ name: '   ', muscle_group: 'chest' }, snap.exercises, () => 'x').error, 'Name required');
  assert.equal(customExerciseRow({ name: 'y'.repeat(60), muscle_group: 'chest' }, snap.exercises, () => 'x').ok, true);
  assert.equal(customExerciseRow({ name: 'y'.repeat(61), muscle_group: 'chest' }, snap.exercises, () => 'x').error, 'Name too long');
});

test('note limits match validateGymRow on both sides', () => {
  assert.equal(SESSION_NOTE_MAX, 2000);
  assert.equal(EXERCISE_NOTE_MAX, 500);
  const w = { id: 'w', name: 'A', day: '2026-11-25', started_at: NOW.toISOString(), ended_at: null };
  assert.equal(validateGymRow('workouts', { ...w, note: 'x'.repeat(SESSION_NOTE_MAX) }), null);
  assert.equal(validateGymRow('workouts', { ...w, note: 'x'.repeat(SESSION_NOTE_MAX + 1) }), 'note');
  const we = { id: 'a', position: 0 };
  assert.equal(validateGymRow('workout_exercises', { ...we, note: 'x'.repeat(EXERCISE_NOTE_MAX) }), null);
  assert.equal(validateGymRow('workout_exercises', { ...we, note: 'x'.repeat(EXERCISE_NOTE_MAX + 1) }), 'note');
  assert.equal(noteError('x'.repeat(2000), SESSION_NOTE_MAX), null);
  assert.match(noteError('x'.repeat(2001), SESSION_NOTE_MAX), /2000/);
  assert.equal(noteError('x'.repeat(500), EXERCISE_NOTE_MAX), null);
  assert.match(noteError('x'.repeat(501), EXERCISE_NOTE_MAX), /500/);
  assert.equal(noteError('', 500), null);
});

test('finishVsStale: a stale prompt never stacks on the finish sheet', () => {
  assert.equal(finishVsStale({ finishOpen: false, finishBusy: false }), 'show');
  assert.equal(finishVsStale({ finishOpen: true, finishBusy: false }), 'close-finish');
  assert.equal(finishVsStale({ finishOpen: true, finishBusy: true }), 'ignore');
  assert.equal(finishVsStale({ finishOpen: false, finishBusy: true }), 'show');
});

test('applyFinishToSnapshot: finished workout replaces the open one, habit log upserted by (habit, date), active cleared', () => {
  const w = { id: 'w1', routine_id: 'r1', name: 'Upper', day: '2026-11-25', started_at: 'a', ended_at: 'b', duration_known: true };
  const open = { ...w, ended_at: null };
  const sn = { workouts: [{ id: 'old', ended_at: 'x' }, open], habitLogs: [{ id: 'l0', habit_id: 'g', date: '2026-11-25', status: 'skipped' }, { id: 'l1', habit_id: 'g', date: '2026-11-24', status: 'done' }], activeWorkout: { workout: open } };
  applyFinishToSnapshot(sn, { workoutRow: w, habitLog: { habit_id: 'g', date: '2026-11-25', status: 'done' } }, () => 'new');
  assert.deepEqual(sn.workouts.map((x) => [x.id, x.ended_at]), [['old', 'x'], ['w1', 'b']]);
  assert.deepEqual(sn.habitLogs.map((x) => [x.date, x.status]), [['2026-11-24', 'done'], ['2026-11-25', 'done']]);
  assert.equal(sn.habitLogs.find((l) => l.date === '2026-11-25').id, 'new');
  assert.equal(sn.activeWorkout, null);
  // no habit: only the workout; a different active workout stays
  const sn2 = { workouts: [], habitLogs: [], activeWorkout: { workout: { id: 'other' } } };
  applyFinishToSnapshot(sn2, { workoutRow: w, habitLog: null }, () => 'n');
  assert.equal(sn2.workouts.length, 1);
  assert.equal(sn2.habitLogs.length, 0);
  assert.equal(sn2.activeWorkout.workout.id, 'other');
  assert.doesNotThrow(() => applyFinishToSnapshot({}, { workoutRow: w, habitLog: null }, () => 'n'));
});

test('applyDiscardToSnapshot: drops the workout and an active copy, nothing else', () => {
  const sn = { workouts: [{ id: 'w1' }, { id: 'w2' }], activeWorkout: { workout: { id: 'w1' } }, habitLogs: [{ id: 'l' }] };
  applyDiscardToSnapshot(sn, 'w1');
  assert.deepEqual(sn.workouts.map((x) => x.id), ['w2']);
  assert.equal(sn.activeWorkout, null);
  assert.equal(sn.habitLogs.length, 1);
  assert.doesNotThrow(() => applyDiscardToSnapshot({}, 'w1'));
});

// ===================== Task 18 review round 1 =====================
import { sheetStash, shouldRestoreSheet, dismissStep, canOpenFinish, createGuard } from '../../js/ui/workout-model.js';

test('sheetStash: a clean sheet stashes nothing, a dirty one keeps its text exactly', () => {
  assert.equal(sheetStash({ kind: 'howto', weId: 'a', text: 'same', initial: 'same' }), null);
  assert.equal(sheetStash({ kind: 'note', weId: 'a', text: '', initial: '' }), null);
  assert.deepEqual(sheetStash({ kind: 'howto', weId: 'a', text: 'Dos droit\nÉpaules basses', initial: 'x' }), { kind: 'howto', weId: 'a', text: 'Dos droit\nÉpaules basses' });
  assert.deepEqual(sheetStash({ kind: 'note', weId: 'a', text: 'lourd', initial: '' }), { kind: 'note', weId: 'a', text: 'lourd' });
  // clearing an existing note is a change too
  assert.deepEqual(sheetStash({ kind: 'note', weId: 'a', text: '', initial: 'old' }), { kind: 'note', weId: 'a', text: '' });
  assert.equal(sheetStash({ kind: 'picker', mode: 'add', weId: null, query: '', view: 'list', name: '', muscle: '' }), null);
  assert.deepEqual(sheetStash({ kind: 'picker', mode: 'add', weId: null, query: 'pre', view: 'list', name: '', muscle: '' }),
    { kind: 'picker', mode: 'add', weId: null, query: 'pre', view: 'list', name: '', muscle: '' });
  assert.equal(sheetStash({ kind: 'picker', mode: 'add', weId: null, query: '', view: 'new', name: '', muscle: '' }), null);
  assert.equal(sheetStash({ kind: 'picker', mode: 'add', weId: null, query: '', view: 'new', name: 'Landmine', muscle: '' }).name, 'Landmine');
  assert.equal(sheetStash({ kind: 'picker', mode: 'add', weId: null, query: '', view: 'new', name: '', muscle: 'chest' }).muscle, 'chest');
  assert.equal(sheetStash(null), null);
  assert.equal(sheetStash({ kind: 'weird' }), null);
});

test('shouldRestoreSheet: only while the exercise it belongs to still exists', () => {
  let d = mk();
  const we = d.exercises[0];
  const byId = exercisesById;
  assert.equal(shouldRestoreSheet({ kind: 'note', weId: we.id, text: 'x' }, d, byId), true);
  assert.equal(shouldRestoreSheet({ kind: 'howto', weId: we.id, text: 'x' }, d, byId), true);
  assert.equal(shouldRestoreSheet({ kind: 'note', weId: 'gone', text: 'x' }, d, byId), false);
  assert.equal(shouldRestoreSheet({ kind: 'howto', weId: 'gone', text: 'x' }, d, byId), false);
  assert.equal(shouldRestoreSheet({ kind: 'howto', weId: we.id, text: 'x' }, d, {}), false); // exercise row gone
  assert.equal(shouldRestoreSheet({ kind: 'picker', mode: 'add', weId: null }, d, byId), true);
  assert.equal(shouldRestoreSheet({ kind: 'picker', mode: 'replace', weId: we.id }, d, byId), true);
  assert.equal(shouldRestoreSheet({ kind: 'picker', mode: 'replace', weId: 'gone' }, d, byId), false);
  d = act(d, { kind: 'tick', weId: we.id, setId: we.sets[0].id });
  assert.equal(shouldRestoreSheet({ kind: 'picker', mode: 'replace', weId: we.id }, d, byId), false); // now has done sets
  assert.equal(shouldRestoreSheet(null, d, byId), false);
  assert.equal(shouldRestoreSheet({ kind: 'note', weId: we.id }, null, byId), false);
});

test('dismissStep: busy ignores, dirty arms then closes, clean closes', () => {
  assert.equal(dismissStep({ busy: true, dirty: true, armed: true }), 'ignore');
  assert.equal(dismissStep({ busy: true, dirty: false, armed: false }), 'ignore');
  assert.equal(dismissStep({ busy: false, dirty: false, armed: false }), 'close');
  assert.equal(dismissStep({ busy: false, dirty: true, armed: false }), 'arm');
  assert.equal(dismissStep({ busy: false, dirty: true, armed: true }), 'close');
});

test('canOpenFinish: never while a finish sheet is open or saving, the stale sheet is open, or an open is in flight', () => {
  assert.equal(canOpenFinish({}), true);
  assert.equal(canOpenFinish({ finishOpen: true }), false);
  assert.equal(canOpenFinish({ finishBusy: true }), false);
  assert.equal(canOpenFinish({ staleOpen: true }), false);
  assert.equal(canOpenFinish({ opening: true }), false);
});

test('createGuard: one run at a time, busy flag, re-enable after failure, ignored errors stay silent', async () => {
  const log = [];
  let release;
  const g = createGuard({ setBusy: (b) => log.push(`busy:${b}`), onError: (e) => log.push(`err:${e.message}`), ignore: (e) => e.message === 'blocked' });
  assert.equal(g.busy, false);
  const first = g.run(() => new Promise((r) => { release = r; }));
  assert.equal(g.busy, true);
  assert.equal(await g.run(async () => log.push('second ran')), false, 'a second tap while pending does nothing');
  release();
  assert.equal(await first, true);
  assert.equal(g.busy, false);
  assert.deepEqual(log, ['busy:true', 'busy:false']);
  log.length = 0;
  assert.equal(await g.run(async () => { throw new Error('queue down'); }), false);
  assert.deepEqual(log, ['busy:true', 'err:queue down', 'busy:false']);
  assert.equal(g.busy, false, 'a failure re-enables');
  assert.equal(await g.run(async () => 1), true, 'and a retry runs');
  log.length = 0;
  assert.equal(await g.run(async () => { throw new Error('blocked'); }), false);
  assert.deepEqual(log, ['busy:true', 'busy:false']);
});

test('resolveFinishEnd: the clock is read fresh, a time typed after the sheet opened is valid (M3)', () => {
  const d = draftWith({ startedAt: at(NOW, -60), lastTick: at(NOW, -2) });
  const planEnd = NOW.toISOString();
  const typed = nowHHMM(at(NOW, 10));
  assert.equal(resolveFinishEnd({ draft: d, now: NOW.toISOString(), planEnd, touched: true, hhmm: typed }).code, 'in-future'); // stale clock
  assert.equal(resolveFinishEnd({ draft: d, now: at(NOW, 10).toISOString(), planEnd, touched: true, hhmm: typed }).code, null); // fresh clock
});
