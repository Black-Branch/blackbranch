// A concurrency bound with a short queue, shared by the server paths that must
// not let a slow dependency pile requests up: the Matrix media relay, and the
// billing paths that hold a database connection across Stripe calls
// (billingConnections.ts).

export type Release = () => void;

/** `acquire()` resolves to a release function, or to null when the queue is
 *  full or the wait ran out. The caller answers 503 then, rather than piling
 *  requests up behind slow work. A release is idempotent; a freed slot goes
 *  straight to the oldest waiter. */
export function createConcurrencyGate(opts: { maxConcurrent: number; maxQueued: number; maxWaitMs: number }) {
  let active = 0;
  const waiting: Array<(r: Release | null) => void> = [];

  function slot(): Release {
    active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active--;
      const next = waiting.shift();
      if (next) next(slot());
    };
  }

  function acquire(): Promise<Release | null> {
    if (active < opts.maxConcurrent) return Promise.resolve(slot());
    if (waiting.length >= opts.maxQueued) return Promise.resolve(null);
    return new Promise((resolve) => {
      const serve = (r: Release | null) => { clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => {
        const i = waiting.indexOf(serve);
        if (i >= 0) waiting.splice(i, 1);
        resolve(null);
      }, opts.maxWaitMs);
      waiting.push(serve);
    });
  }

  return { acquire };
}
