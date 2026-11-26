// Start-of-session decisions, kept pure and injectable so they are testable in node:
//  - flush the offline queue (capped) before the first read, so queued writes are not missing from it
//  - seed defaults when, and only when, the settings row does not exist yet
//  - what online / resume should do (retry a failed first load, re-check a deferred session)

import { needsGymSeed } from '../data/gym-repo.js';

export const FLUSH_CAP_MS = 3000;

// Condition on the NULL settings row, never on empty rituals: deleting a ritual must not re-seed it.
export const needsSeed = (snapshot) => !!snapshot && snapshot.settings === null;

// Start a flush and wait for it, but never longer than capMs. Resolves to the number of ops sent
// (0 when the cap wins or the flush fails). onLate runs if a flush that missed the cap sends something.
export async function flushCapped(outbox, { capMs = FLUSH_CAP_MS, setTimer = setTimeout, clearTimer = clearTimeout, onLate } = {}) {
  let timer;
  const capped = new Promise((resolve) => { timer = setTimer(() => resolve('cap'), capMs); });
  let flush;
  try { flush = Promise.resolve(outbox.flush()).catch(() => null); } catch { flush = Promise.resolve(null); }
  try {
    const first = await Promise.race([flush, capped]);
    if (first === 'cap') {
      flush.then((r) => { if (r?.sent > 0) onLate?.(); }).catch(() => {});
      return 0;
    }
    return first?.sent ?? 0;
  } finally {
    clearTimer(timer);
  }
}

// First load of a session: flush (capped), read, then seed defaults once if the settings row is missing.
// Auth errors during the flush go through the outbox's own onAuthError recovery path.
export async function loadFirst({ ctx, load, ensureDefaults, ensureGymDefaults, capMs, setTimer, clearTimer, onLate }) {
  await flushCapped(ctx.outbox, { capMs, setTimer, clearTimer, onLate });
  let snapshot = await load();
  if (needsSeed(snapshot)) {
    try {
      await ensureDefaults(ctx);
      await flushCapped(ctx.outbox, { capMs, setTimer, clearTimer, onLate });
      snapshot = await load();
    } catch {
      return snapshot; // seeding is retried at the next session; the app still works without it
    }
  }
  if (ensureGymDefaults && needsGymSeed(snapshot)) {
    try {
      await ensureGymDefaults(ctx, snapshot);
      await flushCapped(ctx.outbox, { capMs, setTimer, clearTimer, onLate });
      return await load();
    } catch {
      return snapshot; // retried next session (gym_seeded_at is still null)
    }
  }
  return snapshot;
}

export function createResume({ getMode, hasSnapshot, isSessionDeferred, flush, refresh, recheckSession }) {
  const safe = async (fn) => { try { await fn(); } catch { /* calm: callers show their own notices */ } };
  return {
    async online() {
      const mode = getMode();
      if (mode === 'app') {
        await safe(flush);
        await safe(refresh);
      } else if (mode === 'login' && isSessionDeferred()) {
        await safe(recheckSession);
      }
    },
    async visible() {
      if (getMode() === 'app' && !hasSnapshot()) await safe(refresh);
    },
  };
}
