// Tiny async key-value store contract: { get, set, del, delPrefix }. Memory version for tests and demo mode.
export function createMemoryKv() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? structuredClone(m.get(key)) : undefined; },
    async set(key, value) { m.set(key, structuredClone(value)); },
    async del(key) { m.delete(key); },
    async delPrefix(prefix) { for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k); },
  };
}
