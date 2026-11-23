import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthRecovery } from '../../js/lib/auth-recovery.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';

function fakes({ refreshOk }) {
  const log = [];
  const client = { auth: {
    refreshSession: async () => { log.push('refresh'); await new Promise((r) => setTimeout(r, 5)); return refreshOk ? { data: { session: {} }, error: null } : { data: {}, error: new Error('x') }; },
    signOut: async (o) => { log.push('signOut:' + o.scope); return { error: null }; },
  } };
  return { log, client, onLoggedOut: async () => { log.push('loggedOut'); }, retryFlush: async () => { log.push('flush'); } };
}

test('recovered: refresh once, flush retried once', async () => {
  const f = fakes({ refreshOk: true });
  const r = createAuthRecovery(f);
  assert.equal(await r.handleAuthFailure(), 'recovered');
  assert.deepEqual(f.log, ['refresh', 'flush']);
});

test('refresh failure: local sign-out then onLoggedOut, no flush', async () => {
  const f = fakes({ refreshOk: false });
  const r = createAuthRecovery(f);
  assert.equal(await r.handleAuthFailure(), 'logged-out');
  assert.deepEqual(f.log, ['refresh', 'signOut:local', 'loggedOut']);
});

test('concurrent failures share one run', async () => {
  const f = fakes({ refreshOk: true });
  const r = createAuthRecovery(f);
  const [a, b] = await Promise.all([r.handleAuthFailure(), r.handleAuthFailure()]);
  assert.equal(a, 'recovered'); assert.equal(b, 'recovered');
  assert.equal(f.log.filter((x) => x === 'refresh').length, 1);
  await r.handleAuthFailure(); // a later failure starts a new run
  assert.equal(f.log.filter((x) => x === 'refresh').length, 2);
});

test('refresh failure does not drop queued ops (clear is the logged-out handler\'s job)', async () => {
  const storage = createMemoryStorage();
  let authErr = true;
  const backend = {
    upsert: async () => { if (authErr) throw Object.assign(new Error('jwt expired'), { kind: 'auth' }); },
    remove: async () => {},
  };
  let rec;
  const ob = createOutbox({ backend, storage, onAuthError: () => rec.handleAuthFailure() });
  await ob.init();
  await ob.enqueue({ kind: 'upsert', table: 't', rows: [{ a: 1 }] });
  const log = [];
  rec = createAuthRecovery({
    client: { auth: { refreshSession: async () => ({ data: {}, error: new Error('x') }), signOut: async () => { log.push('signOut'); return {}; } } },
    onLoggedOut: async () => { log.push('loggedOut'); log.push('pending:' + ob.pending()); },
  });
  await ob.flush();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log, ['signOut', 'loggedOut', 'pending:1']);
  assert.equal((await storage.load()).length, 1);
});

test('auth error on flush -> refresh once -> flush retried once', async () => {
  const storage = createMemoryStorage();
  let authErr = true, attempts = 0;
  const backend = {
    upsert: async () => { attempts++; if (authErr) throw Object.assign(new Error('jwt'), { kind: 'auth' }); },
    remove: async () => {},
  };
  let refreshes = 0, rec;
  const ob = createOutbox({ backend, storage, onAuthError: () => rec.handleAuthFailure() });
  await ob.init();
  await ob.enqueue({ kind: 'upsert', table: 't', rows: [{ a: 1 }] });
  rec = createAuthRecovery({
    client: { auth: { refreshSession: async () => { refreshes++; authErr = false; return { data: { session: {} }, error: null }; }, signOut: async () => ({}) } },
    onLoggedOut: async () => {},
    retryFlush: () => ob.flush(),
  });
  await ob.flush();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(refreshes, 1);
  assert.equal(attempts, 2);
  assert.equal(ob.pending(), 0);
});
