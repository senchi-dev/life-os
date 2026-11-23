// App shell: router, context, lifecycle. No work at import time so it can be unit tested in node.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createMemoryBackend } from './data/backend-memory.js';
import { createSupabaseBackend } from './data/backend-supabase.js';
import { createOutbox, createMemoryStorage } from './data/outbox.js';
import { createIdbStorage } from './data/idb.js';
import { demoSeed } from './data/demo-seed.js';
import { loadSnapshot } from './data/repo.js';
import { BackendError } from './data/backend-supabase.js';
import { authGate, shouldClearOutbox } from './lib/auth-gate.js';
import { createAuthRecovery } from './lib/auth-recovery.js';
import { renderAuth } from './ui/auth-view.js';
import { h } from './ui/dom.js';
import { localDateKey } from './lib/dates.js';
import { renderToday, renderCalendar, renderReview, renderMore } from './views/placeholder.js';

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
    todayKey: localDateKey(new Date()),
    async refresh() {
      if (app.mode !== 'app') return;
      app.todayKey = localDateKey(new Date());
      try {
        app.snapshot = await loadSnapshotWithAuthRetry();
        setBanner(demo ? 'Demo mode: sample data, nothing is saved.' : null);
      } catch (e) {
        if (e instanceof BackendError && e.kind === 'auth') return; // already routed to login
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
      document.body.dataset.mode = 'auth';
      setBanner(notice);
      if (clear) try { await outbox.clear(); } catch { /* queue is dropped from memory either way */ }
      renderAuth(root, { client, onSignedIn: (session) => enqueue(() => (authGate('SIGNED_IN', session) === 'app' ? app.toApp() : undefined)) });
    },
  };

  // Auth transitions run one at a time, in order.
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };
  const apply = (event, session, error = null) => (authGate(event, session) === 'app'
    ? app.toApp()
    : app.toLogin({
      clear: shouldClearOutbox({ event, error, session }),
      notice: error ? 'Could not check your session. Check your connection.' : null,
    }));

  recovery = createAuthRecovery({
    client,
    onLoggedOut: () => app.toLogin(),
    retryFlush: () => outbox.flush(),
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
        await app.toLogin();
      }
      throw e;
    }
  }

  addEventListener('hashchange', () => { app.rerender(); if (app.mode === 'app') { root.focus({ preventScroll: true }); window.scrollTo(0, 0); } });
  addEventListener('online', () => { if (app.mode === 'app') outbox.flush().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || app.mode !== 'app') return;
    outbox.flush().catch(() => {});
    if (localDateKey(new Date()) !== app.todayKey) app.refresh();
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
  let initial = null, initialError = null;
  try {
    const res = await client.auth.getSession();
    initial = res?.data?.session ?? null;
    initialError = res?.error ?? null;
  } catch (e) { initialError = e ?? new Error('getSession failed'); }
  await enqueue(() => apply('INITIAL_SESSION', initial, initialError));
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') boot();
