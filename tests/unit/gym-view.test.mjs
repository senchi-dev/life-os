import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewFor } from '../../js/ui/gym-view.js';

test('viewFor: known sub-routes', () => {
  assert.deepEqual(viewFor([]), { view: 'home' });
  assert.deepEqual(viewFor(undefined), { view: 'home' });
  assert.deepEqual(viewFor(['exercises']), { view: 'exercises' });
  assert.deepEqual(viewFor(['routine', 'new']), { view: 'routine', id: 'new' });
  assert.deepEqual(viewFor(['routine', 'abc-123']), { view: 'routine', id: 'abc-123' });
  assert.deepEqual(viewFor(['schedule']), { view: 'schedule' });
  assert.deepEqual(viewFor(['history', 'w1']), { view: 'history', id: 'w1' });
});

test('viewFor: prototype keys and unknown sub-routes render the Gym home', () => {
  for (const sub of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'nope', '', 'Routine']) {
    assert.deepEqual(viewFor([sub]), { view: 'home' }, sub);
    assert.deepEqual(viewFor([sub, 'x']), { view: 'home' }, `${sub}/x`);
  }
  assert.deepEqual(viewFor(['routine']), { view: 'home' }, 'routine without id');
  assert.deepEqual(viewFor(['history']), { view: 'home' }, 'history without id');
  assert.deepEqual(viewFor([null]), { view: 'home' });
  assert.deepEqual(viewFor([42]), { view: 'home' });
});
