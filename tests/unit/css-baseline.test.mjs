import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Readability baseline (phase 2c): no text below 13px outside the tab bar, 15px/500 section
// headings, 44px rows, Big type rows 20-22px, tabular numbers.
const root = new URL('../../', import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), 'utf8');
const FILES = ['css/app.css', 'css/gym.css', 'css/layouts.css', 'css/calendar.css'];

// Flatten a stylesheet into { selector, body } rules, descending into @media/@supports and
// skipping @keyframes. Braces are matched the same way as tokens.test's block().
function rules(src) {
  const out = [];
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const head = s.slice(i, open).trim();
    let depth = 0, close = open;
    for (; close < s.length; close++) {
      if (s[close] === '{') depth++;
      else if (s[close] === '}' && --depth === 0) break;
    }
    const body = s.slice(open + 1, close);
    if (/^@(media|supports)/.test(head)) out.push(...rules(body));
    else if (!head.startsWith('@')) out.push({ selector: head, body });
    i = close + 1;
  }
  return out;
}
const decl = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

const vars = Object.fromEntries([...rules(read('css/app.css')).find((r) => r.selector === ':root').body
  .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function px(v) {
  const varm = v.match(/^var\((--[\w-]+)\)$/);
  if (varm) {
    assert.ok(varm[1] in vars, `unknown token ${varm[1]}`);
    return px(vars[varm[1]]);
  }
  const m = v.match(/^([\d.]+)(px|rem)$/);
  assert.ok(m, `unresolvable font-size: ${v}`);
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}
// font-size from `font-size:` or the size part of a `font:` shorthand.
function fontSize(body) {
  const fs = decl(body, 'font-size');
  if (fs) return fs;
  const f = decl(body, 'font');
  if (!f || f === 'inherit') return null;
  const m = f.match(/(var\(--[\w-]+\)|[\d.]+(?:px|rem))(?:\/[\d.]+)?/);
  return m ? m[1] : null;
}

const all = FILES.flatMap((f) => (existsSync(join(root, f)) ? rules(read(f)).map((r) => ({ ...r, file: f })) : []));
const find = (sel) => all.filter((r) => r.selector.split(',').map((x) => x.trim()).includes(sel));

test('layouts.css exists', () => {
  assert.ok(existsSync(join(root, 'css/layouts.css')));
});
test('no text below 13px outside the tab bar', () => {
  const small = [];
  for (const r of all) {
    const v = fontSize(r.body);
    if (v == null || r.selector.includes('.tabbar')) continue;
    if (px(v) < 13) small.push(`${r.file} ${r.selector}: ${v} = ${px(v)}px`);
  }
  assert.deepEqual(small, []);
});
test('.sec-title is 15px weight 500', () => {
  const r = find('.sec-title');
  assert.ok(r.length, 'missing .sec-title');
  const fs = r.map((x) => fontSize(x.body)).filter(Boolean).at(-1);
  assert.equal(px(fs), 15);
  assert.equal(r.map((x) => decl(x.body, 'font-weight')).filter(Boolean).at(-1), '500');
});
test('.blk-row is at least 44px tall', () => {
  const mh = find('.blk-row').map((x) => decl(x.body, 'min-height')).filter(Boolean).at(-1);
  assert.ok(mh, 'missing .blk-row min-height');
  assert.ok(px(mh) >= 44, mh);
});
test('Big type rows resolve to 20-22px', () => {
  const fs = find('[data-layout="big"] .blk-row').map((x) => fontSize(x.body)).filter(Boolean).at(-1);
  assert.ok(fs, 'missing [data-layout="big"] .blk-row font-size');
  assert.ok(px(fs) >= 20 && px(fs) <= 22, `${fs} = ${px(fs)}px`);
});
test('Big type Agenda rows resolve to 20-22px and at least 44px tall', () => {
  const r = find('[data-layout="big"] .cal .blk-list > .citem');
  const fs = r.map((x) => fontSize(x.body)).filter(Boolean).at(-1);
  assert.ok(fs, 'missing Big Agenda row font-size');
  assert.ok(px(fs) >= 20 && px(fs) <= 22, `${fs} = ${px(fs)}px`);
  const mh = r.map((x) => decl(x.body, 'min-height')).filter(Boolean).at(-1);
  assert.ok(mh && px(mh) >= 44, `min-height ${mh}`);
});
test('.num uses tabular-nums', () => {
  assert.ok(find('.num').some((x) => decl(x.body, 'font-variant-numeric') === 'tabular-nums'));
});
test('index.html loads layouts.css after gym.css', () => {
  const html = read('index.html');
  const g = html.indexOf('<link rel="stylesheet" href="css/gym.css">');
  const l = html.indexOf('<link rel="stylesheet" href="css/layouts.css">');
  assert.ok(g >= 0 && l > g);
});
test('workout set table: 44px rows, 16px inputs in every layout, one 5-column grid', () => {
  const mh = find('.wk-row').map((x) => decl(x.body, 'min-height')).filter(Boolean).at(-1);
  assert.ok(mh && px(mh) >= 44, `.wk-row min-height ${mh}`);
  const fs = find('.wk-in').map((x) => fontSize(x.body)).filter(Boolean).at(-1);
  assert.ok(fs, 'missing .wk-in font-size');
  assert.equal(px(fs), 16);
  for (const r of all.filter((x) => x.selector.includes('[data-layout') && x.selector.includes('.wk-'))) {
    const v = fontSize(r.body);
    if (r.selector.includes('.wk-in') && v != null) assert.ok(px(v) >= 16, `${r.selector}: ${v}`);
    assert.equal(decl(r.body, 'grid-template-columns'), null, `${r.selector} changes the grid`);
    const rmh = decl(r.body, 'min-height');
    if (rmh && /\.wk-(row|in)\b/.test(r.selector)) assert.ok(px(rmh) >= 44, `${r.selector}: ${rmh}`);
  }
  const grid = find('.wk-row').map((x) => decl(x.body, 'grid-template-columns')).filter(Boolean).at(-1);
  assert.equal(grid, '44px minmax(0, 1fr) 72px 64px 48px');
});
test('row labels with a sub line truncate: the label is a block box in a shrinkable column', () => {
  const lab = find('.blk-row .grow > .ellip');
  assert.ok(lab.length, 'missing .blk-row .grow > .ellip');
  assert.equal(lab.map((x) => decl(x.body, 'display')).filter(Boolean).at(-1), 'block');
  const ellip = find('.ellip').at(-1)?.body ?? '';
  assert.equal(decl(ellip, 'overflow'), 'hidden');
  assert.equal(decl(ellip, 'text-overflow'), 'ellipsis');
  assert.equal(decl(ellip, 'white-space'), 'nowrap');
  const grow = find('.blk-row > .grow').concat(find('.grow'));
  assert.ok(grow.some((x) => decl(x.body, 'min-width') === '0'), '.grow needs min-width: 0');
});
test('Big type score caption is at least 13px', () => {
  const fs = find('.blk-score-cap').map((x) => fontSize(x.body)).filter(Boolean).at(-1);
  assert.ok(fs, 'missing .blk-score-cap font-size');
  assert.ok(px(fs) >= 13, `${fs} = ${px(fs)}px`);
});
