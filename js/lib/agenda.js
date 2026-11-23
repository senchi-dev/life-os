import { addDays, isoWeekday, hhmmToMinutes } from './dates.js';

function byTime(a, b) {
  if (a.time === null && b.time !== null) return -1;
  if (b.time === null && a.time !== null) return 1;
  if (a.time === null) return 0;
  return hhmmToMinutes(a.time) - hhmmToMinutes(b.time);
}

export function agenda(events, rituals, todayKey, days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(todayKey, i);
    const items = [];
    for (const e of events) {
      if (e.date === date) items.push({ kind: 'event', id: e.id, title: e.title, time: e.start_time || null });
    }
    for (const r of rituals) {
      if (r.weekday === isoWeekday(date)) items.push({ kind: 'ritual', id: r.id, title: r.name, time: r.time || null });
    }
    items.sort(byTime);
    out.push({ date, items });
  }
  return out;
}

export function nowNext(events, todayKey, now) {
  const n = hhmmToMinutes(now);
  const today = events
    .filter((e) => e.date === todayKey && e.start_time)
    .sort((a, b) => hhmmToMinutes(a.start_time) - hhmmToMinutes(b.start_time));
  const isCurrent = (e) => {
    const s = hhmmToMinutes(e.start_time);
    if (e.end_time) return s <= n && n < hhmmToMinutes(e.end_time);
    return s <= n && n - s <= 60;
  };
  const current = today.find(isCurrent);
  const next = today.find((e) => hhmmToMinutes(e.start_time) > n && e !== current);
  return [current, next].filter(Boolean);
}
