import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, symlinkSync, writeFileSync, existsSync, cpSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const script = join(root, 'tools/publish-public.sh');
const src = existsSync(script) ? readFileSync(script, 'utf8') : '';
// Built at runtime so this shipped file never contains the term the tests put in the denylist.
const S = 'zz-not-' + 'present-zz';
const ORIGIN = 'https://github.com/senchi-dev/life-os.git';
const mk = (name) => mkdtempSync(join(tmpdir(), name));
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const pubRepo = (origin = ORIGIN) => { const d = mk('lifeos-pub-'); git(d, 'init', '-q', '-b', 'main'); if (origin) git(d, 'remote', 'add', 'origin', origin); return d; };
const denyFile = (text) => { const f = join(mk('lifeos-deny-'), 'deny'); if (text !== null) writeFileSync(f, text); return f; };
const run = (args, env, cwd = root, sh = script) =>
  spawnSync('bash', [sh, ...args], {
    cwd, encoding: 'utf8', input: '',
    env: { PATH: process.env.PATH, HOME: mk('lifeos-home-'), PUBLISH_ALLOW_DIRTY: '1', PUBLISH_SKIP_TESTS: '1', ...env },
  });
const dry = (pub, deny, extra = {}, cwd, sh) =>
  run(['--dry-run'], { LIFEOS_PUBLIC_DIR: pub, PUBLISH_DENYLIST: deny, ...extra }, cwd, sh);
const out = (r) => r.stdout + r.stderr;

// A throwaway committed copy of the repo (path contains a space), optionally with extra tracked files.
function repoCopy(extra = {}) {
  const base = mk('lifeos copy-');
  const d = join(base, 'my repo');
  mkdirSync(d);
  for (const f of ['index.html', 'sw.js', 'package.json', 'manifest.webmanifest', '.gitattributes', 'css', 'js', 'icons', 'vendor', 'tools', 'supabase']) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(d, f), { recursive: true });
  }
  for (const [p, c] of Object.entries(extra)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c); }
  mkdirSync(join(d, 'docs')); writeFileSync(join(d, 'docs/secret.md'), 'private');
  mkdirSync(join(d, '.superpowers')); writeFileSync(join(d, '.superpowers/x.md'), 'private');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'add', '-A', '-f'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}

test('script exists, is executable and statically hardened', () => {
  assert.ok(existsSync(script), 'tools/publish-public.sh missing');
  assert.ok(statSync(script).mode & 0o100, 'not executable');
  assert.match(src, /^#!\/usr\/bin\/env bash\n/);
  assert.match(src, /^set -euo pipefail$/m);
  assert.match(src, /stamp-sw\.mjs --check/);
  assert.match(src, /rm -rf "\$STAGE\/docs" "\$STAGE\/\.superpowers"/);
  assert.match(src, /mktemp -d/);
  assert.match(src, /trap .*EXIT/);
  assert.match(src, /read -r -p 'Type publish to push to origin main: ' ANSWER < \/dev\/tty/);
  assert.match(src, /\[ -t 0 \] && \[ -t 1 \]/);
  assert.match(src, /"\$ANSWER" = "publish"/);
  assert.match(src, /rsync -a --delete --exclude \.git/);
  assert.match(src, /grep -rIiF -f/);
});

test('git push appears exactly once, after the prompt; never forced', () => {
  const lines = src.split('\n').filter((l) => !/^\s*#/.test(l));
  const push = lines.map((l, i) => (/\bgit\b.*\spush(\s|$)/.test(l) ? i : -1)).filter((i) => i >= 0);
  const prompt = lines.findIndex((l) => l.includes('read -r -p'));
  assert.equal(push.length, 1);
  assert.ok(prompt >= 0 && push[0] > prompt);
  assert.doesNotMatch(src, /--force|--force-with-lease|\bpush\b[^\n]*\s-f\b|\+main/);
  assert.match(lines[push[0] - 1] + lines[push[0]] + (lines[push[0] - 2] || ''), /"\$ANSWER" = "publish"/);
});

test('I3: a real run asks, from /dev/tty, that migration 004 is applied before anything is synced or pushed', () => {
  const lines = src.split('\n').filter((l) => !/^\s*#/.test(l));
  const ask = lines.findIndex((l) => l.includes("Migration 004 applied in Supabase and rls.sql showed RLS OK? Type yes: "));
  assert.ok(ask >= 0, 'the 004 prompt exists');
  assert.match(lines[ask], /read -r -p '[^']*' MIGRATED < \/dev\/tty/, 'read from /dev/tty');
  const block = lines.slice(Math.max(0, ask - 6), ask + 4).join('\n');
  assert.match(block, /if \[ "\$DRY" -ne 1 \]/, 'only on a real run');
  assert.match(block, /\[ "\$MIGRATED" = "yes" \] \|\| die/, 'anything but yes aborts');
  const pushPrompt = lines.findIndex((l) => l.includes("Type publish to push to origin main"));
  const push = lines.findIndex((l) => /\bgit\b.*\spush(\s|$)/.test(l));
  const sync = lines.findIndex((l) => /^rsync -a --delete/.test(l));
  assert.ok(ask < sync && ask < pushPrompt && ask < push, 'asked before the sync, the push prompt and the push');
});

test('guard: the env overrides are honoured only with --dry-run', () => {
  assert.match(src, /ignored without --dry-run/);
  assert.match(src, /dry-run needs an existing LIFEOS_PUBLIC_DIR/);
});

test('dry run end to end: exit 0, index.html shipped, docs and .superpowers absent', () => {
  const pub = pubRepo();
  const r = dry(pub, denyFile(S + '\n'));
  assert.equal(r.status, 0, out(r));
  assert.ok(existsSync(join(pub, 'index.html')));
  assert.ok(!existsSync(join(pub, 'docs')));
  assert.ok(!existsSync(join(pub, '.superpowers')));
  assert.ok(!existsSync(join(pub, '.git', 'COMMIT_EDITMSG')), 'dry run must not commit');
});

test('dry run is idempotent and removes stale files from the public dir (--delete)', () => {
  const pub = pubRepo();
  writeFileSync(join(pub, 'stale.txt'), 'x');
  const deny = denyFile(S + '\n');
  assert.equal(dry(pub, deny).status, 0);
  assert.ok(!existsSync(join(pub, 'stale.txt')));
  assert.equal(dry(pub, deny).status, 0);
});

test('works from a repo path containing a space (committed copy, docs stripped)', () => {
  const d = repoCopy();
  const pub = pubRepo();
  const r = dry(pub, denyFile(S + '\n'), {}, d, join(d, 'tools/publish-public.sh'));
  assert.equal(r.status, 0, out(r));
  assert.ok(existsSync(join(pub, 'index.html')));
  assert.ok(!existsSync(join(pub, 'docs')) && !existsSync(join(pub, '.superpowers')));
});

test('denylist hit is fatal and the matched term is never printed (only file names)', () => {
  const pub = pubRepo();
  const r = dry(pub, denyFile('Life OS\n'));
  assert.notEqual(r.status, 0);
  assert.ok(!out(r).includes('Life OS'), 'leaked the denylist term');
  assert.match(out(r), /index\.html|\.js|\.css/);
});

test('denylist match is case-insensitive and ignores nothing else (term in a tmp copy file)', () => {
  const d = repoCopy({ 'js/zz.js': '// SecretCorpName was here\n' });
  const pub = pubRepo();
  const r = dry(pub, denyFile('secretcorpname\n'), {}, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.ok(!/secretcorpname/i.test(out(r)));
  assert.match(out(r), /zz\.js/);
});

test('denylist missing, empty, whitespace-only and comment-only are all fatal', () => {
  for (const text of [null, '', '\n\n', '   \n\t\n', '# only a comment\n']) {
    const pub = pubRepo();
    const r = dry(pub, denyFile(text));
    assert.notEqual(r.status, 0, JSON.stringify(text));
    assert.match(out(r), /denylist/i);
  }
});

test('shipped-file leak guards are fatal (tracked strive/lifeos/db/sqlite/env files)', () => {
  const cases = ['bad.strive.json', 'x/y.LIFEOS.JSON', 'data.db', 'a/b.SQLITE', '.env', '.env.local'];
  for (const name of cases) {
    const d = repoCopy({ [name]: 'secret' });
    const pub = pubRepo();
    const r = dry(pub, denyFile(S + '\n'), {}, d, join(d, 'tools/publish-public.sh'));
    assert.notEqual(r.status, 0, name);
    assert.ok(!out(r).includes('"secret"'));
  }
});

test('dirty tree is fatal without PUBLISH_ALLOW_DIRTY', () => {
  const d = repoCopy();
  writeFileSync(join(d, 'untracked.txt'), 'x');
  const pub = pubRepo();
  const env = { PUBLISH_ALLOW_DIRTY: '', PUBLISH_SKIP_TESTS: '1' };
  const r = dry(pub, denyFile(S + '\n'), env, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.match(out(r), /dirty/i);
  const ok = dry(pub, denyFile(S + '\n'), { PUBLISH_ALLOW_DIRTY: '1' }, d, join(d, 'tools/publish-public.sh'));
  assert.equal(ok.status, 0, out(ok));
});

test('stale stamp is fatal', () => {
  const d = repoCopy();
  writeFileSync(join(d, 'js/app.js'), readFileSync(join(d, 'js/app.js'), 'utf8') + '\n// edit\n');
  git(d, 'commit', '-qam', 'edit');
  const r = dry(pubRepo(), denyFile(S + '\n'), {}, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.match(out(r), /stamp is stale/);
});

test('env overrides are ignored (with a warning) without --dry-run, and nothing is pushed', () => {
  const d = repoCopy();
  writeFileSync(join(d, 'untracked.txt'), 'x');
  const pub = pubRepo();
  const r = run([], { LIFEOS_PUBLIC_DIR: pub, PUBLISH_DENYLIST: denyFile(S + '\n') }, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.match(out(r), /ignored without --dry-run/);
  assert.match(out(r), /dirty/i);
  assert.ok(!existsSync(join(pub, 'index.html')));
});

test('dry run refuses to clone when the public dir is absent or not a git repo', () => {
  const gone = join(mk('lifeos-gone-'), 'nope');
  const r = dry(gone, denyFile(S + '\n'));
  assert.notEqual(r.status, 0);
  assert.match(out(r), /dry-run needs an existing LIFEOS_PUBLIC_DIR/);
  assert.ok(!existsSync(gone));
  const plain = mk('lifeos-plain-');
  const r2 = dry(plain, denyFile(S + '\n'));
  assert.notEqual(r2.status, 0);
  assert.match(out(r2), /not a git repo/);
});

test('unknown arguments are rejected', () => {
  const r = run(['--bogus'], { LIFEOS_PUBLIC_DIR: pubRepo(), PUBLISH_DENYLIST: denyFile('zz\n') });
  assert.notEqual(r.status, 0);
});

// ---- round 1 review fixes ---------------------------------------------------------------------------------
const j = (...a) => a.join('');
const okDeny = () => denyFile(S + '\n');
const dryCopy = (extra, deny = okDeny(), pub = pubRepo(), env = {}) => {
  const d = repoCopy(extra);
  return { d, pub, r: dry(pub, deny, env, d, join(d, 'tools/publish-public.sh')) };
};
const fakeNpm = () => { const b = mk('lifeos-bin-'); writeFileSync(join(b, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); return b; };

test('real run never pushes without an interactive terminal, whatever is piped in', () => {
  for (const input of ['y\n', 'publish\n', 'y\n'.repeat(200)]) {
    const d = repoCopy();
    const pub = pubRepo();
    // GIT_ALLOW_PROTOCOL=file: even a broken gate could not reach the network from this test.
    const r = spawnSync('bash', [join(d, 'tools/publish-public.sh')], {
      cwd: d, input, encoding: 'utf8',
      env: { PATH: fakeNpm() + ':' + process.env.PATH, HOME: mk('lifeos-home-'), LIFEOS_PUBLIC_DIR: pub, PUBLISH_DENYLIST: okDeny(),
        GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
    });
    assert.notEqual(r.status, 0);
    assert.match(out(r), /interactive terminal/);
    assert.ok(!existsSync(join(pub, 'index.html')), 'public dir was modified');
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: pub }).status, 0, 'a commit was made');
  }
});

test('built-in secret guard: each planted secret is fatal and never echoed', () => {
  const cases = {
    'js/a.js': j('const k = "sb_', 'secret_', 'AbCdEf0123456789";'),
    'js/b.js': j('const t = "ey', 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0.', 'abcdefghij";'),
    'js/c.js': j('// -----BEGIN ', 'RSA PRIVATE KEY-----\n'),
    'js/d.js': j('service', '_role = "', 'abcdefghijklmnopqrstuvwxyz0123";'),
    'js/e.js': j('service', "_role: '", 'abcdefghijklmnopqrstuvwxyz0123', "'"),
    'x.pem': 'x', 'sub/k.KEY': 'x', '.npmrc': 'x', 'ssh/id_rsa': 'x', 'ssh/id_rsa.pub': 'x',
  };
  for (const [name, body] of Object.entries(cases)) {
    const { r } = dryCopy({ [name]: body });
    assert.notEqual(r.status, 0, name);
    assert.ok(!out(r).includes('abcdefghijkl') && !out(r).includes('AbCdEf0123') && !out(r).includes('PRIVATE KEY'), `echoed secret for ${name}`);
  }
});

test('secret guard does not trip on public keys or the bare word service_role', () => {
  const { r } = dryCopy({
    'js/pub.js': j('const k = "sb_', 'publishable_', 'AbCdEf0123456789AbCdEf";'),
    'js/word.js': '// never ship the service' + '_role key to the browser\n',
  });
  assert.equal(r.status, 0, out(r));
});

test('denylist term in a file or directory name is fatal and the name is masked', () => {
  for (const path of ['js/qzxterm-notes.js', 'qzxterm-dir/a.js', 'JS/QZXTERM/x.css']) {
    const { r } = dryCopy({ [path]: 'harmless' }, denyFile('qzxterm\n'));
    assert.notEqual(r.status, 0, path);
    assert.ok(!/qzxterm/i.test(out(r)), `echoed the term for ${path}`);
    assert.match(out(r), /name/i);
  }
});

test('binary and UTF-16 content is scanned: term inside NUL data, a png, and UTF-16 text is fatal', () => {
  const term = 'qzxterm';
  const nul = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(term), Buffer.from([0, 0])]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), Buffer.from('xx' + term + 'yy')]);
  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello ' + term, 'utf16le')]);
  const noBom = Buffer.from('hello ' + term, 'utf16le');
  const be = Buffer.from('hello ' + term, 'utf16le').swap16();
  const cases = { 'data.bin': nul, 'img/x.png': png, 'u16.txt': bom, 'u16b.txt': noBom, 'u16be.txt': be };
  for (const [name, body] of Object.entries(cases)) {
    const { r } = dryCopy({ [name]: body }, denyFile(term + '\n'));
    assert.notEqual(r.status, 0, name);
    assert.ok(!out(r).includes(term), `echoed the term for ${name}`);
  }
});

test('extension allowlist: unknown types are fatal, allowlisted png/ico/woff2/svg pass', () => {
  assert.notEqual(dryCopy({ 'tools/x.exe': 'MZ' }).r.status, 0);
  assert.notEqual(dryCopy({ 'a/b.zip': 'PK' }).r.status, 0);
  assert.notEqual(dryCopy({ 'noext': 'x' }).r.status, 0);
  const ok = dryCopy({ 'i/a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), 'i/b.ico': Buffer.from([0, 0, 1, 0]), 'i/c.svg': '<svg/>', 'f/d.woff2': Buffer.from([0, 1]) });
  assert.equal(ok.r.status, 0, out(ok.r));
});

test('symlinks and .DS_Store in the tree are fatal', () => {
  assert.notEqual(dryCopy({ '.DS_Store': 'x' }).r.status, 0);
  const d = repoCopy();
  symlinkSync('/etc/hosts', join(d, 'link.txt'));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'link');
  const r = dry(pubRepo(), okDeny(), {}, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.match(out(r), /symlink/i);
});

test('denylist: UTF-8 BOM on the first line is stripped; a #term line is warned about', () => {
  const f = join(mk('lifeos-deny-'), 'deny');
  writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('qzxterm\n#hashterm\n')]));
  const { r } = dryCopy({ 'js/z.js': '// qzxterm\n' }, f);
  assert.notEqual(r.status, 0);
  assert.match(out(r), /starting with '#'/);
});

test('public dir validation: must be a git root with the right origin, separate from the private repo', () => {
  const deny = okDeny();
  const sub = (() => { const p = pubRepo(); mkdirSync(join(p, 'sub')); return join(p, 'sub'); })();
  const run1 = (pub, env = {}) => dry(pub, deny, env);
  assert.notEqual(run1(sub).status, 0, 'subdirectory of a repo');
  assert.match(out(run1(sub)), /root of a git repo/);
  assert.notEqual(run1(pubRepo('https://github.com/someone/else.git')).status, 0, 'wrong origin');
  assert.match(out(run1(pubRepo('https://github.com/someone/else.git'))), /origin/);
  assert.notEqual(run1(pubRepo(null)).status, 0, 'no origin');
  const home = pubRepo();
  assert.notEqual(run1(home, { HOME: home }).status, 0, 'HOME');
  assert.match(out(run1(home, { HOME: home })), /HOME/);
  assert.notEqual(run1('/').status, 0, 'root dir');
  for (const origin of [ORIGIN, 'https://GitHub.com/Senchi-Dev/Life-OS', 'git@github.com:senchi-dev/life-os.git', 'ssh://git@github.com/senchi-dev/life-os.git']) {
    const r = run1(pubRepo(origin));
    assert.equal(r.status, 0, `${origin}\n${out(r)}`);
  }
  for (const origin of ['https://github.com/senchi-dev/life-os-evil.git', 'https://evil.com/senchi-dev/life-os.git', 'https://github.com/senchi-dev/life-os.git.evil']) {
    assert.notEqual(run1(pubRepo(origin)).status, 0, origin);
  }
});

test('public dir nested inside, or containing, the private repo is fatal', () => {
  const d = repoCopy();
  const nested = join(d, 'nested'); mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main'); git(nested, 'remote', 'add', 'origin', ORIGIN);
  const r = dry(nested, okDeny(), {}, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.match(out(r), /separate directory/);
  const parent = join(d, '..');
  git(parent, 'init', '-q', '-b', 'main'); git(parent, 'remote', 'add', 'origin', ORIGIN);
  const r2 = dry(parent, okDeny(), {}, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r2.status, 0);
  assert.match(out(r2), /separate directory/);
});

test('stamp check fails closed: output must say "stamp is current"', () => {
  assert.match(src, /stamp is current/);
});

// ---- round 2 review fixes ---------------------------------------------------------------------------------
test('no check prints a denylisted term from a path (names check runs first, every path masked)', () => {
  const term = 'Qzxsurname';
  const cases = [
    { [`cv-${term}.pdf`]: 'x' },            // non-allowlisted extension
    { [`.env.${term}`]: 'x' },              // private-file name check
    { [`${term}.EXE`]: 'MZ' },
    { [`js/${term}.db`]: 'x' },
  ];
  for (const extra of cases) {
    const { r } = dryCopy(extra, denyFile(term.toLowerCase() + '\n'));
    assert.notEqual(r.status, 0, Object.keys(extra)[0]);
    assert.ok(!out(r).toLowerCase().includes(term.toLowerCase()), `leaked term via ${Object.keys(extra)[0]}: ${out(r)}`);
  }
  const d = repoCopy();
  symlinkSync('/etc/hosts', join(d, `${term}.html`));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'link');
  const r = dry(pubRepo(), denyFile(term + '\n'), {}, d, join(d, 'tools/publish-public.sh'));
  assert.notEqual(r.status, 0);
  assert.ok(!out(r).toLowerCase().includes(term.toLowerCase()), 'leaked term via symlink name');
});

test('content and secret hits print masked paths (term in the file name is hidden)', () => {
  const term = 'qzxsurname';
  const a = dryCopy({ [`js/${term}-a.js`]: `// ${term}\n` }, denyFile(term + '\n'));
  assert.notEqual(a.r.status, 0);
  assert.ok(!out(a.r).toLowerCase().includes(term));
});

test('.claude/ is stripped from the stage and never ships', () => {
  const { r, pub } = dryCopy({ '.claude/launch.json': '{}' });
  assert.equal(r.status, 0, out(r));
  assert.ok(!existsSync(join(pub, '.claude')));
  assert.match(src, /rm -rf "\$STAGE\/docs" "\$STAGE\/\.superpowers" "\$STAGE\/\.claude"/);
  assert.match(src, /\.claude\/ present/);
});

test('origin redirection via pushurl, insteadOf or pushInsteadOf is fatal', () => {
  const bare = mk('lifeos-bare-'); git(bare, 'init', '-q', '--bare');
  for (const [k, v] of [['remote.origin.pushurl', bare], [`url.${bare}.insteadOf`, ORIGIN], [`url.${bare}.pushInsteadOf`, ORIGIN]]) {
    const pub = pubRepo();
    git(pub, 'config', k, v);
    const r = dry(pub, okDeny());
    assert.notEqual(r.status, 0, k);
    assert.match(out(r), /origin/, k);
  }
});

test('service role assignments are caught in common spellings, case-insensitively', () => {
  const v = j('abcdefghij', 'klmnopqrstuvwxyz0123');
  const cases = [j('SERVICE', '_ROLE_KEY=', v), j('const service', 'Role = "', v, '";'), j('Service', '-Role: ', v), j('supabase', 'ServiceRoleKey: "', v, '"')];
  for (const body of cases) {
    const { r } = dryCopy({ 'js/s.js': body + '\n' });
    assert.notEqual(r.status, 0, body.slice(0, 20));
    assert.ok(!out(r).includes(v));
  }
  const short = dryCopy({ 'js/s.js': j('SERVICE', '_ROLE_KEY=', 'short') + '\n' });
  assert.equal(short.r.status, 0, out(short.r));
});

// ---- round 3 review fixes ---------------------------------------------------------------------------------
const subs4 = (terms) => {
  const all = new Set();
  for (const t of terms) for (const form of [t, t.normalize('NFC'), t.normalize('NFD')]) {
    const l = form.toLowerCase();
    for (let i = 0; i + 4 <= l.length; i++) for (let k = i + 4; k <= l.length; k++) all.add(l.slice(i, k));
  }
  return [...all];
};
const assertNoLeak = (r, terms) => {
  const o = out(r).toLowerCase();
  for (const s of subs4(terms)) assert.ok(!o.includes(s), `output leaks "${s}":\n${out(r)}`);
};

test('mask merges overlapping and nested term spans against the original name', () => {
  const cases = [
    { terms: ['0612', '0612345678'], file: 'tel-0612345678.md', shown: 'tel-***.md' },
    { terms: ['0612345678', '0612'], file: 'tel-0612345678.md', shown: 'tel-***.md' },
    { terms: ['abcde', 'abc', 'cde'].slice(1), file: 'abcde.md', shown: '***.md' },
    { terms: ['345', '0612345678'], file: 'n-0612345678-x.md', shown: 'n-***-x.md' },
    { terms: ['0612345678', '345'], file: 'n-0612345678-x.md', shown: 'n-***-x.md' },
    { terms: ['abcd', 'cdef', 'efgh'], file: 'xabcdefghx.md', shown: 'x***x.md' },
    { terms: ['efgh', 'abcd', 'cdef'], file: 'XABCDEFGHX.md', shown: 'X***X.md' },
  ];
  for (const { terms, file, shown } of cases) {
    const { r } = dryCopy({ [`js/${file}`]: 'x' }, denyFile(terms.join('\n') + '\n'));
    assert.notEqual(r.status, 0, file);
    assert.ok(out(r).includes(`js/${shown}`), `expected js/${shown} in:\n${out(r)}`);
    assertNoLeak(r, terms.filter((t) => t.length >= 4));
  }
});

test('accented terms: NFD file names and content still match an NFC denylist term, output masked', () => {
  const term = 'josé';
  for (const extra of [{ [`cv-${'José'.normalize('NFD')}.md`]: 'x' }, { 'js/n.js': `// ${'JOSÉ'.normalize('NFD')}\n` }, { [`cv-JOSÉ.md`]: 'x' }]) {
    const { r } = dryCopy(extra, denyFile(term + '\n'));
    assert.notEqual(r.status, 0, Object.keys(extra)[0]);
    assertNoLeak(r, [term, 'jose']);
  }
});

test('rsync errors are printed masked', () => {
  const term = 'qzx' + 'leakterm'; // built at runtime: this test scans the real (committed) tree
  const pub = pubRepo();
  const ro = join(pub, 'ro'); mkdirSync(ro);
  writeFileSync(join(ro, `${term}-cv.md`), 'x');
  spawnSync('chmod', ['555', ro]);
  try {
    const r = dry(pub, denyFile(term + '\n'));
    assert.notEqual(r.status, 0, out(r));
    assertNoLeak(r, [term]);
    assert.match(out(r), /rsync/);
  } finally {
    spawnSync('chmod', ['755', ro]);
  }
});

test('nested .claude/ directories are stripped anywhere in the tree', () => {
  const { r, pub } = dryCopy({ 'js/.claude/settings.json': '{}', 'a/b/.Claude/x.json': '{}' });
  assert.equal(r.status, 0, out(r));
  assert.ok(!existsSync(join(pub, 'js/.claude')) && !existsSync(join(pub, 'a/b/.Claude')));
  assert.match(src, /\.claude/);
});

test('service role guard: references are not secrets; spaced and env forms are', () => {
  const v = j('abcdefghij', 'klmnopqrstuvwxyz0123');
  const refs = [
    j('const service', 'RoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY_FOR_ADMIN;'),
    j('const k = { service', 'RoleKey: config.serviceRoleKeyValueFromSettings };'),
    j('service', 'Role = getServiceRoleFromVaultNow();'),
  ];
  for (const body of refs) {
    const { r } = dryCopy({ 'js/s.js': body + '\n' });
    assert.equal(r.status, 0, `${body}\n${out(r)}`);
  }
  for (const body of [j('service role', ' key = ', v), j('SERVICE', '_ROLE_KEY=', v), j('service', '_role: `', v, '`')]) {
    const { r } = dryCopy({ 'js/s.js': body + '\n' });
    assert.notEqual(r.status, 0, body.slice(0, 18));
    assert.ok(!out(r).includes(v));
  }
});
