export const THEME_KEY = 'lifeos-theme';
const VALID = ['dark', 'light', 'system'];

export function readTheme(storage) {
  try {
    const v = storage.getItem(THEME_KEY);
    return VALID.includes(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function writeTheme(storage, value) {
  try {
    storage.setItem(THEME_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function applyTheme(el, value) {
  el.dataset.theme = value;
}

export function themeColor(value, prefersLight) {
  const light = value === 'light' || (value === 'system' && prefersLight);
  return light ? '#f5f6f7' : '#0b0c0e';
}

// The applied attribute wins (works when storage is blocked); storage, then default, otherwise.
export function currentTheme(el, storage) {
  const v = el?.dataset?.theme;
  return VALID.includes(v) ? v : readTheme(storage);
}

export function applyThemeColor(doc, color) {
  for (const m of doc.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', color);
}

// While the theme is "system", follow OS light/dark changes. No-op without matchMedia support.
export function watchSystemTheme(mq, getTheme, onColor) {
  if (!mq || typeof mq.addEventListener !== 'function') return;
  mq.addEventListener('change', () => {
    const t = getTheme();
    if (t === 'system') onColor(themeColor(t, mq.matches));
  });
}
