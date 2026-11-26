// Deterministic ids and slugs. Browser and Node safe (WebCrypto only).
// seedId gives the same uuid for the same (user, key) so seeding and the Strive import are idempotent.
export async function seedId(userId, key) {
  const data = new TextEncoder().encode(`lifeos:${userId}:${key}`);
  const b = new Uint8Array((await crypto.subtle.digest('SHA-256', data)).slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function slug(name) {
  return String(name).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
