import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../../js/data/backend-memory.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';
import { ALL_TABLES } from '../../js/data/tables.js';
import { demoSeed } from '../../js/data/demo-seed.js';
import { missRun, habitFlag } from '../../js/lib/habits.js';
import * as repo from '../../js/data/repo.js';

async function mk(seed = {}) {
  const backend = createMemoryBackend(seed);
  const outbox = createOutbox({ backend, storage: createMemoryStorage() });
  await outbox.init();
  const ctx = { backend, outbox };
  const settle = async () => { await new Promise((r) => setTimeout(r, 5)); await outbox.flush(); };
  return { ctx, backend, outbox, settle };
}
const rows = (backend, t) => backend.dump()[t] ?? [];

test('ensureDefaults is idempotent', async () => {
  const { ctx, backend, settle } = await mk();
  await repo.ensureDefaults(ctx); await settle();
  await repo.ensureDefaults(ctx); await settle();
  assert.equal(rows(backend, 'settings').length, 1);
  assert.equal(rows(backend, 'rituals').length, 3);
  assert.equal(rows(backend, 'settings')[0].water_target_l, 2.5);
  assert.equal(rows(backend, 'habits').length, 0);
});

test('setHabitStatus done then null removes the log', async () => {
  const { ctx, backend, settle } = await mk();
  await repo.setHabitStatus(ctx, 'h1', '2026-11-20', 'done'); await settle();
  assert.equal(rows(backend, 'habit_logs').length, 1);
  await repo.setHabitStatus(ctx, 'h1', '2026-11-20', null); await settle();
  assert.equal(rows(backend, 'habit_logs').length, 0);
});

test('addWater/removeWater with client ids', async () => {
  const { ctx, backend, settle } = await mk();
  const { row: a } = repo.addWater(ctx, 0.5);
  repo.addWater(ctx, 0.25);
  assert.ok(a.id && a.liters === 0.5 && typeof a.at === 'string');
  await settle();
  assert.equal(rows(backend, 'water').length, 2);
  await repo.removeWater(ctx, a.id); await settle();
  assert.equal(rows(backend, 'water').length, 1);
});

test('setDaily merges patches into one row', async () => {
  const { ctx, backend, settle } = await mk();
  await repo.setDaily(ctx, '2026-11-20', { pages: 20 });
  await repo.setDaily(ctx, '2026-11-20', { mood: 4 }); await settle();
  const d = rows(backend, 'daily');
  assert.equal(d.length, 1);
  assert.equal(d[0].pages, 20);
  assert.equal(d[0].mood, 4);
});

test('saveSleep upserts per night, ISO strings, no minutes', async () => {
  const { ctx, backend, settle } = await mk();
  const base = { night_of: '2026-11-19', minutes: 480 };
  await repo.saveSleep(ctx, { ...base, bed_at: new Date('2026-11-19T22:00:00Z'), wake_at: new Date('2026-11-20T06:00:00Z') });
  await repo.saveSleep(ctx, { ...base, bed_at: new Date('2026-11-19T23:00:00Z'), wake_at: new Date('2026-11-20T07:00:00Z') }); await settle();
  const s = rows(backend, 'sleep');
  assert.equal(s.length, 1);
  assert.equal(s[0].bed_at, '2026-11-19T23:00:00.000Z');
  assert.equal('minutes' in s[0], false);
});

test('saveRitualLog sets done_at only when done', async () => {
  const { ctx, backend, settle } = await mk();
  await repo.saveRitualLog(ctx, 'r1', '2026-11-16', { A: true, B: false }, false);
  await repo.saveRitualLog(ctx, 'r1', '2026-11-16', { A: true, B: true }, true); await settle();
  const l = rows(backend, 'ritual_logs');
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].checklist_state, { A: true, B: true });
  assert.ok(l[0].done_at);
});

test('saveEvent/deleteEvent/saveReview/saveSettings/saveHabit/saveRitual/saveBook', async () => {
  const { ctx, backend, settle } = await mk();
  const ev = await repo.saveEvent(ctx, { title: 'X', date: '2026-11-23' });
  await repo.saveReview(ctx, '2026-11-16', { went_right: 'a' });
  await repo.saveReview(ctx, '2026-11-16', { one_change: 'b' });
  await repo.saveSettings(ctx, { weekly_pages: 100 });
  await repo.saveSettings(ctx, { water_target_l: 3 });
  await repo.saveHabit(ctx, { name: 'H', schedule_kind: 'daily' });
  await repo.saveRitual(ctx, { name: 'R', weekday: 1, time: '10:00', checklist: [] });
  await repo.saveBook(ctx, { title: 'B' });
  await settle();
  assert.equal(rows(backend, 'events').length, 1);
  assert.equal(rows(backend, 'reviews').length, 1);
  assert.equal(rows(backend, 'reviews')[0].went_right, 'a');
  assert.equal(rows(backend, 'settings').length, 1);
  assert.equal(rows(backend, 'habits').length, 1);
  assert.equal(rows(backend, 'rituals').length, 1);
  assert.equal(rows(backend, 'books').length, 1);
  await repo.deleteEvent(ctx, ev.id); await settle();
  assert.equal(rows(backend, 'events').length, 0);
});

test('loadSnapshot excludes old water, orders sleep and logs ascending', async () => {
  const today = '2026-11-23';
  const old = new Date(2026, 9, 4, 12).toISOString(); // 50 days before
  const recent = new Date(2026, 10, 23, 8).toISOString();
  const { ctx } = await mk({
    water: [{ id: 'w1', at: old, liters: 1 }, { id: 'w2', at: recent, liters: 1 }],
    sleep: [
      { id: 's2', night_of: '2026-11-20' }, { id: 's1', night_of: '2026-11-18' }, { id: 's0', night_of: '2026-08-01' },
    ],
    habit_logs: [{ id: 'l2', date: '2026-11-21' }, { id: 'l1', date: '2026-11-19' }, { id: 'l0', date: '2026-01-01' }],
    settings: [{ id: 'st', water_target_l: 2.5 }],
  });
  const snap = await repo.loadSnapshot(ctx, today);
  assert.deepEqual(snap.water.map((w) => w.id), ['w2']);
  assert.deepEqual(snap.sleep.map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(snap.habitLogs.map((s) => s.id), ['l1', 'l2']);
  assert.equal(snap.settings.id, 'st');
  assert.deepEqual(Object.keys(snap).sort(),
    ['activeWorkout', 'books', 'daily', 'events', 'exercises', 'habitLogs', 'habits', 'reviews', 'ritualLogs', 'rituals', 'routineItems', 'routines', 'scheduleSlots', 'settings', 'sleep', 'water', 'workouts']);
  const empty = await repo.loadSnapshot((await mk()).ctx, today);
  assert.equal(empty.settings, null);
});

test('exportAll returns every table', async () => {
  const { ctx } = await mk({ books: [{ id: 'b', title: 'T' }] });
  const out = await repo.exportAll(ctx);
  assert.deepEqual(Object.keys(out.tables), ALL_TABLES);
  assert.equal(ALL_TABLES.length, 18);
  assert.equal(out.tables.books.length, 1);
  assert.ok(!Number.isNaN(Date.parse(out.exported_at)));
});

test('demoSeed shape and double-missed Read habit', async () => {
  const today = '2026-11-23';
  const seed = demoSeed(today);
  assert.deepEqual(Object.keys(seed).sort(), [...ALL_TABLES].sort().filter((t) => t in seed).sort());
  assert.equal(seed.habits.length, 4);
  assert.equal(seed.habits.find((h) => h.name === 'Gym').target_n, 4);
  const red = seed.habits.filter((h) => habitFlag(missRun(h, seed.habit_logs, today)) === 'red');
  assert.deepEqual(red.map((h) => h.name), ['Read']);
  assert.ok(seed.habits.every((h) => h.created_at < '2026-09-25'));
  assert.equal(seed.rituals.length, 3);
  assert.equal(seed.events.filter((e) => e.date === today).length, 2);
  assert.equal(seed.events.length, 5);
  assert.equal(seed.sleep.length, 10);
  assert.equal(seed.water[0].liters, 1.5);
  assert.equal(seed.books[0].title, 'Investment Banking');
  const { ctx } = await mk(seed);
  const snap = await repo.loadSnapshot(ctx, today);
  assert.equal(snap.events.length, 5);
  assert.equal(snap.water.length, 1);
});

test('normalizeTime', () => {
  assert.equal(repo.normalizeTime(null), null);
  assert.equal(repo.normalizeTime(undefined), null);
  assert.equal(repo.normalizeTime('14:00'), '14:00');
  assert.equal(repo.normalizeTime('14:00:00'), '14:00');
  assert.equal(repo.normalizeTime('09:05:00.123'), '09:05');
});

test('loadSnapshot normalizes HH:MM:SS times and gives events a 90-day window', async () => {
  const { addDays } = await import('../../js/lib/dates.js');
  const today = '2026-11-23';
  const ev = (id, date, s, e) => ({ id, title: id, date, start_time: s, end_time: e, location: null });
  const { ctx } = await mk({
    events: [
      ev('a', today, '14:00:00', '15:30:00'), ev('y', addDays(today, -1), '10:00:00', null),
      ev('far60', addDays(today, 60), null, null), ev('far120', addDays(today, 120), null, null),
      ev('old', addDays(today, -36), null, null),
    ],
    rituals: [{ id: 'r', name: 'R', weekday: 1, time: '19:30:00', checklist: [] }],
  });
  const snap = await repo.loadSnapshot(ctx, today);
  const ids = snap.events.map((e) => e.id).sort();
  assert.deepEqual(ids, ['a', 'far60', 'y']);
  const a = snap.events.find((e) => e.id === 'a');
  assert.equal(a.start_time, '14:00');
  assert.equal(a.end_time, '15:30');
  assert.equal(snap.events.find((e) => e.id === 'far60').start_time, null);
  assert.equal(snap.rituals.find((r) => r.id === 'r').time, '19:30');
});

// ---- B3: habit-log window; R8: paginated export ----
import { addDays as addD2, localDateKey as lk2 } from '../../js/lib/dates.js';

test('loadSnapshot loads habit_logs 70 days back (65d yes, 90d no) while other tables keep 42', async () => {
  const today = lk2(new Date());
  const { ctx } = await mk({
    habit_logs: [
      { id: 'a', habit_id: 'h', date: addD2(today, -65), status: 'done' },
      { id: 'b', habit_id: 'h', date: addD2(today, -90), status: 'done' },
    ],
    daily: [
      { id: 'c', date: addD2(today, -65), pages: 1 },
      { id: 'd', date: addD2(today, -30), pages: 1 },
    ],
  });
  const snap = await repo.loadSnapshot(ctx, today);
  assert.deepEqual(snap.habitLogs.map((l) => l.id), ['a']);
  assert.deepEqual(snap.daily.map((l) => l.id), ['d']);
});

test('exportAll returns every row of a 2,500-row table, no duplicates', async () => {
  const water = Array.from({ length: 2500 }, (_, i) => ({ id: `w${String(i).padStart(5, '0')}`, liters: 0.25, at: '2026-01-01T00:00:00Z' }));
  const { ctx } = await mk({ water });
  const out = await repo.exportAll(ctx);
  assert.equal(out.tables.water.length, 2500);
  assert.equal(new Set(out.tables.water.map((r) => r.id)).size, 2500);
});

test('exportAll pages with range and stops on a short page (exact multiple costs one extra empty page)', async () => {
  const calls = [];
  const data = Array.from({ length: 2000 }, (_, i) => ({ id: String(i) }));
  const backend = { select: async (t, q) => { if (t === 'water') calls.push(q.range); const [a, b] = q.range ?? [0, 1e9]; return t === 'water' ? data.slice(a, b + 1) : []; } };
  const out = await repo.exportAll({ backend });
  assert.equal(out.tables.water.length, 2000);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('exportAll returns all 2,500 sets across three pages and keys for all 18 tables', async () => {
  const sets = Array.from({ length: 2500 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, set_no: 1, reps: 5, weight_kg: 60 }));
  const { ctx } = await mk({ sets });
  const out = await repo.exportAll(ctx);
  assert.equal(out.tables.sets.length, 2500);
  assert.equal(new Set(out.tables.sets.map((r) => r.id)).size, 2500);
  assert.deepEqual(Object.keys(out.tables), ALL_TABLES);
});

test('saveRitualLog only accepts the {itemText: bool} object form', async () => {
  const { ctx } = await mk();
  for (const bad of [[true, false], null, undefined, 'x', { A: 'yes' }]) {
    await assert.rejects(() => repo.saveRitualLog(ctx, 'r1', '2026-11-16', bad, false), TypeError, JSON.stringify(bad));
  }
});

// ---- Task 11: wider event window, on-demand range loads ----
test('snapshot loads events from today-35', async () => {
  const today = '2026-11-26';
  const ev = (id, date) => ({ id, title: id, date, start_time: null, end_time: null, location: null });
  const { ctx } = await mk({ events: [ev('in35', addD2(today, -35)), ev('out36', addD2(today, -36))] });
  const snap = await repo.loadSnapshot(ctx, today);
  assert.deepEqual(snap.events.map((e) => e.id), ['in35']);
});

test('loadEvents returns a range with normalised times', async () => {
  const ev = (id, date, s, e) => ({ id, title: id, date, start_time: s, end_time: e, location: null });
  const { ctx } = await mk({ events: [
    ev('b', '2026-06-10', '09:00:00', '10:30:00'), ev('a', '2026-06-01', null, null),
    ev('out', '2026-07-01', '09:00:00', null), ev('before', '2026-05-31', null, null),
  ] });
  const got = await repo.loadEvents(ctx, '2026-06-01', '2026-06-30');
  assert.deepEqual(got.map((e) => e.id), ['a', 'b']);
  assert.equal(got[1].start_time, '09:00');
  assert.equal(got[1].end_time, '10:30');
  assert.equal(got[0].start_time, null);
});
