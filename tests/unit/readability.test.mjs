import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Readability baseline (phase 2c): screens moved onto layout blocks use sentence-case section
// titles (.sec-title via section()), not the old .cap labels, and say status in words.
const root = new URL('../../', import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), 'utf8');

const SCREENS = [
  'js/ui/today-view.js',
  'js/ui/gym-view.js', 'js/ui/history-view.js', 'js/ui/library-view.js',
  'js/ui/routine-view.js', 'js/ui/exercise-view.js', 'js/ui/import-view.js',
  'js/ui/review-view.js', 'js/ui/more-view.js',
];

test('screens on blocks use no .cap labels', () => {
  for (const f of SCREENS) {
    const s = read(f);
    assert.equal(/class: 'cap'/.test(s), false, `${f}: class: 'cap'`);
    assert.equal(/'cap /.test(s), false, `${f}: 'cap ...' class`);
    assert.equal(/h2', \{ class: 'cap/.test(s), false, `${f}: h2 with cap`);
  }
});

test('Today says habit status in words, not a ✓ / – mark', () => {
  const s = read('js/ui/today-view.js');
  assert.equal(/mark = .*['"]✓/.test(s), false, 'habit mark glyph');
});

test('workout set table keeps the check button', () => {
  const s = read('js/ui/workout-view.js');
  assert.match(s, /const tickGlyph = \(done\) => \(done \? '✓' : '○'\)/, 'tickGlyph helper');
  // In-place update: glyph, aria-pressed and the "<name> done" label are set together.
  const paint = s.slice(s.indexOf('function paintRow'), s.indexOf('function paintRow') + 1200);
  const upd = paint.slice(paint.indexOf("const tick = el.querySelector('.wk-tick')"), paint.indexOf("tick.classList.toggle('is-blocked'"));
  assert.match(upd, /\.wk-check'\)\.textContent = tickGlyph\(r\.done\)/);
  assert.match(upd, /setAttribute\('aria-pressed', String\(r\.done\)\)/);
  assert.match(upd, /setAttribute\('aria-label', `\$\{name\} done`\)/);
  // Initial build uses the same helper, never a hard-coded ✓ in the row button.
  assert.match(s, /class: 'wk-check', 'aria-hidden': 'true' \}, tickGlyph\(r\.done\)\)/);
  // Header cell stays ✓; exercise names are section titles.
  assert.match(s, /h\('span', \{\}, 'Reps'\), h\('span', \{\}, '✓'\)/);
  assert.match(s, /h2', \{ class: 'sec-title wk-exname'/);
});

test('Review numbers, habits and health are layout blocks', () => {
  const s = read('js/ui/review-view.js');
  assert.match(s, /import \{ section, metrics, valueRow, list \} from '\.\/blocks\.js'/);
  assert.match(s, /metrics\(\[\n\s+\{ key: 'sleep', label: 'Sleep avg'/);
  assert.match(s, /section\(\{ title: 'Habits' \}/);
  assert.match(s, /section\(\{ title: 'Health' \}/);
  assert.match(s, /h\('h2', \{ class: 'sec-title' \}, 'Last week’s change'\)/);
  assert.doesNotMatch(s, /rnums|class: 'rrow'/);
});

test('More: Appearance first, then Gym, then disclosure heads as .blk-row buttons with aria-expanded', () => {
  const s = read('js/ui/more-view.js');
  const shell = s.slice(s.indexOf('export function renderMore'));
  assert.ok(shell.indexOf('appearanceRow(app)') < shell.indexOf('gymRows(app)'));
  assert.ok(shell.indexOf('gymRows(app)') < shell.indexOf('sections(app)'));
  assert.match(shell, /class: 'tap blk-row', 'aria-expanded': open \? 'true' : 'false', onClick: \(\) => toggleSection\(app, id\)/);
  assert.match(shell, /h\('span', \{ class: 'num blk-val' \}, summary\)/);
  assert.doesNotMatch(s, /class: 'mhead/);
});
