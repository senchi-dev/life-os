import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const css = readFileSync(join(root, 'css/app.css'), 'utf8');

// Brace-matched body of the first block that starts with `head`.
function block(src, head) {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `missing: ${head}`);
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open + 1, j);
  }
  throw new Error(`unbalanced: ${head}`);
}
const decls = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

// Spec 2.1 values. A12 overrides: --faint raised (both themes) and light --accent darkened
// so every text pair reaches 4.5:1.
const DARK = {
  '--bg': '#0b0c0e', '--surface': '#15171a', '--surface-2': '#1e2125', '--line': '#272b30',
  '--fg': '#f2f3f5', '--muted': '#8c929a', '--faint': '#868c94', '--accent': '#2fd27a',
  '--accent-ink': '#03140a', '--accent-tint': 'rgba(47,210,122,.12)', '--danger': '#ff6b5e',
};
const LIGHT = {
  '--bg': '#f5f6f7', '--surface': '#ffffff', '--surface-2': '#eceef1', '--line': '#dfe2e6',
  '--fg': '#0e1013', '--muted': '#5c636b', '--faint': '#666d75', '--accent': '#0a7239',
  '--accent-ink': '#ffffff', '--accent-tint': 'rgba(10,114,57,.10)', '--danger': '#c0392b',
};

const dark = decls(block(css, ':root {'));
const light = decls(block(css, ':root[data-theme="light"]'));
const system = decls(block(block(css, '@media (prefers-color-scheme: light)'), ':root[data-theme="system"]'));

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('dark tokens are the :root default', () => {
  for (const [k, v] of Object.entries(DARK)) assert.equal(dark[k], v, k);
});
test('light tokens under data-theme=light and under system + prefers light', () => {
  for (const [k, v] of Object.entries(LIGHT)) {
    assert.equal(light[k], v, `light ${k}`);
    assert.equal(system[k], v, `system ${k}`);
  }
});
test('type, spacing and radius scales', () => {
  const t = decls(block(css, ':root {'));
  assert.equal(t['--fs-label'], '0.75rem');
  assert.equal(t['--fs-s'], '0.8125rem');
  assert.equal(t['--fs-m'], '1rem');
  assert.equal(t['--fs-l'], '1.25rem');
  assert.equal(t['--fs-xl'], '1.75rem');
  assert.equal(t['--fs-display'], '3.5rem');
  assert.equal(t['--fs-clock'], '2.75rem');
  ['4px', '8px', '12px', '16px', '24px', '32px', '48px'].forEach((v, i) => assert.equal(t[`--s${i + 1}`], v));
  assert.equal(t['--r-s'], '8px');
  assert.equal(t['--r-m'], '14px');
  assert.equal(t['--r-pill'], '999px');
});

for (const [name, T] of [['dark', DARK], ['light', LIGHT]]) {
  test(`${name}: every text token reaches 4.5:1 on every surface`, () => {
    for (const text of ['--fg', '--muted', '--faint', '--accent', '--danger']) {
      for (const bg of ['--bg', '--surface', '--surface-2']) {
        const r = ratio(T[text], T[bg]);
        assert.ok(r >= 4.5, `${name} ${text} on ${bg} = ${r.toFixed(2)}`);
      }
    }
    // Done state: accent text on the tint composited over each surface (.habit.is-done, .chip.is-done).
    const [tr, tg, tb, ta] = T['--accent-tint'].match(/[\d.]+/g).map(Number);
    const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    for (const bg of ['--bg', '--surface', '--surface-2']) {
      const base = [1, 3, 5].map((i) => parseInt(T[bg].slice(i, i + 2), 16));
      const comp = hex([tr, tg, tb].map((v, i) => v * ta + base[i] * (1 - ta)));
      const rt = ratio(T['--accent'], comp);
      assert.ok(rt >= 4.5, `${name} accent on tint over ${bg} = ${rt.toFixed(2)}`);
    }
    const ink = ratio(T['--accent-ink'], T['--accent']);
    assert.ok(ink >= 4.5, `${name} accent-ink on accent = ${ink.toFixed(2)}`);
  });
}

test('prefers-reduced-motion block collapses motion to 0.01ms', () => {
  const b = block(css, '@media (prefers-reduced-motion: reduce)');
  assert.match(b, /0\.01ms/);
});
test('flat: no shadows, no gradients', () => {
  for (const m of css.matchAll(/box-shadow\s*:\s*([^;]+);/g)) assert.equal(m[1].trim(), 'none');
  assert.ok(!/gradient/i.test(css));
});
test('no hacky negative margins', () => {
  assert.ok(!css.includes('-8px'));
  assert.ok(!/button\.link\.num[^{]*\{[^}]*margin\s*:\s*-/.test(css));
  assert.ok(!/\.link\.num[^{]*\{[^}]*margin\s*:\s*-/.test(css));
});
test('.mconfirm: danger text only, no danger fill or border', () => {
  const b = block(css, '.mconfirm');
  assert.match(b, /color:\s*var\(--danger\)/);
  assert.ok(!/background|border/.test(b.replace(/border-color:\s*var\(--line\)/g, '')), b);
});
test('shared classes exist', () => {
  for (const c of ['.card', '.label', '.num-display', '.row-list', '.pill', '.pending', '.minibar', '.seg']) assert.ok(css.includes(c), c);
});
test('app.css stays under 800 lines', () => {
  assert.ok(css.split('\n').length < 800);
});
test('manifest colours are dark --bg', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.theme_color, '#0b0c0e');
  assert.equal(m.background_color, '#0b0c0e');
});
