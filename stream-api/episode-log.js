'use strict';
// Rate-limit the LOG of a retry loop without touching the loop.
//
// A reconnect loop that retries every few seconds is usually right; logging
// every attempt is not — obs.js wrote two lines per 5 s for as long as OBS was
// closed, which is most of every day. An "episode" is one unbroken run of
// failures: note() says whether THIS failure should be logged (the first, then
// one per `everyMs`) and how many were swallowed since the last logged one;
// end() closes the episode on recovery so the next failure speaks again.

function createEpisodeLog({ everyMs = 600_000, now = Date.now } = {}) {
  let open = false;
  let lastLogAt = 0;
  let suppressed = 0;
  return {
    note() {
      const t = now();
      if (!open || t - lastLogAt >= everyMs) {
        const out = { log: true, suppressed };
        open = true; lastLogAt = t; suppressed = 0;
        return out;
      }
      suppressed += 1;
      return { log: false, suppressed };
    },
    /** Close the episode. Returns whether one was open (i.e. worth a "recovered" line). */
    end() {
      const was = open;
      open = false; suppressed = 0;
      return was;
    },
  };
}

module.exports = { createEpisodeLog };
