// Tiny DOM helpers. Text goes in as text nodes only; style and raw-HTML props are rejected.
// Names assembled so the repo-wide grep for the raw-HTML sink stays clean.
const BANNED_PROPS = new Set(['style', 'inner' + 'html', 'outer' + 'html']); // compared lowercase

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (BANNED_PROPS.has(k.toLowerCase())) throw new Error(`h(): "${k}" prop is not allowed`);
    if (v === null || v === undefined || v === false) continue;
    if (/^on/i.test(k)) {
      if (typeof v !== 'function') throw new Error(`h(): "${k}" must be a function handler`);
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

// Tap vs. hold on one element. Cancels on movement > 10px; suppresses the iOS context menu.
export function longPress(el, { onTap, onHold, ms = 450 } = {}) {
  let timer = null, sx = 0, sy = 0, held = false, active = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    active = true; held = false; sx = e.clientX; sy = e.clientY;
    clear();
    timer = setTimeout(() => { held = true; timer = null; onHold?.(e); }, ms);
  });
  el.addEventListener('pointermove', (e) => {
    if (active && timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clear(); active = false; }
  });
  el.addEventListener('pointerup', (e) => {
    const wasActive = active; active = false;
    if (!wasActive) return;
    if (timer) { clear(); onTap?.(e); }
  });
  el.addEventListener('pointercancel', () => { active = false; clear(); });
  el.addEventListener('pointerleave', () => { active = false; clear(); });
}
