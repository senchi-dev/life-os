// Repository: reads go through ctx.backend, every write is outbox.enqueue(op) then a non-awaited flush.
import { V1_TABLES, SNAPSHOT_PAST_DAYS, HABIT_LOG_PAST_DAYS } from './tables.js';
import { DEFAULT_RITUALS } from '../lib/rituals.js';
import { addDays, parseDateKey, weekStart } from '../lib/dates.js';

// PostgREST returns time columns as 'HH:MM:SS[.fff]'; all logic uses 'HH:MM'.
export function normalizeTime(t) {
  if (t === null || t === undefined || t === '') return null;
  return String(t).slice(0, 5);
}
const EVENT_PAST_DAYS = 1;
const EVENT_FUTURE_DAYS = 90;

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const upsertOp = (table, rows, onConflict, ignoreDuplicates) => ({
  kind: 'upsert', table, rows, onConflict, ...(ignoreDuplicates ? { ignoreDuplicates: true } : {}),
});
const removeOp = (table, eq) => ({ kind: 'remove', table, eq });

// Fire-and-forget: the caller never waits on the network and never sees its rejection.
function kick(ctx) {
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
  const evRange = { gte: { date: addDays(todayKey, -EVENT_PAST_DAYS) }, lte: { date: addDays(todayKey, EVENT_FUTURE_DAYS) }, order: ['date', true] };
  const b = ctx.backend;
  const [settings, habits, habitLogs, rituals, ritualLogs, events, sleep, water, daily, books, reviews] = await Promise.all([
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
  ]);
  const fixEvent = (e) => ({ ...e, start_time: normalizeTime(e.start_time), end_time: normalizeTime(e.end_time) });
  const fixRitual = (r) => ({ ...r, time: normalizeTime(r.time) });
  return {
    settings: settings[0] ?? null, habits, habitLogs, rituals: rituals.map(fixRitual), ritualLogs, events: events.map(fixEvent), sleep,
    water: water.filter((w) => w.at < toTs), daily, books, reviews,
  };
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

export function addWater(ctx, liters, at = new Date()) {
  const row = { id: crypto.randomUUID(), liters, at: iso(at) };
  ctx.outbox.enqueue(upsertOp('water', row, 'id')).then(() => kick(ctx), () => {});
  return row;
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

export async function saveRitualLog(ctx, ritualId, weekStartKey, state, done) {
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
  for (const t of V1_TABLES) {
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
