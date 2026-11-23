// Pure view-model for the Today screen. No DOM, no I/O.
import { addDays, daysBetween, formatDayLabel, localDateKey } from '../lib/dates.js';
import { MAX_ACTIVE_HABITS, streak, consistency28, missRun, habitFlag } from '../lib/habits.js';
import { ritualsForToday } from '../lib/rituals.js';
import { nowNext } from '../lib/agenda.js';
import { defaultTimes, DEFAULT_WATER_TARGET_L } from '../lib/health.js';
import { weekToDate } from '../lib/review.js';
import { pickCurrentBook } from '../lib/books.js';

const hhmm = (v) => {
  const d = new Date(v);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const round2 = (x) => Math.round(x * 100) / 100;

// A habit that did not exist yet cannot have been missed: cap by age, and stay quiet for 2 days.
function habitMiss(habit, logs, todayKey) {
  const raw = missRun(habit, logs, todayKey);
  if (!habit.created_at) return raw;
  const age = daysBetween(localDateKey(new Date(habit.created_at)), todayKey);
  if (age <= 2) return 0;
  return Math.min(raw, age - 1);
}

export function buildTodayModel(snapshot, todayKey, now) {
  const s = snapshot;
  const habitLogs = s.habitLogs ?? [];
  const daily = s.daily ?? [];
  const todayDaily = daily.find((d) => d.date === todayKey) ?? null;

  const habits = (s.habits ?? [])
    .filter((h) => h.active)
    .sort((a, b) => a.sort - b.sort)
    .slice(0, MAX_ACTIVE_HABITS)
    .map((h) => {
      const run = habitMiss(h, habitLogs, todayKey);
      const log = habitLogs.find((l) => l.habit_id === h.id && l.date === todayKey);
      return {
        id: h.id, name: h.name, status: log?.status ?? null,
        streak: streak(h, habitLogs, todayKey), consistency28: consistency28(h, habitLogs, todayKey),
        missRun: run, flag: habitFlag(run),
      };
    });

  const waterRows = (s.water ?? [])
    .filter((w) => localDateKey(new Date(w.at)) === todayKey)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const lastW = waterRows[waterRows.length - 1] ?? null;

  const night = (s.sleep ?? []).find((r) => r.night_of === addDays(todayKey, -1)) ?? null;
  const sleep = night
    ? { logged: true, bed: hhmm(night.bed_at), wake: hhmm(night.wake_at), minutes: Math.round((new Date(night.wake_at) - new Date(night.bed_at)) / 60000) }
    : { logged: false, ...defaultTimes(s.sleep ?? []), minutes: null };

  const book = pickCurrentBook(s.books, s.settings);

  return {
    dayLabel: formatDayLabel(todayKey),
    nowNext: nowNext(s.events ?? [], todayKey, now),
    rituals: ritualsForToday(s.rituals ?? [], s.ritualLogs ?? [], todayKey),
    habits,
    water: {
      total: round2(waterRows.reduce((t, w) => t + w.liters, 0)),
      target: s.settings?.water_target_l ?? DEFAULT_WATER_TARGET_L,
      last: lastW ? { id: lastW.id, liters: lastW.liters } : null,
    },
    sleep,
    pages: { today: todayDaily?.pages ?? 0, book: book ? { id: book.id, title: book.title } : null },
    mood: todayDaily?.mood ?? null,
    week: weekToDate({ todayKey, habits: s.habits ?? [], habitLogs, daily, settings: s.settings ?? null }),
  };
}
