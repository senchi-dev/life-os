// Apply a new app version on the first open after a deploy.
// When a new service worker takes control (controllerchange), reload once so the page runs the new code.
// Never on the first install (no controller at boot), and never under someone's fingers: while a field
// has focus the reload waits until the app is hidden (switched away or closed).

export function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function watchSwUpdate(sw, doc, reload) {
  if (!sw || typeof sw.addEventListener !== 'function') return;
  const hadController = !!sw.controller;
  let pending = false;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
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
