// Auth failure recovery, injectable for tests: refresh once; on success retry the flush once;
// on failure sign out locally and hand off to the logged-out handler (which clears local data).
export function createAuthRecovery({ client, onLoggedOut, retryFlush }) {
  let inflight = null;
  async function run() {
    let ok = false;
    try {
      const { data, error } = (await client.auth.refreshSession()) ?? {};
      ok = !error && !!data?.session;
    } catch { ok = false; }
    if (ok) {
      try { await retryFlush?.(); } catch { /* ops stay queued */ }
      return 'recovered';
    }
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* handled below */ }
    await onLoggedOut();
    return 'logged-out';
  }
  return {
    handleAuthFailure() {
      if (!inflight) inflight = run().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
