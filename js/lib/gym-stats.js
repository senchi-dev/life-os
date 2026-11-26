// Pure gym maths: Epley e1RM, Pareto PR rule, replay, prefill, labels. No DOM, no storage.

const EPS = 1e-9;

export function epley(w, r) {
  if (!(r >= 1) || r > 12) return null;
  if (r === 1) return w;
  return w * (1 + r / 30);
}

export function isWorking(set) {
  return set.type !== 'warmup' && set.reps >= 1;
}

export function beatsFront(front, p) {
  return !front.some((q) => q.w >= p.w && q.r >= p.r);
}

export function insertFront(front, p) {
  if (!beatsFront(front, p)) return front.slice();
  return front.filter((q) => !(q.w <= p.w && q.r <= p.r)).concat([{ w: p.w, r: p.r }])
    .sort((a, b) => b.w - a.w || b.r - a.r);
}

const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; };
export function orderSets(sets) {
  return sets.slice().sort((a, b) => time(a.done_at) - time(b.done_at) || a.set_no - b.set_no);
}

// Walk one session's sets against a history; returns flags plus the updated history.
export function replaySession(front, best, sets) {
  const flags = new Map();
  let f = front, b = best;
  for (const s of orderSets(sets)) {
    if (!isWorking(s)) { flags.set(s.id, false); continue; }
    const p = { w: Number(s.weight_kg), r: s.reps };
    const e = epley(p.w, p.r);
    flags.set(s.id, beatsFront(f, p) || (e !== null && b !== null && e > b + EPS));
    f = insertFront(f, p);
    if (e !== null && (b === null || e > b)) b = e;
  }
  return { flags, front: f, bestE1rm: b };
}

export function replayPrs(sessions) {
  const out = new Map();
  const ordered = sessions.slice().sort((a, b) => time(a.startedAt) - time(b.startedAt));
  let front = [], best = null, seen = false;
  for (const ses of ordered) {
    const r = replaySession(front, best, ses.sets);
    const hasWorking = ses.sets.some(isWorking);
    for (const [id, flag] of r.flags) out.set(id, seen ? flag : false);
    if (hasWorking) seen = true;
    front = r.front; best = r.bestE1rm;
  }
  return out;
}

// Callers pass only ticked (done) sets; unticked sets are not evaluated (A8).
export function prsForDraft(index, draft) {
  const sets = draft.sets || [];
  const ex = index && index.exercises && index.exercises[draft.exerciseId];
  if (!ex) return new Map(sets.map((s) => [s.id, false]));
  return replaySession(ex.front, ex.bestE1rm, sets).flags;
}

export function bestPr(sets, prMap) {
  let best = null, bestE = null;
  for (const s of sets) {
    if (!prMap.get(s.id)) continue;
    const e = epley(Number(s.weight_kg), s.reps);
    if (!best) { best = s; bestE = e; continue; }
    const a = e ?? -Infinity, c = bestE ?? -Infinity;
    const better = a !== c ? a > c
      : Number(s.weight_kg) !== Number(best.weight_kg) ? Number(s.weight_kg) > Number(best.weight_kg)
        : s.set_no < best.set_no;
    if (better) { best = s; bestE = e; }
  }
  return best ? { weight_kg: best.weight_kg, reps: best.reps } : null;
}

export function prefillSets({ prev, targetSets, targetRepsMin, equipment }) {
  const n = Math.max(1, targetSets || 1);
  if (prev && prev.length) {
    return Array.from({ length: n }, (_, i) => {
      const p = prev[Math.min(i, prev.length - 1)];
      return { kg: p.weight_kg, reps: p.reps, type: p.type };
    });
  }
  const kg = equipment === 'bodyweight' ? 0 : null;
  return Array.from({ length: n }, () => ({ kg, reps: targetRepsMin, type: 'normal' }));
}

export function fmtKg(w) {
  if (Number(w) === 0) return 'BW';
  return String(Math.round(Number(w) * 100) / 100);
}

export function setLabel(s) {
  if (!s) return '—';
  return `${fmtKg(s.weight_kg)} × ${s.reps}`;
}
