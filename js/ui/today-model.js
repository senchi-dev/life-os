// Pure view-model for the Today screen. No DOM, no I/O.
import { addDays, daysBetween, formatDayLabel, hhmmToMinutes, localDateKey, parseDateKey } from '../lib/dates.js';
import { MAX_ACTIVE_HABITS, streak, consistency28, missRun, habitFlag } from '../lib/habits.js';
import { ritualsForToday } from '../lib/rituals.js';
import { nowNext } from '../lib/agenda.js';
import { defaultTimes, DEFAULT_WATER_TARGET_L } from '../lib/health.js';
import { weekToDate } from '../lib/review.js';
import { pickCurrentBook } from '../lib/books.js';
import { dayScore } from '../lib/score.js';
import { nextRoutineId, trainingCycle, todayHint, hintText, weekSessions } from '../lib/schedule.js';
import { displayDuration } from '../lib/workout.js';

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

// 'HH:MM' on todayKey as a local Date (dayScore needs a Date; the model is called with the clock string).
function localAt(todayKey, hhmmText) {
  const d = parseDateKey(todayKey);
  const m = /^\d{1,2}:\d{2}$/.test(String(hhmmText)) ? hhmmToMinutes(hhmmText) : 0;
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d;
}

const habitAria = (hb, flag) => [
  hb.name, hb.status === 'done' ? 'done' : hb.status === 'skipped' ? 'skipped' : 'not done', `streak ${hb.streak}`,
  hb.status ? null : flag === 'red' ? 'missed twice' : flag === 'warn' ? 'missed yesterday' : null,
].filter(Boolean).join(', ');

// Sessions the index holds for one workout (sum of working sets over its exercises); null when it is not indexed.
function indexedSets(index, workoutId) {
  if (!index?.exercises) return null;
  let found = false, total = 0;
  for (const ex of Object.values(index.exercises)) {
    for (const ses of ex.sessions ?? []) {
      if (ses.workoutId !== workoutId) continue;
      found = true;
      total += ses.workingSets ?? 0;
    }
  }
  return found ? total : null;
}

function gymCardOf(s, todayKey, draft, index) {
  const routines = (s.routines ?? []).filter((r) => !r.archived);
  const slots = s.scheduleSlots ?? [];
  const workouts = s.workouts ?? [];
  const hint = hintText(todayHint({ slots, routines: s.routines ?? [], workouts, todayKey }));
  const others = (id) => routines.filter((r) => r.id !== id).map((r) => ({ id: r.id, name: r.name }));
  if (draft?.workout) {
    const w = draft.workout;
    return { state: 'resume', routineId: w.routine_id ?? null, name: w.name ?? null, others: others(w.routine_id), startedAt: w.started_at, workoutId: w.id, hint };
  }
  const finished = workouts.filter((w) => w.ended_at && w.day === todayKey).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
  if (finished) {
    return {
      state: 'done', routineId: finished.routine_id ?? null, name: finished.name ?? null, others: others(finished.routine_id),
      workoutId: finished.id, duration: displayDuration(finished), sets: indexedSets(index, finished.id), hint,
    };
  }
  const nextId = nextRoutineId({ cycle: trainingCycle(slots, s.routines ?? []), workouts });
  const next = routines.find((r) => r.id === nextId) ?? null;
  return { state: 'start', routineId: next?.id ?? null, name: next?.name ?? null, others: others(next?.id), hint };
}

export function buildTodayModel(snapshot, todayKey, now, { draft = null, index = null } = {}) {
  const s = snapshot;
  const habitLogs = s.habitLogs ?? [];
  const daily = s.daily ?? [];
  const todayDaily = daily.find((d) => d.date === todayKey) ?? null;

  const gymWeek = weekSessions({ workouts: s.workouts ?? [], slots: s.scheduleSlots ?? [], todayKey });
  const habits = (s.habits ?? [])
    .filter((h) => h.active)
    .sort((a, b) => a.sort - b.sort)
    .slice(0, MAX_ACTIVE_HABITS)
    .map((h) => {
      const run = habitMiss(h, habitLogs, todayKey);
      const log = habitLogs.find((l) => l.habit_id === h.id && l.date === todayKey);
      const row = {
        id: h.id, name: h.name, status: log?.status ?? null,
        streak: streak(h, habitLogs, todayKey), consistency28: consistency28(h, habitLogs, todayKey),
        missRun: run, flag: habitFlag(run),
      };
      row.ariaLabel = habitAria(row, row.flag);
      row.text = h.id === s.settings?.gym_habit_id ? `${h.name} \u00b7 ${gymWeek.done}/${gymWeek.plan} this week` : h.name;
      return row;
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

  const score = dayScore({
    habits: s.habits ?? [], habitLogs, water: s.water ?? [], sleep: s.sleep ?? [], settings: s.settings ?? undefined,
    dateKey: todayKey, now: localAt(todayKey, now),
  });

  return {
    dayScore: score,
    gymCard: gymCardOf(s, todayKey, draft, index),
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
