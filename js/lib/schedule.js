// Weekly training plan, rolling next-routine rule and today hint. Pure; dates are device-local keys.
import { addDays, isoWeekday, weekStart } from './dates.js';

export function shortName(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf(' - ');
  return i < 0 ? s : s.slice(i + 3);
}

const byWeekday = (slots) => [...slots].sort((a, b) => a.weekday - b.weekday);
const liveRoutines = (routines) => new Map(routines.filter((r) => !r.archived).map((r) => [r.id, r]));
const trainingSlots = (slots) => byWeekday(slots).filter((s) => s.routine_id != null);

export function trainingCycle(slots, routines) {
  const live = liveRoutines(routines);
  if (!slots.length) return [...live.values()].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((r) => r.id);
  return trainingSlots(slots).filter((s) => live.has(s.routine_id)).map((s) => s.routine_id);
}

export function nextRoutineId({ cycle, workouts }) {
  const n = cycle.length;
  if (!n) return null;
  const q = workouts.filter((w) => w.ended_at && cycle.includes(w.routine_id))
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  if (!q.length) return cycle[0];
  const R = q[q.length - 1].routine_id;
  const idxs = [];
  cycle.forEach((id, i) => { if (id === R) idxs.push(i); });
  let i = idxs[0];
  if (idxs.length > 1 && q.length > 1) {
    const P = q[q.length - 2].routine_id;
    const hit = idxs.find((k) => cycle[(k - 1 + n) % n] === P);
    if (hit !== undefined) i = hit;
  }
  return cycle[(i + 1) % n];
}

const finished = (w) => !!w.ended_at;
const doneOn = (workouts, day) => workouts.find((w) => finished(w) && w.day === day);

export function todayHint({ slots, routines, workouts, todayKey }) {
  if (!slots.length) return null;
  if (doneOn(workouts, addDays(todayKey, -1)) && doneOn(workouts, addDays(todayKey, -2))) return { kind: 'two-in-a-row' };
  const slot = slots.find((s) => s.weekday === isoWeekday(todayKey));
  const r = slot && slot.routine_id != null ? liveRoutines(routines).get(slot.routine_id) : null;
  return r ? { kind: 'planned', name: shortName(r.name) } : { kind: 'rest' };
}

export function hintText(hint) {
  if (!hint) return '';
  if (hint.kind === 'two-in-a-row') return '2 days in a row · rest suggested';
  if (hint.kind === 'planned') return `Planned today: ${shortName(hint.name)}`;
  if (hint.kind === 'rest') return 'Rest day planned';
  return '';
}

function minutesOf(w) {
  if (w.duration_known === false) return null;
  const m = (Date.parse(w.ended_at) - Date.parse(w.started_at)) / 60000;
  return Number.isFinite(m) ? Math.round(m) : null;
}

export function plannedRows({ slots, routines, workouts, todayKey, days = 7 }) {
  const live = liveRoutines(routines);
  const rows = [];
  for (let k = 0; k < days; k++) {
    const date = addDays(todayKey, k);
    const w = doneOn(workouts, date);
    if (w) { rows.push({ date, kind: 'done', name: shortName(w.name), workoutId: w.id, minutes: minutesOf(w) }); continue; }
    const slot = slots.find((s) => s.weekday === isoWeekday(date));
    const r = slot && slot.routine_id != null ? live.get(slot.routine_id) : null;
    if (r) rows.push({ date, kind: 'planned', name: shortName(r.name) });
  }
  return rows;
}

export function weekSessions({ workouts, slots, todayKey }) {
  const start = weekStart(todayKey);
  const end = addDays(start, 6);
  const mine = workouts.filter((w) => finished(w) && w.imported === false && w.day >= start && w.day <= end);
  const planned = new Set(trainingSlots(slots).map((s) => s.weekday));
  const doneDays = new Set(mine.map((w) => isoWeekday(w.day)));
  const dots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, planned: planned.has(weekday), done: doneDays.has(weekday) }));
  return { done: mine.length, plan: planned.size || 4, dots };
}

export function gymTargetPatch(habit, slots) {
  const n = trainingSlots(slots).length;
  if (habit.schedule_kind !== 'n_per_week' || n < 1 || n > 7 || habit.target_n === n) return null;
  return { ...habit, target_n: n };
}

export function defaultSlots(upperId, lowerId) {
  return [upperId, lowerId, null, upperId, lowerId, null, null].map((routine_id, i) => ({ weekday: i + 1, routine_id }));
}
