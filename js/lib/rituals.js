import { addDays, isoWeekday, weekStart } from './dates.js';

export const DEFAULT_RITUALS = [
  {
    name: 'Budget day', weekday: 7, time: '10:00',
    checklist: ['Import statements', 'Clear review queue', 'Check spend and runway', 'Encrypted export (monthly)'],
  },
  {
    name: 'Planning session', weekday: 7, time: '18:00',
    checklist: ['Weekly review', "Place next week's events", 'Pick the one change'],
  },
  {
    name: 'Cleaning reset', weekday: 6, time: '10:00',
    checklist: [
      'Tidy everything into its place', 'Dust the shelves', 'Change the bed sheets',
      "Prepare the week's outfits", 'Haircut (if due)', 'Weigh in',
      'Review gym progress', 'Recalibrate calories',
    ],
  },
];

// Most recent date <= todayKey falling on the ritual's weekday.
export function occurrence(ritual, todayKey) {
  const back = (isoWeekday(todayKey) - ritual.weekday + 7) % 7;
  return addDays(todayKey, -back);
}

export function ritualsForToday(rituals, logs, todayKey) {
  const out = [];
  for (const ritual of rituals) {
    const occ = occurrence(ritual, todayKey);
    const ws = weekStart(occ);
    const log = logs.find((l) => l.ritual_id === ritual.id && l.week_start === ws);
    const done = !!(log && log.done_at);
    const overdue = occ < todayKey;
    if (overdue && done) continue;
    const n = ritual.checklist.length;
    const state = Array.from({ length: n }, (_, i) => !!(log && log.checklist_state && log.checklist_state[i]));
    out.push({ ritual, occurrence: occ, weekStart: ws, overdue, state, done });
  }
  return out;
}

export function toggleItem(state, i, n) {
  const next = Array.from({ length: n }, (_, k) => !!state[k]);
  next[i] = !next[i];
  return { state: next, done: next.length > 0 && next.every(Boolean) };
}
