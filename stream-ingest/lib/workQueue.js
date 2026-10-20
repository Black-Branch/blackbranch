// Bounded async work queue with a fixed worker-pool concurrency.
//
// Why this exists: the platform connectors call processMessage() once per
// incoming chat event WITHOUT awaiting, so without a bound a chat burst would fan
// out an unbounded number of concurrent fetches at stream-api (saturating its
// database pool) and at the model provider (dozens of concurrent scoring calls),
// and chat would fall further behind under load. Routing that work through a queue with
// a fixed worker pool bounds the in-flight concurrency, so throughput is steady
// instead of collapsing under a thundering herd.
//
// `maxQueue` is the backpressure ceiling: once the backlog exceeds it, new work
// is shed (onDrop) rather than letting the backlog — and latency — grow without
// bound. Delivery uses a high ceiling (never want to drop a message); enrichment
// (scoring/embedding) uses a low ceiling since gaps in it are harmless.

export function createWorkQueue({
  concurrency = 4,
  maxQueue = Infinity,
  onDrop,
} = {}) {
  /** @type {Array<() => Promise<unknown>>} */
  const q = [];
  let active = 0;

  function drain() {
    while (active < concurrency && q.length) {
      const fn = q.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .catch(() => {}) // jobs own their error handling; never crash the worker
        .finally(() => {
          active--;
          drain();
        });
    }
  }

  return {
    /**
     * Enqueue a job. Returns true if accepted, false if shed (queue full).
     * @param {() => Promise<unknown>} fn
     */
    push(fn) {
      if (q.length >= maxQueue) {
        onDrop?.();
        return false;
      }
      q.push(fn);
      drain();
      return true;
    },
    get size() {
      return q.length;
    },
    get active() {
      return active;
    },
  };
}
