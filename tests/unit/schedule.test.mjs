import test from 'node:test';
import assert from 'node:assert/strict';
import { shortName, trainingCycle, nextRoutineId, todayHint, hintText, plannedRows, weekSessions,
  gymTargetPatch, defaultSlots } from '../../js/lib/schedule.js';

const routines = [
  { id: 'U', name: 'Day 1 - Upper Force', sort: 0, archived: false },
  { id: 'L', name: 'Day 2 - Lower', sort: 1, archived: false },
  { id: 'X', name: 'Old', sort: 2, archived: true },
];
const slots = [[1, 'U'], [2, 'L'], [3, null], [4, 'U'], [5, 'L'], [6, null], [7, null]]
  .map(([weekday, routine_id]) => ({ weekday, routine_id }));
// 2026-11-25 is a Wednesday
const WED = '2026-11-25';
const fin = (id, routine_id, day, extra = {}) => ({ id, routine_id, day, imported: false,
  started_at: `${day}T08:00:00Z`, ended_at: `${day}T09:10:00Z`, ...extra });

test('shortName', () => {
  assert.equal(shortName('Day 1 - Upper Force'), 'Upper Force');
  assert.equal(shortName('Day 2 - Lower'), 'Lower');
  assert.equal(shortName('Push'), 'Push');
  assert.equal(shortName('A - B - C'), 'C');
});

test('trainingCycle', () => {
  assert.deepEqual(trainingCycle(slots, routines), ['U', 'L', 'U', 'L']);
  assert.deepEqual(trainingCycle(slots.map((s) => (s.weekday === 2 ? { ...s, routine_id: null } : s)), routines), ['U', 'U', 'L']);
  assert.deepEqual(trainingCycle(slots.map((s) => (s.weekday === 5 ? { ...s, routine_id: 'X' } : s)), routines), ['U', 'L', 'U']);
  assert.deepEqual(trainingCycle([], routines), ['U', 'L']);
});

test('nextRoutineId on [U,L,U,L]', () => {
  const cycle = ['U', 'L', 'U', 'L'];
  const w = (...ids) => ids.map((r, i) => fin(`w${i}`, r, `2026-11-${String(10 + i).padStart(2, '0')}`));
  assert.equal(nextRoutineId({ cycle, workouts: [] }), 'U');
  assert.equal(nextRoutineId({ cycle, workouts: w('U') }), 'L');
  assert.equal(nextRoutineId({ cycle, workouts: w('U', 'L') }), 'U');
  assert.equal(nextRoutineId({ cycle, workouts: w('U', 'L', 'U') }), 'L');
  assert.equal(nextRoutineId({ cycle, workouts: w('U', null) }), 'L');
  assert.equal(nextRoutineId({ cycle, workouts: w('L') }), 'U');
  assert.equal(nextRoutineId({ cycle, workouts: w('U', 'Z') }), 'L');
  assert.equal(nextRoutineId({ cycle, workouts: [...w('U'), fin('act', 'L', '2026-11-20', { ended_at: null })] }), 'L');
  assert.equal(nextRoutineId({ cycle, workouts: [fin('i', 'U', '2026-11-10', { imported: true })] }), 'L');
  assert.equal(nextRoutineId({ cycle: [], workouts: w('U') }), null);
});

test('nextRoutineId on [A,B,A,C] disambiguates by previous', () => {
  const cycle = ['A', 'B', 'A', 'C'];
  const w = (...ids) => ids.map((r, i) => fin(`w${i}`, r, `2026-11-${String(10 + i).padStart(2, '0')}`));
  assert.equal(nextRoutineId({ cycle, workouts: w('C', 'A') }), 'B');
  assert.equal(nextRoutineId({ cycle, workouts: w('B', 'A') }), 'C');
});

test('todayHint and hintText', () => {
  const base = { slots, routines, workouts: [] };
  assert.deepEqual(todayHint({ ...base, todayKey: WED }), { kind: 'rest' });
  assert.deepEqual(todayHint({ ...base, todayKey: '2026-11-26' }), { kind: 'planned', name: 'Upper Force' });
  const two = [fin('a', 'U', '2026-11-23'), fin('b', 'L', '2026-11-24')];
  assert.deepEqual(todayHint({ ...base, workouts: two, todayKey: WED }), { kind: 'two-in-a-row' });
  assert.equal(todayHint({ slots: [], routines, workouts: [], todayKey: WED }), null);
  assert.equal(hintText({ kind: 'two-in-a-row' }), '2 days in a row · rest suggested');
  assert.equal(hintText({ kind: 'planned', name: 'Lower' }), 'Planned today: Lower');
  assert.equal(hintText({ kind: 'rest' }), 'Rest day planned');
  assert.equal(hintText(null), '');
});

test('plannedRows', () => {
  const rows = plannedRows({ slots, routines, workouts: [], todayKey: WED });
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  assert.equal(by['2026-11-26'].kind, 'planned');
  assert.equal(by['2026-11-26'].name, 'Upper Force');
  assert.equal(by['2026-11-27'].name, 'Lower');
  assert.equal(by['2026-11-28'], undefined);
  assert.equal(by['2026-11-29'], undefined);
  const done = plannedRows({ slots, routines, workouts: [fin('t', 'U', WED, { name: 'Day 1 - Upper Force' })], todayKey: WED });
  assert.deepEqual(done[0], { date: WED, kind: 'done', name: 'Upper Force', workoutId: 't', minutes: 70 });
});

test('weekSessions', () => {
  const workouts = [fin('a', 'U', '2026-11-23'), fin('b', 'L', '2026-11-24'),
    fin('i', 'U', '2026-11-25', { imported: true }), fin('old', 'U', '2026-11-20'),
    fin('act', 'L', '2026-11-25', { ended_at: null })];
  const r = weekSessions({ workouts, slots, todayKey: WED });
  assert.equal(r.done, 2);
  assert.equal(r.plan, 4);
  assert.deepEqual(r.dots.filter((d) => d.planned).map((d) => d.weekday), [1, 2, 4, 5]);
  assert.deepEqual(r.dots.filter((d) => d.done).map((d) => d.weekday), [1, 2]);
  assert.equal(weekSessions({ workouts: [], slots: [], todayKey: WED }).plan, 4);
});

test('gymTargetPatch', () => {
  const h = { id: 'h', schedule_kind: 'n_per_week', target_n: 3 };
  assert.deepEqual(gymTargetPatch(h, slots), { ...h, target_n: 4 });
  assert.equal(gymTargetPatch({ ...h, target_n: 4 }, slots), null);
  assert.equal(gymTargetPatch({ ...h, schedule_kind: 'daily' }, slots), null);
  assert.equal(gymTargetPatch(h, slots.map((s) => ({ ...s, routine_id: null }))), null);
});

test('defaultSlots', () => {
  assert.deepEqual(defaultSlots('u', 'l'), [
    { weekday: 1, routine_id: 'u' }, { weekday: 2, routine_id: 'l' }, { weekday: 3, routine_id: null },
    { weekday: 4, routine_id: 'u' }, { weekday: 5, routine_id: 'l' }, { weekday: 6, routine_id: null },
    { weekday: 7, routine_id: null }]);
});
