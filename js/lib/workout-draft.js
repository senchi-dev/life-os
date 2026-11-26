// Workout draft reducer: pure state -> exact outbox ops. No DOM, no storage, no clock (callers pass `now`).
import { upsertRows, removeRow } from '../data/gym-repo.js';
import { prefillSets, isWorking } from './gym-stats.js';
import { prevFor } from './gym-index.js';
import { localDateKey } from './dates.js';

const defaultId = () => crypto.randomUUID();
const clone = (x) => structuredClone(x);

const weRow = (draft, e) => ({ id: e.id, workout_id: draft.workout.id, exercise_id: e.exercise_id, position: e.position, note: e.note });
const setRow = (we, s, isPr = false) => ({
  id: s.id, workout_exercise_id: we.id, set_no: s.set_no, reps: s.reps, weight_kg: s.kg, type: s.type, is_pr: isPr, done_at: s.done_at,
});
const workoutRow = (w, extra) => ({
  id: w.id, routine_id: w.routine_id, name: w.name, day: w.day, started_at: w.started_at,
  ended_at: null, duration_known: true, note: w.note, imported: false, source_ref: null, ...extra,
});

function buildSets(filled, newId) {
  return filled.map((p, i) => ({ id: newId(), set_no: i + 1, kg: p.kg, reps: p.reps, type: p.type, done: false, done_at: null }));
}

function prefillFor(index, exercise, targetSets, targetRepsMin) {
  return prefillSets({ prev: prevFor(index, exercise.id), targetSets, targetRepsMin, equipment: exercise.equipment });
}

export function startDraft({ routine, items, exercisesById, index, userId, now, newId = defaultId }) {
  const startedAt = now.toISOString();
  const workout = { id: newId(), routine_id: routine ? routine.id : null, name: routine ? routine.name : 'Workout',
    day: localDateKey(now), started_at: startedAt, note: '' };
  const exercises = items.slice().sort((a, b) => a.position - b.position).map((it) => {
    const ex = exercisesById[it.exercise_id] || { id: it.exercise_id };
    const id = newId();
    return { id, exercise_id: it.exercise_id, position: it.position, note: '',
      sets: buildSets(prefillFor(index, ex, it.target_sets, it.target_reps_min), newId) };
  });
  const draft = { v: 1, userId, workout, exercises, undo: [], lastTickAt: null };
  const ops = [upsertRows('workouts', [workoutRow(workout, {})])];
  if (exercises.length) ops.push(upsertRows('workout_exercises', exercises.map((e) => weRow(draft, e))));
  return { draft, ops };
}

// Renumber 1..n; returns the done siblings whose set_no changed.
function renumber(we) {
  const changed = [];
  we.sets.forEach((s, i) => {
    if (s.set_no !== i + 1) { s.set_no = i + 1; if (s.done) changed.push(s); }
  });
  return changed;
}

const validKg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const validReps = (v) => Number.isInteger(v) && v >= 0 && v <= 1000;
const find = (d, weId) => d.exercises.find((e) => e.id === weId);
const err = (draft, error) => ({ draft, ops: [], error });

export function reduce(draft0, action, { now, newId = defaultId, index } = {}) {
  const d = clone(draft0);
  const ops = [];
  const we = action.weId ? find(d, action.weId) : null;
  const set = we && action.setId ? we.sets.find((s) => s.id === action.setId) : null;
  switch (action.kind) {
    case 'edit': {
      if (!set) break;
      if (action.field !== 'kg' && action.field !== 'reps') return err(draft0, 'bad-field');
      const valid = action.field === 'kg' ? validKg(action.value) : validReps(action.value);
      // A done set is already queued: an invalid value would emit a row the validator rejects and stall the outbox.
      if (set.done && !valid) return err(draft0, action.field === 'kg' ? 'kg-required' : 'reps-required');
      // An undone set may be cleared (null) but never holds garbage: a later tick would queue it.
      if (action.value !== null && !valid) return err(draft0, 'bad-value');
      set[action.field] = action.value;
      set.edited = true; // the view shows prefilled, untouched rows faint
      if (set.done) ops.push(upsertRows('sets', [setRow(we, set)]));
      break;
    }
    case 'tick':
      if (!set) break;
      if (set.kg == null) return err(draft0, 'kg-required');
      if (set.reps == null) return err(draft0, 'reps-required');
      set.done = true; set.edited = true; set.done_at = now.toISOString(); d.lastTickAt = set.done_at;
      ops.push(upsertRows('sets', [setRow(we, set)]));
      break;
    case 'untick':
      if (!set) break;
      set.done = false; set.done_at = null;
      ops.push(removeRow('sets', set.id));
      break;
    case 'setType':
      if (!set) break;
      set.type = action.type;
      if (set.done) ops.push(upsertRows('sets', [setRow(we, set)]));
      break;
    case 'addSet': {
      if (!we) break;
      const last = we.sets[we.sets.length - 1];
      we.sets.push({ id: newId(), set_no: we.sets.length + 1, kg: last ? last.kg : null, reps: last ? last.reps : null,
        type: 'normal', done: false, done_at: null });
      break;
    }
    case 'removeSet': {
      if (!set) break;
      const i = we.sets.indexOf(set);
      d.undo.push({ kind: 'set', weId: we.id, index: i, item: set });
      we.sets.splice(i, 1);
      if (set.done) ops.push(removeRow('sets', set.id));
      const changed = renumber(we);
      if (changed.length) ops.push(upsertRows('sets', changed.map((s) => setRow(we, s))));
      break;
    }
    case 'undo': {
      const u = d.undo.pop();
      if (!u) break;
      if (u.kind === 'set') {
        const owner = find(d, u.weId);
        if (!owner) break;
        owner.sets.splice(Math.min(u.index, owner.sets.length), 0, u.item);
        const changed = renumber(owner);
        u.item.set_no = owner.sets.indexOf(u.item) + 1;
        const rows = owner.sets.filter((s) => (s === u.item && s.done) || changed.includes(s));
        if (rows.length) ops.push(upsertRows('sets', rows.map((s) => setRow(owner, s))));
      } else {
        d.exercises.splice(Math.min(u.index, d.exercises.length), 0, u.item);
        const moved = [];
        d.exercises.forEach((e, i) => { if (e.position !== i) { e.position = i; if (e !== u.item) moved.push(e); } });
        ops.push(upsertRows('workout_exercises', [u.item, ...moved].map((e) => weRow(d, e))));
        const done = u.item.sets.filter((s) => s.done);
        if (done.length) ops.push(upsertRows('sets', done.map((s) => setRow(u.item, s))));
      }
      break;
    }
    case 'addExercise': {
      const ex = action.exercise;
      const position = d.exercises.reduce((m, e) => Math.max(m, e.position), -1) + 1;
      const e = { id: newId(), exercise_id: ex.id, position, note: '', sets: buildSets(prefillFor(index, ex, 3, 8), newId) };
      d.exercises.push(e);
      ops.push(upsertRows('workout_exercises', [weRow(d, e)]));
      break;
    }
    case 'replaceExercise': {
      if (!we) break;
      if (we.sets.some((s) => s.done)) return err(draft0, 'has-done-sets');
      const ex = action.exercise;
      d.undo = d.undo.filter((u) => u.weId !== we.id);
      we.exercise_id = ex.id;
      we.sets = buildSets(prefillFor(index, ex, we.sets.length || 3, 8), newId);
      ops.push(upsertRows('workout_exercises', [weRow(d, we)]));
      break;
    }
    case 'move': {
      if (!we) break;
      const order = d.exercises.slice().sort((a, b) => a.position - b.position);
      const j = order.indexOf(we) + action.dir;
      if (j < 0 || j >= order.length) break;
      const other = order[j];
      [we.position, other.position] = [other.position, we.position];
      d.exercises.sort((a, b) => a.position - b.position);
      ops.push(upsertRows('workout_exercises', [weRow(d, we), weRow(d, other)]));
      break;
    }
    case 'removeExercise': {
      if (!we) break;
      const i = d.exercises.indexOf(we);
      d.undo.push({ kind: 'exercise', weId: we.id, index: i, item: we });
      d.exercises.splice(i, 1);
      ops.push(removeRow('workout_exercises', we.id));
      break;
    }
    case 'exerciseNote':
      if (!we) break;
      we.note = action.text;
      ops.push(upsertRows('workout_exercises', [weRow(d, we)]));
      break;
    case 'sessionNote':
      d.workout.note = action.text;
      break;
    default:
      break;
  }
  return { draft: d, ops };
}

const hasValues = (s) => s.kg != null && s.reps != null;

export function finishOps(draft, { end, durationKnown, prMap, gymHabitId, logUnticked }) {
  const pr = (id) => !!(prMap && prMap.get(id));
  const rows = [];
  const loggedSets = [];
  let working = false;
  for (const e of draft.exercises) {
    for (const s of e.sets) {
      let sent = s.done;
      let doneAt = s.done_at;
      if (!s.done && logUnticked && hasValues(s)) { sent = true; doneAt = end; }
      if (!sent) continue;
      const row = setRow(e, { ...s, done_at: doneAt }, pr(s.id));
      if (isWorking({ type: s.type, reps: s.reps })) working = true;
      // Every done set is re-sent (full row, keyed by id, idempotent): a tick upsert lost from the queue (cleared by a
      // session re-check that kept the draft, or permanently rejected) must not lose the set.
      rows.push(row);
      if (!s.done) loggedSets.push(row);
    }
  }
  const w = workoutRow(draft.workout, { ended_at: end, duration_known: durationKnown });
  // FK order, every write an idempotent full-row upsert: if the queue lost the start insert or an addExercise upsert, the
  // parents are re-created before the sets (else the sets batch fails the foreign key and every set is dropped).
  // The finished row is written first (FK-safe and never a second open workout) and again LAST, so ended_at wins.
  const ops = [];
  const wes = draft.exercises.map((e) => weRow(draft, e));
  if (wes.length || rows.length) ops.push(upsertRows('workouts', [w]));
  if (wes.length) ops.push(upsertRows('workout_exercises', wes));
  if (rows.length) ops.push(upsertRows('sets', rows));
  ops.push(upsertRows('workouts', [w]));
  if (gymHabitId && working) {
    ops.push({ kind: 'upsert', table: 'habit_logs', rows: [{ habit_id: gymHabitId, date: draft.workout.day, status: 'done' }], onConflict: 'habit_id,date' });
  }
  return { ops, workoutRow: w, loggedSets };
}

export const discardOps = (draft) => [removeRow('workouts', draft.workout.id)];

export function untickedWithValues(draft) {
  return draft.exercises.reduce((n, e) => n + e.sets.filter((s) => !s.done && hasValues(s)).length, 0);
}

export function draftSummary(draft) {
  const sets = draft.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  return { sets, exercisesDone: draft.exercises.filter((e) => e.sets.some((s) => s.done)).length, exercisesTotal: draft.exercises.length };
}

export function reconcileDraft({ draft, snapshot, queueEmpty }) {
  const w = (snapshot.workouts || []).find((x) => x.id === draft.workout.id);
  if (w) return w.ended_at ? 'finished-elsewhere' : 'keep';
  return queueEmpty ? 'discarded-elsewhere' : 'keep';
}

export function draftFromServer({ workout, workoutExercises, sets }, userId) {
  let last = null;
  const exercises = workoutExercises.slice().sort((a, b) => a.position - b.position).map((we) => {
    const mine = sets.filter((s) => s.workout_exercise_id === we.id && s.done_at)
      .sort((a, b) => a.set_no - b.set_no)
      .map((s) => {
        if (!last || Date.parse(s.done_at) > Date.parse(last)) last = s.done_at;
        return { id: s.id, set_no: s.set_no, kg: Number(s.weight_kg), reps: s.reps, type: s.type, done: true, done_at: s.done_at };
      });
    return { id: we.id, exercise_id: we.exercise_id, position: we.position, note: we.note || '', sets: mine };
  });
  return { v: 1, userId, undo: [], lastTickAt: last, exercises,
    workout: { id: workout.id, routine_id: workout.routine_id, name: workout.name, day: workout.day, started_at: workout.started_at, note: workout.note || '' } };
}
