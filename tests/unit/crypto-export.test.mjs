import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptExport, decryptExport, validatePassphrase, exportFileName,
} from '../../js/lib/crypto-export.js';

const sample = { habits: [{ id: 'h1', name: 'Run' }], n: 3, s: 'é✓' };
const PASS = 'correct horse battery';
const b64len = (s) => Buffer.from(s, 'base64').length;

test('round-trip returns deep-equal object', async () => {
  const text = await encryptExport(sample, PASS, { iterations: 1000 });
  assert.deepEqual(await decryptExport(text, PASS), sample);
});

test('default envelope has expected parameters', async () => {
  const env = JSON.parse(await encryptExport(sample, PASS));
  assert.equal(env.format, 'lifeos-export');
  assert.equal(env.v, 1);
  assert.ok(!Number.isNaN(Date.parse(env.created_at)));
  assert.equal(env.kdf.name, 'PBKDF2');
  assert.equal(env.kdf.hash, 'SHA-256');
  assert.equal(env.kdf.iterations, 600000);
  assert.equal(b64len(env.kdf.salt), 16);
  assert.equal(env.cipher.name, 'AES-GCM');
  assert.equal(env.cipher.length, 256);
  assert.equal(b64len(env.cipher.iv), 12);
  assert.ok(!JSON.stringify(env).includes('Run'));
});

test('two encryptions differ in salt, iv and data', async () => {
  const a = JSON.parse(await encryptExport(sample, PASS, { iterations: 1000 }));
  const b = JSON.parse(await encryptExport(sample, PASS, { iterations: 1000 }));
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.data, b.data);
});

test('wrong passphrase rejects', async () => {
  const text = await encryptExport(sample, PASS, { iterations: 1000 });
  await assert.rejects(decryptExport(text, 'another passphrase!'), /Wrong passphrase or damaged file/);
});

test('tampered data and garbage reject with same message', async () => {
  const env = JSON.parse(await encryptExport(sample, PASS, { iterations: 1000 }));
  const c = env.data[10] === 'A' ? 'B' : 'A';
  env.data = env.data.slice(0, 10) + c + env.data.slice(11);
  await assert.rejects(decryptExport(JSON.stringify(env), PASS), /Wrong passphrase or damaged file/);
  await assert.rejects(decryptExport('not json', PASS), /Wrong passphrase or damaged file/);
  await assert.rejects(decryptExport('{"format":"other"}', PASS), /Wrong passphrase or damaged file/);
});

test('large payload does not overflow the stack', async () => {
  const big = { blob: 'x'.repeat(2_000_000) };
  const text = await encryptExport(big, PASS, { iterations: 1000 });
  assert.equal((await decryptExport(text, PASS)).blob.length, 2_000_000);
});

test('validatePassphrase', () => {
  assert.equal(validatePassphrase('short', 'short'), 'At least 12 characters');
  assert.equal(validatePassphrase('twelve chars!', 'twelve chars?'), 'Passphrases differ');
  assert.equal(validatePassphrase('twelve chars!', 'twelve chars!'), null);
});

test('exportFileName', () => {
  assert.equal(exportFileName('2026-11-23'), 'life-os-export-2026-11-23.lifeos.json');
});
