import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../../js/lib/event-form.js';

const ok = { title: 'Dentist', date: '2026-11-24', start_time: '14:00', end_time: '15:00' };

test('valid event passes', () => {
  assert.equal(validateEvent(ok), null);
  assert.equal(validateEvent({ title: 'Dinner', date: '2026-11-24' }), null);
  assert.equal(validateEvent({ ...ok, start_time: '', end_time: '' }), null);
  assert.equal(validateEvent({ ...ok, end_time: null }), null);
});

test('title is required, trimmed, at most 80 chars', () => {
  assert.equal(validateEvent({ ...ok, title: '' }), 'Title required');
  assert.equal(validateEvent({ ...ok, title: '   ' }), 'Title required');
  assert.equal(validateEvent({ ...ok, title: undefined }), 'Title required');
  assert.equal(validateEvent({ ...ok, title: 'x'.repeat(80) }), null);
  assert.equal(validateEvent({ ...ok, title: 'x'.repeat(81) }), 'Title: 80 characters max');
});

test('date is required and well formed', () => {
  assert.equal(validateEvent({ ...ok, date: '' }), 'Date required');
  assert.equal(validateEvent({ ...ok, date: null }), 'Date required');
  assert.equal(validateEvent({ ...ok, date: '24/11/2026' }), 'Date required');
});

test('end must be after start', () => {
  assert.equal(validateEvent({ ...ok, start_time: '10:00', end_time: '09:00' }), 'End must be after start');
  assert.equal(validateEvent({ ...ok, start_time: '10:00', end_time: '10:00' }), 'End must be after start');
});

test('end without start is rejected', () => {
  assert.equal(validateEvent({ ...ok, start_time: '', end_time: '09:00' }), 'Add a start time first');
  assert.equal(validateEvent({ ...ok, start_time: null, end_time: '09:00' }), 'Add a start time first');
});

import { splitWindow } from '../../js/lib/event-form.js';

test('splitWindow: day 6 inside, day 7 later, yesterday excluded, sorted', () => {
  const ev = (id, date, start_time = null) => ({ id, title: id, date, start_time });
  const today = '2026-11-23';
  const events = [
    ev('later2', '2026-12-31', '09:00'), ev('past', '2026-11-22'), ev('d7', '2026-11-30'),
    ev('d6b', '2026-11-29', '18:00'), ev('d6a', '2026-11-29', '08:00'), ev('later1', '2026-12-01'),
    ev('later1b', '2026-12-01', '07:00'),
  ];
  const { inWindow, later } = splitWindow(events, today, 7);
  assert.deepEqual(inWindow.map((e) => e.id), ['d6a', 'd6b']);
  assert.deepEqual(later.map((e) => e.id), ['d7', 'later1', 'later1b', 'later2']);
});

// ---- Task 16: planned workouts in the Calendar ----
import { calendarPlanned } from '../../js/ui/calendar-view.js';

const WED = '2026-11-25';
const gsnap = (over = {}) => ({
  events: [{ id: 'e1', title: 'Dentist', date: '2026-11-26', start_time: '14:00', end_time: null }],
  rituals: [],
  routines: [{ id: 'U', name: 'Day 1 - Upper Force', sort: 0, archived: false }, { id: 'L', name: 'Lower', sort: 1, archived: false }],
  scheduleSlots: [[1, 'U'], [2, 'L'], [3, null], [4, 'U'], [5, 'L'], [6, null], [7, null]].map(([weekday, routine_id]) => ({ weekday, routine_id })),
  workouts: [],
  ...over,
});

test('calendarPlanned: 7 days from today, agenda items first, planned rows muted with href #/gym', () => {
  const days = calendarPlanned(gsnap(), WED);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.date), ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01']);
  const thu = days[1];
  assert.deepEqual(thu.items.map((i) => i.kind), ['event', 'gym']);
  assert.deepEqual(thu.items[1], { kind: 'gym', state: 'planned', title: 'Upper Force', label: 'Upper Force · planned', href: '#/gym', muted: true });
  assert.deepEqual(days[0].items, [], 'Wednesday is rest');
  assert.equal(days[2].items[0].label, 'Lower · planned');
  assert.deepEqual(days[3].items, []);
});

test('calendarPlanned: done workout replaces planned, duration through displayMinutes, links to history', () => {
  const w = (over) => ({ id: 'w1', routine_id: 'U', name: 'Day 1 - Upper Force', day: '2026-11-26', started_at: '2026-11-26T08:00:00Z', ended_at: '2026-11-26T08:58:00Z', duration_known: true, ...over });
  const row = (over) => calendarPlanned(gsnap({ workouts: [w(over)] }), WED)[1].items.find((i) => i.kind === 'gym');
  assert.deepEqual(row({}), { kind: 'gym', state: 'done', title: 'Upper Force', label: 'Upper Force · 58 min', href: '#/gym/history/w1', muted: false });
  assert.equal(row({ ended_at: '2026-11-26T09:12:00Z' }).label, 'Upper Force · 1h12', 'over an hour');
  assert.equal(row({ duration_known: false }).label, 'Upper Force · —', 'A9: unknown duration is a dash');
  assert.equal(row({ ended_at: '2026-11-26T14:00:00Z' }).label, 'Upper Force · —', 'implausible (> 4 h) is a dash');
  assert.equal(row({ id: 'w2/x' }).href, '#/gym/history/w2%2Fx', 'id is URL-encoded');
});

test('calendarPlanned: archived routine slot is rest; missing arrays and no slots do not throw; open workout is not done', () => {
  const archived = gsnap({ routines: [{ id: 'U', name: 'Upper', archived: true }, { id: 'L', name: 'Lower', archived: false }] });
  assert.deepEqual(calendarPlanned(archived, WED)[1].items.map((i) => i.kind), ['event']);
  assert.equal(calendarPlanned({}, WED).length, 7);
  assert.ok(calendarPlanned({}, WED).every((d) => d.items.length === 0));
  assert.equal(calendarPlanned(null, WED).length, 7);
  const open = gsnap({ workouts: [{ id: 'o', routine_id: 'U', name: 'Upper', day: '2026-11-26', started_at: '2026-11-26T08:00:00Z', ended_at: null }] });
  assert.equal(calendarPlanned(open, WED)[1].items.find((i) => i.kind === 'gym').state, 'planned');
});
