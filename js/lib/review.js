import { addDays, isoWeekday, weekStart as mondayOf } from './dates.js';
import { isDue, consistency28, weekHits } from './habits.js';
import { sleepStats, waterTotalsByDay, DEFAULT_WEEKLY_PAGES, DEFAULT_WATER_TARGET_L } from './health.js';

const activeHabits = (habits) => habits.filter((h) => h.active !== false).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
const weekKeys = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));
const inWeek = (key, start) => key >= start && key <= addDays(start, 6);

// Sunday: review the week that is ending now; any other day: the last complete week.
export function reviewWeekStart(todayKey) {
  const mon = mondayOf(todayKey);
  return isoWeekday(todayKey) === 7 ? mon : addDays(mon, -7);
}

// Due days without any log. 'skipped' is a deliberate exemption, not a miss.
// n_per_week habits have no fixed days, so they report no missed days.
function missStats(habit, logs, start) {
  if (habit.schedule_kind === 'n_per_week') return { missedDays: 0, missedTwice: 0 };
  const logged = new Set(logs.filter((l) => l.habit_id === habit.id).map((l) => l.date));
  let missedDays = 0, missedTwice = 0, run = 0;
  for (const d of weekKeys(start)) {
    const missed = isDue(habit, d) && !logged.has(d);
    if (missed) {
      missedDays++; run++;
      if (run === 2) missedTwice++; // count each run of >= 2 once
    } else if (isDue(habit, d)) run = 0; // non-due days neither extend nor break a run
  }
  return { missedDays, missedTwice };
}

export function weeklyReview({ weekStart, habits, habitLogs, sleep, water, daily, settings }) {
  const weekEnd = addDays(weekStart, 6);
  const target = settings?.water_target_l ?? DEFAULT_WATER_TARGET_L;
  const pagesTarget = settings?.weekly_pages ?? DEFAULT_WEEKLY_PAGES;

  const habitRows = activeHabits(habits).map((h) => {
    const { hits, target: t } = weekHits(h, habitLogs, weekStart);
    return {
      id: h.id, name: h.name, hits, target: t,
      consistency28: consistency28(h, habitLogs, weekEnd),
      ...missStats(h, habitLogs, weekStart),
    };
  });

  const totals = waterTotalsByDay(water);
  const daysOnTarget = weekKeys(weekStart).filter((d) => (totals.get(d) ?? 0) >= target).length;

  const days = daily.filter((r) => inWeek(r.date, weekStart));
  const moods = days.map((r) => r.mood).filter((m) => m != null);

  return {
    weekStart, weekEnd,
    habits: habitRows,
    sleep: sleepStats(sleep.filter((r) => inWeek(r.night_of, weekStart))),
    water: { daysOnTarget, days: 7, target },
    pages: { total: days.reduce((s, r) => s + (r.pages ?? 0), 0), target: pagesTarget },
    mood: {
      avg: moods.length ? Math.round((moods.reduce((s, m) => s + m, 0) / moods.length) * 10) / 10 : null,
      n: moods.length,
    },
  };
}

// Monday..today. Choice: today IS counted in the habit target (weekHits' due count includes
// an unlogged today), so an early-morning view shows e.g. 2/3 rather than 2/2.
export function weekToDate({ todayKey, habits, habitLogs, daily, settings }) {
  const start = mondayOf(todayKey);
  let hits = 0, target = 0;
  for (const h of activeHabits(habits)) {
    const w = weekHits(h, habitLogs, start, todayKey);
    hits += w.hits; target += w.target;
  }
  return {
    pages: daily.filter((r) => r.date >= start && r.date <= todayKey).reduce((s, r) => s + (r.pages ?? 0), 0),
    pagesTarget: settings?.weekly_pages ?? DEFAULT_WEEKLY_PAGES,
    habitsPct: target > 0 ? Math.round((hits / target) * 100) : null,
  };
}
