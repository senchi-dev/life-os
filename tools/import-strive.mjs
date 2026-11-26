#!/usr/bin/env node
// Local tool (NOT shipped, NOT in the service-worker SHELL): turns a Strive backup (.db) into a 'lifeos-strive-1' JSON
// that the in-app import reads. The JSON holds personal data: it is never written inside the repo (*.strive.json is gitignored too).
//
// Usage: node tools/import-strive.mjs <backup.db> [--out <file>] [--dry-run] [--from-json-dir <dir>]
//   default out: <db dir>/<db basename without extension>.strive.json
//   --dry-run     print the report (counts, mapping), write nothing
//   --from-json-dir <dir>  fallback when node:sqlite is unavailable: export each table first with
//     sqlite3 -readonly -json <backup.db> "select * from <table>" > <dir>/<table>.json
//     for the 8 tables + personal_records (personal_records.json optional); <backup.db> is then only used to name the output.
// Exit codes: 0 ok, 1 counts mismatch or read error, 2 usage error or refusing to write inside the repo.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, basename, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseStrive, buildImportPlan, mappingLine, STRIVE_FORMAT } from '../js/lib/strive-import.js';
import { replayPrs } from '../js/lib/gym-stats.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TABLES = ['routine_logs', 'routine_exercise_logs', 'routine_exercise_set_logs', 'routines', 'routine_exercise_sets', 'exercises', 'routine_exercise_notes', 'routine_exercises'];

const sourceCountsOf = (raw, prCount) => ({
  sessions: raw.routine_logs.length, entries: raw.routine_exercise_logs.length, sets: raw.routine_exercise_set_logs.length, personal_records: prCount,
});

// node:sqlite is loaded lazily so the --from-json-dir fallback works on a Node without it (and prints no ExperimentalWarning).
export function loadSqlite(req = createRequire(import.meta.url)) {
  try { return req('node:sqlite'); } catch (e) {
    throw new Error(`node:sqlite is not available on this Node (${e.message}); export the tables with sqlite3 and use --from-json-dir (see the file header)`);
  }
}

export function readStriveDb(path) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const raw = {};
    for (const t of TABLES) raw[t] = db.prepare(`select * from ${t}`).all().map((r) => ({ ...r }));
    const pr = db.prepare('select count(*) as n from personal_records').get().n; // counted only, never imported (A17)
    raw.sourceCounts = sourceCountsOf(raw, Number(pr));
    return raw;
  } finally { db.close(); }
}

const readTable = (f) => { const t = readFileSync(f, 'utf8'); return t.trim() === '' ? [] : JSON.parse(t); }; // sqlite3 -json writes nothing for zero rows

export function readJsonDir(dir) {
  const raw = {};
  for (const t of TABLES) raw[t] = readTable(join(dir, `${t}.json`));
  const pf = join(dir, 'personal_records.json');
  raw.sourceCounts = sourceCountsOf(raw, existsSync(pf) ? readTable(pf).length : 0);
  return raw;
}

export function exportedCounts(json) {
  const w = json.workouts ?? [];
  return {
    sessions: w.length,
    entries: w.reduce((n, x) => n + x.exercises.length, 0),
    sets: w.reduce((n, x) => n + x.exercises.reduce((m, e) => m + e.sets.length, 0), 0),
  };
}

function replayedPrCount(json) {
  const per = new Map();
  for (const w of json.workouts) for (const e of w.exercises) {
    if (!per.has(e.exercise_ref)) per.set(e.exercise_ref, []);
    per.get(e.exercise_ref).push({ startedAt: w.started_at, sets: e.sets.map((s) => ({ ...s, id: s.ref })) });
  }
  let n = 0;
  for (const sessions of per.values()) for (const f of replayPrs(sessions).values()) if (f) n++;
  return n;
}

// The mapping is the in-app plan's own, against a fresh library: only exercise names and notes-free rows go in, so the
// report shows exactly what the import would create or rename.
async function freshMapping(json) {
  const exercises = json.exercises.map((x) => ({ ...x, how_to: '' }));
  const empty = { format: STRIVE_FORMAT, counts: { sessions: 0, entries: 0, sets: 0 }, exercises, routines: [], workouts: [] };
  const state = { importedRefs: new Set(), nativeDays: new Set(), childCounts: new Map() };
  const { preview } = await buildImportPlan({ json: empty, snapshot: { exercises: [] }, importState: state, userId: 'dry-run' });
  return preview.mapping;
}

// Never includes note text or ids (names of exercises are fine).
export async function dryRunReport(json, sourceCounts, prCountStrive) {
  const got = exportedCounts(json);
  const same = got.sessions === sourceCounts.sessions && got.entries === sourceCounts.entries && got.sets === sourceCounts.sets;
  const sets = json.workouts.flatMap((w) => w.exercises.flatMap((e) => e.sets));
  const known = json.workouts.filter((w) => w.duration_known).length;
  const lines = [
    `sessions ${got.sessions} · entries ${got.entries} · sets ${got.sets}`,
    same ? 'counts OK' : `COUNTS MISMATCH (source: sessions ${sourceCounts.sessions}, entries ${sourceCounts.entries}, sets ${sourceCounts.sets})`,
    `dropsets ${sets.filter((s) => s.type === 'dropset').length}`,
    `how-to notes ${json.exercises.filter((x) => x.how_to).length} · session notes ${json.workouts.filter((w) => w.note).length}`,
    `durations known ${known} · unknown ${json.workouts.length - known}`,
    `Strive PRs ${prCountStrive} · replayed here ${replayedPrCount(json)}`,
    'mapping:',
  ];
  for (const m of await freshMapping(json)) lines.push(`  ${mappingLine(m)}`);
  return lines.join('\n');
}

function realish(p) { // realpath of the deepest existing ancestor + the rest, so symlinks cannot hide a repo path
  let head = resolve(p); const tail = [];
  while (!existsSync(head) && dirname(head) !== head) { tail.unshift(basename(head)); head = dirname(head); }
  return join(realpathSync.native(head), ...tail);
}
export function isInsideRepo(out, root = REPO) {
  const rel = relative(resolve(root), resolve(out));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function parseArgs(argv) {
  const a = { db: null, out: null, dry: false, jsonDir: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dry = true;
    else if (v === '--out' || v === '--from-json-dir') {
      if (i + 1 >= argv.length) return null;
      a[v === '--out' ? 'out' : 'jsonDir'] = argv[++i];
    } else if (v.startsWith('--') || a.db) return null;
    else a.db = v;
  }
  return a.db ? a : null;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args) { console.error('Usage: node tools/import-strive.mjs <backup.db> [--out <file>] [--dry-run] [--from-json-dir <dir>]'); return 2; }
  const db = resolve(args.db);
  const out = resolve(args.out ?? join(dirname(db), `${basename(db, extname(db))}.strive.json`));
  if (!args.dry && (isInsideRepo(out) || isInsideRepo(realish(out)))) { console.error('refusing to write inside the repo'); return 2; }
  let raw, json;
  try {
    raw = args.jsonDir ? readJsonDir(resolve(args.jsonDir)) : readStriveDb(db);
    json = normaliseStrive(raw);
  } catch (e) { console.error(`could not read the backup: ${e.message}`); return 1; }
  const got = exportedCounts(json), src = raw.sourceCounts;
  const same = got.sessions === src.sessions && got.entries === src.entries && got.sets === src.sets;
  console.log(await dryRunReport(json, src, src.personal_records));
  if (!same) return 1;
  if (args.dry) return 0;
  writeFileSync(out, JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote ${out}`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));

