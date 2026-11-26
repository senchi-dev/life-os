// today-view's DOM-free action factory: handlers read the app state at action time, never from a closure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateKey, weekStart } from '../../js/lib/dates.js';

const { todayActions, weekLineText, clockText } = await import('../../js/ui/today-view.js');

const base = (over = {}) => ({
  todayKey: '2026-11-23',
  snapshot: { habits: [], habitLogs: [], water: [], daily: [], sleep: [], ritualLogs: [], settings: { water_target_l: 2.5 }, books: [], routines: [] },
  ctx: { id: 'ctx' },
  refreshed: 0, rerendered: 0,
  rerender() { this.rerendered++; },
  async refresh() { this.refreshed++; },
  ...over,
});
const quiet = (p) => { p?.catch?.(() => {}); return p; }; // the code under test handles it; keeps node from flagging the eager rejection
const fakeRepo = (over = {}) => ({
  calls: [],
  addWater(ctx, liters, at) {
    this.calls.push({ liters, at });
    return { row: { id: `w${this.calls.length}`, liters, at: at.toISOString() }, saved: quiet(over.saved) ?? Promise.resolve() };
  },
  setDaily(ctx, date, patch) { this.calls.push({ date, patch }); return quiet(over.write) ?? Promise.resolve(); },
  saveRitualLog(ctx, id, ws, state, done) { this.calls.push({ id, ws, state, done }); return Promise.resolve(); },
  setHabitStatus(ctx, id, date, status) { this.calls.push({ id, date, status }); return Promise.resolve(); },
  removeWater() { return Promise.resolve(); },
  saveSleep() { return Promise.resolve(); },
});
const tick = () => new Promise((r) => setTimeout(r, 0));

test('addWater uses the day that is current at action time, not at creation', async () => {
  const app = base();
  const repo = fakeRepo();
  const now = new Date(2026, 10, 30, 9, 0); // Monday of the next week
  const act = todayActions(app, { repo, now: () => now });
  app.todayKey = '2026-11-30'; // changed after the factory was created
  app.snapshot.daily = [{ id: 'd', date: '2026-11-30', pages: 12, mood: null }];
  act.addWater(0.5);
  assert.equal(repo.calls.length, 1);
  assert.equal(localDateKey(repo.calls[0].at), '2026-11-30');
  assert.equal(app.refreshed, 0, 'same day: no rollover refresh');
  assert.equal(app.snapshot.water.length, 1);
  assert.equal(localDateKey(new Date(app.snapshot.water[0].at)), '2026-11-30');
  // the week line is computed for the new week, not the one captured earlier
  assert.equal(weekStart(app.todayKey), '2026-11-30');
  assert.match(act.weekLine(now), /^This week: habits /);
  await tick();
});

test('addWater after midnight moves app.todayKey and refreshes before writing', async () => {
  const app = base({ todayKey: '2026-11-23' });
  const repo = fakeRepo();
  const act = todayActions(app, { repo, now: () => new Date(2026, 10, 24, 0, 5) });
  act.addWater(0.25);
  assert.equal(app.todayKey, '2026-11-24');
  assert.equal(app.refreshed, 1);
  assert.equal(localDateKey(repo.calls[0].at), '2026-11-24');
  await tick();
});

test('addWater: "Saved." only after saved resolves', async () => {
  let release;
  const saved = new Promise((r) => { release = r; });
  const app = base();
  const act = todayActions(app, { repo: fakeRepo({ saved }), now: () => new Date(2026, 10, 23, 9) });
  act.addWater(0.5);
  assert.equal(act.ui.notice, '', 'not before the write result');
  release();
  await tick();
  assert.equal(act.ui.notice, 'Saved.');
  assert.equal(app.snapshot.water.length, 1);
});

test('addWater rejection restores the snapshot and says so', async () => {
  const before = [{ id: 'old', at: new Date(2026, 10, 23, 8).toISOString(), liters: 1 }];
  const app = base();
  app.snapshot.water = before;
  const act = todayActions(app, { repo: fakeRepo({ saved: Promise.reject(new Error('queue full')) }), now: () => new Date(2026, 10, 23, 9) });
  act.addWater(0.5);
  assert.equal(app.snapshot.water.length, 2, 'optimistic row first');
  await tick();
  assert.deepEqual(app.snapshot.water, before);
  assert.equal(act.ui.notice, 'Could not save. Try again.');
  assert.ok(app.rerendered >= 2);
});

test('addWater rejection does not undo a newer snapshot', async () => {
  const app = base();
  const act = todayActions(app, { repo: fakeRepo({ saved: Promise.reject(new Error('x')) }), now: () => new Date(2026, 10, 23, 9) });
  act.addWater(0.5);
  const fresh = { ...app.snapshot, water: [{ id: 'server', at: new Date(2026, 10, 23, 7).toISOString(), liters: 2 }] };
  app.snapshot = fresh; // a refresh replaced the snapshot while the write was in flight
  await tick();
  assert.equal(app.snapshot, fresh);
  assert.equal(act.ui.notice, 'Could not save. Try again.');
});

test('addWater rejects nonsense amounts without writing', () => {
  const app = base();
  const repo = fakeRepo();
  const act = todayActions(app, { repo, now: () => new Date(2026, 10, 23, 9) });
  for (const bad of [0, -1, NaN, Infinity, 'x', null, 3.5]) act.addWater(bad);
  assert.equal(repo.calls.length, 0);
  assert.equal(app.snapshot.water.length, 0);
});

test('setDaily (pages) reads the current day and mood at action time; Saved. only after the write', async () => {
  let release;
  const write = new Promise((r) => { release = r; });
  const app = base();
  const repo = fakeRepo({ write });
  const act = todayActions(app, { repo, now: () => new Date(2026, 10, 30, 9) });
  app.todayKey = '2026-11-30';
  app.snapshot.daily = [{ id: 'd', date: '2026-11-30', pages: 5, mood: 4 }];
  act.addPages(10, 'b1'); // current pages are read now: 5 + 10
  assert.deepEqual(repo.calls[0], { date: '2026-11-30', patch: { pages: 15, book_id: 'b1' } });
  assert.equal(act.ui.notice, '');
  release();
  await tick();
  assert.equal(act.ui.notice, 'Saved.');
  assert.equal(app.snapshot.daily[0].mood, 4, 'mood untouched');
});

test('pages write rejection rolls back and says so', async () => {
  const app = base();
  app.snapshot.daily = [{ id: 'd', date: '2026-11-23', pages: 5, mood: null }];
  const act = todayActions(app, { repo: fakeRepo({ write: Promise.reject(new Error('x')) }), now: () => new Date(2026, 10, 23, 9) });
  act.setPages(40, null);
  assert.equal(app.snapshot.daily[0].pages, 40);
  await tick();
  assert.equal(app.snapshot.daily[0].pages, 5);
  assert.equal(act.ui.notice, 'Could not save. Try again.');
});

test('ritual toggle saves the object form keyed by item text', async () => {
  const app = base();
  const repo = fakeRepo();
  const act = todayActions(app, { repo, now: () => new Date(2026, 10, 23, 9) });
  const entry = { ritual: { id: 'r1', checklist: ['A', 'B'] }, weekStart: '2026-11-23', state: [false, false] };
  // the stored state at action time wins over the state the row was drawn with
  app.snapshot.ritualLogs = [{ id: 'l1', ritual_id: 'r1', week_start: '2026-11-23', checklist_state: { A: true }, done_at: null }];
  act.toggleRitual(entry, 1);
  assert.deepEqual(repo.calls[0].state, { A: true, B: true });
  assert.equal(repo.calls[0].done, true);
  assert.deepEqual(app.snapshot.ritualLogs[0].checklist_state, { A: true, B: true });
  assert.equal(app.snapshot.ritualLogs.length, 1);
  await tick();
});

test('startWorkout: starts through app.gym then navigates to #/workout; failure stays put', async () => {
  const nav = [];
  const app = base({ gym: { start: async (id) => (id === 'bad' ? null : { workout: { id: 'w' } }) } });
  const act = todayActions(app, { repo: fakeRepo(), now: () => new Date(2026, 10, 23, 9), navigate: (h) => nav.push(h) });
  await act.startWorkout('r1');
  assert.deepEqual(nav, ['#/workout']);
  await act.startWorkout('bad');
  assert.deepEqual(nav, ['#/workout']);
  assert.equal(act.ui.notice, 'Could not start the workout. Try again.');
  const boom = base({ gym: { start: async () => { throw new Error('x'); } } });
  const act2 = todayActions(boom, { repo: fakeRepo(), now: () => new Date(2026, 10, 23, 9), navigate: (h) => nav.push(h) });
  await act2.startWorkout('r1');
  assert.deepEqual(nav, ['#/workout']);
  assert.equal(act2.ui.notice, 'Could not start the workout. Try again.');
});

test('startWorkout ignores a second tap while the first is running', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = base({ gym: { start: async () => { calls++; await gate; return { workout: { id: 'w' } }; } } });
  const nav = [];
  const act = todayActions(app, { repo: fakeRepo(), now: () => new Date(2026, 10, 23, 9), navigate: (h) => nav.push(h) });
  const a = act.startWorkout('r1');
  const b = act.startWorkout('r1');
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(nav, ['#/workout']);
});

test('weekLineText and clockText', () => {
  assert.equal(weekLineText({ pages: 12, pagesTarget: 200, habitsPct: null }), 'This week: habits \u2013');
  assert.equal(weekLineText({ pages: 12, pagesTarget: 200, habitsPct: 75 }), 'This week: habits 75%');
  const start = '2026-11-23T09:00:00.000Z';
  assert.equal(clockText(start, Date.parse(start) + 42 * 60000 + 18000), '00:42:18');
  assert.equal(clockText(start, Date.parse(start) - 5000), '00:00:00', 'clock never runs backwards');
  assert.equal(clockText('garbage', Date.now()), '00:00:00');
});
