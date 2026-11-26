export const LAYOUT_KEY = 'lifeos-layout';
export const LAYOUTS = ['list', 'tiles', 'big'];

export function readLayout(storage) {
  try {
    const v = storage.getItem(LAYOUT_KEY);
    return LAYOUTS.includes(v) ? v : 'list';
  } catch {
    return 'list';
  }
}

export function writeLayout(storage, value) {
  if (!LAYOUTS.includes(value)) return false;
  try {
    storage.setItem(LAYOUT_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function applyLayout(el, value) {
  el.dataset.layout = value;
}

// The applied attribute wins (works when storage is blocked); storage, then default, otherwise.
export function currentLayout(el, storage) {
  const v = el?.dataset?.layout;
  return LAYOUTS.includes(v) ? v : readLayout(storage);
}
