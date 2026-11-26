// Calendar shell logic without a real DOM: on-demand range loading, commit's handling of fetched events,
// the collapsible form and resetCalendar (Review Focus #4/#5).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fixtures/fake-dom.mjs';
import { addDays, localDateKey } from '../../js/lib/dates.js';
import { mergeEvents } from '../../js/lib/event-window.js';

installFakeDom();
const C = await import('../../js/ui/calendar-view.js');

const T = localDateKey(new Date()); // syncToday compares with the real clock
const tick = () => new Promise((r) => setImmediate(r));
const OLD = addDays(T, -50); // outside the boot window (today -35 .. +90)

function makeApp({ select, enqueue } = {}) {
  const calls = { select: [], enqueue: [], rerender: 0, refresh: 0 };
  const app = {
    todayKey: T,
    snapshot: { events: [], rituals: [], scheduleSlots: [], routines: [], workouts: [] },
    ctx: {
      backend: { select: async (table, opts) => { calls.select.push({ table, opts }); return select ? select(opts) : []; } },
      outbox: { enqueue: async (op) => { calls.enqueue.push(op); if (enqueue) await enqueue(op); }, flush: async () => {} },
    },
    rerender: () => { calls.rerender++; },
    refresh: async () => { calls.refresh++; },
  };
  return { app, calls };
}

const ev = (id, date, title = id) => ({ id, title, date, start_time: '10:00', end_time: '11:00', location: null });
const shown = (app) => mergeEvents(app.snapshot.events, C.calendarState().cal.extra);

function setOnline(v) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: v }, configurable: true, writable: true });
}

beforeEach(() => { C.resetCalendar(); setOnline(true); });

test('ensureRange fetches only the missing part, keeps the rows and marks the range loaded', async () => {
  const { app, calls } = makeApp({ select: () => [ev('a', addDays(T, -40))] });
  const want = { from: OLD, to: addDays(T, -30) };
  assert.equal(C.ensureRange(app, want), 'ok');
  await tick();
  assert.equal(calls.select.length, 1);
  assert.equal(calls.select[0].table, 'events');
  assert.deepEqual([calls.select[0].opts.gte.date, calls.select[0].opts.lte.date], [OLD, addDays(T, -36)]);
  const { cal } = C.calendarState();
  assert.deepEqual(cal.extra.map((e) => e.id), ['a']);
  assert.ok(calls.rerender >= 1);
  assert.equal(C.ensureRange(app, want), 'ok');
  await tick();
  assert.equal(calls.select.length, 1, 'already loaded: no second fetch');
  assert.equal(C.ensureRange(app, { from: T, to: addDays(T, 6) }), 'ok');
  assert.equal(calls.select.length, 1, 'boot window counts as loaded');
});

test('ensureRange: a failed fetch shows failed, never refetches in a loop and removes nothing', async () => {
  let fail = false;
  const { app, calls } = makeApp({ select: () => { if (fail) throw new Error('net'); return [ev('a', addDays(T, -40))]; } });
  C.ensureRange(app, { from: addDays(T, -40), to: addDays(T, -40) });
  await tick();
  fail = true;
  const want = { from: addDays(T, -60), to: addDays(T, -55) };
  C.ensureRange(app, want);
  await tick();
  assert.equal(calls.select.length, 2);
  assert.equal(C.ensureRange(app, want), 'failed');
  await tick();
  assert.equal(calls.select.length, 2, 'no refetch after a failure on rerender');
  assert.deepEqual(C.calendarState().cal.extra.map((e) => e.id), ['a']);
});

test('ensureRange offline: status offline, no fetch, loaded events kept', async () => {
  const { app, calls } = makeApp();
  C.calendarState().cal.extra = [ev('a', addDays(T, -40))];
  setOnline(false);
  assert.equal(C.ensureRange(app, { from: OLD, to: addDays(T, -30) }), 'offline');
  await tick();
  assert.equal(calls.select.length, 0);
  assert.equal(C.calendarState().cal.extra.length, 1);
  assert.equal(C.ensureRange(app, { from: T, to: T }), 'ok');
});

test('ensureRange results from before resetCalendar are dropped', async () => {
  const { app, calls } = makeApp({ select: () => [ev('a', OLD)] });
  C.ensureRange(app, { from: OLD, to: OLD });
  C.resetCalendar();
  await tick();
  assert.equal(calls.select.length, 1);
  assert.deepEqual(C.calendarState().cal.extra, []);
});

test('editing a fetched event shows it once, also after a snapshot refresh', async () => {
  const { app } = makeApp();
  const a = ev('a', OLD, 'Old title');
  C.calendarState().cal.extra = [a];
  C.selectEvent(app, a);
  C.calendarState().ui.draft.title = 'New title';
  C.submitEvent(app);
  await tick();
  let rows = shown(app).filter((e) => e.id === 'a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'New title');
  app.snapshot.events = []; // refresh: the boot window does not hold it
  rows = shown(app).filter((e) => e.id === 'a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'New title');
});

test('a new event outside the boot window survives a snapshot refresh', async () => {
  const { app } = makeApp();
  C.openForm(app);
  Object.assign(C.calendarState().ui.draft, { title: 'Far', date: addDays(T, 120) });
  C.submitEvent(app);
  await tick();
  app.snapshot.events = [];
  assert.deepEqual(shown(app).map((e) => e.title), ['Far']);
});

test('deleting a fetched event is not resurrected', async () => {
  const { app, calls } = makeApp();
  const a = ev('a', OLD);
  C.calendarState().cal.extra = [a];
  C.selectEvent(app, a);
  C.removeEvent(app);
  C.removeEvent(app); // second tap confirms
  await tick();
  assert.equal(calls.enqueue.length, 1);
  assert.equal(shown(app).some((e) => e.id === 'a'), false);
  app.snapshot.events = [];
  assert.equal(shown(app).some((e) => e.id === 'a'), false);
});

test('a failed write restores only the touched row; rows fetched meanwhile stay', async () => {
  let reject;
  const { app, calls } = makeApp({ enqueue: () => new Promise((_, r) => { reject = r; }) });
  const a = ev('a', OLD, 'Original');
  C.calendarState().cal.extra = [a];
  C.selectEvent(app, a);
  C.calendarState().ui.draft.title = 'Edited';
  C.submitEvent(app);
  await tick();
  const { cal } = C.calendarState();
  cal.extra = [...cal.extra, ev('b', addDays(OLD, 1))]; // an on-demand fetch lands before the write fails
  reject(new Error('down'));
  await tick();
  assert.equal(calls.refresh, 1);
  assert.deepEqual(cal.extra.map((e) => [e.id, e.title]).sort(), [['a', 'Original'], ['b', 'b']]);
  assert.equal(C.calendarState().ui.notice, 'Could not save that. Try again.');
});

test('a failed write of a new fetched-range event removes it from extra', async () => {
  let reject;
  const { app } = makeApp({ enqueue: () => new Promise((_, r) => { reject = r; }) });
  C.openForm(app);
  Object.assign(C.calendarState().ui.draft, { title: 'Far', date: addDays(T, 120) });
  C.submitEvent(app);
  await tick();
  assert.equal(C.calendarState().cal.extra.length, 1);
  reject(new Error('down'));
  await tick();
  assert.deepEqual(C.calendarState().cal.extra, []);
});

test('form: closed by default, opens on Add event or select, closes on save, cancel and delete', async () => {
  const { app } = makeApp();
  const { ui } = C.calendarState();
  assert.equal(ui.formOpen, false);
  C.openForm(app);
  assert.equal(C.calendarState().ui.formOpen, true);
  C.submitEvent(app); // empty title: stays open with the error
  assert.equal(C.calendarState().ui.formOpen, true);
  assert.equal(C.calendarState().ui.notice, 'Title required');
  C.closeForm(app);
  assert.equal(C.calendarState().ui.formOpen, false);
  C.openForm(app);
  C.calendarState().ui.draft.title = 'Lunch';
  C.submitEvent(app);
  await tick();
  assert.equal(C.calendarState().ui.formOpen, false);
  const lunch = app.snapshot.events.find((e) => e.title === 'Lunch');
  assert.equal(lunch.date, T);
  C.selectEvent(app, lunch);
  assert.equal(C.calendarState().ui.formOpen, true);
  C.removeEvent(app);
  assert.equal(C.calendarState().ui.formOpen, true, 'first tap only arms the delete');
  C.removeEvent(app);
  assert.equal(C.calendarState().ui.formOpen, false);
});

test('form date defaults to the shown day in Day view', async () => {
  const { app } = makeApp();
  const { cal } = C.calendarState();
  cal.view = 'day';
  cal.anchor = addDays(T, 3);
  C.openForm(app);
  C.calendarState().ui.draft.title = 'Dentist';
  C.submitEvent(app);
  await tick();
  assert.equal(app.snapshot.events.find((e) => e.title === 'Dentist').date, addDays(T, 3));
});

test('resetCalendar clears view state, fetched events, the draft and closes the form', () => {
  const { app } = makeApp();
  const { cal } = C.calendarState();
  Object.assign(cal, { view: 'day', anchor: OLD, extra: [ev('a', OLD)], loaded: [{ from: OLD, to: OLD }], failedKey: 'x' });
  C.selectEvent(app, ev('a', OLD));
  C.resetCalendar();
  const s = C.calendarState();
  assert.notEqual(s.cal, cal);
  assert.equal(s.cal.view, null);
  assert.equal(s.cal.anchor, null);
  assert.deepEqual(s.cal.extra, []);
  assert.deepEqual(s.cal.loaded, []);
  assert.equal(s.cal.failedKey, null);
  assert.equal(s.ui.draft.id, null);
  assert.equal(s.ui.formOpen, false);
  assert.equal(s.ui.notice, '');
});
