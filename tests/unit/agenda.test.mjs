import test from 'node:test';
import assert from 'node:assert/strict';
import { agenda, nowNext } from '../../js/lib/agenda.js';
import { DEFAULT_RITUALS } from '../../js/lib/rituals.js';

const R = DEFAULT_RITUALS.map((r, i) => ({ id: 'r' + i, ...r }));
const ev = (id, date, s, e) => ({ id, title: id, date, start_time: s, end_time: e, location: null });

test('agenda spans 7 days, includes rituals, sorts all-day first, excludes day 8', () => {
  const events = [
    ev('timed', '2026-11-24', '09:30', '10:00'),
    ev('allday', '2026-11-24', null, null),
    ev('far', '2026-11-30', '09:00', null),
  ];
  const a = agenda(events, R, '2026-11-23');
  assert.equal(a.length, 7);
  assert.equal(a[0].date, '2026-11-23');
  assert.equal(a[6].date, '2026-11-29');
  assert.ok(a.find((d) => d.date === '2026-11-28').items.some((i) => i.kind === 'ritual' && i.title === 'Cleaning reset'));
  assert.deepEqual(a[1].items.map((i) => i.id), ['allday', 'timed']);
  assert.ok(!a.some((d) => d.items.some((i) => i.id === 'far')));
});

test('nowNext', () => {
  const events = [ev('a', '2026-11-23', '09:30', '11:00'), ev('b', '2026-11-23', '18:00', '19:00'), ev('x', '2026-11-24', '10:00', null)];
  assert.deepEqual(nowNext(events, '2026-11-23', '10:00').map((e) => e.id), ['a', 'b']);
  assert.deepEqual(nowNext(events, '2026-11-23', '12:00').map((e) => e.id), ['b']);
  const noEnd = [ev('a', '2026-11-23', '09:30', null), ev('b', '2026-11-23', '18:00', null)];
  assert.deepEqual(nowNext(noEnd, '2026-11-23', '10:45').map((e) => e.id), ['b']);
  assert.deepEqual(nowNext(noEnd, '2026-11-23', '10:15').map((e) => e.id), ['a', 'b']);
});
