'use strict';
// Automod.
//
// Automod HOLDS and MARKS; it never removes, bans or times anyone out.
//   • Site messages: web asks POST /automod/check before delivery. A risky verdict writes a
//     `pending` site.automod_held row (source 'ai') and the message waits for a moderator.
//   • Platform messages are already public: stream-ingest classifies them after relay and posts
//     a risky one to POST /automod/ai → a `flagged` row a moderator dismisses.
//   • A person with `automod.markAfterCount` risky messages in `automod.markAfterHours` gets ONE
//     open mods-only "suspicious" mark (site.user_marks), its reason built from fixed text.
// It FAILS OPEN: no model, a slow one, a bad key, unparseable output, or more than
// 8 checks in flight → the message is delivered unchecked and counted; a slow verdict can still
// flag it afterwards. Three failures in a row, or over 20 % unchecked in 5 minutes, is
// "degraded": shown to mods and alarmed once (15-minute cooldown).
// Unreviewed AI holds are dropped after `automod.holdExpiry` seconds; word-filter
// and link holds are never swept here.
// Every held row — any source, any status — is DELETED AUTOMOD_HELD_RETENTION_DAYS after it was
// held (a daily prune, started with the module). The same daily run then deletes every OPEN mark
// automod itself opened (source 'automod') once none of its evidence rows is left — an automatic
// mark does not outlive its evidence. Carried and hand-placed marks, and
// cleared marks, stay. A mark of another source that automod adds evidence to keeps its reason.
//
// The verdict comes only from the model's own structured answer, parsed strictly by the adapter
// (parseAutomodVerdict): anything partial, injected or out of range is `ok`. Who is exempt is
// web's decision, from server-side roles — this module never trusts a caller's claim about it.

const { AI_ADAPTER } = require('./aiAdapter.generated.js');
const { NATIVE_SQL, NATIVE_PLATFORM, isNativePlatform } = require('./native-platform');

const SLOT = 'automod.classify';
const MAX_IN_FLIGHT = 8;
const SWEEP_MS = 30_000;
const DEGRADED_RUN = 3;
const DEGRADED_WINDOW_MS = 5 * 60_000;
const DEGRADED_SHARE = 0.2;
const DEGRADED_MIN_SAMPLES = 5;
const ALERT_COOLDOWN_MS = 15 * 60_000;
const LATE_FLAG_TIMEOUT_MS = 15_000;
const MAX_TEXT = 2000;
const MODEL_TEXT = 1000;          // what the model is shown at most (a site message is far shorter)
const MAX_LATE_IN_FLIGHT = 4;     // background re-checks of messages delivered unchecked
const MAX_PENDING_PER_SENDER = 3; // AI holds one person may have waiting at once
// Characters that hide a word from a reader-model while it still reads on screen.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const HIDING = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** The text the model judges: compatibility forms folded, invisible characters out, bounded.
 *  So a word split by a zero-width space, or written in full-width letters, is judged as the
 *  word it reads as. Pure. */
function forCheck(text) {
  return String(text ?? '').normalize('NFKC').replace(HIDING, '').replace(/\s+/g, ' ').trim().slice(0, MODEL_TEXT);
}
const PLATFORMS = /^[a-z][a-z0-9.-]{0,23}$/;

/** Days a site.automod_held row is kept, counted from held_at, whatever its status or source.
 *  The row carries the words of someone's message, and a moderator's decision is made within
 *  days, not months; keeping the words for ever would make every hold a permanent copy of a
 *  message the person may have deleted. The marks (site.user_marks) hold no message text; an open
 *  automatic one goes when its last evidence row does (MARK_SWEEP_SQL), every other mark stays. The legal page states
 *  this number (web/app/legal/automodRetention.ts, held equal by its render test). */
const AUTOMOD_HELD_RETENTION_DAYS = 30;
const PRUNE_FIRST_MS = 60_000;              // a minute after boot: never in the start-up rush
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000; // then daily
const PRUNE_SQL = `DELETE FROM site.automod_held WHERE held_at < now() - make_interval(days => $1::int)`;
/** The open automatic marks whose evidence is all gone, deleted with one mod_log row each, in ONE
 *  statement: the removal and its record cannot part, and a second run finds nothing (retry-safe).
 *  The log row is how a moderator reading the person's history sees why the mark_set has no mark
 *  any more; it carries no message text. A mark that gains evidence while this runs may still go
 *  (READ COMMITTED) — an accepted worst case: it reopens at the next threshold. */
const MARK_SWEEP_SQL = `WITH gone AS (
    DELETE FROM site.user_marks m
     WHERE m.source = 'automod' AND m.cleared_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM site.automod_held h WHERE h.id = ANY(m.evidence))
    RETURNING COALESCE(m.canonical_id, m.matrix_id) AS subject)
  INSERT INTO site.mod_log (action, target_id, performed_by, reason)
  SELECT 'mark_expired', subject, 'automod', 'automatic mark removed: its supporting evidence was deleted' FROM gone`;

function createAutomod({
  pool, ai, config = null, notify = () => {}, log = console, now = () => Date.now(),
  timers = { setTimeout, setInterval, clearTimeout, clearInterval },
  pruneTiming = { firstMs: PRUNE_FIRST_MS, everyMs: PRUNE_EVERY_MS },
}) {
  const cfg = () => config || require('./instance-config').instanceConfig;
  let inFlight = 0;
  let lateInFlight = 0;
  let consecutive = 0;
  let degradedSince = null;
  let lastAlertAt = 0;
  const outcomes = [];   // { at, checked: bool } — the last 5 minutes
  let sweepTimer = null;
  let pruneFirst = null;
  let pruneDaily = null;

  const enabled = () => cfg().get('automod.enabled') === true;
  const categories = () => cfg().get('automod.categories') || [];
  const policy = (content) => (content && content.get('prompt.automod.classify')) ||
    AI_ADAPTER.PRODUCT_SLOTS.find((s) => s.id === SLOT).defaultPrompt;
  let contentStore = null;

  function record(checked) {
    const t = now();
    outcomes.push({ at: t, checked });
    while (outcomes.length && t - outcomes[0].at > DEGRADED_WINDOW_MS) outcomes.shift();
    consecutive = checked ? 0 : consecutive + 1;
    const unchecked = outcomes.filter((o) => !o.checked).length;
    const share = outcomes.length >= DEGRADED_MIN_SAMPLES ? unchecked / outcomes.length : 0;
    const bad = consecutive >= DEGRADED_RUN || share > DEGRADED_SHARE;
    if (bad && degradedSince === null) {
      degradedSince = t;
      log.warn(`[automod] DEGRADED — messages are being delivered unchecked (${consecutive} in a row, ${Math.round(share * 100)} % in 5 min)`);
      if (t - lastAlertAt > ALERT_COOLDOWN_MS) {
        lastAlertAt = t;
        notify('automod.degraded', 'Automod degraded', 'Automod checks are failing or too slow: site messages are being delivered unchecked. See the AI page.');
      }
    } else if (!bad && degradedSince !== null && checked) {
      log.log('[automod] recovered — checks are succeeding again');
      degradedSince = null;
    }
  }

  /** One verdict within `budgetMs`, no retries — and a hard wall-clock race at the budget, so a
   *  provider (or an adapter) that does not honour its abort still cannot make a message wait.
   *  `{ ok, verdict?, code? }`. */
  async function classify(text, budgetMs) {
    const base = ai.route(SLOT);
    if (!base.enabled) return { ok: false, code: base.reason || 'not_configured' };
    const budget = Math.max(100, budgetMs);
    const route = { ...base, timeoutMs: budget, retries: 0 };
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), budget + 25); });
    const call = (async () => {
      try {
        const out = await ai.chat(route, { ...AI_ADAPTER.automodRequest(policy(contentStore), categories(), forCheck(text)), temperature: 0 });
        return { ok: true, verdict: AI_ADAPTER.parseAutomodVerdict(out.text, categories(), cfg().get('automod.minConfidence')) };
      } catch (e) {
        return { ok: false, code: (e && e.code) || 'network' };
      }
    })();
    try { return await Promise.race([call, deadline]); } finally { clearTimeout(timer); }
  }

  /** How many AI holds this sender already has waiting. */
  /**
   * Hold a risky site message unless the sender already has MAX_PENDING_PER_SENDER AI holds
   * waiting: count and insert under one per-sender lock, so concurrent sends cannot all read the
   * same count and overrun the cap. Returns the row id, or null when the cap refused it.
   */
  async function holdUnlessFull({ matrixId, username, text, verdict }) {
    const client = await pool.connect();
    let id = null;
    let rollbackErr = null;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('automod.pending'), hashtext($1))`, [matrixId]);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM site.automod_held WHERE source = 'ai' AND status = 'pending' AND matrix_id = $1`, [matrixId]);
      if (rows[0].n < MAX_PENDING_PER_SENDER) id = await insertRisky(client, { status: 'pending', platform: NATIVE_PLATFORM, matrixId, username, text, verdict });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch((re) => { rollbackErr = re; });
      throw e;
    } finally {
      client.release(rollbackErr);
    }
    if (id !== null) await markIfDue(subjectOf({ matrixId, canonicalId: null }), { platform: NATIVE_PLATFORM, username }).catch((e) => log.warn(`[automod] mark check failed: ${e.message}`));
    return id;
  }

  /** The person a row is about: a site account, or a platform person (canonical id). */
  function subjectOf({ matrixId, canonicalId }) {
    return matrixId ? { matrixId, canonicalId: null } : { matrixId: null, canonicalId };
  }

  /** The risky row itself, on `db` (the pool, or a caller's transaction). Returns its id. */
  async function insertRisky(db, { status, platform, matrixId = null, canonicalId = null, username = null, text, verdict }) {
    const { rows } = await db.query(
      `INSERT INTO site.automod_held (source, status, platform, matrix_id, user_id, user_name, text, category, confidence, matched_term)
       VALUES ('ai', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [status, platform, matrixId, canonicalId, username, String(text).slice(0, MAX_TEXT), verdict.category, verdict.confidence, verdict.reason || null]);
    return Number(rows[0].id);
  }

  /** Write a risky row, then mark the person if they reached the threshold. Returns the row id. */
  async function writeRisky({ status, platform, matrixId = null, canonicalId = null, username = null, text, verdict }) {
    const id = await insertRisky(pool, { status, platform, matrixId, canonicalId, username, text, verdict });
    await markIfDue(subjectOf({ matrixId, canonicalId }), { platform, username }).catch((e) => log.warn(`[automod] mark check failed: ${e.message}`));
    return id;
  }

  /** Fixed-text reason: "3 risky messages in 24 h: harassment ×2, spam ×1". Pure. */
  function markReason(rows, hours) {
    const by = {};
    for (const r of rows) by[r.category] = (by[r.category] || 0) + 1;
    const parts = Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} ×${n}`);
    return `${rows.length} risky message${rows.length === 1 ? '' : 's'} in ${hours} h: ${parts.join(', ')}`;
  }

  /** Count this person's risky rows in the window since their last cleared mark; at the
   *  threshold open their ONE mark (or add the evidence to it), with a mod_log row on opening. */
  async function markIfDue(subject, { platform, username }) {
    const count = cfg().get('automod.markAfterCount');
    const hours = cfg().get('automod.markAfterHours');
    const key = subject.canonicalId || subject.matrixId;
    if (!key) return null;
    const { rows } = await pool.query(
      `SELECT h.id, h.category FROM site.automod_held h
        WHERE h.source = 'ai' AND h.held_at > now() - make_interval(hours => $3::int)
          AND (($1::text IS NOT NULL AND h.matrix_id = $1) OR ($2::text IS NOT NULL AND h.platform NOT IN ${NATIVE_SQL} AND h.user_id = $2))
          AND h.held_at > COALESCE((SELECT max(m.cleared_at) FROM site.user_marks m WHERE COALESCE(m.canonical_id, m.matrix_id) = $4), '-infinity')
        ORDER BY h.id`,
      [subject.matrixId, subject.canonicalId, hours, key]);
    if (rows.length < count) return null;
    const ids = rows.map((r) => Number(r.id));
    const reason = markReason(rows, hours);
    const r = await pool.query(
      `INSERT INTO site.user_marks (canonical_id, matrix_id, platform, platform_user, reason, source, evidence, created_by)
       VALUES ($1, $2, $3, $4, $5, 'automod', $6::bigint[], 'automod')
       ON CONFLICT ((COALESCE(canonical_id, matrix_id))) WHERE cleared_at IS NULL
       DO UPDATE SET evidence = ARRAY(SELECT DISTINCT e FROM unnest(site.user_marks.evidence || EXCLUDED.evidence) e ORDER BY e),
                     -- only automod's own mark takes the new count; a carried or moderator's mark
                     -- keeps the reason a person (or the deletion record) gave it
                     reason = CASE WHEN site.user_marks.source = 'automod' THEN EXCLUDED.reason ELSE site.user_marks.reason END
       RETURNING id, (xmax = 0) AS opened`,
      [subject.canonicalId, subject.matrixId, platform || null, username || null, reason, ids]);
    const mark = r.rows[0];
    if (mark.opened) {
      await pool.query(
        `INSERT INTO site.mod_log (action, target_id, performed_by, reason) VALUES ('mark_set', $1, 'automod', $2)`,
        [key, reason]);
      log.log(`[automod] suspicious mark opened (#${mark.id}): ${reason}`);
    }
    return { id: Number(mark.id), opened: mark.opened, reason };
  }

  /**
   * A site message before delivery (web, after its own exemptions). Within the budget: risky →
   * held row + `{held, rowId}`; ok → `{held:false}`; anything else → delivered unchecked, counted,
   * and judged again in the background so a late risky verdict still flags it.
   */
  async function check({ matrixId, username, text, budgetMs }) {
    if (!enabled()) return { held: false, off: true };
    if (typeof text !== 'string' || !forCheck(text)) return { held: false };
    const budget = Math.min(Math.max(Number(budgetMs) || cfg().get('automod.holdBudgetMs'), 100), 5000);
    if (inFlight >= MAX_IN_FLIGHT) {
      ai.noteUnchecked(SLOT);
      record(false);
      return { held: false, unchecked: true, code: 'busy' };
    }
    inFlight++;
    let r;
    try { r = await classify(text, budget); } finally { inFlight--; }
    if (!r.ok) {
      ai.noteUnchecked(SLOT);
      record(false);
      if (r.code !== 'off' && r.code !== 'not_configured') lateFlag({ matrixId, username, text });
      return { held: false, unchecked: true, code: r.code };
    }
    record(true);
    if (r.verdict.verdict !== 'risky') return { held: false };
    // One person cannot fill the moderators' queue: with this many AI holds already waiting, a
    // further risky message is REFUSED — never delivered unchecked, never queued over anyone's.
    const rowId = await holdUnlessFull({ matrixId, username, text, verdict: r.verdict });
    if (rowId === null) return { held: false, refused: 'too_many_pending' };
    return { held: true, rowId, category: r.verdict.category };
  }

  /** The slow path for a message delivered unchecked: judged without the hold budget, flagged
   *  (not held — it is already posted) if risky. Never awaited by the sender. */
  function lateFlag({ matrixId, username, text }) {
    // Capped like the hold check: a flood of slow messages must not fan out unbounded calls.
    if (lateInFlight >= MAX_LATE_IN_FLIGHT) return;
    lateInFlight++;
    classify(text, LATE_FLAG_TIMEOUT_MS).finally(() => { lateInFlight--; }).then(async (r) => {
      if (r.ok && r.verdict.verdict === 'risky') {
        await writeRisky({ status: 'flagged', platform: NATIVE_PLATFORM, matrixId, username, text, verdict: r.verdict });
        log.log('[automod] a message delivered unchecked was flagged afterwards');
      }
    }).catch((e) => log.warn(`[automod] late check failed: ${e.message}`));
  }

  /** A platform message stream-ingest judged risky after relay → a `flagged` row (+ marks). The
   *  verdict is re-parsed here from its parts, so a caller cannot store a category or a
   *  confidence outside the install's own bounds. */
  async function flagPlatform({ platform, canonicalId, username, text, category, confidence, reason }) {
    if (!enabled()) return { status: 200, body: { ok: true, off: true } };
    if (!PLATFORMS.test(platform || '') || isNativePlatform(platform)) return { status: 400, body: { error: 'a platform message is required' } };
    if (typeof text !== 'string' || !text.trim()) return { status: 400, body: { error: 'text required' } };
    const verdict = AI_ADAPTER.parseAutomodVerdict(JSON.stringify({ verdict: 'risky', category, confidence, reason: typeof reason === 'string' ? reason.slice(0, 120) : '' }), categories(), cfg().get('automod.minConfidence'));
    if (verdict.verdict !== 'risky') return { status: 400, body: { error: 'not a risky verdict within this install\'s categories and confidence floor' } };
    const id = await writeRisky({ status: 'flagged', platform, canonicalId: typeof canonicalId === 'string' && canonicalId ? canonicalId : null, username, text, verdict });
    return { status: 200, body: { ok: true, rowId: id } };
  }

  /** Drop unreviewed AI holds past their expiry. Only source 'ai', only 'pending'. */
  async function sweep() {
    const secs = cfg().get('automod.holdExpiry');
    const r = await pool.query(
      `UPDATE site.automod_held SET status = 'expired', resolved_at = now()
        WHERE source = 'ai' AND status = 'pending' AND held_at < now() - make_interval(secs => $1::int)`, [secs]);
    if (r.rowCount) log.log(`[automod] ${r.rowCount} unreviewed hold(s) dropped after ${secs} s`);
    return r.rowCount;
  }

  function status() {
    return { enabled: enabled(), degraded: degradedSince !== null, degradedSince: degradedSince ? new Date(degradedSince).toISOString() : null, inFlight, lateInFlight, holdExpiry: cfg().get('automod.holdExpiry') };
  }

  /** Delete held rows older than AUTOMOD_HELD_RETENTION_DAYS (any status, any source). Returns the count. */
  async function pruneHeld() {
    const r = await pool.query(PRUNE_SQL, [AUTOMOD_HELD_RETENTION_DAYS]);
    if (r.rowCount) log.log(`[automod] ${r.rowCount} held row(s) older than ${AUTOMOD_HELD_RETENTION_DAYS} days deleted`);
    return r.rowCount;
  }
  /** Delete the open automatic marks none of whose evidence is left (MARK_SWEEP_SQL). Returns the count. */
  async function sweepOrphanMarks() {
    const r = await pool.query(MARK_SWEEP_SQL);
    if (r.rowCount) log.log(`[automod] ${r.rowCount} automatic mark(s) removed: their evidence was deleted`);
    return r.rowCount;
  }
  /** The daily job: the held rows first, then the marks they supported. */
  async function dailyPrune() {
    const held = await pruneHeld();
    const marks = await sweepOrphanMarks();
    return { held, marks };
  }
  /** The timer's run: a failure is logged, never thrown (it would be an unhandled rejection). */
  const pruneRun = () => dailyPrune().catch((e) => log.warn(`[automod] prune failed: ${e.message}`));

  function start({ content } = {}) {
    contentStore = content || null;
    sweepTimer = timers.setInterval(() => { sweep().catch((e) => log.warn(`[automod] sweep failed: ${e.message}`)); }, SWEEP_MS);
    sweepTimer.unref?.();
    // Runs whether or not automod is switched on: rows written while it was on, and the word-filter
    // and link holds, still age out.
    pruneFirst = timers.setTimeout(() => {
      pruneDaily = timers.setInterval(pruneRun, pruneTiming.everyMs);
      pruneDaily.unref?.();
      return pruneRun();
    }, pruneTiming.firstMs);
    pruneFirst.unref?.();
  }
  function stop() {
    if (sweepTimer) timers.clearInterval(sweepTimer);
    if (pruneFirst) timers.clearTimeout(pruneFirst);
    if (pruneDaily) timers.clearInterval(pruneDaily);
  }

  const isMatrixId = (v) => typeof v === 'string' && /^@[^:\s]+:\S+$/.test(v);

  function registerAutomodRoutes(app, { requireInternal, wrap }) {
    // POST /automod/check { matrixId, username?, text, budgetMs? } — web, before delivering a site
    // message that is not exempt. Always 200: the answer says held, delivered, or unchecked.
    app.post('/automod/check', requireInternal, wrap(async (req, res) => {
      const { matrixId, username, text, budgetMs } = req.body || {};
      if (!isMatrixId(matrixId) || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
        return res.status(400).json({ error: 'matrixId and text required' });
      }
      res.json(await check({ matrixId, username: typeof username === 'string' ? username.slice(0, 64) : null, text, budgetMs }));
    }));
    // POST /automod/ai { platform, canonicalId?, username, text, category, confidence, reason? } —
    // stream-ingest, for a relayed platform message it judged risky.
    app.post('/automod/ai', requireInternal, wrap(async (req, res) => {
      const b = req.body || {};
      const r = await flagPlatform({
        platform: b.platform, canonicalId: b.canonicalId, username: typeof b.username === 'string' ? b.username.slice(0, 64) : null,
        text: typeof b.text === 'string' ? b.text.slice(0, MAX_TEXT) : '', category: b.category, confidence: b.confidence, reason: b.reason,
      });
      res.status(r.status).json(r.body);
    }));
    // GET /automod/status — the mod queue's "degraded since" header.
    app.get('/automod/status', requireInternal, (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(status());
    });
  }

  return { check, flagPlatform, sweep, pruneHeld, dailyPrune, status, start, stop, registerAutomodRoutes, markIfDue, markReason, classify };
}

module.exports = { createAutomod, forCheck, AUTOMOD_HELD_RETENTION_DAYS };
