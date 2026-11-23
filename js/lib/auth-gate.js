// Pure auth helpers. No DOM, no network, no logging of emails or codes.
export function authGate(event, session) {
  if (event === 'SIGNED_OUT' || !session) return 'login';
  return 'app';
}

const RATE = 'Too many codes requested. Wait a minute.';
const BAD_CODE = 'Code wrong or expired. Request a new one.';
const NO_SEND = 'Could not send a code to this address.';
const OFFLINE = 'No connection. Check your network and try again.';

// step: 'send' | 'verify'. Unknown-user and every other send failure share one message,
// so the UI never reveals whether an address has an account.
export function authMessage(err, step) {
  const msg = String(err?.message ?? '');
  const code = String(err?.code ?? '');
  if (err?.status === 429 || /rate_?limit/i.test(code) || /rate.?limit|too many/i.test(msg)) return RATE;
  if (err instanceof TypeError || /failed to fetch|network|load failed/i.test(msg)) return OFFLINE;
  return step === 'verify' ? BAD_CODE : NO_SEND;
}

// The outbox holds unsynced user writes: drop it only on an explicit sign-out, or when the
// session check succeeded and truly found no session. A failed check (offline, transient) keeps it.
export function shouldClearOutbox({ event, error, session } = {}) {
  if (event === 'SIGNED_OUT') return true;
  if (session) return false;
  if (error) return false;
  return true;
}
