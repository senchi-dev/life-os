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
  for (const t of ['#/today', '#/gym', '#/calendar', '#/review', '#/more']) assert.ok(html.includes(`href="${t}"`), t);
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

test('index.html: five tabs in order, #pending status and #minibar link, gym stylesheet, both theme-color metas', () => {
  const tabs = [...html.matchAll(/<nav class="tabbar"[\s\S]*?<\/nav>/g)][0][0];
  assert.deepEqual([...tabs.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['#/today', '#/gym', '#/calendar', '#/review', '#/more']);
  assert.match(html, /<div id="pending" class="pending" role="status" hidden><\/div>/);
  assert.match(html, /<a id="minibar" class="minibar tap" href="#\/workout" hidden><\/a>/);
  assert.match(html, /<link rel="stylesheet" href="css\/gym\.css">/);
  const metas = [...html.matchAll(/<meta name="theme-color"[^>]*content="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(metas, ['#0b0c0e', '#0b0c0e']);
  assert.ok(existsSync(join(root, 'css/gym.css')));
});

test('More has an Appearance section (layout + colours); login has OTP input styling hooks', () => {
  const more = read('js/ui/more-view.js');
  assert.ok(more.includes("'Appearance'") && more.includes('writeTheme') && more.includes('applyTheme'));
  assert.ok(more.includes('writeLayout') && more.includes('applyLayout'));
  const auth = read('js/ui/auth-view.js');
  assert.ok(auth.includes('one-time-code') && auth.includes('auth-code') && auth.includes('Life OS'));
});

test('service worker install fetches every shell file cache-busted and fails on a bad response', async () => {
  const { readFile } = await import('node:fs/promises');
  const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /searchParams\.set\('v', CACHE\)/);
  assert.match(sw, /cache: 'reload'/);
  assert.match(sw, /if \(!res\.ok\) throw/);
  assert.match(sw, /c\.put\(new Request\(u\), res\)/);
  assert.doesNotMatch(sw, /addAll\(/);
});
