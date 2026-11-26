// Repository: reads go through ctx.backend, every write is outbox.enqueue(op) then a non-awaited flush.
import { ALL_TABLES, SNAPSHOT_PAST_DAYS, HABIT_LOG_PAST_DAYS, GYM_SNAPSHOT_DAYS } from './tables.js';
import { DEFAULT_RITUALS } from '../lib/rituals.js';
import { addDays, parseDateKey, weekStart } from '../lib/dates.js';
import { bootWindow } from '../lib/event-window.js';

// PostgREST returns time columns as 'HH:MM:SS[.fff]'; all logic uses 'HH:MM'.
export function normalizeTime(t) {
  if (t === null || t === undefined || t === '') return null;
  return String(t).slice(0, 5);
}
// timestamptz comes back as '...+00:00' with microseconds; the app compares canonical ISO strings.
export function normalizeTs(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? String(v) : new Date(t).toISOString();
}
const TS_COLS = ['started_at', 'ended_at', 'done_at', 'created_at', 'updated_at'];
// numeric(…) comes back as a string; timestamps are canonicalised. Only keys the row has are touched.
export function normalizeGymRow(table, row) {
  const out = { ...row };
  for (const k of TS_COLS) if (k in out) out[k] = normalizeTs(out[k]);
  if ('weight_kg' in out && out.weight_kg !== null && out.weight_kg !== undefined) out.weight_kg = Number(out.weight_kg);
  return out;
}
const fixEvent = (e) => ({ ...e, start_time: normalizeTime(e.start_time), end_time: normalizeTime(e.end_time) });

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const upsertOp = (table, rows, onConflict, ignoreDuplicates) => ({
  kind: 'upsert', table, rows, onConflict, ...(ignoreDuplicates ? { ignoreDuplicates: true } : {}),
});
const removeOp = (table, eq) => ({ kind: 'remove', table, eq });

// Fire-and-forget: the caller never waits on the network and never sees its rejection.
export function kick(ctx) {
  try { Promise.resolve(ctx.outbox.flush()).catch(() => {}); } catch { /* ignore */ }
}
async function write(ctx, op) {
  await ctx.outbox.enqueue(op);
  kick(ctx);
}

export async function loadSnapshot(ctx, todayKey, { pastDays = SNAPSHOT_PAST_DAYS, futureDays = 7, habitLogDays = HABIT_LOG_PAST_DAYS } = {}) {
  const from = addDays(todayKey, -pastDays);
  const to = addDays(todayKey, futureDays);
  const range = { gte: { date: from }, lte: { date: to }, order: ['date', true] };
  const habitRange = { gte: { date: addDays(todayKey, -Math.max(habitLogDays, pastDays)) }, lte: { date: to }, order: ['date', true] };
  const fromTs = parseDateKey(from).toISOString();
  const toTs = parseDateKey(addDays(to, 1)).toISOString();
  const ev = bootWindow(todayKey);
  const evRange = { gte: { date: ev.from }, lte: { date: ev.to }, order: ['date', true] };
  const b = ctx.backend;
  const gymFrom = parseDateKey(addDays(todayKey, -GYM_SNAPSHOT_DAYS)).toISOString();
  const [settings, habits, habitLogs, rituals, ritualLogs, events, sleep, water, daily, books, reviews,
    exercises, routines, routineItems, scheduleSlots, recentWorkouts, openWorkouts] = await Promise.all([
    b.select('settings', {}),
    b.select('habits', { order: ['sort', true] }),
    b.select('habit_logs', habitRange),
    b.select('rituals', {}),
    b.select('ritual_logs', { gte: { week_start: weekStart(from) }, lte: { week_start: to }, order: ['week_start', true] }),
    b.select('events', evRange),
    b.select('sleep', { gte: { night_of: from }, lte: { night_of: to }, order: ['night_of', true] }),
    b.select('water', { gte: { at: fromTs }, lte: { at: toTs }, order: ['at', true] }),
    b.select('daily', range),
    b.select('books', {}),
    b.select('reviews', { gte: { week_start: weekStart(from) }, lte: { week_start: to }, order: ['week_start', true] }),
    b.select('exercises', { order: ['name', true] }),
    b.select('routines', { order: ['sort', true] }),
    b.select('routine_items', { order: ['position', true] }),
    b.select('schedule_slots', { order: ['weekday', true] }),
    b.select('workouts', { gte: { started_at: gymFrom } }),
    b.select('workouts', { is: { ended_at: null } }),
  ]);
  const fixG = (t) => (r) => normalizeGymRow(t, r);
  const byId = new Map();
  for (const w of [...recentWorkouts, ...openWorkouts].map(fixG('workouts'))) byId.set(w.id, w);
  const workouts = [...byId.values()].sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  const open = workouts.filter((w) => w.ended_at === null).at(-1) ?? null;
  let activeWorkout = null;
  if (open) {
    const workoutExercises = (await b.select('workout_exercises', { eq: { workout_id: open.id }, order: ['position', true] })).map(fixG('workout_exercises'));
    const sets = (await b.select('sets', { in: { workout_exercise_id: workoutExercises.map((x) => x.id) }, order: ['done_at', true] })).map(fixG('sets'));
    activeWorkout = { workout: open, workoutExercises, sets };
  }
  const fixRitual = (r) => ({ ...r, time: normalizeTime(r.time) });
  return {
    settings: settings[0] ?? null, habits, habitLogs, rituals: rituals.map(fixRitual), ritualLogs, events: events.map(fixEvent), sleep,
    water: water.filter((w) => w.at < toTs), daily, books, reviews,
    exercises: exercises.map(fixG('exercises')), routines: routines.map(fixG('routines')),
    routineItems: routineItems.map(fixG('routine_items')), scheduleSlots: scheduleSlots.map(fixG('schedule_slots')),
    workouts, activeWorkout,
  };
}

// Events in [from, to] (inclusive date keys), for calendar ranges outside the boot window.
export async function loadEvents(ctx, from, to) {
  const rows = await ctx.backend.select('events', { gte: { date: from }, lte: { date: to }, order: ['date', true] });
  return rows.map(fixEvent);
}

export async function ensureDefaults(ctx) {
  await write(ctx, upsertOp('settings', {
    water_target_l: 2.5, weekly_pages: 200, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }, 'user_id', true));
  await write(ctx, upsertOp('rituals', DEFAULT_RITUALS.map((r) => ({ ...r, checklist: [...r.checklist] })), 'user_id,name', true));
}

export async function setHabitStatus(ctx, habitId, dateKey, status) {
  if (status === null) return write(ctx, removeOp('habit_logs', { habit_id: habitId, date: dateKey }));
  return write(ctx, upsertOp('habit_logs', { habit_id: habitId, date: dateKey, status }, 'habit_id,date'));
}

// Returns at once: `row` for the optimistic UI, `saved` settles when the op is durably queued (rejects if not).
export function addWater(ctx, liters, at = new Date()) {
  const row = { id: crypto.randomUUID(), liters, at: iso(at) };
  const saved = ctx.outbox.enqueue(upsertOp('water', row, 'id')).then(() => kick(ctx));
  saved.catch(() => {}); // never an unhandled rejection; callers that await `saved` still see it
  return { row, saved };
}
export const removeWater = (ctx, id) => write(ctx, removeOp('water', { id }));

export async function saveSleep(ctx, s) {
  const row = { night_of: s.night_of, bed_at: iso(s.bed_at), wake_at: iso(s.wake_at) };
  await write(ctx, upsertOp('sleep', row, 'user_id,night_of'));
  return row;
}

export async function setDaily(ctx, dateKey, patch) {
  const row = { date: dateKey };
  for (const k of ['pages', 'mood', 'book_id']) if (patch[k] !== undefined) row[k] = patch[k];
  return write(ctx, upsertOp('daily', row, 'user_id,date'));
}

// `state` is the {itemText: bool} object (positional arrays are the v1 format and are only read, never written).
export async function saveRitualLog(ctx, ritualId, weekStartKey, state, done) {
  const ok = state !== null && typeof state === 'object' && !Array.isArray(state) && Object.values(state).every((v) => typeof v === 'boolean');
  if (!ok) throw new TypeError('checklist_state must be an object of {itemText: boolean}');
  return write(ctx, upsertOp('ritual_logs', {
    ritual_id: ritualId, week_start: weekStartKey, checklist_state: state, done_at: done ? new Date().toISOString() : null,
  }, 'ritual_id,week_start'));
}

async function saveById(ctx, table, row) {
  const out = { ...row, id: row.id ?? crypto.randomUUID() };
  await write(ctx, upsertOp(table, out, 'id'));
  return out;
}
export const saveEvent = (ctx, event) => saveById(ctx, 'events', event);
export const saveHabit = (ctx, habit) => saveById(ctx, 'habits', habit);
export const saveRitual = (ctx, ritual) => saveById(ctx, 'rituals', ritual);
export const saveBook = (ctx, book) => saveById(ctx, 'books', book);
export const deleteEvent = (ctx, id) => write(ctx, removeOp('events', { id }));
export const saveReview = (ctx, weekStartKey, patch) =>
  write(ctx, upsertOp('reviews', { ...patch, week_start: weekStartKey }, 'user_id,week_start'));
export const saveSettings = (ctx, patch) => write(ctx, upsertOp('settings', { ...patch }, 'user_id'));

// Supabase caps one response at 1000 rows: page every table with a stable order until a short page.
export const EXPORT_PAGE_SIZE = 1000;
export async function exportAll(ctx, pageSize = EXPORT_PAGE_SIZE) {
  const tables = {};
  for (const t of ALL_TABLES) {
    const out = [];
    for (let from = 0; ; from += pageSize) {
      const page = await ctx.backend.select(t, { order: ['id', true], range: [from, from + pageSize - 1] });
      out.push(...page);
      if (page.length < pageSize) break;
    }
    tables[t] = out;
  }
  return { exported_at: new Date().toISOString(), tables };
}
