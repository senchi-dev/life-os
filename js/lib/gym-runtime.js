// Gym runtime: owns the live workout draft and the history index for one signed-in user.
// dispatch/start/finish/discard/init are serialised; every write goes through enqueueGym (validated, FIFO outbox).
// The draft is mirrored to kv (coalesced) so a reload or a crash never loses a workout in progress.
import { enqueueGym, fetchFinishedHistory, fetchWorkoutsByIds } from '../data/gym-repo.js';
import { GymValidationError } from './gym-validate.js';
import { startDraft, reduce, finishOps, discardOps, reconcileDraft, draftFromServer } from './workout-draft.js';
import { buildIndex, applyWorkouts, canApplyIncrementally, missingWorkoutIds, dropWorkoutFromIndex } from './gym-index.js';
import { prsForDraft, bestPr } from './gym-stats.js';
import { isStaleWorkout } from './workout.js';

export const SAVE_DELAY_MS = 250;
const DRAFT_PREFIX = 'active-workout:';
const INDEX_PREFIX = 'gym-index:';
const FORGOTTEN_PREFIX = 'gym-index:forgotten:'; // under the index prefix so clearAll removes it with the index
const CLOSED_PREFIX = 'gym-index:closed:'; // same: cleared by clearAll

export function createGymRuntime({
  ctx, kv, getSnapshot, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, newId,
}) {
  let draft = null;
  let index = null;
  let gen = 0; // bumped by clearAll: results of work started before it are dropped
  let rebuildNeeded = false;
  let saveTimer = null;
  let chain = Promise.resolve(); // serialises init/start/dispatch/finish/discard
  let kvChain = Promise.resolve(); // serialises kv writes so a late save can never overtake a delete
  let indexJob = null;
  // Tombstones: workouts deleted here whose remove is still QUEUED. The server still has them, so every read from it
  // (index rebuild, snapshot reload) must filter them out until the outbox has drained. Persisted so a reload keeps them.
  const forgotten = new Set();
  let forgottenLoaded = false;
  let building = null; // { local: [] } while a full history fetch is in flight
  // Workouts finished or discarded on this device whose close may not have reached the server yet: a snapshot read
  // before the queued op landed still shows them open, and they must never be rebuilt as a draft (Discard would delete a
  // finished workout, Finish would overwrite it). id -> finished workout row, or null when discarded. Persisted per user.
  const closed = new Map();
  let closedFor = null; // the user whose closed ids are loaded
  const idOpt = newId ? { newId } : {};

  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const kvWrite = (fn) => {
    const p = kvChain.catch(() => {}).then(fn);
    kvChain = p.catch(() => {});
    return p;
  };
  const uid = () => getSnapshot()?.settings?.user_id ?? null;
  const draftKey = (u) => `${DRAFT_PREFIX}${u}`;
  const indexKey = (u) => `${INDEX_PREFIX}${u}`;
  const forgottenKey = (u) => `${FORGOTTEN_PREFIX}${u}`;

  const closedKey = (u) => `${CLOSED_PREFIX}${u}`;
  async function loadClosed(u) {
    if (!u || closedFor === u) return;
    const g = gen;
    const v = await kv.get(closedKey(u));
    if (g !== gen || closedFor === u) return;
    closed.clear();
    closedFor = u;
    for (const x of Array.isArray(v) ? v : []) if (x && typeof x.id === 'string') closed.set(x.id, x.row ?? null);
  }
  function persistClosed() {
    const u = closedFor;
    if (!u) return Promise.resolve();
    const g = gen;
    const list = [...closed].map(([id, row]) => ({ id, row }));
    return kvWrite(async () => {
      if (g !== gen) return;
      if (list.length) await kv.set(closedKey(u), list); else await kv.del(closedKey(u));
    });
  }
  async function markClosed(u, id, row) {
    await loadClosed(u);
    closed.set(id, row);
    await persistClosed().catch(() => {});
  }
  const isClosedId = (id) => closedFor === uid() && closed.has(id);
  // Hide closed workouts in a snapshot (in place): never the active workout; a finished one shows finished, a discarded one
  // is gone. Then forget the ids the server has caught up with: the queue is empty AND this (raw) snapshot no longer
  // shows them open. A snapshot read before the drain still shows them open, so a stale read never clears them.
  function applyClosed(snapshot, { sweep }) {
    if (!snapshot || !closed.size || closedFor !== uid()) return;
    const openOnServer = new Set((snapshot.workouts ?? []).filter((w) => w.ended_at == null).map((w) => w.id));
    if (snapshot.activeWorkout) openOnServer.add(snapshot.activeWorkout.workout.id);
    if (snapshot.activeWorkout && closed.has(snapshot.activeWorkout.workout.id)) snapshot.activeWorkout = null;
    const seen = new Set();
    let workouts = (snapshot.workouts ?? []).flatMap((w) => {
      if (!closed.has(w.id)) return [w];
      seen.add(w.id);
      const row = closed.get(w.id);
      if (!row) return [];
      return [w.ended_at ? w : { ...w, ...row }];
    });
    for (const [id, row] of closed) if (row && !seen.has(id)) workouts.push({ ...row });
    workouts = workouts.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
    snapshot.workouts = workouts;
    if (!sweep || ctx.outbox.pending() !== 0) return;
    let any = false;
    for (const id of [...closed.keys()]) if (!openOnServer.has(id)) { closed.delete(id); any = true; }
    if (any) persistClosed().catch(() => {});
  }

  function persistForgotten() {
    const u = uid();
    if (!u) return;
    const g = gen;
    kvWrite(async () => {
      if (g !== gen) return;
      if (forgotten.size) await kv.set(forgottenKey(u), [...forgotten]); else await kv.del(forgottenKey(u));
    }).catch(() => {});
  }
  async function loadForgotten() {
    const u = uid();
    if (forgottenLoaded || !u) return;
    const g = gen;
    const v = await kv.get(forgottenKey(u));
    if (g !== gen) return;
    forgottenLoaded = true;
    for (const id of Array.isArray(v) ? v : []) if (typeof id === 'string') forgotten.add(id);
    if (index && forgotten.size) { for (const id of forgotten) index = dropWorkoutFromIndex(index, id); rebuildNeeded = true; }
  }
  // Once the outbox is empty the removes were applied (or dropped as rejected, in which case the server rightly still has them),
  // and the index has been rebuilt from that state (a reload before then would bring back the pre-delete index).
  function sweepForgotten() {
    if (forgotten.size && ctx.outbox.pending() === 0 && !rebuildNeeded) { forgotten.clear(); persistForgotten(); }
  }
  function withoutForgotten(rows) {
    if (!forgotten.size) return rows;
    const workouts = rows.workouts.filter((w) => !forgotten.has(w.id));
    const keep = new Set(workouts.map((w) => w.id));
    const workoutExercises = rows.workoutExercises.filter((x) => keep.has(x.workout_id));
    const entries = new Set(workoutExercises.map((x) => x.id));
    return { ...rows, workouts, workoutExercises, sets: rows.sets.filter((x) => entries.has(x.workout_exercise_id)) };
  }

  // Writes whatever the current draft is when the write runs; a dropped draft or a cleared runtime writes nothing.
  function saveNow() {
    const g = gen;
    return kvWrite(async () => {
      if (g !== gen || !draft) return;
      await kv.set(draftKey(draft.userId), draft);
    });
  }
  function cancelTimer() {
    if (saveTimer !== null) { clearTimer(saveTimer); saveTimer = null; }
  }
  function scheduleSave() {
    if (saveTimer !== null) return; // coalesce: the pending write will pick up the latest draft
    saveTimer = setTimer(() => { saveTimer = null; saveNow().catch(() => {}); }, SAVE_DELAY_MS);
  }
  function dropDraft() {
    cancelTimer();
    const key = draft ? draftKey(draft.userId) : null;
    draft = null;
    return key ? kvWrite(() => kv.del(key)) : kvChain;
  }
  function saveIndex(u) {
    const g = gen;
    return kvWrite(async () => { if (g === gen && index) await kv.set(indexKey(u), index); });
  }
  async function loadIndexFromKv(u) {
    const v = await kv.get(indexKey(u));
    return v && v.version === 1 ? v : null;
  }

  const nameOf = (exerciseId) => (getSnapshot()?.exercises ?? []).find((e) => e.id === exerciseId)?.name ?? 'Exercise';
  const toRow = (e, s) => ({ id: s.id, workout_exercise_id: e.id, set_no: s.set_no, reps: s.reps, weight_kg: s.kg, type: s.type, done_at: s.done_at });

  // PRs are evaluated on ticked sets only (A8): a set still unticked at Finish is never a PR candidate.
  function prInfo(d) {
    const byExercise = new Map();
    for (const e of d.exercises) {
      const list = byExercise.get(e.exercise_id) ?? [];
      for (const s of e.sets) if (s.done) list.push(toRow(e, s));
      byExercise.set(e.exercise_id, list);
    }
    const prMap = new Map();
    const lines = [];
    for (const [exerciseId, sets] of byExercise) {
      if (!sets.length) continue;
      // A stale index (rebuild flagged: a deleted workout's sets still feed `front`/`bestE1rm`) must not produce PR flags.
      const flags = prsForDraft(rebuildNeeded ? null : index, { exerciseId, sets });
      for (const [id, f] of flags) prMap.set(id, f);
      const best = bestPr(sets, flags);
      if (best) lines.push({ name: nameOf(exerciseId), weight_kg: Number(best.weight_kg), reps: best.reps });
    }
    return { prMap, lines };
  }

  const isStale = (d) => isStaleWorkout({ startedAt: d.workout.started_at, lastTickAt: d.lastTickAt, now: now().toISOString() });

  // --- index ---------------------------------------------------------------------------------------------------
  async function rebuild(u) {
    const g = gen;
    const job = { local: [] };
    building = job;
    try {
      sweepForgotten();
      const rows = withoutForgotten(await fetchFinishedHistory(ctx));
      if (g !== gen) return;
      let next = buildIndex(rows);
      let unresolved = false;
      // Workouts finished on this device while the fetch was in flight may not be on the server yet.
      for (const b of job.local) {
        if (next.workoutIds.includes(b.workouts[0].id)) continue;
        if (canApplyIncrementally(next, b.workouts, b.workoutExercises)) next = applyWorkouts(next, b);
        else unresolved = true;
      }
      index = next;
      rebuildNeeded = unresolved;
      await saveIndex(u);
    } finally {
      if (building === job) building = null;
    }
  }

  async function runEnsureIndex() {
    const u = uid();
    if (!u) return;
    const g = gen;
    if (!index) index = await loadIndexFromKv(u);
    await loadForgotten();
    if (g !== gen) return;
    sweepForgotten();
    if (!index || rebuildNeeded) {
      if (index) { try { await ctx.outbox.flush(); } catch { /* offline: rebuild from what the server has, tombstones filter it */ } }
      await rebuild(u);
      return;
    }
    const missing = missingWorkoutIds(index, (getSnapshot()?.workouts ?? []).filter((w) => !forgotten.has(w.id)));
    if (!missing.length) return;
    const rows = withoutForgotten(await fetchWorkoutsByIds(ctx, missing));
    if (g !== gen) return;
    if (canApplyIncrementally(index, rows.workouts, rows.workoutExercises)) {
      index = applyWorkouts(index, rows);
      await saveIndex(u);
    } else {
      await rebuild(u);
    }
  }

  // Local, no network: fold the workout just finished into the index (A: finish never reads the backend).
  function indexFinished(d, workoutRow, loggedSets) {
    if (!index) return; // never built (offline since sign-in): ensureIndex builds it from the server later
    const workoutExercises = d.exercises.map((e) => ({ id: e.id, workout_id: d.workout.id, exercise_id: e.exercise_id, position: e.position, note: e.note }));
    const sets = d.exercises.flatMap((e) => e.sets.filter((s) => s.done).map((s) => toRow(e, s)));
    sets.push(...loggedSets);
    const bundle = { workouts: [workoutRow], workoutExercises, sets };
    if (building) building.local.push(bundle);
    // Stale index (a delete flagged a rebuild): applying incrementally would build on a baseline that still contains the
    // deleted workout. Leave the flag set; the next ensureIndex rebuilds from the server once the outbox has drained.
    if (rebuildNeeded) return;
    if (canApplyIncrementally(index, bundle.workouts, bundle.workoutExercises)) {
      index = applyWorkouts(index, bundle);
      saveIndex(d.userId).catch(() => {});
    } else {
      rebuildNeeded = true; // older than an indexed session: only a full rebuild is correct
    }
  }

  // --- public API ----------------------------------------------------------------------------------------------
  return {
    draft: () => draft,
    index: () => index,

    // `cached`: the snapshot is an offline copy (I1), possibly older than the draft. It cannot prove the workout was
    // finished or deleted elsewhere, so the stored draft is kept as is; the app calls init again on the first live snapshot.
    init: ({ cached = false } = {}) => serial(async () => {
      const snap = getSnapshot();
      const u = uid();
      if (!u) return { notice: null, stale: false };
      let notice = null;
      await loadClosed(u);
      const stored = draft && draft.userId === u ? draft : ((await kv.get(draftKey(u))) ?? null);
      draft = stored;
      if (draft && isClosedId(draft.workout.id)) await dropDraft(); // closed here (a crash before the kv delete landed)
      if (draft && !cached) {
        const verdict = reconcileDraft({ draft, snapshot: snap, queueEmpty: ctx.outbox.pending() === 0 });
        if (verdict !== 'keep') {
          notice = verdict === 'finished-elsewhere'
            ? 'This workout was finished on another device, so the draft here was closed.'
            : 'This workout no longer exists on the server, so the draft here was closed.';
          await dropDraft();
        }
      }
      applyClosed(snap, { sweep: false });
      if (!draft && snap.activeWorkout && !isClosedId(snap.activeWorkout.workout.id)) {
        draft = draftFromServer(snap.activeWorkout, u);
        await saveNow();
      }
      if (!index) index = await loadIndexFromKv(u);
      await loadForgotten();
      onChange();
      return { notice, stale: draft ? isStale(draft) : false };
    }),

    // No-op (returning the existing draft) when a workout is already open here or on the server.
    start: (routineId) => serial(async () => {
      if (draft) return draft;
      const snap = getSnapshot();
      const u = uid();
      if (!u) return null;
      await loadClosed(u);
      if (snap.activeWorkout && !isClosedId(snap.activeWorkout.workout.id)) {
        draft = draftFromServer(snap.activeWorkout, u);
        await saveNow();
        onChange();
        return draft;
      }
      const routine = routineId ? (snap.routines ?? []).find((r) => r.id === routineId) : null;
      if (routineId && !routine) return null;
      const items = routine ? (snap.routineItems ?? []).filter((i) => i.routine_id === routine.id) : [];
      const exercisesById = Object.fromEntries((snap.exercises ?? []).map((e) => [e.id, e]));
      if (!index) index = await loadIndexFromKv(u);
      const { draft: d, ops } = startDraft({ routine, items, exercisesById, index, userId: u, now: now(), ...idOpt });
      await enqueueGym(ctx, ops);
      draft = d;
      await saveNow();
      onChange();
      return draft;
    }),

    dispatch: (action) => serial(async () => {
      if (!draft) return { error: 'no-draft' };
      const r = reduce(draft, action, { now: now(), index, ...idOpt });
      if (r.error) return { error: r.error };
      if (r.ops.length) {
        try {
          await enqueueGym(ctx, r.ops);
        } catch (e) {
          return { error: e instanceof GymValidationError ? 'invalid' : 'queue-failed' };
        }
      }
      draft = r.draft;
      scheduleSave();
      onChange();
      return {};
    }),

    flushDraft: async () => {
      cancelTimer();
      await saveNow();
    },

    // Pure: the PR lines the finish sheet shows before anything is saved. Unticked sets are not evaluated (A8).
    previewFinish: () => (draft ? prInfo(draft).lines : []),

    finish: ({ end, durationKnown, logUnticked }) => serial(async () => {
      if (!draft) throw new Error('no-draft');
      const d = draft;
      const { prMap, lines } = prInfo(d);
      const { ops, workoutRow, loggedSets } = finishOps(d, { end, durationKnown, prMap, gymHabitId: getSnapshot()?.settings?.gym_habit_id ?? null, logUnticked });
      await enqueueGym(ctx, ops);
      await markClosed(d.userId, d.workout.id, workoutRow); // before the draft delete: a reload never sees neither
      await dropDraft();
      indexFinished(d, workoutRow, loggedSets);
      onChange();
      const habitOp = ops.find((o) => o.table === 'habit_logs');
      // workoutRow and habitLog let the caller update its in-memory snapshot without a network read.
      return { prLines: lines, habitChecked: !!habitOp, workoutRow, habitLog: habitOp ? habitOp.rows[0] : null };
    }),

    discard: () => serial(async () => {
      if (!draft) return { habitStillChecked: false };
      const d = draft;
      const snap = getSnapshot();
      await enqueueGym(ctx, discardOps(d));
      await markClosed(d.userId, d.workout.id, null);
      await dropDraft();
      onChange();
      const hid = snap?.settings?.gym_habit_id;
      return { habitStillChecked: !!hid && (snap.habitLogs ?? []).some((l) => l.habit_id === hid && l.date === d.workout.day && l.status === 'done') };
    }),

    // Shared while running: concurrent callers wait for the same fetch.
    ensureIndex() {
      if (!indexJob) indexJob = runEnsureIndex().finally(() => { indexJob = null; });
      return indexJob;
    },

    // A workout was deleted: hide its sessions now and make the next ensureIndex/rebuildIndex recompute PRs and
    // "last" from the remaining history (those cannot be derived without the sets).
    forgetWorkout: (workoutId) => {
      forgotten.add(workoutId);
      persistForgotten();
      if (!index) return;
      index = dropWorkoutFromIndex(index, workoutId);
      rebuildNeeded = true;
      const u = uid();
      if (u) saveIndex(u).catch(() => {});
    },

    // The Strive import re-creates a deleted workout under the same deterministic id: its tombstone must go, or the rebuilt index
    // would hide it. (While the delete is still queued the tombstone stands; the import then sees the workout as already there.)
    unforgetWorkouts: (ids) => {
      let any = false;
      for (const id of ids) any = forgotten.delete(id) || any;
      if (any) persistForgotten();
    },

    isForgotten: (id) => { sweepForgotten(); return forgotten.has(id); },
    forgottenIds: () => { sweepForgotten(); return new Set(forgotten); },
    // Snapshot reloads re-read workouts the server still has: hide the ones whose delete is queued.
    // ...and workouts closed here whose finish/discard is still queued (C1).
    // `cached`: an offline copy (possibly older than the close) proves nothing about the server, so it never clears an id.
    hideForgotten: (snapshot, { cached = false } = {}) => {
      sweepForgotten();
      if (snapshot && forgotten.size) snapshot.workouts = (snapshot.workouts ?? []).filter((w) => !forgotten.has(w.id));
      applyClosed(snapshot, { sweep: !cached });
      return snapshot;
    },

    isClosed: (id) => isClosedId(id),

    rebuildIndex: async () => {
      const u = uid();
      if (u) await rebuild(u);
    },

    clearAll: async () => {
      gen++;
      cancelTimer();
      await chain.catch(() => {});
      draft = null;
      index = null;
      rebuildNeeded = false;
      forgotten.clear();
      forgottenLoaded = false;
      building = null;
      indexJob = null;
      closed.clear();
      closedFor = null;
      await kvWrite(async () => {
        await kv.delPrefix(DRAFT_PREFIX);
        await kv.delPrefix(INDEX_PREFIX);
      });
    },
  };
}
