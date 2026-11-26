// Tap guard for Start buttons: disabled while the start runs and after it succeeds (the screen is about to change);
// re-enabled when it fails, so the user can try again. Returns the start result, false on failure, null if ignored.
export async function guardedStart(btn, startFn) {
  if (btn.disabled) return null;
  btn.disabled = true;
  let ok = false;
  try { ok = !!(await startFn()); } catch { ok = false; }
  if (!ok) btn.disabled = false;
  return ok;
}
