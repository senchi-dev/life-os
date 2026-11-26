// Pure view-model for the Gym tab home. No DOM, no I/O.
import { addDays } from '../lib/dates.js';
import { nextRoutineId, trainingCycle, weekSessions, shortName } from '../lib/schedule.js';
import { displayDuration } from '../lib/workout.js';

export const HISTORY_DAYS = 42;

// workoutId -> { sets, prs } from the history index (working sets, exercises with a PR). One pass.
function statsByWorkout(index) {
  const out = new Map();
  for (const ex of Object.values(index?.exercises ?? {})) {
    for (const s of ex.sessions ?? []) {
      const e = out.get(s.workoutId) ?? { sets: 0, prs: 0 };
      e.sets += s.workingSets ?? 0;
      if (s.hasPr) e.prs += 1;
      out.set(s.workoutId, e);
    }
  }
  return out;
}

const letter = (name) => (Array.from(shortName(name).trim())[0] ?? '').toUpperCase() || '·';

export function gymHomeModel(snapshot, { draft = null, index = null, todayKey } = {}) {
  const s = snapshot ?? {};
  const allRoutines = s.routines ?? [];
  const live = allRoutines.filter((r) => !r.archived).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const items = s.routineItems ?? [];
  const slots = s.scheduleSlots ?? [];
  const workouts = s.workouts ?? [];
  const finished = workouts.filter((w) => w.ended_at);

  let start;
  if (draft?.workout) {
    start = { state: 'resume', name: draft.workout.name ?? null, routineId: draft.workout.routine_id ?? null };
  } else {
    const id = nextRoutineId({ cycle: trainingCycle(slots, allRoutines), workouts });
    const next = live.find((r) => r.id === id) ?? null;
    start = { state: 'start', name: next?.name ?? null, routineId: next?.id ?? null };
  }

  const liveById = new Map(live.map((r) => [r.id, r]));
  const schedule = slots.length
    ? [1, 2, 3, 4, 5, 6, 7].map((d) => {
      const slot = slots.find((x) => x.weekday === d);
      const r = slot && slot.routine_id != null ? liveById.get(slot.routine_id) : null;
      return r ? letter(r.name) : '·';
    }).join(' ')
    : '';

  const routines = live.map((r) => ({
    id: r.id, name: r.name,
    count: items.filter((i) => i.routine_id === r.id).length,
    lastDay: finished.filter((w) => w.routine_id === r.id).map((w) => w.day).sort().at(-1) ?? null,
  }));

  const cutoff = addDays(todayKey, -HISTORY_DAYS);
  const stats = statsByWorkout(index);
  const history = finished
    .filter((w) => w.day >= cutoff)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
    .map((w) => ({
      id: w.id, day: w.day, name: w.name, duration: displayDuration(w),
      sets: stats.has(w.id) ? stats.get(w.id).sets : null, prs: stats.get(w.id)?.prs ?? 0,
    }));

  return {
    start,
    week: weekSessions({ workouts, slots, todayKey }),
    schedule,
    routines,
    exerciseCount: (s.exercises ?? []).filter((e) => !e.archived).length,
    history,
    empty: live.length === 0 && workouts.length === 0,
  };
}
