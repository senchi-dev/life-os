import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWaterTarget, validateWeeklyPages, validateHabit, validateRitual, validateBook,
  parseChecklist, moveHabit, nextSort,
} from '../../js/lib/more-forms.js';

test('water target: 0.5 to 6, comma or dot', () => {
  assert.deepEqual(validateWaterTarget('3'), { value: 3, error: null });
  assert.deepEqual(validateWaterTarget('2,5'), { value: 2.5, error: null });
  assert.deepEqual(validateWaterTarget(' 6 '), { value: 6, error: null });
  assert.deepEqual(validateWaterTarget('0.5'), { value: 0.5, error: null });
  for (const bad of ['0.4', '6.1', '', 'abc', '-1', '1e2', null]) assert.ok(validateWaterTarget(bad).error, String(bad));
});

test('weekly pages: integer 0 to 5000', () => {
  assert.deepEqual(validateWeeklyPages('200'), { value: 200, error: null });
  assert.deepEqual(validateWeeklyPages('0'), { value: 0, error: null });
  assert.deepEqual(validateWeeklyPages('5000'), { value: 5000, error: null });
  for (const bad of ['5001', '-1', '1.5', '', 'x']) assert.ok(validateWeeklyPages(bad).error, bad);
});

test('habit form: name and coherent schedule', () => {
  assert.deepEqual(validateHabit({ name: ' Read ', kind: 'daily' }).value, { name: 'Read', schedule_kind: 'daily', weekdays: null, target_n: null });
  assert.deepEqual(validateHabit({ name: 'Maths', kind: 'weekdays', weekdays: [5, 1, 3, 3] }).value,
    { name: 'Maths', schedule_kind: 'weekdays', weekdays: [1, 3, 5], target_n: null });
  assert.deepEqual(validateHabit({ name: 'Gym', kind: 'n_per_week', targetN: '4' }).value,
    { name: 'Gym', schedule_kind: 'n_per_week', weekdays: null, target_n: 4 });
  assert.ok(validateHabit({ name: '', kind: 'daily' }).error);
  assert.ok(validateHabit({ name: 'x'.repeat(41), kind: 'daily' }).error);
  assert.equal(validateHabit({ name: 'x'.repeat(40), kind: 'daily' }).error, null);
  assert.ok(validateHabit({ name: 'A', kind: 'weekdays', weekdays: [] }).error);
  assert.ok(validateHabit({ name: 'A', kind: 'weekdays', weekdays: [8] }).error);
  assert.ok(validateHabit({ name: 'A', kind: 'n_per_week', targetN: '0' }).error);
  assert.ok(validateHabit({ name: 'A', kind: 'n_per_week', targetN: '8' }).error);
  assert.ok(validateHabit({ name: 'A', kind: 'n_per_week', targetN: '2.5' }).error);
  assert.ok(validateHabit({ name: 'A', kind: 'monthly' }).error);
});

test('checklist: one per line, trimmed, blanks dropped', () => {
  assert.deepEqual(parseChecklist(' a \n\n b\r\n   \nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseChecklist(''), []);
});

test('ritual form', () => {
  const ok = { name: 'Budget day', weekday: '7', time: '10:00', checklistText: 'One\nTwo' };
  assert.deepEqual(validateRitual(ok).value, { name: 'Budget day', weekday: 7, time: '10:00', checklist: ['One', 'Two'] });
  assert.ok(validateRitual({ ...ok, name: ' ' }).error);
  assert.ok(validateRitual({ ...ok, name: 'x'.repeat(41) }).error);
  assert.ok(validateRitual({ ...ok, weekday: '0' }).error);
  assert.ok(validateRitual({ ...ok, weekday: '8' }).error);
  assert.ok(validateRitual({ ...ok, time: '25:00' }).error);
  assert.ok(validateRitual({ ...ok, time: '9:00' }).error);
  assert.equal(validateRitual({ ...ok, time: '23:59' }).error, null);
  assert.equal(validateRitual({ ...ok, checklistText: Array(12).fill('a').join('\n') }).error, null);
  assert.ok(validateRitual({ ...ok, checklistText: Array(13).fill('a').join('\n') }).error);
  assert.ok(validateRitual({ ...ok, checklistText: 'x'.repeat(61) }).error);
  assert.equal(validateRitual({ ...ok, checklistText: 'x'.repeat(60) }).error, null);
});

test('book form: title required, pages optional positive integer', () => {
  assert.deepEqual(validateBook({ title: ' Dune ', author: ' Herbert ', pages: '412' }).value, { title: 'Dune', author: 'Herbert', total_pages: 412 });
  assert.deepEqual(validateBook({ title: 'Dune', author: '', pages: '' }).value, { title: 'Dune', author: null, total_pages: null });
  assert.ok(validateBook({ title: '', pages: '' }).error);
  assert.ok(validateBook({ title: 'x'.repeat(121), pages: '' }).error);
  assert.equal(validateBook({ title: 'x'.repeat(120), pages: '' }).error, null);
  for (const bad of ['0', '-3', '1.5', 'abc']) assert.ok(validateBook({ title: 'A', pages: bad }).error, bad);
});

test('moveHabit renumbers and returns only changed rows; edges are no-ops', () => {
  const hs = [{ id: 'a', sort: 0 }, { id: 'b', sort: 1 }, { id: 'c', sort: 1 }];
  assert.deepEqual(moveHabit(hs, 'c', -1), [{ id: 'b', sort: 2 }]);
  assert.deepEqual(moveHabit(hs, 'a', -1), []);
  assert.deepEqual(moveHabit(hs, 'c', 1), []);
  const clean = [{ id: 'a', sort: 0 }, { id: 'b', sort: 1 }, { id: 'c', sort: 2 }];
  assert.deepEqual(moveHabit(clean, 'a', 1), [{ id: 'b', sort: 0 }, { id: 'a', sort: 1 }]);
  assert.deepEqual(moveHabit(clean, 'zzz', 1), []);
});

test('nextSort goes after the existing ones', () => {
  assert.equal(nextSort([]), 0);
  assert.equal(nextSort([{ sort: 0 }, { sort: 3 }]), 4);
});

test('scheduleLabel and currentBookId', async () => {
  const { scheduleLabel, currentBookId } = await import('../../js/lib/more-forms.js');
  assert.equal(scheduleLabel({ schedule_kind: 'daily' }), 'Daily');
  assert.equal(scheduleLabel({ schedule_kind: 'n_per_week', target_n: 4 }), '4 per week');
  assert.equal(scheduleLabel({ schedule_kind: 'weekdays', weekdays: [1, 2, 3, 4, 5] }), 'Mon to Fri');
  assert.equal(scheduleLabel({ schedule_kind: 'weekdays', weekdays: [6, 2] }), 'Tue, Sat');
  assert.equal(currentBookId([{ id: 'a', started_on: '2026-01-01' }, { id: 'b', started_on: '2026-02-01' }, { id: 'c', started_on: '2026-03-01', finished_on: '2026-03-02' }]), 'b');
  assert.equal(currentBookId([]), null);
  assert.equal(currentBookId([{ id: 'a', started_on: '2026-01-01' }, { id: 'b', started_on: '2026-02-01' }], { current_book_id: 'a' }), 'a');
  assert.equal(currentBookId([{ id: 'a', started_on: '2026-02-01', created_at: '1' }, { id: 'b', started_on: '2026-02-01', created_at: '2' }]), 'b');
});

import { signOutWarning } from '../../js/lib/more-forms.js';
import { readFileSync } from 'node:fs';

test('M2 signOutWarning: null when nothing would be lost; names the open workout and/or the unsynced count', () => {
  assert.equal(signOutWarning({ hasDraft: false, pending: 0 }), null);
  assert.equal(signOutWarning({}), null);
  assert.equal(signOutWarning({ hasDraft: false, pending: -1 }), null);
  assert.equal(signOutWarning({ hasDraft: true, pending: 0 }), 'A workout is open. Sign out anyway? It will be lost.');
  assert.equal(signOutWarning({ hasDraft: false, pending: 1 }), '1 change is not synced yet. Sign out anyway? It will be lost.');
  assert.equal(signOutWarning({ hasDraft: false, pending: 3 }), '3 changes are not synced yet. Sign out anyway? They will be lost.');
  assert.equal(signOutWarning({ hasDraft: true, pending: 2 }), 'A workout is open and 2 changes are not synced yet. Sign out anyway? They will be lost.');
});

test('M2 wiring: both sign-out buttons go through the warning sheet before signing out', () => {
  const src = readFileSync(new URL('../../js/ui/more-view.js', import.meta.url), 'utf8');
  const acc = src.slice(src.indexOf('function accountBody'), src.indexOf('// ---- Runbook'));
  assert.match(acc, /signOutWarning\(\{ hasDraft: !!app\.gym\?\.draft\(\), pending: app\.ctx\?\.outbox\?\.pending\(\) \?\? 0 \}\)/);
  assert.match(acc, /guarded\(\(\) => app\.signOut\(\)\)/);
  assert.match(acc, /guarded\(\(\) => app\.signOutEverywhere\(\)\)/);
  assert.doesNotMatch(acc, /run\(\(\) => app\.signOut(Everywhere)?\(\)\)/, 'no direct sign-out');
  assert.match(acc, /class: 'danger'/);
  assert.match(acc, /Sign out anyway/);
});
