// ── Profile reads ───────────────────────────────────────────────────────────
// Read-only profile lookup for the website (profile cards) and the bot's chat
// commands. No writes, no identity resolution beyond lookups. web uses
// /user/lookup; the bot gets per-user context via POST /bot/retrieve.
//
// Two answers:
//   • MERGED — the whole person: every platform's lines, the aggregate tiers, the plugin's fields,
//     and the identity's preferred name (names.js: the SITE name when there is a site account).
//     What a lookup without `platform` answers (web's card asks by canonical and decides itself
//     what a stranger may see — web/app/lib/profileView.ts).
//   • IDENTITY — one platform ACCOUNT: the handle asked about, on ONE platform, and the figures of
//     that handle's own lines there. Scoped to the handle, not the platform: two handles of one
//     person on the same platform (a rename, or two accounts merged into one identity) answered
//     with one set of figures and the newest name would publish their link too. chat_log carries no
//     platform account id, so the handle is the account's key here.
//     What a lookup WITH `platform` answers (the !rank / !karma command in platform chat), unless
//     every account on the person shows its links (noOptOutSql, the one consent predicate, plus a
//     site account with show_links on), when it is the merged one. Answering a Twitch handle with
//     the site name, or with figures another handle would share, publishes a hidden link to the
//     whole chat; and a name is looked up on the asking platform only, so a site name (or another
//     platform's handle) asked from Twitch is "no record" unless the person shows their links.

const { ERASED_CANONICAL } = require('./account-erase');
const { noOptOutSql } = require('./pseudonym');
const { NATIVE_SQL } = require('./native-platform');

/** A platform name as stored (twitch, youtube, kick, native…): anything else is refused. */
const PLATFORM_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** SQL: the lines of canonical $1 on platform $2 (lower case; the site's own lines for native)
 *  under handle $3 (lower case). */
const IDENTITY_LINES = `user_id = $1 AND lower(username) = $3::text
    AND (CASE WHEN $2::text IN ${NATIVE_SQL} THEN platform IN ${NATIVE_SQL} ELSE lower(platform) = $2::text END)`;

/** One identity's figures — the same ones, by the same formulas, as web's card shows a stranger
 *  (web/app/lib/publicProfile.ts IDENTITY_STATS_SQL): karma = the last 100 scored lines (default
 *  0.5), membership and sub tier from the newest line. The aggregate tiers (support, regularity,
 *  word count, intelligence) and a plugin's label are figures of the WHOLE person, so they are not
 *  here. $1 = the canonical, $2 = the platform, $3 = the handle (lower case). */
const IDENTITY_SQL = `WITH l AS (
    SELECT stream_id, karma, created_at, is_member, tier, username FROM stream.chat_log WHERE ${IDENTITY_LINES}
  )
  SELECT (SELECT COUNT(*) FROM l)::int AS activity,
         (SELECT COUNT(DISTINCT stream_id) FROM l)::int AS streams,
         COALESCE((SELECT AVG(k) FROM (SELECT karma AS k FROM l WHERE karma IS NOT NULL ORDER BY created_at DESC LIMIT 100) x), 0.5)::float AS karma,
         COALESCE((SELECT is_member FROM l ORDER BY created_at DESC LIMIT 1), false) AS is_member,
         (SELECT NULLIF(TRIM(tier), '') FROM l ORDER BY created_at DESC LIMIT 1) AS sub_tier,
         (SELECT username FROM l ORDER BY created_at DESC LIMIT 1) AS name`;

/** SQL: may canonical $1 be answered merged — every account on it shows links (noOptOutSql) and a
 *  site account on it has show_links on (the account whose choice is being shown). */
const CONSENT_SQL = `SELECT (${noOptOutSql('$1')}) AND EXISTS (
    SELECT 1 FROM site.platform_links pl JOIN site.users u ON u.matrix_id = pl.matrix_id
     WHERE pl.canonical_id = $1 AND u.show_links
    UNION ALL
    SELECT 1 FROM stream.links nl JOIN site.users u ON u.matrix_id = nl.platform_id
     WHERE nl.platform IN ${NATIVE_SQL} AND nl.canonical = $1 AND u.show_links
  ) AS consent`;


/** @param {{ pool, requireInternal, wrap, profileExtras?: (ctx: { pool, canonicalId: string }) => Promise<object> }} deps
 *  profileExtras: the site plugin's fields for /user/lookup (absent = none). */
function registerProfileRoutes(app, { pool, requireInternal, wrap, profileExtras = null }) {
  // The merged profile of a canonical (see the head of this file); null = no profile row.
  async function mergedProfile(canonicalId) {
    const r = await pool.query(`
      WITH ranked AS (
        SELECT us.*,
          RANK() OVER (
            PARTITION BY us.intelligence_tier
            ORDER BY us.intelligence DESC NULLS LAST
          ) AS intel_label_rank,
          COUNT(*) OVER (PARTITION BY us.intelligence_tier) AS intel_label_count
        FROM stream.user_stats us
      )
      SELECT r.*, u.name
      FROM ranked r
      JOIN stream.users u ON u.id = r.user_id
      WHERE r.user_id = $1
    `, [canonicalId]);

    if (!r.rows.length) return null;

    const row = r.rows[0];
    // The site plugin's own fields on the card (e.g. its bot's standing read on the person, or a
    // scoring plugin's label and its rank — the product derives no label),
    // under names it chooses. Best-effort: a failing extra never costs the profile.
    const extras = profileExtras
      ? await profileExtras({ pool, canonicalId }).catch((e) => { console.warn('[profiles] plugin extras:', e.message); return {}; })
      : {};
    return {
      ...extras,
      canonicalId,
      name:             row.name,
      karma:            parseFloat(row.karma),
      activity:         parseInt(row.activity),
      streams:          parseInt(row.streams),
      support:          parseFloat(row.support),
      isMember:         row.is_member,
      subTier:          row.sub_tier || null,
      variance:         row.std_karma   >  0    ? parseFloat(row.std_karma) : null,
      extremePct:       row.extreme_pct != null ? parseInt(row.extreme_pct) : 0,
      intelligence:     row.intelligence      != null ? parseFloat(row.intelligence)      : null,
      intelligenceTier: row.intelligence_tier  || null,
      intelLabelRank:   row.intel_label_rank  != null ? parseInt(row.intel_label_rank)  : null,
      intelLabelCount:  row.intel_label_count != null ? parseInt(row.intel_label_count) : null,
      wordCountTier:    row.word_count_tier   || null,
      supportTier:      row.support_tier      || null,
      regularityTier:   row.regularity_tier   || null,
      avgMessageWords:  row.avg_message_words != null ? parseFloat(row.avg_message_words) : null,
    };
  }

  // The canonical behind `name` ON `platform`. A name nobody was ever first seen under (no nameidx
  // row — the set the lookup has always searched) is nobody's, without a scan. Else: the name's first
  // owner when they have chatted under it there (indexed by person); else — a handle shared across
  // platforms, or a site name asked from a platform — whoever chatted under it there most recently.
  async function canonicalOnPlatform(name, platform) {
    const onPlatform = `(CASE WHEN $2::text IN ${NATIVE_SQL} THEN c.platform IN ${NATIVE_SQL} ELSE lower(c.platform) = $2::text END)`;
    const idx = await pool.query(
      `SELECT n.canonical, EXISTS (SELECT 1 FROM stream.chat_log c
          WHERE c.user_id = n.canonical AND lower(c.username) = $1 AND ${onPlatform}) AS here
         FROM stream.nameidx n WHERE n.name_lower = $1`,
      [name, platform]);
    const first = idx.rows[0];
    if (!first) return null;
    if (first.here) return first.canonical;
    const r = await pool.query(
      `SELECT c.user_id FROM stream.chat_log c WHERE lower(c.username) = $1 AND ${onPlatform}
        ORDER BY c.created_at DESC LIMIT 1`, [name, platform]);
    return r.rows[0]?.user_id ?? null;
  }

  const consents = async (canonicalId) =>
    (await pool.query(CONSENT_SQL, [canonicalId])).rows[0]?.consent === true;

  // GET /user/lookup — profile lookup by canonicalId, username, or platform userId; with
  // `platform` (and then `username`, the handle — with canonicalId/userId too when the asker is
  // asking about themselves), the answer for that one platform account (head of this file).
  app.get('/user/lookup', requireInternal, wrap(async (req, res) => {
    const { username, userId, canonicalId: qId } = req.query;
    if (!username && !userId && !qId)
      return res.status(400).json({ error: 'canonicalId, username, or userId required' });
    const nameLower = typeof username === 'string' ? username.toLowerCase().trim().replace(/^@/, '') : '';

    if (req.query.platform !== undefined) {
      const raw = req.query.platform;
      const platform = typeof raw === 'string' ? raw.toLowerCase() : '';
      if (!PLATFORM_RE.test(platform)) return res.status(400).json({ error: 'platform must be a platform name' });

      let canonicalId = typeof qId === 'string' && qId ? qId : null;
      if (!canonicalId && typeof userId === 'string' && userId) {
        const r = await pool.query(
          'SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2', [platform, userId]);
        canonicalId = r.rows[0]?.canonical ?? null;
      }
      if (!canonicalId && nameLower) canonicalId = await canonicalOnPlatform(nameLower, platform);
      // Nobody (or a deleted person) is "no record" however they were asked; a living person asked
      // for without the handle cannot be answered as one account.
      if (canonicalId && canonicalId !== ERASED_CANONICAL && !nameLower)
        return res.status(400).json({ error: 'a platform lookup needs the username (the handle) too' });

      if (canonicalId && canonicalId !== ERASED_CANONICAL) {
        if (await consents(canonicalId)) {
          const merged = await mergedProfile(canonicalId);
          if (merged) return res.json({ scope: 'merged', ...merged });
        }
        const r = await pool.query(IDENTITY_SQL, [canonicalId, platform, nameLower]);
        const row = r.rows[0];
        if (row && row.activity > 0) {
          return res.json({
            scope:    'identity',
            platform,
            name:     row.name,
            karma:    Number(row.karma),
            activity: row.activity,
            streams:  row.streams,
            isMember: row.is_member,
            subTier:  row.sub_tier ?? null,
          });
        }
        return res.status(404).json({ error: 'not found' });
      }
      // Not on this platform. A name that is someone's ELSEWHERE is answered only when that person
      // shows their links (then it is the merged answer, as before) — otherwise no record, the same
      // as nobody, so a miss never confirms an account exists.
      if (nameLower) {
        const r = await pool.query('SELECT canonical FROM stream.nameidx WHERE name_lower = $1', [nameLower]);
        const other = r.rows[0]?.canonical;
        if (other && other !== ERASED_CANONICAL && await consents(other)) {
          const merged = await mergedProfile(other);
          if (merged) return res.json({ scope: 'merged', ...merged });
        }
      }
      return res.status(404).json({ error: 'not found' });
    }

    // No platform: the merged lookup (a platform user id only resolves together with its platform).
    let canonicalId = qId || null;
    if (!canonicalId && username) {
      const r = await pool.query(
        'SELECT canonical FROM stream.nameidx WHERE name_lower = $1',
        [nameLower]
      );
      if (r.rows.length) canonicalId = r.rows[0].canonical;
    }

    // The erased-person row is nobody's profile (account-erase.js).
    if (!canonicalId || canonicalId === ERASED_CANONICAL) return res.status(404).json({ error: 'not found' });

    const merged = await mergedProfile(canonicalId);
    if (!merged) return res.status(404).json({ error: 'not found' });
    res.json(merged);
  }));

}

module.exports = { registerProfileRoutes };
