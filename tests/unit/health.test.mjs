import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nightOf, buildSleep, defaultTimes, sleepStats, formatDuration,
  parseLiters, waterTotalsByDay, LITER_CHIPS, PAGE_CHIPS,
  DEFAULT_WATER_TARGET_L, DEFAULT_WEEKLY_PAGES,
} from '../../js/lib/health.js';

// Builds a sleep row for the night starting on 2026-11-(10+i); local-time constructors only.
const toRow = ([bed, wake], i = 0) => {
  const [bh, bm] = bed.split(':').map(Number);
  const [wh, wm] = wake.split(':').map(Number);
  const wakeDay = 11 + i;
  const bedDay = bh >= 12 ? wakeDay - 1 : wakeDay;
  return { bed_at: new Date(2026, 10, bedDay, bh, bm), wake_at: new Date(2026, 10, wakeDay, wh, wm) };
};

test('bed after midnight belongs to previous night', () => {
  const s = buildSleep({ wakeDateKey: '2026-11-23', bed: '00:40', wake: '07:55' });
  assert.equal(s.night_of, '2026-11-22'); assert.equal(s.minutes, 435);
  assert.equal(formatDuration(s.minutes), '7h15');
});
test('bed before midnight', () => {
  const s = buildSleep({ wakeDateKey: '2026-11-23', bed: '23:10', wake: '07:00' });
  assert.equal(s.night_of, '2026-11-22'); assert.equal(s.minutes, 470);
});
test('impossible sleep throws', () =>
  assert.throws(() => buildSleep({ wakeDateKey: '2026-11-23', bed: '08:00', wake: '07:00' }), RangeError));
test('sleep over 20h throws', () =>
  assert.throws(() => buildSleep({ wakeDateKey: '2026-11-23', bed: '12:00', wake: '09:00' }), RangeError));
test('nightOf uses bed minus 12h', () => {
  assert.equal(nightOf(new Date(2026, 10, 23, 0, 40)), '2026-11-22');
  assert.equal(nightOf(new Date(2026, 10, 22, 23, 10)), '2026-11-22');
});
test('defaultTimes median across midnight', () => {
  const h = [['23:50','07:30'],['00:10','07:40'],['00:30','08:00']].map(toRow);
  assert.deepEqual(defaultTimes(h), { bed: '00:10', wake: '07:40' });
});
test('defaultTimes fallback', () => assert.deepEqual(defaultTimes([]), { bed: '23:30', wake: '07:30' }));
test('defaultTimes uses only the last 7 nights', () => {
  const old = Array.from({ length: 5 }, () => ['21:00', '05:00']);
  const recent = Array.from({ length: 7 }, () => ['23:00', '07:00']);
  assert.deepEqual(defaultTimes([...old, ...recent].map(toRow)), { bed: '23:00', wake: '07:00' });
});
test('sleepStats bed average and spread across midnight', () => {
  const st = sleepStats([['23:00','07:00'],['01:00','09:00']].map(toRow));
  assert.equal(st.avgBed, '00:00'); assert.equal(st.bedSpreadMin, 60); assert.equal(st.avgMinutes, 480);
  assert.equal(st.nights, 2);
});
test('sleepStats empty', () =>
  assert.deepEqual(sleepStats([]), { nights: 0, avgMinutes: null, avgBed: null, bedSpreadMin: null }));
test('sleepStats accepts ISO strings and ignores minutes column', () => {
  const r = toRow(['23:00', '07:00']);
  const st = sleepStats([{ bed_at: r.bed_at.toISOString(), wake_at: r.wake_at.toISOString(), minutes: 1 }]);
  assert.equal(st.avgMinutes, 480);
});
test('formatDuration pads minutes', () => assert.equal(formatDuration(425), '7h05'));
test('parseLiters handles French comma and rejects junk', () => {
  assert.equal(parseLiters('0,33'), 0.33); assert.equal(parseLiters('0.5'), 0.5);
  assert.equal(parseLiters('33'), null); assert.equal(parseLiters(''), null); assert.equal(parseLiters('-1'), null);
  assert.equal(parseLiters('abc'), null); assert.equal(parseLiters(0.333), 0.33); assert.equal(parseLiters(3), 3);
});
test('waterTotalsByDay groups by local day', () => {
  const m = waterTotalsByDay([{ at: new Date(2026,10,22,23,50), liters: 0.5 }, { at: new Date(2026,10,23,0,10), liters: 0.25 }, { at: new Date(2026,10,23,9,0), liters: 0.1 }]);
  assert.equal(m.get('2026-11-22'), 0.5); assert.equal(m.get('2026-11-23'), 0.35);
});
test('constants', () => {
  assert.deepEqual(LITER_CHIPS, [0.25, 0.5, 1]); assert.deepEqual(PAGE_CHIPS, [10, 20, 30]);
  assert.equal(DEFAULT_WATER_TARGET_L, 2.5); assert.equal(DEFAULT_WEEKLY_PAGES, 200);
});
