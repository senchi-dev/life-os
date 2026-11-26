import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSeed } from '../../js/data/demo-seed.js';
import { defaultTimes } from '../../js/lib/health.js';
import { buildTodayModel } from '../../js/ui/today-model.js';
import { dayScore } from '../../js/lib/score.js';

const TODAY = '2026-11-23';
const snapOf = (seed) => ({
  settings: seed.settings[0] ?? null, habits: seed.habits, habitLogs: seed.habit_logs, rituals: seed.rituals,
  ritualLogs: seed.ritual_logs, events: seed.events, sleep: seed.sleep, water: seed.water,
  daily: seed.daily, books: seed.books, reviews: seed.reviews,
});
const fresh = () => snapOf(demoSeed(TODAY));

test('header, now/next, water, habits from the demo seed', () => {
  const m = buildTodayModel(fresh(), TODAY, '10:00');
  assert.equal(m.dayLabel, 'Mon 23 Nov');
  assert.deepEqual(m.nowNext.map((e) => e.title), ['Rates desk', 'Gym']);
  assert.equal(m.habits.length, 4);
  assert.equal(m.habits.find((h) => h.name === 'Read').flag, 'red');
  assert.equal(m.water.total, 1.5);
  assert.equal(m.water.target, 2.5);
  assert.equal(m.water.last.liters, 1.5);
  assert.equal(m.pages.book.title, 'Investment Banking');
  assert.equal(m.mood, null);
});

test('no sleep row for last night: defaults, not logged', () => {
  const s = fresh();
  s.sleep = s.sleep.filter((r) => r.night_of !== '2026-11-22');
  const m = buildTodayModel(s, TODAY, '10:00');
  const d = defaultTimes(s.sleep);
  assert.equal(m.sleep.logged, false);
  assert.equal(m.sleep.bed, d.bed);
  assert.equal(m.sleep.wake, d.wake);
  assert.equal(m.sleep.minutes, null);
  const logged = buildTodayModel(fresh(), TODAY, '10:00');
  assert.equal(logged.sleep.logged, true);
  assert.ok(logged.sleep.minutes > 300);
});

test('overdue ritual appears', () => {
  const m = buildTodayModel(fresh(), TODAY, '10:00');
  const c = m.rituals.find((r) => r.ritual.name === 'Cleaning reset');
  assert.ok(c);
  assert.equal(c.overdue, true);
});

test('habits are capped at 6, sorted, active only', () => {
  const s = fresh();
  for (let i = 0; i < 3; i++) s.habits.push({ id: `x${i}`, name: `Extra ${i}`, schedule_kind: 'daily', active: true, sort: 10 + i, created_at: '2026-01-01T09:00:00Z' });
  s.habits.push({ id: 'off', name: 'Off', schedule_kind: 'daily', active: false, sort: -1, created_at: '2026-01-01T09:00:00Z' });
  const m = buildTodayModel(s, TODAY, '10:00');
  assert.equal(m.habits.length, 6);
  assert.ok(!m.habits.some((h) => h.id === 'off'));
  assert.deepEqual(m.habits.map((h) => h.id).slice(4), ['x0', 'x1']);
});

test('a habit created yesterday with no logs is not flagged', () => {
  const s = fresh();
  s.habits.push({ id: 'new', name: 'New', schedule_kind: 'daily', active: true, sort: 9, created_at: new Date(2026, 10, 22, 12).toISOString() });
  const h = buildTodayModel(s, TODAY, '10:00').habits.find((x) => x.id === 'new');
  assert.equal(h.flag, 'none');
});

test('a habit created 5 days ago with no logs is capped by its age', () => {
  const s = fresh();
  s.habits.push({ id: 'n5', name: 'N5', schedule_kind: 'daily', active: true, sort: 9, created_at: new Date(2026, 10, 18, 12).toISOString() });
  const h = buildTodayModel(s, TODAY, '10:00').habits.find((x) => x.id === 'n5');
  assert.equal(h.missRun, 4);
});

test('first run: empty snapshot uses defaults and does not throw', () => {
  const m = buildTodayModel({ settings: null, habits: [], habitLogs: [], rituals: [], ritualLogs: [], events: [], sleep: [], water: [], daily: [], books: [], reviews: [] }, TODAY, '10:00');
  assert.equal(m.water.target, 2.5);
  assert.equal(m.week.pagesTarget, 200);
  assert.deepEqual(m.habits, []);
  assert.equal(m.pages.book, null);
  assert.equal(m.water.last, null);
});

import { isNewDay, localDateKey } from '../../js/lib/dates.js';

test('isNewDay compares the local date of now with todayKey', () => {
  assert.equal(isNewDay(TODAY, new Date(2026, 10, 23, 23, 59)), false);
  assert.equal(isNewDay(TODAY, new Date(2026, 10, 24, 0, 30)), true);
  assert.equal(isNewDay('2026-11-24', new Date(2026, 10, 24, 0, 30)), false);
});

test('water at 00:30 on the new day counts for the new day, 23:30 the day before does not', () => {
  const s = fresh();
  const NEW = '2026-11-24';
  s.water = [
    { id: 'a', at: new Date(2026, 10, 23, 23, 30).toISOString(), liters: 1 },
    { id: 'b', at: new Date(2026, 10, 24, 0, 30).toISOString(), liters: 0.5 },
  ];
  assert.equal(localDateKey(new Date(s.water[1].at)), NEW);
  const m = buildTodayModel(s, NEW, '00:31');
  assert.equal(m.water.total, 0.5);
  assert.equal(m.water.last.id, 'b');
  assert.equal(buildTodayModel(s, TODAY, '23:45').water.total, 1);
});

test('current book: marker wins, then latest started_on, then created_at, then id', () => {
  const mk = (id, started_on, created_at, finished_on = null) => ({ id, title: id, started_on, created_at, finished_on });
  const base = () => ({ ...fresh(), books: [mk('a', '2026-01-01', '2026-01-01T00:00:00Z'), mk('b', '2026-02-01', '2026-02-01T00:00:00Z')] });
  const titleOf = (s) => buildTodayModel(s, TODAY, '10:00').pages.book?.title;
  // fallback: latest started_on
  assert.equal(titleOf(base()), 'b');
  // marker wins
  const s1 = base(); s1.settings = { ...s1.settings, current_book_id: 'a' };
  assert.equal(titleOf(s1), 'a');
  // marker pointing at a finished or missing book is ignored
  const s2 = base(); s2.books[0].finished_on = '2026-03-01'; s2.settings = { ...s2.settings, current_book_id: 'a' };
  assert.equal(titleOf(s2), 'b');
  const s3 = base(); s3.settings = { ...s3.settings, current_book_id: 'zzz' };
  assert.equal(titleOf(s3), 'b');
  // tie on started_on: created_at desc, then id
  const s4 = { ...base(), books: [mk('a', '2026-02-01', '2026-02-01T00:00:00Z'), mk('b', '2026-02-01', '2026-02-02T00:00:00Z')] };
  assert.equal(titleOf(s4), 'b');
  const s5 = { ...base(), books: [mk('a', '2026-02-01', '2026-02-01T00:00:00Z'), mk('b', '2026-02-01', '2026-02-01T00:00:00Z')] };
  assert.equal(titleOf(s5), 'a');
});

// ---- Task 14: score, gym card, aria labels ----
const iso = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const bare = (over = {}) => ({
  settings: { water_target_l: 2.5, gym_habit_id: null }, habits: [], habitLogs: [], rituals: [], ritualLogs: [], events: [], sleep: [], water: [],
  daily: [], books: [], reviews: [], routines: [], routineItems: [], scheduleSlots: [], workouts: [], ...over,
});
// water = 2.5 L (full), sleep = `min` minutes, no habits: score = round(100 * (1 + min/480) / 2)
const withSleep = (min) => bare({
  water: [{ id: 'w', at: iso(2026, 11, 23, 9), liters: 2.5 }],
  sleep: [{ id: 's', night_of: '2026-11-22', bed_at: iso(2026, 11, 22, 23), wake_at: new Date(new Date(2026, 10, 22, 23).getTime() + min * 60000).toISOString() }],
});

test('dayScore is in the model and matches score.js; good flips exactly at 85', () => {
  const at84 = buildTodayModel(withSleep(326), TODAY, '10:00');
  const at85 = buildTodayModel(withSleep(336), TODAY, '10:00');
  assert.equal(at84.dayScore.score, 84);
  assert.equal(at84.dayScore.good, false);
  assert.equal(at85.dayScore.score, 85);
  assert.equal(at85.dayScore.good, true);
  const s = fresh();
  const direct = dayScore({ habits: s.habits, habitLogs: s.habitLogs, water: s.water, sleep: s.sleep, settings: s.settings, dateKey: TODAY, now: new Date(2026, 10, 23, 10, 0) });
  assert.deepEqual(buildTodayModel(s, TODAY, '10:00').dayScore, direct);
});

test('dayScore: sleep missing before noon is absent, at noon it counts as 0', () => {
  const s = bare({ water: [{ id: 'w', at: iso(2026, 11, 23, 8), liters: 2.5 }] });
  assert.equal(buildTodayModel(s, TODAY, '11:59').dayScore.score, 100);
  assert.equal(buildTodayModel(s, TODAY, '12:00').dayScore.score, 50);
});

const U = { id: 'ru', name: 'Day 1 - Upper Force', sort: 0, archived: false };
const L = { id: 'rl', name: 'Day 2 - Lower Force', sort: 1, archived: false };
const slots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, routine_id: [U.id, L.id, null, U.id, L.id, null, null][weekday - 1] }));
const wk = (id, routine, day, h, mins = 58) => ({
  id, routine_id: routine.id, name: routine.name, day, imported: false, duration_known: true,
  started_at: iso(...day.split('-').map(Number), h), ended_at: new Date(new Date(...day.split('-').map(Number).map((x, i) => (i === 1 ? x - 1 : x)), h).getTime() + mins * 60000).toISOString(),
});

test('gymCard start: next routine after a Lower workout is Day 1 - Upper Force, others listed', () => {
  const s = bare({ routines: [U, L], scheduleSlots: slots, workouts: [wk('w1', L, '2026-11-21', 18)] });
  const g = buildTodayModel(s, TODAY, '10:00').gymCard;
  assert.equal(g.state, 'start');
  assert.equal(g.routineId, U.id);
  assert.equal(g.name, 'Day 1 - Upper Force');
  assert.deepEqual(g.others, [{ id: L.id, name: 'Day 2 - Lower Force' }]);
});

test('gymCard start with no routines: name null, no others', () => {
  const g = buildTodayModel(bare(), TODAY, '10:00').gymCard;
  assert.equal(g.state, 'start');
  assert.equal(g.routineId, null);
  assert.equal(g.name, null);
  assert.deepEqual(g.others, []);
});

test('gymCard resume when a draft is given', () => {
  const s = bare({ routines: [U, L], scheduleSlots: slots });
  const draft = { workout: { id: 'live', routine_id: L.id, name: L.name, started_at: iso(2026, 11, 23, 9) } };
  const g = buildTodayModel(s, TODAY, '10:00', { draft }).gymCard;
  assert.equal(g.state, 'resume');
  assert.equal(g.name, 'Day 2 - Lower Force');
  assert.equal(g.startedAt, draft.workout.started_at);
  assert.equal(g.workoutId, 'live');
});

test('gymCard done: finished workout today, duration 58 min, sets from the index; null when unknown', () => {
  const w = wk('wd', U, TODAY, 18);
  const s = bare({ routines: [U, L], scheduleSlots: slots, workouts: [w] });
  const index = { version: 1, workoutIds: ['wd'], exercises: {
    e1: { sessions: [{ workoutId: 'wd', workingSets: 4 }, { workoutId: 'other', workingSets: 9 }] },
    e2: { sessions: [{ workoutId: 'wd', workingSets: 3 }] },
  } };
  const g = buildTodayModel(s, TODAY, '19:30', { index }).gymCard;
  assert.equal(g.state, 'done');
  assert.equal(g.duration, '58 min');
  assert.equal(g.sets, 7);
  assert.equal(g.workoutId, 'wd');
  assert.equal(buildTodayModel(s, TODAY, '19:30').gymCard.sets, null);
  assert.equal(buildTodayModel(s, TODAY, '19:30', { index: { version: 1, workoutIds: [], exercises: {} } }).gymCard.sets, null);
  // yesterday's workout is not "done today"
  const y = bare({ routines: [U, L], scheduleSlots: slots, workouts: [wk('wy', U, '2026-11-22', 18)] });
  assert.equal(buildTodayModel(y, TODAY, '10:00').gymCard.state, 'start');
  // a draft wins over a finished workout (starting another one)
  const draft = { workout: { id: 'live2', routine_id: L.id, name: L.name, started_at: iso(2026, 11, 23, 20) } };
  assert.equal(buildTodayModel(s, TODAY, '20:10', { draft }).gymCard.state, 'resume');
});

test('gymCard hint: rest day, planned day, two in a row', () => {
  const s = bare({ routines: [U, L], scheduleSlots: slots });
  // 2026-11-25 is a Wednesday: rest slot
  assert.equal(buildTodayModel(s, '2026-11-25', '10:00').gymCard.hint, 'Rest day planned');
  assert.equal(buildTodayModel(s, TODAY, '10:00').gymCard.hint, 'Planned today: Upper Force');
  const two = bare({ routines: [U, L], scheduleSlots: slots, workouts: [wk('a', U, '2026-11-21', 18), wk('b', L, '2026-11-22', 18)] });
  assert.equal(buildTodayModel(two, TODAY, '10:00').gymCard.hint, '2 days in a row \u00b7 rest suggested');
  assert.equal(buildTodayModel(bare(), TODAY, '10:00').gymCard.hint, '');
});

test('habit ariaLabel carries state, streak and miss flag; gym row text shows the week', () => {
  const m = buildTodayModel(fresh(), TODAY, '10:00');
  const maths = m.habits.find((h) => h.name.startsWith('Maths'));
  assert.match(maths.ariaLabel, /^Maths 30', (done|skipped|not done), streak \d+/);
  const read = m.habits.find((h) => h.name === 'Read');
  assert.equal(read.ariaLabel, 'Read, not done, streak 0, missed twice');

  const habit = { id: 'hd', name: 'Drink', schedule_kind: 'daily', active: true, sort: 0, created_at: iso(2026, 1, 1, 9) };
  const logs = ['2026-11-20', '2026-11-21', '2026-11-22', TODAY].map((date) => ({ id: date, habit_id: 'hd', date, status: 'done' }));
  const s = bare({ habits: [habit], habitLogs: logs });
  const h = buildTodayModel(s, TODAY, '10:00').habits[0];
  assert.equal(h.ariaLabel, 'Drink, done, streak 4');
  const skipped = bare({ habits: [habit], habitLogs: [{ id: 'k', habit_id: 'hd', date: TODAY, status: 'skipped' }] });
  assert.match(buildTodayModel(skipped, TODAY, '10:00').habits[0].ariaLabel, /^Drink, skipped, streak/);
  // 'streak 3' boundary: three done days ending today
  const three = bare({ habits: [habit], habitLogs: ['2026-11-21', '2026-11-22', TODAY].map((date) => ({ id: date, habit_id: 'hd', date, status: 'done' })) });
  assert.match(buildTodayModel(three, TODAY, '10:00').habits[0].ariaLabel, /streak 3$/);
  // missed yesterday (one day) vs twice
  const once = bare({ habits: [habit], habitLogs: ['2026-11-20', '2026-11-21'].map((date) => ({ id: date, habit_id: 'hd', date, status: 'done' })) });
  assert.match(buildTodayModel(once, TODAY, '10:00').habits[0].ariaLabel, /missed yesterday$/);
  const twice = bare({ habits: [habit], habitLogs: [{ id: 'x', habit_id: 'hd', date: '2026-11-20', status: 'done' }] });
  assert.match(buildTodayModel(twice, TODAY, '10:00').habits[0].ariaLabel, /missed twice$/);
});

test('gym habit row text is "Gym · n/plan this week"', () => {
  const gym = { id: 'hg', name: 'Gym', schedule_kind: 'n_per_week', target_n: 4, active: true, sort: 0, created_at: iso(2026, 1, 1, 9) };
  const done = [wk('a', U, '2026-11-23', 8), wk('b', L, '2026-11-24', 8)];
  const s = bare({ settings: { water_target_l: 2.5, gym_habit_id: 'hg' }, habits: [gym], routines: [U, L], scheduleSlots: slots, workouts: done });
  const h = buildTodayModel(s, '2026-11-24', '10:00').habits[0];
  assert.equal(h.text, 'Gym \u00b7 2/4 this week');
  const other = buildTodayModel({ ...s, settings: { water_target_l: 2.5, gym_habit_id: null } }, '2026-11-24', '10:00').habits[0];
  assert.equal(other.text, 'Gym');
});
