import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryActions } from '../../js/ui/library-view.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const mk = (over = {}) => {
  const ops = [];
  const app = {
    todayKey: '2026-11-25', rerendered: 0, rerender() { this.rerendered++; }, refresh: async () => {},
    snapshot: { exercises: [{ id: 'a', name: 'Squat', muscle_group: 'quads', equipment: 'barbell', how_to: '', is_custom: false, archived: false }], routineItems: [] },
    ctx: { outbox: { async enqueue(op) { if (over.fail) throw new Error('x'); ops.push(op); }, async flush() {} }, backend: { select: async () => over.rows ?? [] } },
    gym: { draft: () => null, index: () => (over.noIndex ? null : { exercises: {} }) },
  };
  return { app, ops, act: libraryActions(app, { newId: () => 'new-1' }) };
};

test('create: optimistic, validated row, Saved.', async () => {
  const { app, ops, act } = mk();
  const r = await act.save(null, { name: 'Cable Pull', muscle_group: 'back', equipment: 'cable', how_to: '' });
  assert.equal(r.ok, true);
  assert.equal(app.snapshot.exercises.length, 2);
  assert.equal(ops[0].table, 'exercises');
  assert.equal(ops[0].rows[0].id, 'new-1');
  assert.equal(ops[0].rows[0].is_custom, true);
  assert.equal(act.ui.notice, 'Saved.');
});

test('invalid or duplicate form: nothing written, no mutation', async () => {
  const { app, ops, act } = mk();
  assert.deepEqual(await act.save(null, { name: 'squat', muscle_group: 'quads' }), { ok: false, error: 'Name already used' });
  assert.deepEqual(await act.save(null, { name: 'a'.repeat(61), muscle_group: 'quads' }), { ok: false, error: 'Name too long' });
  assert.equal(ops.length, 0);
  assert.equal(app.snapshot.exercises.length, 1);
});

test('edit keeps own name (selfId) and is_custom; rollback on failed write', async () => {
  const { app, ops, act } = mk({ fail: true });
  const r = await act.save('a', { name: 'Squat', muscle_group: 'quads', equipment: 'barbell', how_to: 'Brace.' });
  assert.equal(r.ok, true);
  await tick();
  assert.equal(ops.length, 0);
  assert.equal(app.snapshot.exercises[0].how_to, '', 'rolled back');
  assert.match(act.ui.notice, /Could not save/);
});

test('archive toggles via full row', async () => {
  const { app, ops, act } = mk();
  await act.setArchived('a', true);
  assert.equal(app.snapshot.exercises[0].archived, true);
  assert.equal(ops[0].rows[0].archived, true);
  assert.equal(ops[0].rows[0].name, 'Squat');
});

test('delete: refused when not allowed, index missing, or server shows history; else removes', async () => {
  let m = mk({ noIndex: true });
  assert.equal((await m.act.remove('a')).ok, false);
  assert.equal(m.ops.length, 0);
  m = mk(); m.app.snapshot.routineItems = [{ exercise_id: 'a' }];
  assert.equal((await m.act.remove('a')).ok, false);
  m = mk({ rows: [{ id: 'we' }] });
  assert.equal((await m.act.remove('a')).ok, false);
  assert.equal(m.app.snapshot.exercises.length, 1);
  m = mk();
  assert.equal((await m.act.remove('a')).ok, true);
  assert.equal(m.app.snapshot.exercises.length, 0);
  assert.deepEqual(m.ops[0], { kind: 'remove', table: 'exercises', eq: { id: 'a' } });
});

import { focusTarget } from '../../js/ui/library-view.js';

test('focusTarget: the row if it is still listed, else + New, else the search field, else null', () => {
  const has = (...keys) => (k) => keys.includes(k);
  assert.equal(focusTarget('a', has('a', '__new', '__search')), 'a');
  assert.equal(focusTarget('a', has('__new', '__search')), '__new', 'archived row filtered out');
  assert.equal(focusTarget(null, has('__new', '__search')), '__new');
  assert.equal(focusTarget('a', has('__search')), '__search');
  assert.equal(focusTarget('a', has()), null);
  assert.equal(focusTarget('__new', has('__new')), '__new');
});
