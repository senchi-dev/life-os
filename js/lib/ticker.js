// A repaint loop that holds no state: paint() once now, then once per interval. start() is idempotent, so a
// re-render can never leave two intervals running; stop() is safe to call any number of times.
export function createTicker(paint, { setTimer = setInterval, clearTimer = clearInterval, ms = 1000 } = {}) {
  let handle = null;
  const safe = () => { try { paint(); } catch { /* a bad paint must not kill the clock */ } };
  return {
    start() {
      if (handle !== null) return;
      safe();
      handle = setTimer(safe, ms);
    },
    stop() {
      if (handle === null) return;
      clearTimer(handle);
      handle = null;
    },
    get running() { return handle !== null; },
  };
}
