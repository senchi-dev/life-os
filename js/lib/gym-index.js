// Derived per-exercise history (last session, e1RM, Pareto front) built from gym rows.
import { epley, isWorking, orderSets, replaySession } from './gym-stats.js';

const empty = () => ({ workoutIds: [], exercises: {} });

function sessionsOf({ workouts, workoutExercises, sets }) {
  const done = new Map(workouts.filter((w) => w.ended_at).map((w) => [w.id, w]));
  const setsByWe = new Map();
  for (const s of sets) {
    if (!setsByWe.has(s.workout_exercise_id)) setsByWe.set(s.workout_exercise_id, []);
    setsByWe.get(s.workout_exercise_id).push(s);
  }
  const byKey = new Map();
  for (const we of workoutExercises) {
    const w = done.get(we.workout_id);
    if (!w) continue;
    const key = `${we.exercise_id}|${w.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, { exerciseId: we.exercise_id, workoutId: w.id, weIds: [], name: w.name,
        day: w.day, startedAt: w.started_at, sets: [] });
    }
    const ses = byKey.get(key);
    ses.weIds.push(we.id);
    ses.sets.push(...(setsByWe.get(we.id) || []));
  }
  return { done, list: [...byKey.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)) };
}

// Fold one session into an exercise entry (or create it). Returns null if it has no working sets.
function advance(entry, ses) {
  const sets = orderSets(ses.sets);
  const working = sets.filter(isWorking);
  if (!working.length) return entry || null;
  const r = replaySession(entry ? entry.front : [], entry ? entry.bestE1rm : null, sets);
  const hasPr = entry ? [...r.flags.values()].some(Boolean) : false;
  let top = null, bestE = null;
  for (const s of working) {
    const p = { w: Number(s.weight_kg), r: s.reps };
    if (!top || p.w > top.w || (p.w === top.w && p.r > top.r)) top = p;
    const e = epley(p.w, p.r);
    if (e !== null && (bestE === null || e > bestE)) bestE = e;
  }
  const session = { workoutId: ses.workoutId, weIds: ses.weIds, name: ses.name, day: ses.day,
    startedAt: ses.startedAt, bestE1rm: bestE, top, workingSets: working.length, hasPr };
  const sessions = (entry ? entry.sessions : []).concat([session])
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const newest = sessions[sessions.length - 1] === session;
  const last = newest || !entry ? {
    workoutId: ses.workoutId, day: ses.day, startedAt: ses.startedAt,
    sets: working.slice().sort((a, b) => a.set_no - b.set_no)
      .map((s) => ({ weight_kg: Number(s.weight_kg), reps: s.reps, type: s.type })),
  } : entry.last;
  return { last, sessions, bestE1rm: r.bestE1rm, front: r.front };
}

export function buildIndex(rows) {
  const { done, list } = sessionsOf(rows);
  const index = empty();
  index.version = 1;
  index.workoutIds = [...done.keys()];
  for (const ses of list) {
    const e = advance(index.exercises[ses.exerciseId], ses);
    if (e) index.exercises[ses.exerciseId] = e;
  }
  return index;
}

// True when applyWorkouts gives the same result as buildIndex: every incoming finished
// workout is new (not already indexed) and starts after the latest indexed session of each
// exercise it touches (all exercises when workoutExercises is omitted). Otherwise callers
// must rebuild with buildIndex over the full history.
export function canApplyIncrementally(index, workouts, workoutExercises) {
  const have = new Set(index.workoutIds);
  const latest = (exId) => {
    const ex = index.exercises[exId];
    return ex && ex.sessions.length ? Date.parse(ex.sessions[ex.sessions.length - 1].startedAt) : -Infinity;
  };
  for (const w of workouts) {
    if (!w.ended_at) continue;
    if (have.has(w.id)) return false;
    const t = Date.parse(w.started_at);
    const exIds = workoutExercises
      ? workoutExercises.filter((we) => we.workout_id === w.id).map((we) => we.exercise_id)
      : Object.keys(index.exercises);
    if (exIds.some((id) => t <= latest(id))) return false;
  }
  return true;
}

// Append-only: only valid when canApplyIncrementally(index, ...) is true. Replaced or
// older workouts would fold in as newest with stale front/last/hasPr; use buildIndex then.
export function applyWorkouts(index, rows) {
  const next = JSON.parse(JSON.stringify(index));
  const { done, list } = sessionsOf(rows);
  const wasPr = new Set();
  for (const id of done.keys()) {
    if (!next.workoutIds.includes(id)) next.workoutIds.push(id);
    for (const [exId, ex] of Object.entries(next.exercises)) {
      const old = ex.sessions.find((s) => s.workoutId === id);
      if (old && old.hasPr) wasPr.add(`${exId}|${id}`);
      ex.sessions = ex.sessions.filter((s) => s.workoutId !== id);
    }
  }
  for (const [exId, ex] of Object.entries(next.exercises)) {
    if (!ex.sessions.length) delete next.exercises[exId];
  }
  for (const ses of list) {
    const e = advance(next.exercises[ses.exerciseId], ses);
    if (!e) continue;
    if (wasPr.has(`${ses.exerciseId}|${ses.workoutId}`)) {
      e.sessions.find((x) => x.workoutId === ses.workoutId).hasPr = true;
    }
    next.exercises[ses.exerciseId] = e;
  }
  return next;
}

export function missingWorkoutIds(index, workouts) {
  const have = new Set(index.workoutIds);
  return workouts.filter((w) => w.ended_at && !have.has(w.id)).map((w) => w.id);
}

export function prevFor(index, exerciseId) {
  const ex = index && index.exercises[exerciseId];
  return ex ? ex.last.sets.map((s) => ({ ...s })) : [];
}

// Index without one workout's sessions (a deleted workout). `last`, `front` and `bestE1rm` of the exercises it touched
// are NOT recomputed (that needs the sets): callers flag a full rebuild. Returns a copy; null stays null.
export function dropWorkoutFromIndex(index, workoutId) {
  if (!index) return index;
  const next = JSON.parse(JSON.stringify(index));
  next.workoutIds = (next.workoutIds ?? []).filter((id) => id !== workoutId);
  for (const [exId, ex] of Object.entries(next.exercises ?? {})) {
    ex.sessions = (ex.sessions ?? []).filter((s) => s.workoutId !== workoutId);
    if (!ex.sessions.length) delete next.exercises[exId];
  }
  return next;
}
