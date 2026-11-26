// Pure Load-more state for the exercise history. A request takes a token; results carry it back, so a result that
// arrives after a reset (new index, new visit) or for an already-served page is ignored. No DOM, no I/O.
const keyOf = (r) => r.session.workoutId;

export const newPager = (size = 20) => ({ size, pages: [], loading: false, error: false, exhausted: false, gen: 0 });

export const pagerRows = (p) => p.pages.flat();

// More to fetch: not exhausted and fewer rows loaded than the total. (Errors keep this true so Try again shows.)
export const hasMore = (p, total) => !p.exhausted && p.pages.length * p.size < total;

// Starts the next page. null when one is already in flight (double tap).
export function beginPage(p) {
  if (p.loading) return null;
  p.loading = true;
  p.error = false;
  return { gen: p.gen, n: p.pages.length };
}

const current = (p, t) => !!t && t.gen === p.gen && t.n === p.pages.length && p.loading;

export function pageDone(p, t, rows) {
  if (!current(p, t)) return false;
  const seen = new Set(pagerRows(p).map(keyOf));
  p.pages.push(rows.filter((r) => !seen.has(keyOf(r))));
  if (rows.length < p.size) p.exhausted = true;
  p.loading = false;
  return true;
}

export function pageFailed(p, t) {
  if (!current(p, t)) return false;
  p.loading = false;
  p.error = true;
  return true;
}

export function resetPager(p) {
  p.gen += 1;
  p.pages = [];
  p.loading = false;
  p.error = false;
  p.exhausted = false;
}

// mountView runs the previous render's cleanup before EVERY render, also a plain repaint of the same route. A cleanup
// followed by enter() in the same tick is a repaint; a cleanup with no enter() means the route was left: onLeave runs.
export function leaveTracker(onLeave) {
  let pending = null;
  return {
    enter() { pending = null; },
    cleanup() {
      const mine = {};
      pending = mine;
      queueMicrotask(() => { if (pending === mine) { pending = null; onLeave(); } });
    },
  };
}
