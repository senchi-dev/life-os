// Pure helpers of the Strive import screen: the preview line, error and result messages, the view state (kept in module
// scope by the view so a re-render of More never loses the chosen preview or toggles) and a stale-result guard.
import { ImportError } from '../lib/strive-import.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const NOT_STRIVE = 'This is not a Strive export from tools/import-strive.mjs.';
export const INCOMPLETE = 'The file is incomplete (counts do not match).';
export const NOT_READY = 'Exercise library not ready yet. Try again in a minute.';
export const GENERIC_ERROR = 'Import failed. Nothing was changed.';
export const TOO_BIG = 'This file is too large to be a Strive export (over 20 MB).';
export const NO_SESSIONS = 'This export contains no sessions to import.';
export const UNREADABLE = 'Could not read that file.';
const OFFLINE = 'You seem to be offline. Connect and try again; nothing was changed.';
const SESSION_EXPIRED = 'Your session expired. Sign in again; nothing was changed.';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "28 sessions · 249 exercise entries · ... · K already imported · D possible duplicates"
export function previewLine(p) {
  const d = p.possibleDuplicates?.length ?? 0;
  return [
    plural(p.sessions, 'session', 'sessions'),
    plural(p.entries, 'exercise entry', 'exercise entries'),
    plural(p.sets, 'set', 'sets'),
    plural(p.routines, 'routine', 'routines'),
    plural(p.exercisesCreated, 'exercise created', 'exercises created'),
    plural(p.howToNotes, 'how-to note', 'how-to notes'),
    plural(p.sessionNotes, 'session note', 'session notes'),
    `${p.alreadyImported} already imported`,
    plural(d, 'possible duplicate', 'possible duplicates'),
  ].join(' · ');
}

const itemName = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

// Human text for any failure. Names the offending lift/session when it is known; never echoes note text or ids.
export function importErrorMessage(err) {
  if (err instanceof ImportError) {
    const msg = String(err.message ?? '');
    switch (err.code) {
      case 'counts': return INCOMPLETE;
      case 'format': {
        if (/^not a Life OS Strive export/.test(msg)) return NOT_STRIVE;
        let m = /^how-to note too long \(\d+ > \d+\): ([\s\S]*)$/.exec(msg);
        if (m) return `The how-to note for "${itemName(m[1])}" is longer than 2000 characters.`;
        m = /^session note too long \(\d+ > \d+\): ([\s\S]*)$/.exec(msg);
        if (m) return `The note on the session "${itemName(m[1])}" is longer than 2000 characters.`;
        if (/^unknown exercise/.test(msg)) return 'The file refers to an exercise it does not contain.';
        if (/^alias target missing/.test(msg)) return 'An exercise in the file could not be matched to your library.';
        return NOT_STRIVE;
      }
      case 'unit': return 'The file has sets that are not in kilograms; only metric sets can be imported.';
      case 'set-type': return 'The file has a set type that cannot be imported (only normal and drop sets).';
      case 'timestamp': return 'A session in the file has a date outside 2020 to 2030.';
      default: return GENERIC_ERROR;
    }
  }
  if (err?.kind === 'network') return OFFLINE;
  if (err?.kind === 'auth') return SESSION_EXPIRED;
  return GENERIC_ERROR;
}

const ROUTINES_LOST = 'the routines or schedule were not';
// result: { status: 'done'|'offline'|'partial'|'auth'|'error', applied, total (both in SESSIONS), routinesNotSaved, message }
export function resultMessage(result, preview) {
  switch (result.status) {
    case 'done': {
      const { newSessions: n, repaired: m } = preview;
      if (n > 0 && m > 0) return `${plural(n, 'session', 'sessions')} imported, ${plural(m, 'session', 'sessions')} repaired.`;
      if (n > 0) return `Imported ${plural(n, 'session', 'sessions')}.`;
      return `Restored missing items for ${plural(m, 'session', 'sessions')}.`;
    }
    case 'offline': return 'Saved on this device. The import finishes when you are back online.';
    case 'partial':
      // The routines, their items and the schedule are written on a FIRST import only (once any imported workout exists a
      // repeat skips them), so when one of those writes was rejected a repeat cannot fix it: say so plainly.
      if (result.routinesNotSaved) {
        return result.applied === result.total
          ? `The workouts were imported, but ${ROUTINES_LOST}, and repeating the import will not recreate them. You can add routines manually in Gym.`
          : `Imported ${result.applied} of ${result.total} sessions, but ${ROUTINES_LOST} saved, and repeating the import will not recreate them. You can add routines manually in Gym.`;
      }
      return `Imported ${result.applied} of ${result.total} sessions; some items failed — try again, the import is safe to repeat.`;
    case 'auth': return 'Your session expired. Sign in again; the import is saved and finishes afterwards.';
    default: return result.message ?? GENERIC_ERROR;
  }
}

// ---- view state (immutable updates) ----
export const initialState = () => ({
  stage: 'idle', fileName: '', text: null, preview: null, includeDuplicates: new Set(), dupList: [], mapOpen: false, planning: false, message: '', kind: 'info',
});

export const withFile = (s, { name, text }) => ({ ...initialState(), stage: 'reading', fileName: name, text });

// The duplicate rows are remembered from the first plan: including one removes it from the next plan's list, and it must
// stay on screen (checked) so it can be switched off again.
export function withPreview(s, preview) {
  const seen = new Map(s.dupList.map((d) => [d.ref, d]));
  for (const d of preview.possibleDuplicates ?? []) if (!seen.has(d.ref)) seen.set(d.ref, d);
  return { ...s, stage: 'preview', preview, dupList: [...seen.values()], planning: false, message: '', kind: 'info' };
}
export const withError = (s, message) => ({ ...s, stage: 'error', preview: null, planning: false, message, kind: 'error' });
// A new plan is being computed (a duplicate was toggled): the shown preview is stale and must not be imported.
export const withPlanning = (s) => ({ ...s, planning: true });
export const duplicateRows = (s) => s.dupList.map((d) => ({ ...d, checked: s.includeDuplicates.has(d.ref) }));
export function toggleDuplicate(s, ref) {
  const next = new Set(s.includeDuplicates);
  if (next.has(ref)) next.delete(ref); else next.add(ref);
  return { ...s, includeDuplicates: next };
}
export const setMapOpen = (s, open) => ({ ...s, mapOpen: !!open });
export const canImport = (p) => !!p && (p.newSessions > 0 || p.repaired > 0);
// A repair is "sessions whose imported entries/sets fall short of the file". A deliberate deletion of an imported set looks the
// same, so the wording is neutral (never "interrupted").
export const importLabel = (p) => {
  if (!p) return 'Import';
  if (p.newSessions > 0) return 'Import';
  return p.repaired > 0 ? `Restore missing items (${plural(p.repaired, 'session', 'sessions')})` : 'Already imported';
};
export const repairNote = (p) => (p && p.newSessions > 0 && p.repaired > 0 ? `Also restores missing items in ${plural(p.repaired, 'session', 'sessions')}.` : null);
// A second start while one runs, or with nothing to import, returns the same state.
export const startImport = (s) => (s.stage === 'preview' && !s.planning && canImport(s.preview) ? { ...s, stage: 'importing' } : s);
export const finishImport = (s, message, kind) => ({ ...s, stage: 'done', text: null, message, kind });

// Only the newest async result may be applied (a quick second toggle must not be overwritten by a slower first one).
export function createLatest() {
  let n = 0;
  return { next: () => ++n, isCurrent: (t) => t === n };
}
