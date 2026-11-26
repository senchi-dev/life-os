import { addDays, localDateKey } from './dates.js';
import { isDue, createdKey } from './habits.js';
import { waterTotalsByDay, DEFAULT_WATER_TARGET_L } from './health.js';

const WEIGHTS = { H: 0.4, W: 0.3, S: 0.3 };
const SLEEP_GOAL_MIN = 480;

// Day score (spec §5): weighted mean of the parts that are present, 0..100.
export function dayScore({ habits = [], habitLogs = [], water = [], sleep = [], settings, dateKey, now }) {
  const status = new Map(habitLogs.filter((l) => l.date === dateKey).map((l) => [l.habit_id, l.status]));
  let done = 0, counted = 0;
  for (const h of habits) {
    if (h.active === false) continue;
    const born = createdKey(h);
    if (born && dateKey < born) continue;
    const s = status.get(h.id);
    if (s === 'skipped') continue;
    if (h.schedule_kind === 'n_per_week') {
      if (s !== 'done') continue; // counts only when done that day
    } else if (!isDue(h, dateKey)) continue;
    counted++;
    if (s === 'done') done++;
  }
  const H = counted ? { done, counted } : null;

  const target = settings?.water_target_l || DEFAULT_WATER_TARGET_L;
  const liters = waterTotalsByDay(water).get(dateKey) ?? 0;
  const W = { liters, target };

  const prev = addDays(dateKey, -1);
  const row = sleep.find((r) => r.night_of === prev);
  let S = null;
  if (row) {
    S = { minutes: Math.round((new Date(row.wake_at) - new Date(row.bed_at)) / 60000) };
  } else if (!(dateKey === localDateKey(now) && now.getHours() < 12)) {
    S = { minutes: 0 };
  }

  const parts = [
    [H && WEIGHTS.H, H && done / counted],
    [WEIGHTS.W, Math.min(liters / target, 1)],
    [S && WEIGHTS.S, S && Math.min(S.minutes / SLEEP_GOAL_MIN, 1)],
  ].filter(([w]) => w);
  const wsum = parts.reduce((a, [w]) => a + w, 0);
  const score = Math.round((parts.reduce((a, [w, v]) => a + w * v, 0) / wsum) * 100);
  return { score, good: score >= 85, parts: { H, W, S } };
}
