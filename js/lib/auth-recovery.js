// Auth failure recovery, injectable for tests. Refresh once. On success retry the flush once (silently:
// a second auth failure must not re-trigger recovery) and log out if it still fails. A network-kind
// refresh failure defers: session and queue are kept. Logged-out paths never clear the offline queue
// (clear:false) so unsynced writes replay after the next login. One run per cooldown after a failure.
import { classifyError } from '../data/backend-supabase.js';

export function createAuthRecovery({ client, onLoggedOut, onDeferred, retryFlush, now = Date.now, cooldownMs = 30000 }) {
  let inflight = null;
  let lastFail = null; // { at, result }

  async function logout() {
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* handled below */ }
    await onLoggedOut?.({ clear: false });
    return 'logged-out';
  }

  async function run() {
    let session = null, err = null;
    try {
      const res = (await client.auth.refreshSession()) ?? {};
      session = res.data?.session ?? null;
      err = res.error ?? null;
    } catch (e) { err = e ?? new Error('refresh failed'); }

    if (!err && session) {
      let res = null;
      try { res = await retryFlush?.(); } catch { /* ops stay queued */ }
      if (res?.authStop) return logout(); // still unauthorized after a fresh token: stop, do not loop
      return 'recovered';
    }
    if (err && (err.kind ?? classifyError(err)) !== 'auth') {
      await onDeferred?.(); // offline or server trouble: keep session and queue
      return 'deferred';
    }
    return logout();
  }

  return {
    handleAuthFailure() {
      if (inflight) return inflight;
      if (lastFail && now() - lastFail.at < cooldownMs) return Promise.resolve(lastFail.result);
      inflight = run()
        .then((result) => { if (result !== 'recovered') lastFail = { at: now(), result }; return result; })
        .finally(() => { inflight = null; });
      return inflight;
    },
  };
}
