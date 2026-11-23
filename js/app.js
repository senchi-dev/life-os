// App shell: router, context, lifecycle. No work at import time so it can be unit tested in node.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createMemoryBackend } from './data/backend-memory.js';
import { createSupabaseBackend } from './data/backend-supabase.js';
import { createOutbox, createMemoryStorage } from './data/outbox.js';
import { createIdbStorage } from './data/idb.js';
import { demoSeed } from './data/demo-seed.js';
import { loadSnapshot, ensureDefaults } from './data/repo.js';
import { BackendError } from './data/backend-supabase.js';
import { authGate, shouldClearOutbox } from './lib/auth-gate.js';
import { createAuthRecovery } from './lib/auth-recovery.js';
import { loadFirst, createResume } from './lib/boot-seed.js';
import { renderAuth } from './ui/auth-view.js';
import { h } from './ui/dom.js';
import { localDateKey } from './lib/dates.js';
import { renderMore, resetMore } from './ui/more-view.js';
import { renderReview } from './ui/review-view.js';
import { renderCalendar } from './ui/calendar-view.js';
import { renderToday } from './ui/today-view.js';

const ROUTES = ['today', 'calendar', 'review', 'more'];
const VIEWS = { today: renderToday, calendar: renderCalendar, review: renderReview, more: renderMore };

export function isDemoAllowed(loc) {
  return ['localhost', '127.0.0.1'].includes(loc.hostname) && /(^|[?&])demo(=|&|$)/.test(loc.search ?? '');
}

export function routeFor(hash) {
  const r = String(hash ?? '').replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTES.includes(r) ? r : 'today';
}

export { authGate };

// Global sign-out, then the same local cleanup as any other sign-out. If the global call fails
// (offline), the local session is still dropped and the error is rethrown so the caller can say so.
export async function signOutEverywhere(app) {
  let failure = null;
  try {
    const { error } = (await app.client.auth.signOut({ scope: 'global' })) ?? {};
    if (error) failure = error;
  } catch (e) {
    failure = e;
  }
  if (failure) {
    try { await app.client.auth.signOut({ scope: 'local' }); } catch { /* local state is cleared below */ }
  }
  await app.toLogin();
  if (failure) throw failure;
}

// Local sign-out: drop this device's session, then the same cleanup (outbox cleared, login screen).
export async function signOutLocal(app) {
  try { await app.client.auth.signOut({ scope: 'local' }); } catch { /* local state is cleared below */ }
  await app.toLogin();
}

export async function boot() {
  const root = document.getElementById('view');
  const banner = document.getElementById('banner');
  const setBanner = (text) => { banner.textContent = text ?? ''; banner.hidden = !text; };
  try {
    await start(root, setBanner);
  } catch {
    // Never leave a blank page: calm banner plus a visible way forward.
    document.body.dataset.mode = 'auth';
    setBanner('Could not start the app.');
    root.replaceChildren(
      h('section', { class: 'auth' },
        h('div', { class: 'auth-body' },
          h('h1', {}, 'Life OS'),
          h('p', { class: 'muted' }, 'Reload to try again. Your data is safe on the server.')),
        h('button', { type: 'button', class: 'tap primary', onClick: () => location.reload() }, 'Reload')),
    );
  }
}

async function start(root, setBanner) {
  const demo = isDemoAllowed(location);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }

  let client = null, backend, storage;
  if (demo) {
    backend = createMemoryBackend(demoSeed(localDateKey(new Date())));
    storage = createMemoryStorage();
  } else {
    client = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    backend = createSupabaseBackend(client);
    storage = createIdbStorage();
  }
  let recovery = null;
  const outbox = createOutbox({ backend, storage, onAuthError: () => recovery?.handleAuthFailure() });
  await outbox.init();
  const ctx = { backend, outbox };

  const app = {
    ctx, client, demo,
    mode: 'login',
    snapshot: null,
    loadFailed: false,
    signOut: () => signOutLocal(app),
    signOutEverywhere: async () => {
      try {
        await signOutEverywhere(app);
      } catch {
        // Other devices may still be signed in: say so on the login screen instead of failing silently.
        await app.toLogin({ clear: false, notice: 'Signed out here only. Could not reach the server to sign out other devices; try again when online.' });
      }
    },
    todayKey: localDateKey(new Date()),
    async refresh() {
      if (app.mode !== 'app') return;
      app.todayKey = localDateKey(new Date());
      try {
        // First load of a session: flush the offline queue (capped) so it is not missing, seed defaults once.
        const snap = app.snapshot
          ? await loadSnapshotWithAuthRetry()
          : await loadFirst({ ctx, load: loadSnapshotWithAuthRetry, ensureDefaults, onLate: () => app.refresh() });
        if (app.mode !== 'app') return; // signed out while loading
        app.snapshot = snap;
        app.loadFailed = false;
        setBanner(demo ? 'Demo mode: sample data, nothing is saved.' : null);
      } catch (e) {
        if (e instanceof BackendError && e.kind === 'auth') return; // already routed to login
        app.loadFailed = true;
        setBanner('Could not load data.');
      }
      if (app.mode === 'app') app.rerender();
    },
    rerender() {
      if (app.mode !== 'app') return;
      const route = routeFor(location.hash);
      for (const a of document.querySelectorAll('.tabbar a')) {
        if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      root.dataset.view = route;
      VIEWS[route](root, app);
    },
    async toApp() {
      if (app.mode === 'app') return;
      app.mode = 'app';
      document.body.dataset.mode = 'app';
      setBanner(demo ? 'Demo mode: sample data, nothing is saved.' : null);
      app.rerender(); // paint the shell first, data follows
      await app.refresh();
    },
    async toLogin({ clear = true, notice = null } = {}) {
      app.mode = 'login';
      app.snapshot = null;
      app.loadFailed = false;
      resetMore();
      document.body.dataset.mode = 'auth';
      setBanner(notice);
      if (clear) try { await outbox.clear(); } catch { /* queue is dropped from memory either way */ }
      renderAuth(root, { client, onSignedIn: (session) => enqueue(() => (authGate('SIGNED_IN', session) === 'app' ? app.toApp() : undefined)) });
    },
  };

  // Auth transitions run one at a time, in order.
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };
  const apply = (event, session, error = null) => (event === 'SIGNED_OUT' && app.mode === 'login'
    ? undefined // already handled by toLogin (e.g. a recovery sign-out that kept the queue)
    : authGate(event, session) === 'app'
    ? app.toApp()
    : app.toLogin({
      clear: shouldClearOutbox({ event, error, session }),
      notice: error ? 'Could not check your session. Check your connection.' : null,
    }));

  recovery = createAuthRecovery({
    client,
    onLoggedOut: (opts) => app.toLogin(opts),
    onDeferred: () => { if (app.mode === 'app') setBanner('Could not check your session. Check your connection.'); },
    retryFlush: () => outbox.flush({ silentAuth: true }),
  });

  // Read path: one recovery attempt (refresh, flush retry); if recovered, retry the read once.
  async function loadSnapshotWithAuthRetry() {
    const isAuth = (e) => e instanceof BackendError && e.kind === 'auth';
    try {
      return await loadSnapshot(ctx, app.todayKey);
    } catch (e) {
      if (!isAuth(e) || !client) throw e;
      if ((await recovery.handleAuthFailure()) === 'recovered') {
        try { return await loadSnapshot(ctx, app.todayKey); } catch (e2) {
          if (!isAuth(e2)) throw e2;
        }
        try { await client.auth.signOut({ scope: 'local' }); } catch { /* fall through to login */ }
        await app.toLogin({ clear: false });
      }
      throw e;
    }
  }

  // A getSession that failed offline leaves the login screen with a notice; re-check when back online.
  let sessionDeferred = false;
  async function checkSession() {
    let session = null, error = null;
    try {
      const res = await client.auth.getSession();
      session = res?.data?.session ?? null;
      error = res?.error ?? null;
    } catch (e) { error = e ?? new Error('getSession failed'); }
    sessionDeferred = !!error;
    return { session, error };
  }
  async function recheckSession() {
    const { session, error } = await checkSession();
    if (error || app.mode !== 'login') return; // still offline: keep the screen (and the typed email) as is
    if (session) { await enqueue(() => apply('INITIAL_SESSION', session, null)); return; }
    try { await outbox.clear(); } catch { /* dropped from memory either way */ }
    setBanner(null);
  }
  const resume = createResume({
    getMode: () => app.mode, hasSnapshot: () => !!app.snapshot, isSessionDeferred: () => sessionDeferred,
    flush: () => outbox.flush(), refresh: () => app.refresh(), recheckSession,
  });

  addEventListener('hashchange', () => { app.rerender(); if (app.mode === 'app') { root.focus({ preventScroll: true }); window.scrollTo(0, 0); } });
  addEventListener('online', () => { resume.online(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || app.mode !== 'app') return;
    outbox.flush().catch(() => {});
    if (localDateKey(new Date()) !== app.todayKey) app.refresh();
    else resume.visible();
  });

  if (demo) {
    await app.toApp();
    return;
  }

  // Subscribe first; the callback only enqueues (never awaits client calls inside it).
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return; // handled by getSession below
    setTimeout(() => enqueue(() => apply(event, session)), 0);
  });
  const { session: initial, error: initialError } = await checkSession();
  await enqueue(() => apply('INITIAL_SESSION', initial, initialError));
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') boot();
