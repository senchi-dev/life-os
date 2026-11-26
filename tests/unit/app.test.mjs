import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDemoAllowed, routeFor, routeParts, mountView } from '../../js/app.js';

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

test('routeFor knows the gym routes, nested paths and queries', () => {
  assert.equal(routeFor('#/gym'), 'gym');
  assert.equal(routeFor('#/gym/routine/x'), 'gym');
  assert.equal(routeFor('#/workout'), 'workout');
  assert.equal(routeFor('#/exercise/abc?from=gym'), 'exercise');
  assert.equal(routeFor('#/gymnastics'), 'today');
});

test('routeParts splits the hash into segments', () => {
  assert.deepEqual(routeParts('#/gym/routine/abc'), ['gym', 'routine', 'abc']);
  assert.deepEqual(routeParts('#/exercise/abc?from=gym'), ['exercise', 'abc']);
  assert.deepEqual(routeParts('#/today'), ['today']);
  assert.deepEqual(routeParts('#/'), []);
  assert.deepEqual(routeParts(''), []);
  assert.deepEqual(routeParts(undefined), []);
});

test('mountView calls the previous view cleanup exactly once when switching, before the next render', () => {
  const log = [];
  const views = {
    a: () => { log.push('render a'); return () => log.push('cleanup a'); },
    b: () => { log.push('render b'); },
  };
  const host = {};
  mountView(host, 'a', 'ROOT', 'APP', views);
  assert.deepEqual(log, ['render a']);
  mountView(host, 'b', 'ROOT', 'APP', views);
  assert.deepEqual(log, ['render a', 'cleanup a', 'render b']);
  mountView(host, 'b', 'ROOT', 'APP', views);
  assert.deepEqual(log, ['render a', 'cleanup a', 'render b', 'render b'], 'cleanup is not called twice, non-function results are ignored');
});

test('mountView passes root and app to the view and survives a throwing cleanup', () => {
  const seen = [];
  const views = { a: () => () => { throw new Error('boom'); }, b: (root, app) => { seen.push([root, app]); } };
  const host = {};
  mountView(host, 'a', 'R', 'A', views);
  assert.doesNotThrow(() => mountView(host, 'b', 'R', 'A', views));
  assert.deepEqual(seen, [['R', 'A']]);
});
