// Calendar items for a date range: events, rituals, finished workouts at their real time, planned gym days.
// Pure; dates are device-local keys, times are minutes from local midnight.
import { agenda } from './agenda.js';
import { plannedRows, shortName } from './schedule.js';
import { hhmmToMinutes, daysBetween, localDateKey } from './dates.js';
import { durationMinutes, displayMinutes } from './workout.js';

export const DEFAULT_MIN = { event: 60, ritual: 30, workout: 60 };
export const KINDS = ['gym', 'event', 'ritual'];

const localMinutes = (d) => d.getHours() * 60 + d.getMinutes();
const maxKey = (a, b) => (a > b ? a : b);

function eventItem(e) {
  if (!e.start_time) return { kind: 'event', id: e.id, title: e.title, label: e.title, start: null, end: null, allDay: true };
  const start = hhmmToMinutes(e.start_time);
  const end = e.end_time && hhmmToMinutes(e.end_time) > start ? hhmmToMinutes(e.end_time) : start + DEFAULT_MIN.event;
  return { kind: 'event', id: e.id, title: e.title, label: e.title, start, end, allDay: false };
}

function ritualItem(id, title, time) {
  const start = time ? hhmmToMinutes(time) : null;
  return { kind: 'ritual', id, title, label: title, start, end: start === null ? null : start + DEFAULT_MIN.ritual, allDay: start === null };
}

function workoutItem(w) {
  const s = new Date(w.started_at);
  const start = localMinutes(s);
  let end = start + DEFAULT_MIN.workout;
  if (w.duration_known !== false) {
    const e = new Date(w.ended_at);
    if (localDateKey(e) === localDateKey(s) && localMinutes(e) > start) end = localMinutes(e);
  }
  const title = shortName(w.name);
  return {
    kind: 'gym', id: w.id, title, label: `${title} · ${displayMinutes(durationMinutes(w))}`,
    start, end, allDay: false, state: 'done', href: `#/gym/history/${encodeURIComponent(w.id)}`,
  };
}

const kindRank = (i) => KINDS.indexOf(i.kind);
function byDayOrder(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.allDay) return kindRank(a) - kindRank(b);
  return a.start - b.start || (b.end - b.start) - (a.end - a.start);
}

export function itemsByDay(snapshot, from, to, todayKey, events = snapshot?.events) {
  const s = snapshot ?? {};
  const out = new Map();
  const days = daysBetween(from, to) + 1;
  if (days < 1) return out;
  const eventsById = new Map((events ?? []).map((e) => [e.id, e]));
  for (const { date, items } of agenda(events ?? [], s.rituals ?? [], from, days)) {
    out.set(date, items.map((i) => (i.kind === 'event' ? eventItem(eventsById.get(i.id)) : ritualItem(i.id, i.title, i.time))));
  }
  for (const w of s.workouts ?? []) {
    if (w.ended_at && w.day >= from && w.day <= to && w.day <= todayKey) out.get(w.day)?.push(workoutItem(w));
  }
  if (to >= todayKey) {
    const first = maxKey(from, todayKey);
    const rows = plannedRows({
      slots: s.scheduleSlots ?? [], routines: s.routines ?? [], workouts: s.workouts ?? [],
      todayKey: first, days: daysBetween(first, to) + 1,
    });
    for (const r of rows) {
      if (r.kind !== 'planned') continue;
      out.get(r.date)?.push({ kind: 'gym', id: null, title: r.name, label: `${r.name} · planned`, start: null, end: null, allDay: true, state: 'planned', href: '#/gym' });
    }
  }
  for (const list of out.values()) list.sort(byDayOrder);
  return out;
}

export function dayKinds(items) {
  const present = new Set(items.map((i) => i.kind));
  return KINDS.filter((k) => present.has(k));
}
