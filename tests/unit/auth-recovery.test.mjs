import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthRecovery } from '../../js/lib/auth-recovery.js';
import { createOutbox, createMemoryStorage } from '../../js/data/outbox.js';

function fakes({ refreshOk }) {
  const log = [];
  const client = { auth: {
    refreshSession: async () => { log.push('refresh'); await new Promise((r) => setTimeout(r, 5)); return refreshOk ? { data: { session: {} }, error: null } : { data: {}, error: Object.assign(new Error('Invalid Refresh Token'), { status: 400 }) }; },
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
    client: { auth: { refreshSession: async () => ({ data: {}, error: Object.assign(new Error('Invalid Refresh Token'), { status: 400 }) }), signOut: async () => { log.push('signOut'); return {}; } } },
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

// ---- fix round 2 ----
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function loopRig({ refresh }) {
  const log = [];
  const storage = createMemoryStorage();
  const backend = {
    upsert: async () => { log.push('apply'); throw Object.assign(new Error('forbidden'), { kind: 'auth' }); },
    remove: async () => {},
  };
  let rec, authCalls = 0;
  const ob = createOutbox({ backend, storage, onAuthError: () => { authCalls++; return rec.handleAuthFailure(); } });
  rec = createAuthRecovery({
    client: { auth: {
      refreshSession: async () => { log.push('refresh'); return refresh(); },
      signOut: async (o) => { log.push('signOut:' + o.scope); return {}; },
    } },
    onLoggedOut: async (o) => { log.push('loggedOut:' + JSON.stringify(o)); },
    onDeferred: () => { log.push('deferred'); },
    retryFlush: () => ob.flush({ silentAuth: true }),
  });
  return { log, ob, rec, storage, authCalls: () => authCalls };
}
const ok = () => ({ data: { session: {} }, error: null });

test('regression: refresh ok but retried flush auth-fails again -> no loop, logged out, queue kept', async () => {
  const t = loopRig({ refresh: ok });
  await t.ob.enqueue({ kind: 'upsert', table: 't', rows: [{ a: 1 }] });
  await t.ob.flush();
  await wait(100);
  assert.equal(t.log.filter((x) => x === 'refresh').length, 1);
  assert.equal(t.log.filter((x) => x === 'signOut:local').length, 1);
  assert.deepEqual(t.log.filter((x) => x.startsWith('loggedOut')), ['loggedOut:{"clear":false}']);
  assert.equal(t.authCalls(), 1);
  assert.equal(t.ob.pending(), 1);
  assert.equal((await t.storage.load()).length, 1);
});

test('refresh fails with a network error -> deferred, no sign-out, nothing cleared', async () => {
  const t = loopRig({ refresh: () => ({ data: {}, error: Object.assign(new Error('fetch failed'), { status: 0 }) }) });
  assert.equal(await t.rec.handleAuthFailure(), 'deferred');
  assert.deepEqual(t.log, ['refresh', 'deferred']);
  const t2 = loopRig({ refresh: () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(await t2.rec.handleAuthFailure(), 'deferred');
  assert.ok(!t2.log.some((x) => x.startsWith('signOut') || x.startsWith('loggedOut')));
});

test('refresh rejected as auth (or null session) -> logged-out, clear:false', async () => {
  const bad = loopRig({ refresh: () => ({ data: {}, error: Object.assign(new Error('Invalid Refresh Token'), { status: 400 }) }) });
  assert.equal(await bad.rec.handleAuthFailure(), 'logged-out');
  assert.deepEqual(bad.log, ['refresh', 'signOut:local', 'loggedOut:{"clear":false}']);
  const nul = loopRig({ refresh: () => ({ data: { session: null }, error: null }) });
  assert.equal(await nul.rec.handleAuthFailure(), 'logged-out');
});

test('cooldown: calls within 30s of a failure do not refresh again', async () => {
  let clock = 1000;
  let refreshes = 0;
  const rec = createAuthRecovery({
    client: { auth: { refreshSession: async () => { refreshes++; return { data: {}, error: Object.assign(new Error('Invalid Refresh Token'), { status: 400 }) }; }, signOut: async () => ({}) } },
    onLoggedOut: async () => {},
    now: () => clock,
  });
  assert.equal(await rec.handleAuthFailure(), 'logged-out');
  clock += 5000;
  assert.equal(await rec.handleAuthFailure(), 'logged-out');
  assert.equal(refreshes, 1);
  clock += 30000;
  await rec.handleAuthFailure();
  assert.equal(refreshes, 2);
});
