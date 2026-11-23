// Offline write queue. FIFO, one flush at a time, persisted via a storage adapter.
import { classifyError } from './backend-supabase.js';

export function createMemoryStorage() {
  let ops = [];
  return {
    async load() { return structuredClone(ops); },
    async save(next) { ops = structuredClone(next); },
    async clear() { ops = []; },
  };
}

export function createOutbox({ backend, storage, onChange = () => {} }) {
  let ops = [];
  let running = null;
  let saveChain = Promise.resolve();
  const applied = new Set(); // ids already sent this session: never apply twice

  const persist = () => {
    const snapshot = structuredClone(ops);
    saveChain = saveChain.catch(() => {}).then(() => storage.save(snapshot));
    return saveChain;
  };
  const apply = (op) => op.kind === 'remove'
    ? backend.remove(op.table, { eq: op.eq })
    : backend.upsert(op.table, op.rows, { onConflict: op.onConflict, ignoreDuplicates: op.ignoreDuplicates });

  async function doFlush() {
    let sent = 0;
    const failed = [];
    while (ops.length) {
      const op = ops[0];
      if (!applied.has(op.id)) {
        try {
          await apply(op);
        } catch (err) {
          const kind = err?.kind ?? classifyError(err);
          if (kind === 'network' || kind === 'auth') break;
          ops.shift();
          failed.push(op);
          await persist();
          onChange(ops.length);
          continue;
        }
        applied.add(op.id);
        sent++;
      }
      ops.shift();
      await persist();
      onChange(ops.length);
    }
    return { sent, remaining: ops.length, failed };
  }

  return {
    async init() {
      ops = await storage.load();
      onChange(ops.length);
    },
    async enqueue(op) {
      ops.push({ ...structuredClone(op), id: crypto.randomUUID() });
      await persist();
      onChange(ops.length);
    },
    flush() {
      running ??= doFlush().finally(() => { running = null; });
      return running;
    },
    pending: () => ops.length,
    async clear() {
      ops = [];
      await saveChain.catch(() => {});
      await storage.clear();
      onChange(0);
    },
  };
}
