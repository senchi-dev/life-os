import { addDays, weekStart } from './dates.js';

export const CALVIEW_KEY = 'lifeos-calview';
export const CAL_VIEWS = ['agenda', 'day', 'week', 'month'];

export function readCalView(storage) {
  try {
    const v = storage.getItem(CALVIEW_KEY);
    return CAL_VIEWS.includes(v) ? v : 'agenda';
  } catch {
    return 'agenda';
  }
}

export function writeCalView(storage, value) {
  if (!CAL_VIEWS.includes(value)) return false;
  try {
    storage.setItem(CALVIEW_KEY, value);
    return true;
  } catch {
    return false;
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Monday..Sunday of the week containing `key`.
export function weekDays(key) {
  const mon = weekStart(key);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

// Month index arithmetic on the key itself: { y, m } with m in 1..12.
function shiftMonth(y, m, dir) {
  const i = y * 12 + (m - 1) + dir;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

function firstOfMonth(y, m) {
  return `${y}-${pad(m)}-01`;
}

function lastOfMonth(y, m) {
  const next = shiftMonth(y, m, 1);
  return addDays(firstOfMonth(next.y, next.m), -1);
}

// Whole Monday-first weeks covering the month of `key` (4 to 6 rows).
export function monthGrid(key) {
  const [y, m] = key.split('-').map(Number);
  const month = `${y}-${pad(m)}`;
  const start = weekStart(firstOfMonth(y, m));
  const end = addDays(weekStart(lastOfMonth(y, m)), 6);
  const weeks = [];
  let d = start;
  while (d <= end) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      row.push({ date: d, inMonth: d.startsWith(month) });
      d = addDays(d, 1);
    }
    weeks.push(row);
  }
  return { month, weeks };
}

export function rangeFor(view, anchor, todayKey) {
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'week') {
    const days = weekDays(anchor);
    return { from: days[0], to: days[6] };
  }
  if (view === 'month') {
    const { weeks } = monthGrid(anchor);
    return { from: weeks[0][0].date, to: weeks[weeks.length - 1][6].date };
  }
  return { from: todayKey, to: addDays(todayKey, 6) };
}

// Move the anchor one view-unit forward (dir 1) or back (dir -1).
// Month keeps the day number, clamped to the target month's length.
export function step(view, anchor, dir) {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'month') {
    const [y, m, d] = anchor.split('-').map(Number);
    const t = shiftMonth(y, m, dir);
    const last = Number(lastOfMonth(t.y, t.m).slice(8));
    return `${t.y}-${pad(t.m)}-${pad(Math.min(d, last))}`;
  }
  return anchor;
}
