// More → Import from Strive. runImportFlow is DOM-free (tested against a memory backend); importBody is the screen.
// The file is read on this device with file.text() and never uploaded anywhere but the user's own backend as normal rows.
import { h } from './dom.js';
import { buildImportPlan, ImportError, STRIVE_FORMAT, mappingLine } from '../lib/strive-import.js';
import { fetchImportState, enqueueGym } from '../data/gym-repo.js';
import { classifyError } from '../data/backend-supabase.js';
import { validateGymRow, GymValidationError } from '../lib/gym-validate.js';
import {
  previewLine, importErrorMessage, resultMessage, NOT_STRIVE, NOT_READY, GENERIC_ERROR, TOO_BIG, NO_SESSIONS, UNREADABLE, MAX_FILE_BYTES,
  initialState, withFile, withPreview, withError, withPlanning, toggleDuplicate, setMapOpen, startImport, finishImport,
  canImport, importLabel, repairNote, duplicateRows, createLatest,
} from './import-model.js';

const FLUSH_ROUNDS = 20;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = Array.isArray;

// A file that says it is a Strive export but whose parts have the wrong shape is "not an export", never a TypeError.
function shapeOk(j) {
  if (!arr(j.workouts) || !arr(j.exercises) || !arr(j.routines)) return false;
  return j.workouts.every((w) => isObj(w) && arr(w.exercises) && w.exercises.every((e) => isObj(e) && arr(e.sets)))
    && j.exercises.every(isObj) && j.routines.every((r) => isObj(r) && arr(r.items));
}

// Validates every op the way enqueueGym will, so a bad row is a message at preview time, not a failure at Import.
function invalidMessage(ops) {
  for (const op of ops) {
    if (op.kind !== 'upsert') continue;
    for (const row of arr(op.rows) ? op.rows : [op.rows]) {
      if (!validateGymRow(op.table, row)) continue;
      const name = typeof row?.name === 'string' ? ` "${row.name.replace(/\s+/g, ' ').trim().slice(0, 60)}"` : '';
      return `The file has a value that cannot be imported${name} (${op.table}). Nothing was changed.`;
    }
  }
  return null;
}

const FIRST_ONLY_VERIFIED = ['routines', 'routine_items', 'schedule_slots']; // rows with ids we can look up on the server
const FIRST_ONLY = new Set([...FIRST_ONLY_VERIFIED, 'habits']);
const IN_CHUNK = 50;

// True when any row of a first-import-only write is missing on the server (decided from the server, not the flush result).
async function firstOnlyMissing(ctx, ops) {
  for (const op of ops) {
    if (op.kind !== 'upsert' || !FIRST_ONLY_VERIFIED.includes(op.table)) continue;
    const ids = (arr(op.rows) ? op.rows : [op.rows]).map((r) => r.id);
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      if ((await ctx.backend.select(op.table, { in: { id: chunk } })).length < chunk.length) return true;
    }
  }
  return false;
}

// Enqueue everything, flush, then decide the outcome from the SERVER: re-derive the import state and re-plan. Success means
// nothing is left to import or repair; the flush result is only a hint (a background flush may have swallowed the failures).
async function sendOps({ ctx, gym, refresh, ops, preview, replan }) {
  const todo = preview.newSessions + preview.repaired;
  const done = (status, extra = {}) => {
    const r = { status, queued: ops.length, total: todo, applied: 0, ...extra };
    return { ...r, message: extra.message ?? resultMessage(r, preview) };
  };
  try { await enqueueGym(ctx, ops); } catch (e) {
    return done('error', { message: e instanceof GymValidationError ? importErrorMessage(null) : 'Could not queue the whole import. Try again; the import is safe to repeat.' });
  }
  // A workout deleted here earlier shares its deterministic id with the re-imported one: its tombstone must not hide it.
  try { gym.unforgetWorkouts?.(ops.filter((o) => o.table === 'workouts').flatMap((o) => o.rows.map((r) => r.id))); } catch { /* ignore */ }

  let sent = 0, failed = [], remaining = 0, authStop = false;
  try {
    for (let i = 0; i < FLUSH_ROUNDS; i++) {
      const r = await ctx.outbox.flush();
      sent += r.sent ?? 0;
      failed = failed.concat(r.failed ?? []);
      remaining = r.remaining;
      if (r.authStop) { authStop = true; break; }
      if (remaining === 0) break;
      if (!r.sent && !(r.failed ?? []).length) break; // no progress: offline, queue kept
    }
  } catch { remaining = ctx.outbox.pending?.() ?? 1; }

  let post = null, missing = false;
  try { post = await replan(); missing = await firstOnlyMissing(ctx, ops); } catch { post = null; }
  const refreshAll = async () => {
    try { await gym.rebuildIndex(); } catch { /* the next ensureIndex rebuilds it */ }
    try { await refresh(); } catch { /* the next refresh shows the rows */ }
  };
  if (!post) {
    if (sent > 0) await refreshAll();
    return done(authStop ? 'auth' : 'offline');
  }
  const left = post.preview.newSessions + post.preview.repaired;
  const applied = Math.max(0, todo - left);
  const lostFirstOnly = (missing || failed.some((o) => FIRST_ONLY.has(o.table))) && post.gateClosed;
  const status = authStop ? 'auth' : lostFirstOnly ? 'partial' : failed.length || (left > 0 && remaining === 0) ? 'partial' : left > 0 ? 'offline' : 'done';
  if (sent > 0 || applied > 0 || status === 'done') await refreshAll();
  return done(status, { applied, routinesNotSaved: lostFirstOnly });
}

export async function runImportFlow({ ctx, gym, snapshot, refresh, file, includeDuplicates = new Set() }) {
  const fail = (message) => ({ stage: 'error', message });
  try {
    if (!file || typeof file.text !== 'function') return fail(UNREADABLE);
    if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) return fail(TOO_BIG);
    let text;
    try { text = await file.text(); } catch { return fail(UNREADABLE); }
    if (typeof text !== 'string') return fail(UNREADABLE);
    if (text.length > MAX_FILE_BYTES) return fail(TOO_BIG);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let json;
    try { json = JSON.parse(text); } catch { return fail(NOT_STRIVE); }
    if (!isObj(json) || json.format !== STRIVE_FORMAT || !shapeOk(json)) return fail(NOT_STRIVE);
    if (snapshot?.settings?.gym_seeded_at == null) return fail(NOT_READY);
    if (json.workouts.length === 0) return fail(NO_SESSIONS);

    let importState;
    try { importState = await fetchImportState(ctx); } catch (e) {
      // Only a failed read of existing data is classified as offline / signed out; any other exception stays generic.
      const kind = e?.kind ?? classifyError(e);
      return fail(importErrorMessage(kind === 'network' || kind === 'auth' ? { kind } : null));
    }
    const { preview, ops } = await buildImportPlan({
      json, snapshot, importState, userId: snapshot.settings.user_id, includeDuplicates: new Set(includeDuplicates),
    });
    const bad = invalidMessage(ops);
    if (bad) return fail(bad);

    // One commit per flow. Concurrent and later calls get the same result, so a double tap can never enqueue twice.
    const replan = async () => {
      const fresh = await fetchImportState(ctx);
      const again = await buildImportPlan({ json, snapshot, importState: fresh, userId: snapshot.settings.user_id, includeDuplicates: new Set(includeDuplicates) });
      return { preview: again.preview, gateClosed: fresh.importedRefs.size > 0 };
    };
    let pending = null;
    const nothingNew = preview.newSessions === 0 && !(preview.repaired > 0);
    const commit = () => {
      if (!pending) {
        pending = nothingNew || ops.length === 0
          ? Promise.resolve({ status: 'done', queued: 0, total: 0, applied: 0, message: 'Already imported.' })
          : sendOps({ ctx, gym, refresh, ops, preview, replan }).catch(() => ({ status: 'error', queued: 0, total: 0, applied: 0, message: GENERIC_ERROR }));
      }
      return pending;
    };
    return { stage: 'preview', preview, line: previewLine(preview), ops, commit };
  } catch (e) {
    return fail(importErrorMessage(e instanceof ImportError || e?.kind ? e : null));
  }
}

// ---- screen ----
let st = initialState();
let source = null; // { size, text() } over the chosen file, cached so toggling a duplicate does not re-read it
let flow = null;
let focusKey = null;
const latest = createLatest();

export function resetImport() { latest.next(); st = initialState(); source = null; flow = null; focusKey = null; }

function cachedFile(file) {
  let cache = null;
  return { size: file.size, text: async () => { if (cache === null) cache = await file.text(); return cache; } };
}

async function plan(app, { keepMessage = null } = {}) {
  const token = latest.next();
  const r = await runImportFlow({
    ctx: app.ctx, gym: app.gym, snapshot: app.snapshot, refresh: () => app.refresh(), file: source, includeDuplicates: st.includeDuplicates,
  });
  if (!latest.isCurrent(token)) return false;
  if (r.stage === 'error') { st = withError(st, r.message); flow = null; focusKey = 'import.msg'; } else {
    flow = r;
    st = withPreview(st, r.preview);
    if (keepMessage) st = { ...st, message: keepMessage.text, kind: keepMessage.kind };
    if (!keepMessage && st.includeDuplicates.size === 0) focusKey = 'import.preview';
  }
  app.rerender();
  return true;
}

function chooseFile(app, input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  source = cachedFile(file);
  flow = null;
  st = withFile(st, { name: file.name, text: null });
  app.rerender();
  plan(app);
}

function toggle(app, ref) {
  st = withPlanning(toggleDuplicate(st, ref));
  app.rerender();
  plan(app);
}

async function doImport(app) {
  const next = startImport(st);
  if (next === st || !flow) return;
  st = next;
  const f = flow;
  const token = latest.next(); // a sign-out / reset while the import runs must not write into the reset state
  app.rerender();
  let res;
  try { res = await f.commit(); } catch { res = { status: 'error', message: GENERIC_ERROR }; }
  if (!latest.isCurrent(token)) return;
  const ok = res.status === 'done' || res.status === 'offline';
  const message = res.message;
  if (res.status === 'partial' && source) {
    // Planning is on while the new plan is computed: a tap in this window is a no-op, never the memoized old result.
    st = { ...withPlanning(st), stage: 'preview' };
    app.rerender();
    if (!(await plan(app, { keepMessage: { text: message, kind: 'error' } }))) return;
    focusKey = 'import.msg';
    app.rerender();
    return;
  }
  st = finishImport(st, message, ok ? 'ok' : 'error');
  if (ok) { source = null; flow = null; }
  focusKey = 'import.msg';
  app.rerender();
}

let fileInput = null;
function fileField(app) {
  if (!fileInput) {
    fileInput = h('input', {
      type: 'file', class: 'field mfile', accept: '.json,application/json', 'data-key': 'import.file', 'aria-label': 'Strive export file',
      onChange: () => chooseFile(fileInput._app, fileInput),
    });
  }
  fileInput._app = app;
  fileInput.disabled = st.stage === 'importing';
  return fileInput;
}

function mappingBlock(preview) {
  const rows = preview.mapping ?? [];
  const det = h('details', { class: 'mmap', 'data-key': 'import.map' },
    h('summary', { class: 'tap mmap-sum' }, `Exercise mapping (${rows.length})`),
    h('ul', { class: 'mlist mmap-list' }, rows.map((m) => h('li', {}, mappingLine(m)))));
  if (st.mapOpen) det.open = true;
  det.addEventListener('toggle', () => { st = setMapOpen(st, det.open); });
  return det;
}

function duplicatesBlock(app) {
  const rows = duplicateRows(st);
  if (!rows.length) return null;
  return h('div', { class: 'mdups' },
    h('h3', { class: 'sec-title' }, 'Possible duplicates'),
    h('p', { class: 'muted' }, 'You already logged a workout on these days. They are skipped unless you switch them on.'),
    rows.map((d) => h('label', { class: 'mrow mdup' },
      h('span', { class: 'grow' }, `${d.name} · ${d.day}`),
      h('span', { class: 'muted' }, 'Import anyway'),
      h('input', {
        type: 'checkbox', 'data-key': `import.dup.${d.ref}`, checked: d.checked, disabled: st.stage === 'importing',
        'aria-label': `Import anyway: ${d.name} on ${d.day}`, onChange: () => toggle(app, d.ref),
      }))));
}

export function importBody(app) {
  const busy = st.stage === 'importing';
  const nodes = [
    h('p', { class: 'muted' }, 'Choose the JSON made by tools/import-strive.mjs. It is read on this device only.'),
    h('label', { class: 'mlabel' }, h('span', { class: 'muted' }, 'Strive export file (.json)'), fileField(app)),
  ];
  if (st.stage === 'reading') nodes.push(h('p', { class: 'muted', role: 'status' }, 'Reading the file…'));
  if (st.message) {
    nodes.push(h('p', { class: `tnotice ${st.kind === 'error' ? 'danger' : 'muted'}`, role: 'status', tabindex: '-1', 'data-key': 'import.msg' }, st.message));
  }
  if (st.preview && (st.stage === 'preview' || busy)) {
    nodes.push(h('div', { class: 'mimport' },
      h('p', { class: 'num mpreview', tabindex: '-1', role: 'status', 'data-key': 'import.preview' }, previewLine(st.preview)),
      repairNote(st.preview) ? h('p', { class: 'muted' }, repairNote(st.preview)) : null,
      mappingBlock(st.preview),
      duplicatesBlock(app),
      h('div', { class: 'mactions' },
        h('button', {
          type: 'button', class: 'tap primary', 'data-key': 'import.go', 'aria-busy': busy ? 'true' : 'false',
          disabled: !canImport(st.preview) || st.planning || busy, onClick: () => doImport(app),
        }, busy ? 'Importing…' : importLabel(st.preview)))));
  }
  if (focusKey) {
    const k = focusKey;
    focusKey = null;
    setTimeout(() => { try { document.querySelector(`[data-key="${k}"]`)?.focus(); } catch { /* ignore */ } }, 0);
  }
  return h('div', { class: 'mform mform-in' }, nodes);
}
