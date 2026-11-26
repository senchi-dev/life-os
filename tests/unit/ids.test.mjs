import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedId, slug } from '../../js/lib/ids.js';

const U = '00000000-0000-0000-0000-00000000000a';

test('seedId reproduces the pinned vectors', async () => {
  assert.equal(await seedId(U, 'bench-press'), '048435f3-8745-81e3-9c32-374df0cc9a5c');
  assert.equal(await seedId(U, 'strive:routine_logs:1'), '0f4d227f-308c-8c90-b9da-fb1b1c522a7d');
  assert.equal(await seedId('demo-user', 'bench-press'), 'a0e378aa-f8aa-8653-a4e0-2934867a9965');
});

test('seedId is a v8-style uuid and differs per user and key', async () => {
  const id = await seedId(U, 'x');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, await seedId(U, 'y'));
  assert.notEqual(id, await seedId('other', 'x'));
});

test('slug', () => {
  assert.equal(slug('Bench Press'), 'bench-press');
  assert.equal(slug('EZ-bar Curl'), 'ez-bar-curl');
  assert.equal(slug('Chest-supported Row'), 'chest-supported-row');
  assert.equal(slug('Exécution  ok!'), 'execution-ok');
});
