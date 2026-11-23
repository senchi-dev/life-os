import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDemoAllowed, routeFor } from '../../js/app.js';

test('isDemoAllowed only on localhost with ?demo', () => {
  assert.equal(isDemoAllowed({ hostname: 'localhost', search: '?demo' }), true);
  assert.equal(isDemoAllowed({ hostname: '127.0.0.1', search: '?demo' }), true);
  assert.equal(isDemoAllowed({ hostname: 'someone.github.io', search: '?demo' }), false);
  assert.equal(isDemoAllowed({ hostname: 'localhost', search: '' }), false);
});

test('routeFor maps hashes and falls back to today', () => {
  assert.equal(routeFor('#/review'), 'review');
  assert.equal(routeFor('#/calendar'), 'calendar');
  assert.equal(routeFor('#/more'), 'more');
  assert.equal(routeFor(''), 'today');
  assert.equal(routeFor('#/nope'), 'today');
});
