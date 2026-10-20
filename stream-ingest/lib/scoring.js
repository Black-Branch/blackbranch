// Message scoring is a plugin's, not the product's: a plugin may contribute a scorer, which
// the seam in index.js registers here; an install with none and its messages are simply not scored
// — no model call, no PATCH, no log line.
//
// A scorer answers, for one logged platform message, the best-effort jobs to queue on the
// pipeline's enrichment pool (each catches and logs its own failure):
//   { platformJobs({ id, clean, words }) → Array<() => Promise<void>> }

/** @typedef {{ platformJobs: (m: { id: string|number, clean: string, words: number }) => Array<() => Promise<void>> }} Scorer */

/** @type {Scorer|null} */
let registered = null;

/** Install the scorer (index.js, from a plugin's register()). Last one wins. */
export function registerScorer(s) {
  if (!s || typeof s.platformJobs !== 'function') throw new Error('registerScorer: a scorer needs platformJobs()');
  registered = s;
}

/** The registered scorer, or null when no plugin scores messages. */
export function scorer() {
  return registered;
}
