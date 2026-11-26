import { pickCurrentBook } from './books.js';
// Pure validation for the More tab forms. Every validator returns { value, error }.
const fail = (error) => ({ value: null, error });
const ok = (value) => ({ value, error: null });
const isInt = (s) => /^\d+$/.test(String(s ?? '').trim());

export function validateWaterTarget(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(s)) return fail('Enter litres, e.g. 2.5');
  const x = Math.round(Number(s) * 100) / 100;
  return x >= 0.5 && x <= 6 ? ok(x) : fail('Between 0.5 and 6 L');
}

export function validateWeeklyPages(input) {
  const s = String(input ?? '').trim();
  if (!isInt(s)) return fail('Whole number, 0 to 5000');
  const n = Number(s);
  return n <= 5000 ? ok(n) : fail('Whole number, 0 to 5000');
}

const KINDS = ['daily', 'weekdays', 'n_per_week'];

export function validateHabit({ name, kind, weekdays, targetN } = {}) {
  const n = String(name ?? '').trim();
  if (!n) return fail('Name required');
  if (n.length > 40) return fail('Name: 40 characters max');
  if (!KINDS.includes(kind)) return fail('Pick a schedule');
  if (kind === 'daily') return ok({ name: n, schedule_kind: 'daily', weekdays: null, target_n: null });
  if (kind === 'weekdays') {
    const days = [...new Set((weekdays ?? []).map(Number))].sort((a, b) => a - b);
    if (!days.length) return fail('Pick at least one day');
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return fail('Pick at least one day');
    return ok({ name: n, schedule_kind: 'weekdays', weekdays: days, target_n: null });
  }
  if (!isInt(targetN) || Number(targetN) < 1 || Number(targetN) > 7) return fail('Times per week: 1 to 7');
  return ok({ name: n, schedule_kind: 'n_per_week', weekdays: null, target_n: Number(targetN) });
}

export function parseChecklist(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function validateRitual({ name, weekday, time, checklistText } = {}) {
  const n = String(name ?? '').trim();
  if (!n) return fail('Name required');
  if (n.length > 40) return fail('Name: 40 characters max');
  const wd = Number(weekday);
  if (!isInt(weekday) || wd < 1 || wd > 7) return fail('Pick a day');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time ?? ''))) return fail('Time as HH:MM');
  const checklist = parseChecklist(checklistText);
  if (checklist.length > 12) return fail('12 steps max');
  if (checklist.some((l) => l.length > 60)) return fail('Each step: 60 characters max');
  return ok({ name: n, weekday: wd, time, checklist });
}

export function validateBook({ title, author, pages } = {}) {
  const t = String(title ?? '').trim();
  if (!t) return fail('Title required');
  if (t.length > 120) return fail('Title: 120 characters max');
  const p = String(pages ?? '').trim();
  let total = null;
  if (p !== '') {
    if (!isInt(p) || Number(p) < 1 || Number(p) > 100000) return fail('Pages: a positive whole number');
    total = Number(p);
  }
  const a = String(author ?? '').trim();
  return ok({ title: t, author: a || null, total_pages: total });
}

export const nextSort = (habits) => habits.reduce((m, hb) => Math.max(m, hb.sort ?? 0), -1) + 1;

// Swap one habit with its neighbour; returns [{ id, sort }] for the rows whose sort actually changes.
export function moveHabit(habits, id, dir) {
  const ordered = habits.map((hb, i) => ({ hb, i })).sort((a, b) => (a.hb.sort ?? 0) - (b.hb.sort ?? 0) || a.i - b.i).map((x) => x.hb);
  const from = ordered.findIndex((hb) => hb.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= ordered.length) return [];
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const changes = [];
  ordered.forEach((hb, i) => { if (hb.sort !== i) changes.push({ id: hb.id, sort: i }); });
  return changes;
}

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function scheduleLabel(habit) {
  if (habit.schedule_kind === 'weekdays') {
    const d = [...(habit.weekdays ?? [])].sort((a, b) => a - b);
    return d.length === 5 && d[0] === 1 && d[4] === 5 ? 'Mon to Fri' : d.map((n) => WEEKDAY_NAMES[n - 1]).join(', ');
  }
  if (habit.schedule_kind === 'n_per_week') return `${habit.target_n} per week`;
  return 'Daily';
}

export const currentBookId = (books, settings) => pickCurrentBook(books, settings)?.id ?? null;

// Sign-out wipes this device's queue and gym draft (M2). null: nothing would be lost, sign out at once.
export function signOutWarning({ hasDraft = false, pending = 0 } = {}) {
  const n = Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0;
  if (!hasDraft && !n) return null;
  const changes = n === 1 ? '1 change is not synced yet' : `${n} changes are not synced yet`;
  const what = hasDraft && n ? `A workout is open and ${changes}` : hasDraft ? 'A workout is open' : changes;
  const lost = n > 1 || (hasDraft && n) ? 'They will be lost.' : 'It will be lost.';
  return `${what}. Sign out anyway? ${lost}`;
}
