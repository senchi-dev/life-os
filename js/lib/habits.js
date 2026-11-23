import { addDays, isoWeekday, weekStart } from './dates.js';

export const MAX_ACTIVE_HABITS = 6;
const MAX_WALK = 3650; // safety bound for backward walks

export function isDue(habit, dateKey) {
  if (habit.schedule_kind === 'n_per_week') return true;
  if (habit.schedule_kind === 'weekdays') return (habit.weekdays || []).includes(isoWeekday(dateKey));
  return true;
}

function statusMap(habit, logs) {
  const m = new Map();
  for (const l of logs) if (l.habit_id === habit.id) m.set(l.date, l.status);
  return m;
}

function doneInWeek(map, start) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (map.get(addDays(start, i)) === 'done') n++;
  return n;
}

// Last 4 complete ISO weeks (current, possibly partial, week excluded), most recent first.
function lastCompleteWeeks(todayKey, count) {
  const cur = weekStart(todayKey);
  return Array.from({ length: count }, (_, i) => addDays(cur, -7 * (i + 1)));
}

export function consistency28(habit, logs, todayKey) {
  const map = statusMap(habit, logs);
  if (habit.schedule_kind === 'n_per_week') {
    const t = habit.target_n;
    if (!t) return null;
    let sum = 0;
    for (const ws of lastCompleteWeeks(todayKey, 4)) sum += Math.min(doneInWeek(map, ws), t);
    return sum / (4 * t);
  }
  let num = 0, den = 0;
  for (let i = 0; i < 28; i++) {
    const d = addDays(todayKey, -i);
    if (!isDue(habit, d)) continue;
    const s = map.get(d);
    if (s === 'skipped') continue;
    if (d === todayKey && !s) continue;
    den++;
    if (s === 'done') num++;
  }
  return den === 0 ? null : num / den;
}

export function streak(habit, logs, todayKey) {
  const map = statusMap(habit, logs);
  if (habit.schedule_kind === 'n_per_week') {
    const t = habit.target_n;
    if (!t) return 0;
    let n = 0;
    // Simplest reading: current (incomplete) week is not counted, walk complete weeks back.
    for (let ws = addDays(weekStart(todayKey), -7); n < 520; ws = addDays(ws, -7)) {
      if (doneInWeek(map, ws) >= t) n++; else break;
    }
    return n;
  }
  let n = 0;
  for (let i = 0; i < MAX_WALK; i++) {
    const d = addDays(todayKey, -i);
    if (!isDue(habit, d)) continue;
    const s = map.get(d);
    if (s === 'skipped') continue;
    if (s === 'done') { n++; continue; }
    if (i === 0) continue; // today unlogged does not break the streak
    break;
  }
  return n;
}

export function missRun(habit, logs, todayKey) {
  if (habit.schedule_kind === 'n_per_week') return 0;
  const map = statusMap(habit, logs);
  let n = 0;
  // Walk back from yesterday; bounded at 28 days when the habit has no done log to stop at.
  for (let i = 1; i <= 28; i++) {
    const d = addDays(todayKey, -i);
    if (!isDue(habit, d)) continue;
    const s = map.get(d);
    if (s === 'done') break;
    if (s === 'skipped') continue;
    n++;
  }
  return n;
}

export function habitFlag(run) {
  return run >= 2 ? 'red' : run === 1 ? 'warn' : 'none';
}

export function weekHits(habit, logs, weekStartKey, upToKey) {
  const map = statusMap(habit, logs);
  const end = addDays(weekStartKey, 6);
  const last = upToKey && upToKey < end ? upToKey : end;
  let hits = 0, due = 0;
  for (let d = weekStartKey; d <= last; d = addDays(d, 1)) {
    const s = map.get(d);
    if (s === 'done') hits++;
    if (isDue(habit, d) && s !== 'skipped') due++;
  }
  if (habit.schedule_kind === 'n_per_week') return { hits, target: habit.target_n };
  return { hits, target: due };
}

export function nextStatus(current, gesture) {
  if (gesture === 'tap') return current === 'done' ? null : 'done';
  return current === 'skipped' ? null : 'skipped';
}

export function canActivate(habits) {
  return habits.filter((h) => h.active).length < MAX_ACTIVE_HABITS;
}
