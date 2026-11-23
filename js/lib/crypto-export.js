// Encrypted export: PBKDF2-SHA-256 -> AES-GCM-256. Uses globalThis.crypto.subtle only.
const FORMAT = 'lifeos-export';
const DEFAULT_ITERATIONS = 600000;
const MAX_ITERATIONS = 10000000;
const FAIL = 'Wrong passphrase or damaged file';
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(str) {
  if (typeof str !== 'string') throw new Error('bad base64');
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptExport(data, passphrase, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('Invalid iterations');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)),
  ));
  return JSON.stringify({
    format: FORMAT,
    v: 1,
    created_at: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', length: 256, iv: toB64(iv) },
    data: toB64(ct),
  });
}

export async function decryptExport(text, passphrase) {
  try {
    const env = JSON.parse(text);
    if (!env || env.format !== FORMAT || env.v !== 1) throw new Error('format');
    const { kdf, cipher } = env;
    if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') throw new Error('kdf');
    if (cipher.name !== 'AES-GCM' || cipher.length !== 256) throw new Error('cipher');
    const iterations = kdf.iterations;
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) throw new Error('iter');
    const salt = fromB64(kdf.salt);
    const iv = fromB64(cipher.iv);
    if (iv.length !== 12) throw new Error('iv');
    const key = await deriveKey(passphrase, salt, iterations);
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromB64(env.data));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error(FAIL);
  }
}

export function validatePassphrase(p1, p2) {
  if (typeof p1 !== 'string' || p1.length < 12) return 'At least 12 characters';
  if (p1 !== p2) return 'Passphrases differ';
  return null;
}

export function exportFileName(dateKey) {
  return `life-os-export-${dateKey}.lifeos.json`;
}
