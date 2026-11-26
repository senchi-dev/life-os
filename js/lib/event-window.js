// Event data window: what the boot snapshot loads, and bookkeeping for ranges fetched on demand.
// Ranges are inclusive { from, to } date keys ('YYYY-MM-DD'), which compare correctly as strings.
import { addDays } from './dates.js';

export const EVENT_PAST_DAYS = 35;
export const EVENT_FUTURE_DAYS = 90;

export function bootWindow(todayKey) {
  return { from: addDays(todayKey, -EVENT_PAST_DAYS), to: addDays(todayKey, EVENT_FUTURE_DAYS) };
}

const covered = (loaded, day) => loaded.some((r) => r.from <= day && day <= r.to);

// Smallest single range covering every day of `want` not inside a loaded range; null when fully loaded.
export function missingRange(loaded, want) {
  let first = null;
  let last = null;
  for (let d = want.from; d <= want.to; d = addDays(d, 1)) {
    if (covered(loaded, d)) continue;
    if (first === null) first = d;
    last = d;
  }
  return first === null ? null : { from: first, to: last };
}

// New sorted list with `range` added; overlapping or adjacent ranges are joined.
export function addLoaded(loaded, range) {
  const all = [...loaded, range].map((r) => ({ ...r })).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out = [];
  for (const r of all) {
    const prev = out.at(-1);
    if (prev && r.from <= addDays(prev.to, 1)) {
      if (r.to > prev.to) prev.to = r.to;
    } else {
      out.push(r);
    }
  }
  return out;
}

// Union by id; the snapshot copy wins so edits and deletes in the boot window are never undone by stale extras.
export function mergeEvents(snapshotEvents, extra) {
  const ids = new Set(snapshotEvents.map((e) => e.id));
  return [...snapshotEvents, ...extra.filter((e) => !ids.has(e.id))];
}

export function windowStatus({ loaded, want, online, failed }) {
  if (missingRange(loaded, want) === null) return 'ok';
  if (!online) return 'offline';
  if (failed) return 'failed';
  return 'ok';
}
