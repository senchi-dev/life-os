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

export function createOutbox({ backend, storage, onChange = () => {}, onAuthError = null }) {
  let ops = [];
  let running = null;
  let runningGen = -1;
  let gen = 0; // bumped by clear(); stale flushes must stop touching the queue
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

  async function doFlush(myGen, silentAuth) {
    let sent = 0;
    let authStop = false;
    const failed = [];
    while (gen === myGen && ops.length) {
      const op = ops[0];
      if (!applied.has(op.id)) {
        try {
          await apply(op);
        } catch (err) {
          if (gen !== myGen) break;
          const kind = err?.kind ?? classifyError(err);
          if (kind === 'auth') authStop = true;
          if (kind === 'network' || kind === 'auth') break;
          if (ops[0] !== op) break;
          ops.shift();
          failed.push(op);
          await persist();
          onChange(ops.length);
          continue;
        }
        applied.add(op.id);
        sent++;
      }
      if (gen !== myGen || ops[0] !== op) break;
      ops.shift();
      await persist();
      onChange(ops.length);
    }
    if (authStop && onAuthError && !silentAuth) {
      // Once per run, after this flush has settled, so a recovery can start a fresh flush.
      setTimeout(() => { try { Promise.resolve(onAuthError()).catch(() => {}); } catch { /* ignore */ } }, 0);
    }
    return authStop ? { sent, remaining: ops.length, failed, authStop: true } : { sent, remaining: ops.length, failed };
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
    flush({ silentAuth = false } = {}) {
      if (running && runningGen === gen) return running;
      const prev = running;
      runningGen = gen;
      const g = gen;
      const p = (prev ? prev.catch(() => {}) : Promise.resolve())
        .then(() => doFlush(g, silentAuth))
        .finally(() => { if (running === p) running = null; });
      running = p;
      return p;
    },
    pending: () => ops.length,
    async clear() {
      gen++;
      ops = [];
      saveChain = saveChain.catch(() => {}).then(() => storage.clear());
      await saveChain;
      onChange(0);
    },
  };
}
