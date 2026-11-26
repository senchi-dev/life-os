// Last good snapshot, per user, on this device (IndexedDB kv in the browser, same store and trust level as the outbox).
// Reopening the app with no signal boots from it, so a workout in progress can be resumed and logged offline.
// Deleted on sign-out (toLogin clear branch). Stores the raw snapshot the app renders, nothing else.

export const SNAPSHOT_CACHE_PREFIX = 'snapshot-cache:';
export const snapshotCacheKey = (uid) => `${SNAPSHOT_CACHE_PREFIX}${uid}`;

// Copied at call time (the in-memory snapshot keeps being patched). `stillValid` is checked after the write: a save that
// lands after a sign-out started removes itself, so nothing of the user stays on the device.
export async function saveSnapshotCache(kv, uid, snapshot, { stillValid = () => true, now = () => new Date() } = {}) {
  const owner = snapshot?.settings?.user_id ?? null;
  if (!uid || !owner || owner !== uid) return false;
  const row = { v: 1, savedAt: now().toISOString(), snapshot: structuredClone(snapshot) };
  if (!stillValid()) return false;
  await kv.set(snapshotCacheKey(uid), row);
  if (!stillValid()) { await kv.del(snapshotCacheKey(uid)); return false; }
  return true;
}

export async function readSnapshotCache(kv, uid) {
  if (!uid) return null;
  const row = await kv.get(snapshotCacheKey(uid));
  if (!row || row.v !== 1 || !row.snapshot || row.snapshot.settings?.user_id !== uid) return null;
  return row.snapshot;
}

export const clearSnapshotCache = (kv) => kv.delPrefix(SNAPSHOT_CACHE_PREFIX);

// First load of a session. Success: cache it and return it. A non-auth failure (offline, server down) with a cache for
// this user: return the cached copy, marked fromCache so the app shows it as offline data and retries later.
export async function loadFirstOrCached({ load, kv, uid, isAuthError = () => false, stillValid, useCache = true }) {
  let snapshot;
  try {
    snapshot = await load();
  } catch (e) {
    if (isAuthError(e) || !useCache) throw e;
    let cached = null;
    try { cached = await readSnapshotCache(kv, uid); } catch { /* storage unavailable: same as no cache */ }
    if (!cached) throw e;
    return { snapshot: cached, fromCache: true };
  }
  try { await saveSnapshotCache(kv, uid ?? snapshot?.settings?.user_id, snapshot, { stillValid }); } catch { /* best effort */ }
  return { snapshot, fromCache: false };
}

// One app.refresh(): which snapshot to show. Throws when the load fails and nothing should replace the current snapshot
// (the caller then keeps app.snapshot as is).
export async function refreshSnapshot({ current, currentCached, loadFirst, loadLive, kv, uid, isAuthError, stillValid }) {
  if (!current || currentCached) {
    // The first-load path (flush, seed) until a live snapshot arrives. The cache is read only when there is no snapshot
    // yet: while running from it, the in-memory copy holds this session's offline edits and must not be reverted.
    return loadFirstOrCached({ load: loadFirst, kv, uid, isAuthError, stillValid, useCache: !current });
  }
  const snapshot = await loadLive();
  try { await saveSnapshotCache(kv, uid, snapshot, { stillValid }); } catch { /* best effort */ }
  return { snapshot, fromCache: false };
}
