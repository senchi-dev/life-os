// App shell: router, context, lifecycle. No work at import time so it can be unit tested in node.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createMemoryBackend } from './data/backend-memory.js';
import { createSupabaseBackend } from './data/backend-supabase.js';
import { createOutbox, createMemoryStorage } from './data/outbox.js';
import { createIdbStorage } from './data/idb.js';
import { demoSeed } from './data/demo-seed.js';
import { loadSnapshot } from './data/repo.js';
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

export async function boot() {
  const root = document.getElementById('view');
  const banner = document.getElementById('banner');
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
  const outbox = createOutbox({ backend, storage });
  await outbox.init();
  const ctx = { backend, outbox };

  const setBanner = (text) => { banner.textContent = text ?? ''; banner.hidden = !text; };

  const app = {
    ctx, client, demo,
    snapshot: null,
    todayKey: localDateKey(new Date()),
    async refresh() {
      app.todayKey = localDateKey(new Date());
      try {
        app.snapshot = await loadSnapshot(ctx, app.todayKey);
        setBanner(demo ? 'Demo mode: sample data, nothing is saved.' : null);
      } catch {
        setBanner('Could not load data.');
      }
      app.rerender();
    },
    rerender() {
      const route = routeFor(location.hash);
      for (const a of document.querySelectorAll('.tabbar a')) {
        if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      VIEWS[route](root, app);
    },
  };

  if (demo) setBanner('Demo mode: sample data, nothing is saved.');

  app.rerender(); // paint the shell first, data follows
  addEventListener('hashchange', () => { app.rerender(); root.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  addEventListener('online', () => { outbox.flush().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    outbox.flush().catch(() => {});
    if (localDateKey(new Date()) !== app.todayKey) app.refresh();
  });
  await app.refresh();
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') boot();
