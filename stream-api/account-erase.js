'use strict';
// The stream-side half of self-serve "Delete my account". web runs the site half; this process owns stream.* and the AI memory.
//
// POST /account/erase { matrixId } (requireSecret — the bearer secret only, never IP trust. web
// calls it with the id of the account its server-signed session belongs to, after its own checks:
// a fresh sign-in by that very account, the typed account name, no subscription; web calls it
// BEFORE its own erase, so the account's site links and opt-out are still there to read):
//   1. AI memory: memory.forget for the identities that are exclusively this account's (see
//      exclusiveIdentities), every plugin forget handler included, at scope 'self' — a plugin's
//      SHARED notes (one note can name several people) are never removed by a self-deletion.
//   2. In ONE transaction:
//      - the memory opt-out survives the account: if the account had switched AI memory off, each
//        platform id it was linked to is recorded in stream.memory_opt_out_platform_ids (platform
//        and id only — no name, no canonical, read by no public route), so a fresh identity those
//        platform ids get later is never remembered either (memory.js reads it);
//      - their linked platform lines in stream.chat_log are tombstoned (text, emotes and reply
//        quotes removed, rows kept so threads stay intact, marked deleted); quotes of their lines,
//        and their name, inside other people's replies are removed; their name is stripped from
//        stream.support_events — it reads '(deleted)' (amount, date, platform and event id are kept);
//      - the stream-side PROFILE of each canonical that was this account's alone is deleted:
//        stream.users (name, pronouns, timezone, avatar), stream.user_stats, stream.nameidx and
//        every stream.links row (each platform's, and the site's own), plus the site.platform_links
//        rows of this account that point at it. The rows that stay — the tombstoned lines and the
//        payments — are moved onto ONE shared erased-person row, ERASED_CANONICAL, which no
//        identity can resolve to and which never gets a profile (aggregates.js skips it,
//        /user/lookup refuses it). So /user/lookup answers 404 for the person by id, name or
//        platform id, and the next message from one of their platform ids starts a FRESH chatter
//        identity that has no tie to the old one;
//      - the site account's identity link (its native stream.links row) is removed.
//      - their payments the ledger could not price or record (stream.unpriced_support) lose the
//        name, the message and the platform id (amounts, currency, event id and status are kept),
//        found by the platform ids captured BEFORE the links go;
//   3. Live: their lines still in the replay buffer are redacted and a `purge` frame removes
//      them from open screens — exactly a mod purge's live half; the identity cache forgets their
//      platform ids and the sponsor pool drops their entries (name and aliases).
// Moderation retention is PRIVATE and never keeps the person public. With an open moderation case
// (keepEvidence) the words of their lines stay, marked deleted = moderators only. With a ban or an
// open case, each of their platform ids is written to stream.erased_restrictions (platform, id,
// account, why — mods-only, outside every identity table, so nothing that expands a canonical
// into accounts can fan out through it). In every case the public profile goes: /user/lookup
// answers 404, and a new message from one of their platform ids starts a FRESH identity — which
// identity.js marks as carrying the restriction (an open site.user_marks row) and never binds back
// to the deleted account. site.bans keeps holding the site account itself.
// Idempotent: a second call finds nothing left to change. Counts only come back.

const { NATIVE_SQL, NATIVE_PLATFORM } = require('./native-platform');

// The name a kept payment record shows once its person is deleted (the column is NOT NULL).
const ERASED_NAME = '(deleted)';
// The one stream.users row every deleted person's kept lines and payments point at (the columns
// are NOT NULL and reference stream.users). Minted ids are 12 hex characters, so this one can never
// be a live person's; nothing resolves to it, nothing links to it, nothing builds a profile for it.
const ERASED_CANONICAL = '(erased)';

// Record (or strengthen) the restriction a deleted account leaves on its platform ids.
// $1 platforms[], $2 platform ids[], $3 the account, $4 'ban' | 'case', $5 expires_at (NULL = never).
// A LIVE record is never weakened: a later 'case' leaves a 'ban' a ban, the first account it was
// recorded for stays its account, and its end only moves later (NULL — permanent — wins). A record
// that has already ENDED is replaced whole: it no longer restricts anything (v156).
const RESTRICTION_UPSERT_SQL = `INSERT INTO stream.erased_restrictions AS r (platform, platform_id, matrix_id, reason, expires_at)
           SELECT p.platform, p.pid, $3, $4, $5::timestamptz FROM unnest($1::text[], $2::text[]) AS p(platform, pid)
           ON CONFLICT (platform, platform_id) DO UPDATE SET
             reason = CASE WHEN r.expires_at IS NOT NULL AND r.expires_at <= NOW() THEN EXCLUDED.reason
                           WHEN r.reason = 'ban' THEN 'ban' ELSE EXCLUDED.reason END,
             matrix_id = CASE WHEN r.expires_at IS NOT NULL AND r.expires_at <= NOW() THEN EXCLUDED.matrix_id ELSE r.matrix_id END,
             expires_at = CASE WHEN r.expires_at IS NOT NULL AND r.expires_at <= NOW() THEN EXCLUDED.expires_at
                               WHEN r.expires_at IS NULL OR EXCLUDED.expires_at IS NULL THEN NULL
                               ELSE GREATEST(r.expires_at, EXCLUDED.expires_at) END`;

function createAccountErase({ pool, memory, identity = null, sponsors = null, msgBuffer = [], broadcast = () => {}, redactBuffered = () => {}, log = console }) {
  /**
   * The identities that are THIS account's alone: the account itself, and each platform identity
   * linked to it that no OTHER site account is linked to. A platform identity shared with another
   * account (two site accounts linked to one Twitch user — a split identity) is left alone: its
   * lines and memories are also the other account's, and one person's deletion must never reach
   * another's rows. Read BEFORE the link is removed.
   */
  async function exclusiveIdentities(matrixId, db = pool) {
    const { rows } = await db.query(
      `WITH mine AS (
         SELECT canonical AS c FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1
         UNION SELECT canonical_id FROM site.platform_links WHERE matrix_id = $1)
       SELECT m.c,
              EXISTS (SELECT 1 FROM stream.links l WHERE l.platform IN ${NATIVE_SQL} AND l.canonical = m.c AND l.platform_id <> $1)
           OR EXISTS (SELECT 1 FROM site.platform_links p WHERE p.canonical_id = m.c AND p.matrix_id <> $1) AS shared
         FROM mine m WHERE m.c IS NOT NULL AND m.c <> $2`, [matrixId, ERASED_CANONICAL]);
    return {
      matrixIds: [matrixId],
      canonicalIds: rows.filter((r) => !r.shared).map((r) => r.c),
      shared: rows.filter((r) => r.shared).map((r) => r.c),
    };
  }

  /**
   * Every name the sponsor pool can hold for these canonicals: their stream name, the names they
   * own in nameidx, the names they paid under. Read BEFORE the rows are renamed or deleted.
   */
  async function sponsorNamesOf(canonicalIds, db) {
    if (!canonicalIds.length) return [];
    const { rows } = await db.query(
      `SELECT name AS n FROM stream.users WHERE id = ANY($1)
       UNION SELECT name_lower FROM stream.nameidx WHERE canonical = ANY($1)
       UNION SELECT username FROM stream.support_events WHERE user_id = ANY($1) AND username <> $2`,
      [canonicalIds, ERASED_NAME]);
    return rows.map((r) => r.n).filter((n) => typeof n === 'string' && n.trim());
  }

  async function erase(matrixId, { keepEvidence = false, keepLinks = false, restrictionExpiresAt = null } = {}) {
    const ids = await exclusiveIdentities(matrixId);
    const sponsorNames = await sponsorNamesOf(ids.canonicalIds, pool);
    const forgot = await memory.forget({ matrixId }, {
      actor: matrixId, reason: 'account deleted', scope: 'self',
      identities: { matrixIds: ids.matrixIds, canonicalIds: ids.canonicalIds },
    });
    const client = await pool.connect();
    let rollbackErr = null;
    const out = { memory: forgot.deleted, optOutCarried: 0, chatLog: 0, quotes: 0, supportEvents: 0, unpriced: 0, restrictionsKept: 0, links: 0, profiles: 0, sharedSkipped: ids.shared.length };
    try {
      await client.query('BEGIN');
      // Every platform id that was theirs, captured BEFORE any link is removed: the unpriced
      // payments below carry a platform id, and the restriction record below is keyed by them.
      const pids = (await client.query(
        `SELECT platform, platform_id FROM stream.links WHERE canonical = ANY($1)
         UNION SELECT platform, platform_id FROM site.platform_links WHERE matrix_id = $2 AND canonical_id = ANY($1)
         UNION SELECT $3::text, $2::text`, [ids.canonicalIds, matrixId, NATIVE_PLATFORM])).rows;
      if (keepLinks || keepEvidence) {
        const real = pids.filter((r) => r.platform !== NATIVE_PLATFORM && !String(r.platform_id).startsWith('name:'));
        // A timeout ends: only a ban with an end, and no open case, expires.
        const expiresAt = keepLinks ? restrictionExpiresAt : null;
        const rr = await client.query(RESTRICTION_UPSERT_SQL,
          [real.map((r) => r.platform), real.map((r) => r.platform_id), matrixId, keepLinks ? 'ban' : 'case', expiresAt]);
        out.restrictionsKept = rr.rowCount;
      }
      // The opt-out outlives the account: every platform id this account was linked to —
      // the ones it linked itself, and those of the identities that were its alone — keeps memory
      // off. Platform and id only. Shared identities' OTHER platform ids are not this person's.
      const o = await client.query(
        `INSERT INTO stream.memory_opt_out_platform_ids (platform, platform_id)
         SELECT DISTINCT x.platform, x.platform_id FROM (
           SELECT platform, platform_id FROM site.platform_links WHERE matrix_id = $1
           UNION SELECT platform, platform_id FROM stream.links WHERE canonical = ANY($2) AND platform NOT IN ${NATIVE_SQL}
         ) x
         WHERE EXISTS (SELECT 1 FROM site.memory_opt_outs WHERE matrix_id = $1)
           AND x.platform IS NOT NULL AND x.platform_id IS NOT NULL
         ON CONFLICT DO NOTHING`, [matrixId, ids.canonicalIds]);
      out.optOutCarried = o.rowCount;
      if (ids.canonicalIds.length) {
        // An open moderation case keeps the words (mods-only: a deleted line reaches moderators
        // only); otherwise the line becomes a tombstone. Either way the row stays.
        const c = keepEvidence
          ? await client.query(
            `UPDATE stream.chat_log SET reply_to_text = NULL, reply_to_username = NULL, is_deleted = true
              WHERE user_id = ANY($1) AND (reply_to_text IS NOT NULL OR is_deleted = false)`, [ids.canonicalIds])
          : await client.query(
            `UPDATE stream.chat_log SET message = '', emotes = NULL, reply_to_text = NULL, reply_to_username = NULL, is_deleted = true
              WHERE user_id = ANY($1) AND (message <> '' OR emotes IS NOT NULL OR reply_to_text IS NOT NULL OR is_deleted = false)`,
            [ids.canonicalIds]);
        out.chatLog = c.rowCount;
        // Other people's replies to them: the quoted words go, and the name they quote reads
        // '(deleted)' (left NULL where it was NULL).
        const q = await client.query(
          `UPDATE stream.chat_log SET reply_to_text = NULL, reply_to_username = CASE WHEN reply_to_username IS NULL THEN NULL ELSE $2 END
            WHERE (reply_to_text IS NOT NULL OR (reply_to_username IS NOT NULL AND reply_to_username <> $2))
              AND reply_to_id IN (SELECT id FROM stream.chat_log WHERE user_id = ANY($1))`,
          [ids.canonicalIds, ERASED_NAME]);
        out.quotes = q.rowCount;
        const s = await client.query(
          `UPDATE stream.support_events SET username = $2 WHERE user_id = ANY($1) AND username <> $2`, [ids.canonicalIds, ERASED_NAME]);
        out.supportEvents = s.rowCount;
      }
      // A row with a platform user id is theirs when that id was. An id-less row (a typed donor
      // name) is theirs only when the name's identity was theirs AND the name is theirs in
      // stream.nameidx (its first owner — the rule memory.js uses): a typed name alone can be
      // anybody's.
      const u = await client.query(
        `UPDATE stream.unpriced_support x SET username = $3, message = NULL, user_id = NULL
          WHERE (x.username <> $3 OR x.message IS NOT NULL OR x.user_id IS NOT NULL)
            AND EXISTS (SELECT 1 FROM unnest($1::text[], $2::text[]) AS p(platform, pid)
                         WHERE p.platform = x.platform
                           AND (p.pid = x.user_id
                                OR (x.user_id IS NULL AND p.pid = 'name:' || lower(trim(x.username))
                                    AND EXISTS (SELECT 1 FROM stream.nameidx n
                                                 WHERE n.name_lower = lower(trim(x.username)) AND n.canonical = ANY($4)))))`,
        [pids.map((r) => r.platform), pids.map((r) => r.platform_id), ERASED_NAME, ids.canonicalIds]);
      out.unpriced = u.rowCount;
      const l = await client.query(`DELETE FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1`, [matrixId]);
      out.links = l.rowCount;
      if (ids.canonicalIds.length) {
        // The kept rows move onto the erased-person row first: both columns reference stream.users.
        await client.query(`INSERT INTO stream.users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [ERASED_CANONICAL, ERASED_NAME]);
        await client.query(
          `UPDATE stream.chat_log SET user_id = $2, username = $3, username_color = NULL WHERE user_id = ANY($1)`,
          [ids.canonicalIds, ERASED_CANONICAL, ERASED_NAME]);
        await client.query(`UPDATE stream.support_events SET user_id = $2 WHERE user_id = ANY($1)`, [ids.canonicalIds, ERASED_CANONICAL]);
        await client.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [ids.canonicalIds]);
        await client.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [ids.canonicalIds]);
        await client.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [ids.canonicalIds]);
        // This account's own site links to them: removed here too so nothing can resolve to a
        // deleted canonical (web removes the rest of its links right after). A ban's record of
        // the platform ids is stream.erased_restrictions above — never an identity table.
        await client.query(`DELETE FROM site.platform_links WHERE matrix_id = $1 AND canonical_id = ANY($2)`, [matrixId, ids.canonicalIds]);
        const p = await client.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [ids.canonicalIds]);
        out.profiles = p.rowCount;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch((re) => { rollbackErr = re; });
      throw e;
    } finally {
      client.release(rollbackErr);
    }
    // Live copies: the replay buffer and every open screen.
    const mine = (b) => b && b.type === 'message' && ((b.matrixId && b.matrixId === matrixId) || (b.canonicalId && ids.canonicalIds.includes(b.canonicalId)));
    if (ids.shared.length) log.warn(`[account] ${ids.shared.length} platform identit${ids.shared.length === 1 ? 'y is' : 'ies are'} linked to another site account too — left untouched`);
    const items = [];
    for (const b of msgBuffer) if (mine(b)) { items.push({ platform: b.platform, id: b.id }); redactBuffered(b); }
    if (items.length) broadcast({ type: 'purge', ids: items.slice(0, 500), batchId: null });
    out.live = items.length;
    // In-memory copies: the identity cache (platform id → canonical) and the sponsor pool (their
    // name and aliases on the public credit frame). Best-effort — the rows are already gone.
    if (ids.canonicalIds.length) {
      try { identity?.forgetCanonicals?.(ids.canonicalIds); } catch (e) { log.warn(`[account] identity cache: ${e.message}`); }
      try { sponsors?.erase?.({ canonicalIds: ids.canonicalIds, names: sponsorNames }); } catch (e) { log.warn(`[account] sponsor pool: ${e.message}`); }
    }
    log.log(`[account] stream-side erase for a deleted account: ${out.memory} memory rows, ${out.chatLog} platform lines, ${out.quotes} quotes, ${out.supportEvents} support-event names, ${out.unpriced} unpriced payment(s), ${out.links} link(s), ${out.profiles} profile(s), ${out.optOutCarried} opt-out platform id(s)`);
    return out;
  }

  const isMatrixId = (v) => typeof v === 'string' && /^@[^:\s]+:\S+$/.test(v);

  function registerAccountEraseRoutes(app, { requireSecret, wrap }) {
    app.post('/account/erase', requireSecret, wrap(async (req, res) => {
      const matrixId = req.body && req.body.matrixId;
      if (!isMatrixId(matrixId)) return res.status(400).json({ error: 'matrixId required' });
      // Both flags only ever KEEP more (an open case's evidence, a ban's identity links); web
      // decides them from server-side facts.
      const b = req.body || {};
      // `restrictionExpiresAt`: when the ban that keeps the links is a TIMEOUT with no open case, its
      // end (web reads both from site.bans / the case tables). Absent or unreadable = permanent —
      // a malformed value can only keep a restriction longer, never drop it.
      const until = typeof b.restrictionExpiresAt === 'string' ? new Date(b.restrictionExpiresAt) : null;
      const restrictionExpiresAt = until && Number.isFinite(until.getTime()) ? until.toISOString() : null;
      res.json({ ok: true, ...(await erase(matrixId, { keepEvidence: b.keepEvidence === true, keepLinks: b.keepLinks === true, restrictionExpiresAt })) });
    }));
  }

  return { erase, exclusiveIdentities, registerAccountEraseRoutes };
}

module.exports = { createAccountErase, ERASED_NAME, ERASED_CANONICAL, RESTRICTION_UPSERT_SQL };
