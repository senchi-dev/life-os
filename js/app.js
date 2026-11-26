// App shell: router, context, lifecycle. No work at import time so it can be unit tested in node.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createMemoryBackend } from './data/backend-memory.js';
import { createSupabaseBackend } from './data/backend-supabase.js';
import { createOutbox, createMemoryStorage } from './data/outbox.js';
import { createIdbStorage, createIdbKv } from './data/idb.js';
import { createMemoryKv } from './data/kv.js';
import { demoSeed } from './data/demo-seed.js';
import { loadSnapshot, ensureDefaults } from './data/repo.js';
import { ensureGymDefaults } from './data/gym-repo.js';
import { BackendError } from './data/backend-supabase.js';
import { authGate, shouldClearOutbox } from './lib/auth-gate.js';
import { createAuthRecovery } from './lib/auth-recovery.js';
import { loadFirst, createResume } from './lib/boot-seed.js';
import { renderAuth } from './ui/auth-view.js';
import { h } from './ui/dom.js';
import { localDateKey } from './lib/dates.js';
import { renderMore, resetMore } from './ui/more-view.js';
import { renderReview } from './ui/review-view.js';
import { renderCalendar, resetCalendar } from './ui/calendar-view.js';
import { renderToday } from './ui/today-view.js';
import { renderGym } from './ui/gym-view.js';
import { renderExercise } from './ui/exercise-view.js';
import { renderWorkout, showGymNotice } from './ui/workout-view.js';
import { minibarText, needsStalePrompt } from './ui/workout-model.js';
import { createTicker } from './lib/ticker.js';
import { createGymRuntime } from './lib/gym-runtime.js';
import { refreshSnapshot, clearSnapshotCache } from './lib/snapshot-cache.js';
import { readTheme, applyTheme, themeColor, applyThemeColor, currentTheme, watchSystemTheme } from './lib/theme.js';
import { readLayout, applyLayout } from './lib/layout.js';
import { watchSwUpdate } from './lib/sw-update.js';

const ROUTES = ['today', 'gym', 'workout', 'exercise', 'calendar', 'review', 'more'];
const VIEWS = {
  today: renderToday, gym: renderGym, workout: renderWorkout, exercise: renderExercise,
  calendar: renderCalendar, review: renderReview, more: renderMore,
};
// Routes that highlight another tab (a workout or an exercise belongs to Gym).
const TAB_OF = { workout: 'gym', exercise: 'gym' };

export function isDemoAllowed(loc) {
  return ['localhost', '127.0.0.1'].includes(loc.hostname) && /(^|[?&])demo(=|&|$)/.test(loc.search ?? '');
}

export function routeFor(hash) {
  const r = String(hash ?? '').replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTES.includes(r) ? r : 'today';
}

// '#/gym/routine/abc?x=1' -> ['gym', 'routine', 'abc']
export function routeParts(hash) {
  return String(hash ?? '').replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
}

// Renders `route` into `root`, first running the cleanup the previous render returned (if it returned a function).
// `host` is the small record that remembers it between calls.
export function mountView(host, route, root, app, views) {
  const prev = host.cleanup;
  host.cleanup = null;
  if (typeof prev === 'function') {
    try { prev(); } catch { /* a failing cleanup must not block the next view */ }
  }
  const out = views[route](root, app);
  host.cleanup = typeof out === 'function' ? out : null;
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

  let themeStore = null;
  try { themeStore = localStorage; } catch { /* storage blocked: default theme */ }
  const theme = readTheme(themeStore);
  applyTheme(document.documentElement, theme);
  applyLayout(document.documentElement, readLayout(themeStore));
  const lightMq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  applyThemeColor(document, themeColor(theme, !!lightMq?.matches));
  watchSystemTheme(lightMq, () => currentTheme(document.documentElement, themeStore), (c) => applyThemeColor(document, c));

  if ('serviceWorker' in navigator) {
    watchSwUpdate(navigator.serviceWorker, document, () => location.reload());
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
  const pendingEl = document.getElementById('pending');
  const setPending = (n) => {
    if (!pendingEl) return;
    pendingEl.textContent = n > 0 ? `${n} pending` : '';
    pendingEl.hidden = !(n > 0);
  };
  const outbox = createOutbox({ backend, storage, onChange: (n) => setPending(n), onAuthError: () => recovery?.handleAuthFailure() });
  await outbox.init();
  const ctx = { backend, outbox };
  // Device key-value store (IndexedDB): gym draft/index and the offline snapshot copy. Wiped on sign-out.
  const kv = demo ? createMemoryKv() : createIdbKv();

  const viewHost = { cleanup: null };
  const minibar = document.getElementById('minibar');
  // One text node, repainted once a second while a draft exists and the workout screen is not open. The ticker is
  // idempotent (no second interval on a re-render) and stopped as soon as the bar hides.
  const minibarNode = document.createTextNode('');
  const minibarTicker = createTicker(() => {
    const d = app.gym?.draft();
    if (d) minibarNode.data = minibarText(d, Date.now());
  });
  const syncMinibar = (route = routeFor(location.hash)) => {
    if (!minibar) return;
    const draft = app.mode === 'app' ? app.gym?.draft() : null;
    // Today's docked Start bar already is the Resume bar there: one of the two, never both.
    const active = !!draft && route !== 'workout' && route !== 'today';
    minibar.hidden = !active;
    if (!active) {
      minibarTicker.stop();
      minibarNode.data = '';
      return;
    }
    minibar.setAttribute('aria-label', `Open workout ${draft.workout.name || ''}`.trim());
    if (minibarNode.parentNode !== minibar) minibar.replaceChildren(minibarNode);
    minibarTicker.start();
  };
  // Staleness is a function of now, so it is re-checked at boot, on every render, and when the app comes back to the
  // foreground. A stale draft sends the user to #/workout (blocking sheet). Returns true when it navigated.
  const checkStale = (route = routeFor(location.hash)) => {
    if (app.mode !== 'app' || !app.gymReady) return false;
    const draft = app.gym?.draft() ?? null;
    const ack = draft && app.staleAck?.workoutId === draft.workout.id ? app.staleAck.at : null;
    const verdict = needsStalePrompt({ draft, now: new Date().toISOString(), route, ackedAt: ack });
    app.gymStale = verdict !== null;
    if (verdict === 'navigate') { location.hash = '#/workout'; return true; }
    return false;
  };
  const app = {
    ctx, client, demo,
    gym: null,
    gymNotice: null,
    gymStale: false,
    staleAck: null, // { workoutId, at }: the user chose Resume on the stale prompt
    gymReady: false, // false until the first gym.init() settles: #/workout must not redirect before the draft is loaded
    lastHash: null, // the last route shown before the workout screen (Minimize goes back there)
    mode: 'login',
    snapshot: null,
    snapshotCached: false, // the snapshot is the offline copy from kv (first load failed): retried on the next refresh
    userId: null, // from the session: keys the offline snapshot cache
    epoch: 0, // bumped by toLogin: a cache write from before the sign-out removes itself
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
      const epoch = app.epoch;
      const stillValid = () => app.epoch === epoch && app.mode === 'app';
      try {
        // First load of a session (or the first live one after an offline boot): flush the offline queue (capped) so it
        // is not missing, seed defaults once. With no signal and no snapshot yet it falls back to the copy cached on this
        // device (I1). A failed load with a snapshot in memory throws and keeps it (offline edits are never reverted).
        const { snapshot: snap, fromCache: cached } = await refreshSnapshot({
          current: app.snapshot, currentCached: app.snapshotCached,
          loadFirst: () => loadFirst({ ctx, load: loadSnapshotWithAuthRetry, ensureDefaults, ensureGymDefaults, onLate: () => app.refresh() }),
          loadLive: loadSnapshotWithAuthRetry,
          kv, uid: app.userId, isAuthError: (e) => e instanceof BackendError && e.kind === 'auth', stillValid,
        });
        if (app.mode !== 'app') return; // signed out while loading
        const wasCached = app.snapshotCached;
        app.snapshot = snap;
        app.snapshotCached = cached;
        app.loadFailed = false;
        // init on the first snapshot, and again on the first live one after an offline boot (only a live snapshot can
        // tell that the draft was finished or deleted elsewhere).
        if (!app.gymReady || (wasCached && !cached)) {
          try {
            const g = await app.gym.init({ cached });
            if (g.notice) app.gymNotice = g.notice;
            app.gymStale = g.stale;
          } catch { /* the gym screens load their own state; Today must still render */ }
          app.gymReady = true;
        }
        app.gym.hideForgotten(app.snapshot, { cached }); // workouts deleted (or closed) here whose op is still queued: the server still returns them
        if (app.mode === 'app') app.gym.ensureIndex().catch(() => {}); // background: never blocks the refresh
        setBanner(demo ? 'Demo mode: sample data, nothing is saved.' : cached ? 'Offline: showing the data saved on this device.' : null);
      } catch (e) {
        if (e instanceof BackendError && e.kind === 'auth') return; // already routed to login
        if (app.snapshot) { setBanner(app.snapshotCached ? 'Offline: showing the data saved on this device.' : 'Could not load data.'); }
        else { app.loadFailed = true; setBanner('Could not load data.'); }
      }
      if (app.mode === 'app') app.rerender();
    },
    rerender() {
      if (app.mode !== 'app') return;
      const route = routeFor(location.hash);
      for (const a of document.querySelectorAll('.tabbar a')) {
        if (a.dataset.route === (TAB_OF[route] ?? route)) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      if (checkStale(route)) return; // hashchange renders the workout screen
      document.body.dataset.route = route;
      if (route !== 'workout') app.lastHash = location.hash || '#/today';
      root.dataset.view = route;
      mountView(viewHost, route, root, app, VIEWS);
      syncMinibar(route);
      showGymNotice(app); // a draft closed elsewhere is explained once, on whichever screen is open
    },
    async toApp(session = null) {
      if (session?.user?.id) app.userId = session.user.id;
      if (app.mode === 'app') return;
      app.mode = 'app';
      document.body.dataset.mode = 'app';
      setBanner(demo ? 'Demo mode: sample data, nothing is saved.' : null);
      app.rerender(); // paint the shell first, data follows
      await app.refresh();
    },
    async toLogin({ clear = true, notice = null } = {}) {
      app.mode = 'login';
      app.epoch++;
      app.snapshot = null;
      app.snapshotCached = false;
      app.userId = null;
      app.gymReady = false;
      app.loadFailed = false;
      resetMore();
      if (typeof viewHost.cleanup === 'function') { try { viewHost.cleanup(); } catch { /* ignore */ } }
      viewHost.cleanup = null;
      syncMinibar();
      document.body.dataset.mode = 'auth';
      setBanner(notice);
      if (clear) {
        // Queue, gym state and the offline snapshot copy go together; one failing must not leave the others behind.
        await Promise.allSettled([outbox.clear(), app.gym.clearAll(), clearSnapshotCache(kv)]);
        resetCalendar(); // fetched events and the open draft belong to the signed-out user
      }
      renderAuth(root, { client, onSignedIn: (session) => enqueue(() => (authGate('SIGNED_IN', session) === 'app' ? app.toApp(session) : undefined)) });
    },
  };

  app.gym = createGymRuntime({
    ctx, kv, getSnapshot: () => app.snapshot, onChange: () => syncMinibar(),
  });

  // Auth transitions run one at a time, in order.
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };
  const apply = (event, session, error = null) => (event === 'SIGNED_OUT' && app.mode === 'login'
    ? undefined // already handled by toLogin (e.g. a recovery sign-out that kept the queue)
    : authGate(event, session) === 'app'
    ? app.toApp(session)
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
    getMode: () => app.mode, hasSnapshot: () => !!app.snapshot && !app.snapshotCached, isSessionDeferred: () => sessionDeferred,
    flush: () => outbox.flush(), refresh: () => app.refresh(), recheckSession,
  });

  addEventListener('hashchange', () => { app.rerender(); if (app.mode === 'app') { root.focus({ preventScroll: true }); window.scrollTo(0, 0); } });
  addEventListener('online', () => { resume.online(); });
  // Back in the foreground (or restored from the page cache): a workout may have gone stale while away.
  const recheckStale = () => {
    if (app.mode !== 'app') return;
    const was = app.gymStale;
    if (!checkStale() && app.gymStale && !was) app.rerender(); // already on #/workout: open the sheet
  };
  addEventListener('pageshow', recheckStale);
  addEventListener('pagehide', () => { app.gym.flushDraft().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { app.gym.flushDraft().catch(() => {}); return; }
    if (document.visibilityState !== 'visible' || app.mode !== 'app') return;
    recheckStale();
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
