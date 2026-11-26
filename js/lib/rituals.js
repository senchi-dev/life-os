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
    const state = ritualState(ritual, log);
    out.push({ ritual, occurrence: occ, weekStart: ws, overdue, state, done });
  }
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Tick state per checklist item. `checklist_state` is {itemText: bool}; v1 rows hold a positional array,
// read as-is (by position) until the next toggle rewrites them as an object. A renamed item reads as unticked.
export function ritualState(ritual, log) {
  const items = ritual?.checklist ?? [];
  const raw = log?.checklist_state;
  if (Array.isArray(raw)) return items.map((_, i) => raw[i] === true);
  if (isPlainObject(raw)) return items.map((text) => raw[text] === true);
  return items.map(() => false);
}

// `state` is the current boolean[] (from ritualState); returns the object form to store. An invalid index changes nothing.
export function toggleItem(state, i, items) {
  const next = items.map((_, k) => !!state?.[k]);
  if (Number.isInteger(i) && i >= 0 && i < items.length) next[i] = !next[i];
  return {
    state: Object.fromEntries(items.map((text, k) => [text, next[k]])),
    done: next.length > 0 && next.every(Boolean),
  };
}
