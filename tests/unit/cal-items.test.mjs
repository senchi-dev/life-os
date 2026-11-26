import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIN, KINDS, itemsByDay, dayKinds } from '../../js/lib/cal-items.js';
import { addDays } from '../../js/lib/dates.js';

const ev = (id, date, s = null, e = null) => ({ id, title: id, date, start_time: s, end_time: e, location: null });
const snap = (over = {}) => ({ events: [], rituals: [], scheduleSlots: [], routines: [], workouts: [], ...over });
const iso = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).toISOString();

test('constants', () => {
  assert.deepEqual(DEFAULT_MIN, { event: 60, ritual: 30, workout: 60 });
  assert.deepEqual(KINDS, ['gym', 'event', 'ritual']);
});

test('one entry per day in range, possibly empty', () => {
  const m = itemsByDay(snap(), '2026-11-23', '2026-11-29', '2026-11-26');
  assert.deepEqual([...m.keys()], [0, 1, 2, 3, 4, 5, 6].map((i) => addDays('2026-11-23', i)));
  for (const v of m.values()) assert.deepEqual(v, []);
});

test('event defaults', () => {
  const s = snap({ events: [ev('a', '2026-11-24', '09:00'), ev('b', '2026-11-24', '09:00', '08:00'), ev('c', '2026-11-24'), ev('d', '2026-11-24', '11:00', '12:30')] });
  const day = itemsByDay(s, '2026-11-24', '2026-11-24', '2026-11-24').get('2026-11-24');
  const by = Object.fromEntries(day.map((i) => [i.id, i]));
  assert.deepEqual([by.a.start, by.a.end, by.a.allDay], [540, 600, false]);
  assert.deepEqual([by.b.start, by.b.end], [540, 600]);
  assert.equal(by.c.allDay, true);
  assert.equal(by.c.start, null);
  assert.deepEqual([by.d.start, by.d.end], [660, 750]);
  assert.equal(by.a.kind, 'event');
  assert.equal(by.a.title, 'a');
});

test('events argument overrides snapshot.events', () => {
  const s = snap({ events: [ev('snap', '2026-11-24', '09:00')] });
  const day = itemsByDay(s, '2026-11-24', '2026-11-24', '2026-11-24', [ev('extra', '2026-11-24', '10:00')]).get('2026-11-24');
  assert.deepEqual(day.map((i) => i.id), ['extra']);
});

test('ritual default 30 min; untimed ritual allDay', () => {
  const rituals = [{ id: 'r1', name: 'Plan week', weekday: 7, time: '18:00' }, { id: 'r2', name: 'Reset', weekday: 7, time: null }];
  const day = itemsByDay(snap({ rituals }), '2026-11-29', '2026-11-29', '2026-11-26').get('2026-11-29');
  const by = Object.fromEntries(day.map((i) => [i.id, i]));
  assert.deepEqual([by.r1.kind, by.r1.title, by.r1.start, by.r1.end, by.r1.allDay], ['ritual', 'Plan week', 1080, 1110, false]);
  assert.equal(by.r2.allDay, true);
  assert.equal(itemsByDay(snap({ rituals }), '2026-11-28', '2026-11-28', '2026-11-26').get('2026-11-28').length, 0, 'Saturday: no Sunday rituals');
});

const wk = (over = {}) => ({
  id: 'w1', routine_id: 'U', name: 'Day 1 - Upper A', day: '2026-11-20',
  started_at: iso(2026, 11, 20, 7, 15), ended_at: iso(2026, 11, 20, 8, 5), duration_known: true, ...over,
});

test('workout at real time', () => {
  const get = (w) => itemsByDay(snap({ workouts: [w] }), '2026-11-20', '2026-11-20', '2026-11-26').get('2026-11-20')[0];
  const it = get(wk());
  assert.deepEqual(
    { kind: it.kind, start: it.start, end: it.end, allDay: it.allDay, label: it.label, title: it.title, state: it.state, href: it.href },
    { kind: 'gym', start: 435, end: 485, allDay: false, label: 'Upper A · 50 min', title: 'Upper A', state: 'done', href: '#/gym/history/w1' },
  );
  const unknown = get(wk({ duration_known: false }));
  assert.deepEqual([unknown.start, unknown.end], [435, 495]);
  const nextDay = get(wk({ ended_at: iso(2026, 11, 21, 0, 30) }));
  assert.equal(nextDay.end, 495, 'ends on another local day → default 60');
  assert.equal(get(wk({ id: 'a/b' })).href, '#/gym/history/a%2Fb');
});

test('unfinished and future workouts are not shown', () => {
  const s = snap({ workouts: [wk({ ended_at: null }), wk({ id: 'w2', day: '2026-11-27', started_at: iso(2026, 11, 27, 7, 0), ended_at: iso(2026, 11, 27, 8, 0) })] });
  const m = itemsByDay(s, '2026-11-20', '2026-11-28', '2026-11-26');
  assert.deepEqual([...m.values()].flat(), []);
});

test('planned only today and after; done replaces planned today', () => {
  const routines = [{ id: 'U', name: 'Day 1 - Upper A', archived: false }];
  const scheduleSlots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, routine_id: 'U' }));
  const done = wk({ day: '2026-11-26', started_at: iso(2026, 11, 26, 7, 0), ended_at: iso(2026, 11, 26, 8, 0) });
  const m = itemsByDay(snap({ routines, scheduleSlots, workouts: [done] }), '2026-11-20', '2026-11-29', '2026-11-26');
  for (let d = '2026-11-20'; d < '2026-11-26'; d = addDays(d, 1)) assert.deepEqual(m.get(d), [], d);
  const today = m.get('2026-11-26');
  assert.equal(today.length, 1);
  assert.equal(today[0].state, 'done');
  for (const d of ['2026-11-27', '2026-11-28', '2026-11-29']) {
    const [p, ...rest] = m.get(d);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { kind: p.kind, allDay: p.allDay, start: p.start, end: p.end, label: p.label, state: p.state, href: p.href },
      { kind: 'gym', allDay: true, start: null, end: null, label: 'Upper A · planned', state: 'planned', href: '#/gym' },
    );
  }
});

test('older range shows events only, no throw', () => {
  const s = { events: [ev('old', '2026-09-10', '09:00')] };
  const m = itemsByDay(s, '2026-09-01', '2026-09-30', '2026-11-26');
  assert.equal(m.size, 30);
  assert.deepEqual([...m.values()].flat().map((i) => i.id), ['old']);
});

test('day sort: allDay first (gym, event, ritual), then start, then longer first', () => {
  const s = snap({
    events: [ev('e-late', '2026-11-29', '14:00'), ev('e-all', '2026-11-29'), ev('e-short', '2026-11-29', '09:00', '09:30'), ev('e-long', '2026-11-29', '09:00', '11:00')],
    rituals: [{ id: 'r-all', name: 'Reset', weekday: 7, time: null }, { id: 'r-8', name: 'Plan', weekday: 7, time: '08:00' }],
    routines: [{ id: 'U', name: 'Upper', archived: false }],
    scheduleSlots: [{ weekday: 7, routine_id: 'U' }],
  });
  const day = itemsByDay(s, '2026-11-29', '2026-11-29', '2026-11-26').get('2026-11-29');
  assert.deepEqual(day.map((i) => i.id ?? i.kind), ['gym', 'e-all', 'r-all', 'r-8', 'e-long', 'e-short', 'e-late']);
});

test('dayKinds order', () => {
  assert.deepEqual(dayKinds([{ kind: 'ritual' }, { kind: 'event' }, { kind: 'gym' }, { kind: 'event' }]), ['gym', 'event', 'ritual']);
  assert.deepEqual(dayKinds([{ kind: 'ritual' }]), ['ritual']);
  assert.deepEqual(dayKinds([]), []);
});

test('workout on the DST Sunday', () => {
  const w = wk({ day: '2026-10-25', started_at: iso(2026, 10, 25, 10, 0), ended_at: iso(2026, 10, 25, 11, 0) });
  const it = itemsByDay(snap({ workouts: [w] }), '2026-10-25', '2026-10-25', '2026-11-26').get('2026-10-25')[0];
  assert.deepEqual([it.start, it.end], [600, 660]);
});
