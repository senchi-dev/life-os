import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authGate, authMessage } from '../../js/lib/auth-gate.js';
import { authGate as appGate, signOutEverywhere } from '../../js/app.js';

test('authGate: SIGNED_OUT or no session means login', () => {
  assert.equal(authGate('SIGNED_OUT', { user: {} }), 'login');
  assert.equal(authGate('INITIAL_SESSION', null), 'login');
  assert.equal(authGate('TOKEN_REFRESHED', null), 'login');
  assert.equal(authGate('TOKEN_REFRESHED', { user: {} }), 'app');
  assert.equal(authGate('SIGNED_IN', { user: {} }), 'app');
  assert.equal(authGate('INITIAL_SESSION', undefined), 'login');
});

test('app.js exports the same gate', () => {
  assert.equal(appGate, authGate);
});

test('authMessage: exact user-facing strings, no account enumeration', () => {
  const rate = authMessage({ status: 429, message: 'x' }, 'send');
  assert.equal(rate, 'Too many codes requested. Wait a minute.');
  assert.equal(authMessage({ code: 'over_email_send_rate_limit' }, 'send'), rate);
  assert.equal(authMessage(new Error('email rate limit exceeded'), 'verify'), rate);
  assert.equal(authMessage({ status: 400, message: 'Token has expired or is invalid' }, 'verify'),
    'Code wrong or expired. Request a new one.');
  // unknown user and any other send failure look identical
  const generic = 'Could not send a code to this address.';
  assert.equal(authMessage({ status: 422, message: 'Signups not allowed for otp' }, 'send'), generic);
  assert.equal(authMessage({ status: 400, message: 'User not found' }, 'send'), generic);
  assert.equal(authMessage(null, 'send'), generic);
  assert.equal(authMessage(new TypeError('Failed to fetch'), 'send'), 'No connection. Check your network and try again.');
});

test('signOutEverywhere: global sign-out then local cleanup', async () => {
  const calls = [];
  const app = {
    client: { auth: { signOut: async (o) => { calls.push(o.scope); return { error: null }; } } },
    toLogin: async () => { calls.push('login'); },
  };
  await signOutEverywhere(app);
  assert.deepEqual(calls, ['global', 'login']);
});

test('signOutEverywhere: still cleans up locally when global fails, then rethrows', async () => {
  const calls = [];
  const app = {
    client: { auth: { signOut: async (o) => { calls.push(o.scope); if (o.scope === 'global') throw new Error('offline'); return { error: null }; } } },
    toLogin: async () => { calls.push('login'); },
  };
  await assert.rejects(() => signOutEverywhere(app), /offline/);
  assert.deepEqual(calls, ['global', 'local', 'login']);
});

test('signOutEverywhere: global error result also falls back to local', async () => {
  const calls = [];
  const app = {
    client: { auth: { signOut: async (o) => { calls.push(o.scope); return { error: o.scope === 'global' ? new Error('x') : null }; } } },
    toLogin: async () => { calls.push('login'); },
  };
  await assert.rejects(() => signOutEverywhere(app));
  assert.deepEqual(calls, ['global', 'local', 'login']);
});

import { shouldClearOutbox } from '../../js/lib/auth-gate.js';
test('shouldClearOutbox: only explicit sign-out or a clean "no session"', () => {
  assert.equal(shouldClearOutbox({ event: 'SIGNED_OUT', session: null, error: null }), true);
  assert.equal(shouldClearOutbox({ event: 'INITIAL_SESSION', session: null, error: new Error('net') }), false);
  assert.equal(shouldClearOutbox({ event: 'INITIAL_SESSION', session: null, error: null }), true);
  for (const event of ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN']) {
    assert.equal(shouldClearOutbox({ event, session: { user: {} }, error: null }), false, event);
  }
});
