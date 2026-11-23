import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, BackendError } from '../../js/data/backend-supabase.js';

test('classifyError', () => {
  assert.equal(classifyError({ status: 401 }), 'auth');
  assert.equal(classifyError({ status: 403 }), 'auth');
  assert.equal(classifyError({ code: 'PGRST301' }), 'auth');
  assert.equal(classifyError({ code: 'PGRST303' }), 'auth');
  assert.equal(classifyError({ message: 'JWT expired' }), 'auth');
  assert.equal(classifyError({ message: 'Invalid Refresh Token' }), 'auth');
  assert.equal(classifyError(new TypeError('Load failed')), 'network');
  assert.equal(classifyError(new TypeError('x')), 'network');
  assert.equal(classifyError(new Error('NetworkError when attempting to fetch')), 'network');
  assert.equal(classifyError({ code: '23514' }), 'server');
  assert.equal(classifyError(null), 'server');
});

test('BackendError carries kind and cause', () => {
  const e = new BackendError('network', 'm', 'c');
  assert.equal(e.kind, 'network');
  assert.equal(e.cause, 'c');
  assert.ok(e instanceof Error);
});
