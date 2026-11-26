// Service worker: cache-first shell, network-only for Supabase. Bump CACHE on every shell change.
const CACHE = 'lifeos-v1-81';
// shell-hash: 9e3879fa16d298b69ad5887a00f337665623ff68c582d02b144fd516b78b7584
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'css/gym.css',
  'css/layouts.css',
  'css/calendar.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/config.js',
  'js/data/backend-memory.js',
  'js/data/backend-supabase.js',
  'js/data/demo-seed.js',
  'js/data/gym-repo.js',
  'js/data/gym-seed.js',
  'js/data/idb.js',
  'js/data/kv.js',
  'js/data/outbox.js',
  'js/data/repo.js',
  'js/data/tables.js',
  'js/lib/agenda.js',
  'js/lib/books.js',
  'js/lib/cal-items.js',
  'js/lib/cal-range.js',
  'js/lib/auth-gate.js',
  'js/lib/auth-recovery.js',
  'js/lib/boot-seed.js',
  'js/lib/crypto-export.js',
  'js/lib/dates.js',
  'js/lib/event-form.js',
  'js/lib/event-window.js',
  'js/lib/gym-forms.js',
  'js/lib/gym-index.js',
  'js/lib/gym-runtime.js',
  'js/lib/gym-stats.js',
  'js/lib/gym-validate.js',
  'js/lib/habits.js',
  'js/lib/health.js',
  'js/lib/ids.js',
  'js/lib/layout.js',
  'js/lib/sw-update.js',
  'js/lib/more-forms.js',
  'js/lib/review.js',
  'js/lib/rituals.js',
  'js/lib/schedule.js',
  'js/lib/score.js',
  'js/lib/snapshot-cache.js',
  'js/lib/strive-import.js',
  'js/lib/theme.js',
  'js/lib/ticker.js',
  'js/lib/timeline.js',
  'js/lib/workout-draft.js',
  'js/lib/workout.js',
  'js/ui/auth-view.js',
  'js/ui/blocks.js',
  'js/ui/cal-views.js',
  'js/ui/calendar-view.js',
  'js/ui/components.js',
  'js/ui/dom.js',
  'js/ui/exercise-view.js',
  'js/ui/gym-model.js',
  'js/ui/gym-view.js',
  'js/ui/history-model.js',
  'js/ui/history-view.js',
  'js/ui/library-view.js',
  'js/ui/loading.js',
  'js/ui/more-view.js',
  'js/ui/import-view.js',
  'js/ui/import-model.js',
  'js/ui/pager.js',
  'js/ui/review-view.js',
  'js/ui/routine-view.js',
  'js/ui/start-guard.js',
  'js/ui/today-model.js',
  'js/ui/today-view.js',
  'js/ui/workout-model.js',
  'js/ui/workout-view.js',
  'vendor/VERSIONS.md',
  'vendor/supabase.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // network-only, never cached
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((hit) => hit || fetch(req)));
    return;
  }
  if (url.origin === self.location.origin) {
    const scope = new URL(self.registration.scope).pathname;
    const path = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : '';
    if (SHELL.includes(path)) {
      e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    }
  }
  // everything else: browser default (network)
});
