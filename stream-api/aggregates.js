// ── Aggregate refresh ─────────────────────────────────────────────────────
// The stream.user_stats rebuild: six statements over stream.chat_log, run on an
// interval and after every identity merge, guarded by single-flight + coalesce.

const { refreshNames } = require('./names');
const { NATIVE_SQL } = require('./native-platform');
const { ERASED_CANONICAL } = require('./account-erase');

const REFRESH_MS = 2 * 60 * 1000;

// SINGLE-FLIGHT + COALESCE. refreshAggregates is a six-statement full rebuild
// over stream.chat_log — a CTE LEFT JOINing stream.users to the whole table
// with per-user correlated LIMIT-100 subqueries, then five full-table UPDATEs
// with PERCENT_RANK windows. Without an in-flight guard a pass longer than
// REFRESH_MS stacks on itself, and every identity merge detaches another copy,
// so a burst of merges launches many concurrent full rebuilds against the pool
// the live /chat INSERT path shares — and chat stalls waiting for a
// connection.
//
// Coalescing (rather than just dropping) matters: a merge that lands DURING a
// run must still be reflected, so a request arriving mid-flight schedules
// exactly one more pass afterwards. N concurrent requests collapse to at most
// 2 runs — the one already going, plus one that sees everything.
//
// Exported on its own so aggregate-refresh.test.js exercises this policy
// directly.
//
// `request.stop()` is the shutdown half (index.js's drain): no pass starts after it, a queued
// follow-up is dropped, and it resolves when the pass already running has ended (createAggregates's
// guard cuts that pass after its current statement) — so the drain ends the pool after the last query.
function makeRefresher(work, onError = () => {}) {
  let inflight = null;
  let queued = false;
  let stopped = false;
  function request() {
    if (stopped) return Promise.resolve();
    if (inflight) { queued = true; return inflight; }   // fold callers into one follow-up pass
    inflight = work()
      .catch(onError)
      .finally(() => {
        inflight = null;
        if (queued && !stopped) { queued = false; request(); }
      });
    return inflight;
  }
  request.stop = () => {
    stopped = true;
    queued = false;
    return inflight || Promise.resolve();
  };
  return request;
}

// `schedule` is injectable so the start() wiring — interval drives the WRAPPER,
// never the raw rebuild — is testable without real timers.
//
// `afterAggregates` is the install plugin's own step over the fresh stats: a scoring plugin derives its labels from the scores there. The product derives none —
// no scorer, no labels. It runs once per rebuild, after the product's last statement; a failure is
// logged and costs neither this pass's stats nor the next pass.
function createAggregates({ pool: realPool, schedule = setInterval, cancel = clearInterval, excludeEventTypes = [], afterAggregates = null }) {
  // Every statement of a pass goes through this guard. Once stop() is called (the drain), the
  // statement already running finishes and the NEXT one is refused — so the drain waits for one
  // statement, never for the rest of a long rebuild, and the pass ends without touching an ended
  // pool. The refusal is marked so it is not logged as a failure.
  let stopping = false;
  const pool = {
    query: (...args) => (stopping
      ? Promise.reject(Object.assign(new Error('aggregates stopped for shutdown'), { stopped: true }))
      : realPool.query(...args)),
  };
  // DIRTY-FLAG. A pass is expensive and runs every two minutes, while chat_log
  // is silent most of the day. The rebuild's INSERT inputs are append-only
  // (chat_log, support_events), so a MAX(id) watermark pair detects every new
  // row. Two things it cannot see, each handled explicitly:
  //   • late karma/intelligence UPDATEs land on existing rows after the last
  //     insert → ONE settle pass runs after the watermark stops moving;
  //   • identity merges rewrite user_id IN PLACE → mergeCanonicals calls
  //     requestAggregateRefresh (forcing); the interval polls the checked entry.
  let lastWatermark = null;   // watermark of the last COMPLETED rebuild
  let settled = false;        // the one extra pass after activity stops has run
  let forced = false;         // set by requestAggregateRefresh, consumed per pass

  async function readWatermark() {
    const { rows } = await pool.query(`
      SELECT (SELECT COALESCE(MAX(id), 0) FROM stream.chat_log)       AS c,
             (SELECT COALESCE(MAX(id), 0) FROM stream.support_events) AS s
    `);
    const r = rows[0] || {};
    return `${r.c}:${r.s}`;
  }

  async function refreshAggregates() {
    const wasForced = forced;
    forced = false;
    const wm = await readWatermark();
    if (!wasForced && wm === lastWatermark) {
      if (settled) return;    // quiet box — skip the six-statement rebuild
      settled = true;         // settle pass: catch scoring UPDATEs that landed
                              // after the last insert's rebuild
    } else {
      settled = false;
    }
    await rebuild();
    lastWatermark = wm;       // only after success — a failed pass retries
  }

  async function rebuild() {
    // ── Step 0: names (names.js) — first, so step 1 copies the right name
    // into user_stats in this same pass.
    const renamed = await refreshNames(pool);
    if (renamed) console.log(`[Refresh] ${renamed} name(s) set by the naming rule`);

    // ── Step 1: Raw metrics ──────────────────────────────────────────────
    // Lifetime support excludes currency spends — spectacle, not support.
    await pool.query(`
      WITH user_metrics AS (
        SELECT
          u.id    AS user_id,
          u.name,
          COALESCE(COUNT(cl.id), 0)                                                AS activity,
          COALESCE(COUNT(DISTINCT cl.stream_id), 0)                                AS streams,
          AVG(cl.clean_word_count) FILTER (WHERE cl.clean_word_count IS NOT NULL)  AS avg_words,
          ROUND(COALESCE(STDDEV(cl.karma) FILTER (WHERE cl.karma IS NOT NULL),
                         0)::numeric, 3)                                           AS std_karma,
          ROUND(COALESCE(
            COUNT(cl.id) FILTER (WHERE cl.karma < 0.3 OR cl.karma > 0.7)::numeric
            / NULLIF(COUNT(cl.id) FILTER (WHERE cl.karma IS NOT NULL), 0), 0
          )::numeric * 100)::int                                                   AS extreme_pct,
          (SELECT AVG(k) FROM (
            SELECT karma AS k FROM stream.chat_log c2
            WHERE c2.user_id = u.id AND c2.karma IS NOT NULL
            ORDER BY c2.created_at DESC LIMIT 100
          ) k100)                                                                   AS karma_100,
          (SELECT AVG(i) FROM (
            SELECT intelligence AS i FROM stream.chat_log c2
            WHERE c2.user_id = u.id AND c2.intelligence IS NOT NULL
            ORDER BY c2.created_at DESC LIMIT 100
          ) i100)                                                                   AS intel_100
        FROM stream.users u
        LEFT JOIN stream.chat_log cl ON cl.user_id = u.id
        -- The erased-person row (account-erase.js) holds every deleted account's kept lines and
        -- payments; a profile built from it would sum strangers together under one card.
        WHERE u.id <> '${ERASED_CANONICAL}'
        GROUP BY u.id, u.name
      )
      INSERT INTO stream.user_stats (
        user_id, name, activity, streams, support,
        karma, intelligence, avg_message_words,
        std_karma, extreme_pct,
        is_member, sub_tier, updated_at
      )
      SELECT
        um.user_id,
        um.name,
        um.activity,
        um.streams,
        COALESCE(s.support, 0.0),
        COALESCE(um.karma_100, 0.5),
        um.intel_100,
        um.avg_words,
        um.std_karma,
        um.extreme_pct,
        COALESCE(r.is_member, false),
        r.sub_tier,
        NOW()
      FROM user_metrics um
      LEFT JOIN (
        SELECT user_id, SUM(amount_usd) AS support
        FROM stream.support_events
        -- event_type is nullable; a blank kind lands as NULL, and bare
        -- <> ALL(...) against NULL is NULL, which WHERE drops. COALESCE
        -- keeps an untyped row counted as support instead of losing it.
        -- Platform-scoped: only the site's own coin-spend rows are excluded —
        -- an external platform's donation that happens to carry
        -- event_type='cheer' must still count toward lifetime support.
        WHERE NOT (platform IN ${NATIVE_SQL} AND COALESCE(event_type, '') = ANY($1::text[]))
        GROUP BY user_id
      ) s ON s.user_id = um.user_id
      LEFT JOIN LATERAL (
        SELECT is_member, NULLIF(TRIM(tier), '') AS sub_tier
        FROM stream.chat_log WHERE user_id = um.user_id
        ORDER BY created_at DESC LIMIT 1
      ) r ON true
      ON CONFLICT (user_id) DO UPDATE SET
        name              = EXCLUDED.name,
        activity          = EXCLUDED.activity,
        streams           = EXCLUDED.streams,
        support           = EXCLUDED.support,
        karma             = EXCLUDED.karma,
        intelligence      = EXCLUDED.intelligence,
        avg_message_words = EXCLUDED.avg_message_words,
        std_karma         = EXCLUDED.std_karma,
        extreme_pct       = EXCLUDED.extreme_pct,
        is_member         = EXCLUDED.is_member,
        sub_tier          = EXCLUDED.sub_tier,
        updated_at        = NOW()
    `, [excludeEventTypes]);

    // ── Step 2: Karma percentile (among users with activity >= 5) ────────
    // PERCENT_RANK like steps 3/5/6 — the correlated-COUNT form this replaces
    // was O(n²) over the qualified pool (the pass's dominant cost at 216k
    // rows). Same strict-less semantics; denominator is N-1 instead of N,
    // which rounds to the same int everywhere but the single top row.
    await pool.query(`
      UPDATE stream.user_stats us SET karma_pct = ROUND(r.pct * 100)::int
      FROM (
        SELECT user_id, PERCENT_RANK() OVER (ORDER BY karma) AS pct
        FROM stream.user_stats WHERE activity >= 5
      ) r
      WHERE us.user_id = r.user_id
    `);

    // ── Step 3: Support tier ─────────────────────────────────────────────
    await pool.query(`
      UPDATE stream.user_stats SET support_tier = 'None'
      WHERE support = 0 AND is_member = false
    `);
    await pool.query(`
      UPDATE stream.user_stats us SET support_tier = CASE
        WHEN pct >= 0.90 THEN 'Blessing'
        WHEN pct >= 0.75 THEN 'Patron'
        WHEN pct >= 0.50 THEN 'Contributor'
        ELSE                  'Supporter'
      END
      FROM (
        SELECT user_id, PERCENT_RANK() OVER (ORDER BY support) AS pct
        FROM stream.user_stats WHERE support > 0 OR is_member = true
      ) r
      WHERE us.user_id = r.user_id
    `);

    // ── Step 4: Word count tier (absolute thresholds) ────────────────────
    await pool.query(`
      UPDATE stream.user_stats SET word_count_tier = CASE
        WHEN avg_message_words IS NULL THEN NULL
        WHEN avg_message_words < 6     THEN 'Reactor'
        WHEN avg_message_words <= 10   THEN 'Chatter'
        ELSE                                'Writer'
      END
    `);

    // ── Step 5: Regularity tier (percentile of streams attended) ─────────
    await pool.query(`
      UPDATE stream.user_stats us SET regularity_tier = CASE
        WHEN pct <= 0.25 THEN 'Stranger'
        WHEN pct <= 0.75 THEN 'Familiar'
        WHEN pct <= 0.90 THEN 'Consistent'
        ELSE                  'Constant'
      END
      FROM (
        SELECT user_id, PERCENT_RANK() OVER (ORDER BY streams) AS pct
        FROM stream.user_stats WHERE activity > 0
      ) r
      WHERE us.user_id = r.user_id AND us.activity > 0
    `);

    // ── Step 6: Intelligence tier (percentile within qualified pool) ──────
    await pool.query(`
      UPDATE stream.user_stats us SET
        intelligence_tier = CASE
          WHEN pct <= 0.33 THEN 'Dumb'
          WHEN pct <= 0.66 THEN 'Average'
          ELSE                  'Smart'
        END,
        intelligence_pct = ROUND(pct * 100)::int
      FROM (
        SELECT us2.user_id, PERCENT_RANK() OVER (ORDER BY us2.intelligence) AS pct
        FROM stream.user_stats us2
        JOIN (
          SELECT user_id, COUNT(*) AS cnt
          FROM stream.chat_log WHERE intelligence IS NOT NULL
          GROUP BY user_id
        ) ic ON ic.user_id = us2.user_id
        WHERE us2.intelligence IS NOT NULL AND ic.cnt >= 20
      ) r
      WHERE us.user_id = r.user_id
    `);

    await checkThresholds();

    // ── The install plugin's step (see createAggregates) ─────────────────
    // The plugin gets the REAL pool (it may need more than query), so the stop guard is applied
    // here instead: a stopping pass skips it. The drain awaits the pass, so it never runs on an
    // ended pool.
    if (afterAggregates && !stopping) {
      await afterAggregates({ pool: realPool }).catch((e) => console.warn('[aggregates] plugin step failed:', e.message));
    }
    console.log('[Refresh] Aggregates updated');
  }

  // Once per CHANGE, not once per pass: on every refresh (the 2-minute interval
  // plus a forced pass per identity merge) it would print thousands of
  // identical lines a night, a canary nobody reads. Remember what was printed per user (at the printed
  // precision); print when a user first appears, when their value moves, and
  // again if they climb out and fall back in.
  const printedLowKarma = new Map(); // user_id → karma as printed (3 dp)

  async function checkThresholds() {
    const lowKarma = await pool.query(`
      SELECT us.user_id, us.karma,
             COUNT(cl.id) FILTER (WHERE cl.karma IS NOT NULL) AS scored
      FROM stream.user_stats us
      JOIN stream.chat_log cl ON cl.user_id = us.user_id
      WHERE us.karma < 0.35
      GROUP BY us.user_id, us.karma
      HAVING COUNT(cl.id) FILTER (WHERE cl.karma IS NOT NULL) >= 5
    `);
    const stillLow = new Set();
    for (const u of lowKarma.rows) {
      const karma = parseFloat(u.karma).toFixed(3);
      stillLow.add(u.user_id);
      if (printedLowKarma.get(u.user_id) === karma) continue;
      printedLowKarma.set(u.user_id, karma);
      console.log(`[Threshold] Low karma: ${u.user_id} karma=${karma} scored=${u.scored}`);
    }
    for (const id of printedLowKarma.keys()) {
      if (!stillLow.has(id)) printedLowKarma.delete(id);
    }
  }

  const runRefresh = makeRefresher(
    refreshAggregates,
    (e) => { if (!e?.stopped) console.warn('[aggregates] refresh failed:', e.message); }
  );

  // Two entries, one refresher (single-flight + coalesce still cover both):
  //   requestAggregateRefresh — FORCES. Identity merges rewrite rows in place,
  //   invisible to the watermark, so their entry must bypass it.
  //   pollAggregateRefresh — honours the watermark. The interval's entry.
  function requestAggregateRefresh() {
    forced = true;
    return runRefresh();
  }
  const pollAggregateRefresh = runRefresh;

  // Interval + startup pass. The interval drives the coalescing wrapper —
  // never refreshAggregates directly, or slow passes stack. Startup polls:
  // lastWatermark is null after a restart, so the first pass always rebuilds.
  let handle = null;
  function start() {
    handle = schedule(pollAggregateRefresh, REFRESH_MS);
    pollAggregateRefresh();
  }

  /** The drain's step BEFORE pool.end(): no new pass starts, and it resolves when the running one
   *  has finished. */
  function stop() {
    stopping = true;
    if (handle != null) { cancel(handle); handle = null; }
    return runRefresh.stop();
  }

  return { requestAggregateRefresh, pollAggregateRefresh, start, stop };
}

module.exports = { createAggregates, makeRefresher, REFRESH_MS };
