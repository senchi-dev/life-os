import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, text, all, byClass } from './fixtures/fake-dom.mjs';

installFakeDom();
const B = await import('../../js/ui/blocks.js');

const ITEMS = [
  { key: 'water', label: 'Water', value: '1.5', unit: 'L', progress: 0.6 },
  { key: 'sleep', label: 'Sleep', value: '1.5', unit: 'L' },
];

test('section: sentence-case heading with count', () => {
  const s = B.section({ title: 'Habits', count: '2 of 4' }, B.list());
  assert.equal(s.tag, 'section');
  assert.ok(s.classList.contains('blk-sec'));
  assert.equal(s.attrs['aria-label'], 'Habits');
  const h2 = all(s).find((x) => x.tag === 'h2');
  assert.ok(h2.classList.contains('sec-title'));
  assert.equal(text(h2), 'Habits · 2 of 4');
  const plain = B.section({ title: 'Habits' });
  assert.equal(text(all(plain).find((x) => x.tag === 'h2')), 'Habits');
});

test('section: aside sits after the heading', () => {
  const aside = B.list();
  const s = B.section({ title: 'Habits', aside });
  assert.ok(all(s).includes(aside));
});

test('metrics per layout', () => {
  const tiles = B.metrics(ITEMS, { layout: 'tiles' });
  assert.equal(byClass(tiles, 'blk-tiles').length, 1);
  const ts = byClass(tiles, 'blk-tile');
  assert.equal(ts.length, 2);
  assert.equal(byClass(ts[0], 'bar').length, 1);
  assert.equal(byClass(ts[1], 'bar').length, 0);

  const list = B.metrics(ITEMS, { layout: 'list' });
  assert.ok(list.classList.contains('blk-list'));
  assert.equal(list.classList.contains('blk-big'), false);
  const rows = byClass(list, 'blk-row');
  assert.equal(rows.length, 2);
  for (const r of rows) {
    const v = byClass(r, 'blk-val');
    assert.equal(v.length, 1);
    assert.ok(v[0].classList.contains('num'));
    assert.equal(text(v[0]), '1.5 L');
  }

  const big = B.metrics(ITEMS, { layout: 'big' });
  assert.ok(big.classList.contains('blk-list'));
  assert.ok(big.classList.contains('blk-big'));
  assert.equal(byClass(big, 'blk-row').length, 2);
});

test('metrics: onClick makes a button with aria-label and aria-expanded', () => {
  for (const layout of ['list', 'tiles', 'big']) {
    let n = 0;
    const el = B.metrics([{ key: 'w', label: 'Water', value: '1.5', unit: 'L', onClick: () => { n += 1; }, expanded: false }], { layout });
    const btn = all(el).find((x) => x.tag === 'button');
    assert.ok(btn, layout);
    assert.equal(btn.attrs['aria-label'], 'Water 1.5 L');
    assert.equal(btn.attrs['aria-expanded'], 'false');
    btn.listeners.click.forEach((fn) => fn({}));
    assert.equal(n, 1, layout);
  }
  const given = B.metrics([{ label: 'Steps', value: 9000, onClick: () => {}, ariaLabel: 'Steps today' }], { layout: 'list' });
  const btn = all(given).find((x) => x.tag === 'button');
  assert.equal(btn.attrs['aria-label'], 'Steps today');
  assert.equal(btn.attrs['aria-expanded'], undefined);
  const noClick = B.metrics([{ label: 'Steps', value: 9000 }], { layout: 'tiles' });
  assert.equal(all(noClick).some((x) => x.tag === 'button'), false);
});

test('layoutNow reads <html data-layout>', () => {
  const ds = document.documentElement.dataset;
  ds.layout = 'tiles';
  assert.equal(B.layoutNow(), 'tiles');
  assert.equal(byClass(B.metrics(ITEMS), 'blk-tiles').length, 1);
  ds.layout = 'x';
  assert.equal(B.layoutNow(), 'list');
  delete ds.layout;
  assert.equal(B.layoutNow(), 'list');
});

test('statusRow words', () => {
  const words = { done: 'Done', todo: 'To do', skipped: 'Skipped' };
  assert.deepEqual(B.STATUS_WORDS, words);
  for (const [status, word] of Object.entries(words)) {
    const r = B.statusRow({ label: 'Read', status });
    assert.equal(r.tag, 'div');
    const s = byClass(r, 'blk-status')[0];
    assert.ok(s.classList.contains(`is-${status}`));
    assert.equal(text(s), word);
  }
  const g = B.statusRow({ label: 'Read', status: 'done', glyph: '✓' });
  const s = byClass(g, 'blk-status')[0];
  const glyph = s.kids.find((k) => k.attrs?.['aria-hidden'] === 'true');
  assert.equal(text(glyph), '✓');
  assert.ok(text(s).includes('Done'));
  assert.equal(text(B.statusRow({ label: 'x', status: 'later' })).includes('later'), true);
  let n = 0;
  const b = B.statusRow({ label: 'Read', status: 'todo', sub: 'Evening', onClick: () => { n += 1; } });
  assert.equal(b.tag, 'button');
  assert.ok(b.classList.contains('tap') && b.classList.contains('blk-row'));
  assert.equal(byClass(b, 'blk-sub').length, 1);
  b.listeners.click[0]({});
  assert.equal(n, 1);
  assert.equal(B.statusRow({ label: 'Read', status: 'todo', button: true }).tag, 'button');
});

test('valueRow: href → link with chevron, value in .num.blk-val', () => {
  const a = B.valueRow({ label: 'Weight', value: '72.4 kg', href: '#/health' });
  assert.equal(a.tag, 'a');
  assert.equal(a.attrs.href, '#/health');
  const v = byClass(a, 'blk-val')[0];
  assert.ok(v.classList.contains('num'));
  assert.equal(text(v), '72.4 kg');
  const chev = all(a).find((x) => text(x) === '›' && x.attrs['aria-hidden'] === 'true');
  assert.ok(chev);
  assert.equal(B.valueRow({ label: 'W', value: 1, onClick: () => {} }).tag, 'button');
  assert.equal(B.valueRow({ label: 'W', value: 1 }).tag, 'div');
  assert.equal(B.list(B.valueRow({ label: 'W', value: 1 })).kids.length, 1);
});

test('score: ring for list and tiles, numeral for big', () => {
  for (const layout of ['list', 'tiles']) {
    const r = B.score({ value: 72, good: true, ariaLabel: 'Day score 72 of 100', layout });
    assert.ok(r.classList.contains('ring'), layout);
    assert.equal(r.attrs['aria-label'], 'Day score 72 of 100');
  }
  const big = B.score({ value: 72, ariaLabel: 'Day score 72 of 100', layout: 'big' });
  assert.ok(big.classList.contains('blk-score'));
  assert.equal(text(byClass(big, 'blk-score-num')[0]), '72');
  assert.equal(byClass(big, 'blk-score-cap').length, 0);
  assert.equal(big.attrs.role, 'img');
  assert.equal(big.attrs['aria-label'], 'Day score 72 of 100');
});

test('score: Big type shows the label as a caption under the numeral, like the ring', () => {
  const big = B.score({ value: 72, label: 'Day score', ariaLabel: 'Day score 72 of 100', layout: 'big' });
  assert.equal(big.attrs.role, 'img');
  assert.equal(big.attrs['aria-label'], 'Day score 72 of 100');
  const num = byClass(big, 'blk-score-num');
  const cap = byClass(big, 'blk-score-cap');
  assert.equal(num.length, 1);
  assert.equal(text(num[0]), '72');
  assert.equal(cap.length, 1);
  assert.equal(text(cap[0]), 'Day score');
  assert.ok(big.kids.indexOf(num[0]) < big.kids.indexOf(cap[0]), 'caption sits under the numeral');
});
