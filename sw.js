// Service worker: cache-first shell, network-only for Supabase. Bump CACHE on every shell change.
const CACHE = 'lifeos-v1-7';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/config.js',
  'js/data/backend-memory.js',
  'js/data/backend-supabase.js',
  'js/data/demo-seed.js',
  'js/data/idb.js',
  'js/data/outbox.js',
  'js/data/repo.js',
  'js/data/tables.js',
  'js/lib/agenda.js',
  'js/lib/auth-gate.js',
  'js/lib/auth-recovery.js',
  'js/lib/crypto-export.js',
  'js/lib/dates.js',
  'js/lib/event-form.js',
  'js/lib/habits.js',
  'js/lib/health.js',
  'js/lib/review.js',
  'js/lib/rituals.js',
  'js/ui/auth-view.js',
  'js/ui/calendar-view.js',
  'js/ui/dom.js',
  'js/ui/today-model.js',
  'js/ui/today-view.js',
  'js/views/placeholder.js',
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
