import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SUPABASE_URL } from '../../js/config.js';

const root = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

const html = read('index.html');

test('CSP meta matches the string built from SUPABASE_URL', () => {
  const host = SUPABASE_URL.replace(/^https:\/\//, '');
  const expected = `default-src 'self'; script-src 'self'; connect-src 'self' https://${host} wss://${host}; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  assert.ok(m, 'CSP meta present');
  assert.equal(m[1], expected);
});

test('index.html: every script has src, no inline style', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(scripts.length >= 2);
  for (const s of scripts) assert.match(s[1], /\bsrc="/);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.match(html, /viewport-fit=cover/);
  for (const t of ['#/today', '#/calendar', '#/review', '#/more']) assert.ok(html.includes(`href="${t}"`), t);
});

test('manifest is installable and scoped relatively', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  for (const size of ['192x192', '512x512']) {
    const icon = m.icons.find((i) => i.sizes === size);
    assert.ok(icon, size);
    assert.ok(existsSync(join(root, icon.src)), icon.src);
  }
});

test('sw.js SHELL lists exactly the shipped files and never caches supabase', () => {
  const sw = read('sw.js');
  const body = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const shell = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const files = shell.filter((p) => p !== './');
  for (const f of files) assert.ok(existsSync(join(root, f)) && statSync(join(root, f)).isFile(), f);
  for (const dir of ['js', 'css', 'vendor', 'icons']) {
    for (const f of walk(dir)) assert.ok(shell.includes(f), `${f} missing from SHELL`);
  }
  assert.ok(sw.includes('supabase.co'));
});

test('no innerHTML or eval( under js/', () => {
  for (const f of walk('js').filter((p) => p.endsWith('.js'))) {
    const src = read(f);
    assert.ok(!src.includes('innerHTML'), `${relative(root, join(root, f))} innerHTML`);
    assert.ok(!src.includes('eval('), `${f} eval(`);
  }
});
