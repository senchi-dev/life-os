#!/usr/bin/env node
// Restore drill: node tools/decrypt-export.mjs <file>. Passphrase is read from stdin (not echoed by us).
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { decryptExport } from '../js/lib/crypto-export.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/decrypt-export.mjs <file>');
  process.exit(2);
}

// Prompt goes to stderr so stdout carries only the JSON. Output stream is omitted so nothing is echoed back.
const rl = createInterface({ input: process.stdin });
process.stderr.write('Passphrase: ');
const passphrase = await new Promise((resolve) => {
  rl.once('line', resolve);
  rl.once('close', () => resolve(''));
});
rl.close();
process.stderr.write('\n');

try {
  const data = await decryptExport(await readFile(file, 'utf8'), passphrase);
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
