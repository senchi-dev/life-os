// Apply a new app version on the first open after a deploy.
// When a new service worker takes control (controllerchange), reload once so the page runs the new code.
// Never on the first install (no controller at boot), and never under someone's fingers: while a field
// has focus the reload waits until the app is hidden (switched away or closed).
// Loop guard: at most one update reload per RELOAD_GAP_MS, remembered in sessionStorage, so two versions
// served by different CDN edges during a deploy can never bounce the app between them.

export const RELOAD_KEY = 'lifeos-sw-reloaded-at';
export const RELOAD_GAP_MS = 60_000;

export function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function lastReload(store) {
  try { return Number(store?.getItem(RELOAD_KEY)) || 0; } catch { return 0; }
}

function markReload(store, t) {
  try { store?.setItem(RELOAD_KEY, String(t)); } catch { /* storage blocked: reload anyway */ }
}

function sessionStore() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

export function watchSwUpdate(sw, doc, reload, { store = sessionStore(), now = () => Date.now() } = {}) {
  if (!sw || typeof sw.addEventListener !== 'function') return;
  const hadController = !!sw.controller;
  let pending = false;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    const t = now();
    if (t - lastReload(store) < RELOAD_GAP_MS) return;
    markReload(store, t);
    reload();
  };
  sw.addEventListener('controllerchange', () => {
    if (!hadController || done) return;
    if (doc.visibilityState === 'hidden' || !isTyping(doc.activeElement)) return go();
    if (pending) return;
    pending = true;
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') go();
    });
  });
}
