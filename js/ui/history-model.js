// Pure view-model for exercise history and past workout detail. No DOM, no I/O.
import { epley, fmtKg, isWorking, orderSets, setLabel } from '../lib/gym-stats.js';
import { formatDayLabel } from '../lib/dates.js';
import { displayDuration } from '../lib/workout.js';
import { typeCode } from './workout-model.js';

export const HISTORY_PAGE = 20;
const DASH = '—';
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const isUuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const posInt = (n) => Number.isInteger(n) && n >= 0;

// Only a stored YYYY-MM-DD is formatted (device-local calendar, never a UTC slice of a timestamp).
function dayText(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return DASH;
  try { return formatDayLabel(day); } catch { return DASH; }
}

// Sessions of one exercise, newest first, `size` per page. Anything invalid (page, size, exercise, index) gives [].
export function exerciseHistoryPage(index, exerciseId, page, size = HISTORY_PAGE) {
  if (!posInt(page) || !Number.isInteger(size) || size < 1) return [];
  const exs = index && typeof index === 'object' ? index.exercises : null;
  if (!exs || typeof exerciseId !== 'string' || !hasOwn(exs, exerciseId)) return [];
  const list = exs[exerciseId]?.sessions;
  if (!Array.isArray(list)) return [];
  const t = (s) => { const n = Date.parse(s?.startedAt); return Number.isNaN(n) ? 0 : n; };
  const newest = list.map((s, i) => ({ s, i, t: t(s) })).sort((a, b) => b.t - a.t || b.i - a.i);
  return newest.slice(page * size, page * size + size).map(({ s }) => ({
    workoutId: s.workoutId, weIds: Array.isArray(s.weIds) ? s.weIds.slice() : [], day: s.day, startedAt: s.startedAt, name: s.name, hasPr: !!s.hasPr,
  }));
}

// The sets (from fetchSetsFor) that belong to one session's entries.
export function setsForSession(session, sets) {
  if (!session || !Array.isArray(sets)) return [];
  const ids = new Set(Array.isArray(session.weIds) ? session.weIds : []);
  return sets.filter((s) => ids.has(s.workout_exercise_id));
}

const compact = (s) => `${fmtKg(s.weight_kg)}×${s.reps}`;

// One history row: '80×8  80×8  80×7', warm-ups prefixed W (drop D, failure F) and never counted in the e1RM.
// `name` (A10) is the workout name; sessions in the index carry it.
export function historyLine(session, sets, name) {
  const list = Array.isArray(sets) ? orderSets(sets) : [];
  const parts = list.map((s) => {
    const code = typeCode(s.type);
    return code ? `${code} ${compact(s)}` : compact(s);
  });
  let best = null;
  for (const s of list) {
    if (!isWorking(s)) continue;
    const w = Number(s.weight_kg);
    if (!(w > 0)) continue; // bodyweight has no load to estimate
    const e = epley(w, s.reps);
    if (e !== null && (best === null || e > best)) best = e;
  }
  return {
    day: dayText(session?.day),
    name: name ?? session?.name ?? 'Workout',
    sets: parts.length ? parts.join('  ') : DASH,
    e1rm: best === null ? DASH : best.toFixed(1),
    pr: !!session?.hasPr,
  };
}

// Past workout screen: header facts plus each entry's sets. PR marks are what was stored (imported rows may have none).
export function workoutDetailModel({ workout, workoutExercises = [], sets = [], exercises = [] }) {
  const names = new Map((exercises ?? []).map((e) => [e.id, e.name]));
  const byEntry = new Map();
  for (const s of Array.isArray(sets) ? sets : []) {
    if (!byEntry.has(s.workout_exercise_id)) byEntry.set(s.workout_exercise_id, []);
    byEntry.get(s.workout_exercise_id).push(s);
  }
  const entries = (Array.isArray(workoutExercises) ? workoutExercises : []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return {
    id: workout.id,
    name: workout.name,
    day: workout.day,
    dayLabel: dayText(workout.day),
    duration: displayDuration(workout),
    note: typeof workout.note === 'string' ? workout.note : '',
    inProgress: workout.ended_at == null,
    exercises: entries.map((we) => {
      let num = 0;
      return {
        id: we.id, exerciseId: we.exercise_id, name: names.get(we.exercise_id) ?? 'Exercise', note: typeof we.note === 'string' ? we.note : '',
        sets: orderSets(byEntry.get(we.id) ?? []).map((s) => {
          const code = typeCode(s.type);
          const working = s.type !== 'warmup';
          if (working) num += 1;
          return { id: s.id, num: working ? num : null, text: setLabel(s), code, pr: working && s.is_pr === true };
        }),
      };
    }),
  };
}

// Only a finished workout can be deleted here; the open draft (or an unfinished row) is handled by the workout screen.
export function canDeleteWorkout(workout, { draft = null } = {}) {
  if (!workout || typeof workout.id !== 'string' || !workout.id || workout.ended_at == null) return false;
  return draft?.workout?.id !== workout.id;
}

function workingSetsOf(index, workoutId) {
  let known = false, n = 0;
  for (const ex of Object.values(index?.exercises ?? {})) {
    for (const s of ex?.sessions ?? []) if (s.workoutId === workoutId) { known = true; n += s.workingSets ?? 0; }
  }
  if (!known && !(index?.workoutIds ?? []).includes(workoutId)) return null; // not indexed: unknown
  return n;
}

// Spec 6: deleting a workout never unchecks the Gym habit. True when that leaves a done Gym tick on the day that no
// other finished workout with working sets explains, so the user is told it stays.
export function habitStillChecked({ snapshot, workout, index = null }) {
  const hid = snapshot?.settings?.gym_habit_id;
  if (!hid || !workout?.day) return false;
  const ticked = (snapshot.habitLogs ?? []).some((l) => l.habit_id === hid && l.date === workout.day && l.status === 'done');
  if (!ticked) return false;
  const others = (snapshot.workouts ?? []).filter((w) => w.id !== workout.id && w.day === workout.day && w.ended_at != null);
  return !others.some((w) => { const n = workingSetsOf(index, w.id); return n === null || n > 0; });
}

// Text of the delete confirmation. A Strive import that is run again would bring an imported workout back.
export function deleteWarning(workout) {
  const base = 'This removes the workout, its exercises and all its sets. It cannot be undone.';
  return workout?.imported ? `${base} It was imported from Strive: running the import again would restore it.` : base;
}
