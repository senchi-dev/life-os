import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateKey, addDays, daysBetween, isoWeekday, weekStart,
  hhmmToMinutes, minutesToHHMM, formatDayLabel,
} from '../../js/lib/dates.js';

test('localDateKey uses local time, not UTC', () => {
  assert.equal(localDateKey(new Date(2026, 10, 23, 0, 30)), '2026-11-23');
  assert.equal(localDateKey(new Date(2026, 10, 22, 23, 59)), '2026-11-22');
});
test('addDays crosses DST and month ends', () => {
  assert.equal(addDays('2026-03-28', 1), '2026-03-29');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});
test('daysBetween is DST-safe', () => assert.equal(daysBetween('2026-03-25', '2026-04-01'), 7));
test('isoWeekday / weekStart', () => {
  assert.equal(isoWeekday('2026-11-23'), 1);
  assert.equal(isoWeekday('2026-11-29'), 7);
  assert.equal(weekStart('2026-11-29'), '2026-11-23');
  assert.equal(weekStart('2026-11-23'), '2026-11-23');
});
test('HH:MM conversions', () => {
  assert.equal(hhmmToMinutes('07:55'), 475);
  assert.equal(minutesToHHMM(1440 + 40), '00:40');
  assert.equal(minutesToHHMM(-20), '23:40');
});
test('formatDayLabel', () => assert.equal(formatDayLabel('2026-11-23'), 'Mon 23 Nov'));
