// ── Identity ────────────────────────────────────────────────────────────────
// Canonical-identity resolution and unification for the whole stream stack.
//
// ResolveOrCreate sits UPSTREAM of both the money ledger and chat ingest.
// Anything that can throw in here takes out donations AND chat silently,
// because alerts fire independently. Both create-path inserts must keep
// `ON CONFLICT DO NOTHING` (see the comment on the nameidx insert below). identity-upsert.test.js drives this module
// with a capture-pool and asserts those statements verbatim.
//
// mergeCanonicals must repoint or delete EVERY table with an FK to
// stream.users before its closing DELETE — identity-merge.test.js
// cross-references migrations/ against this file.

const crypto = require('crypto');
const { capMap } = require('./chat-dedup');
const { NATIVE_PLATFORM, NATIVE_SQL, isNativePlatform } = require('./native-platform');
const { ERASED_CANONICAL } = require('./account-erase');

function createIdentity({ pool, requestAggregateRefresh }) {
  // platform:userId → { canonical, name }. A hit with an unchanged name skips both
  // the links SELECT and the redundant name UPDATE in resolveOrCreate. Invalidated
  // wholesale on an identity merge (canonicals get repointed there).
  const identityCache = new Map();
  const IDENTITY_CACHE_MAX = 20000;
  function clearIdentityCache() { identityCache.clear(); }
  // A deleted account's canonicals (account-erase.js): drop every platform id cached as one of
  // them, so the next message from that id resolves afresh instead of to a deleted identity.
  function forgetCanonicals(canonicalIds) {
    const gone = new Set(canonicalIds || []);
    if (!gone.size) return 0;
    let n = 0;
    for (const [key, v] of identityCache) if (gone.has(v.canonical)) { identityCache.delete(key); n += 1; }
    return n;
  }

  // Resolve a chat identity to its canonical user id (matrix → canonical via the
  // link tables; canonical passes through).
  async function resolveCanonical(canonicalId, matrixId) {
    if (canonicalId) return canonicalId;
    if (!matrixId) return null;
    // ORDER BY prio, not bare LIMIT over the UNION: with no ordering the
    // returned row is plan-dependent, so a SPLIT person (the two link tables
    // disagreeing — the exact state /identity/check exists to find) resolved to
    // a different canonical from call to call: double poll votes, impressions
    // split across two ids. The ONE preferred identity: the account's own native
    // stream.links row first; else the LOWEST platform-linked canonical id — the same
    // order web's canonicalFromMatrix uses, so a split person with no native row gets
    // one answer on both sides. (Permission and consent checks ask a different
    // question — EVERY linked identity — and use gatherIdentity, never this.)
    const r = await pool.query(
      `SELECT id FROM (
         SELECT canonical AS id, 1 AS prio FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1
         UNION SELECT canonical_id, 2 FROM site.platform_links WHERE matrix_id = $1
       ) x WHERE id IS NOT NULL AND id <> $2 ORDER BY prio, id LIMIT 1`,
      [matrixId, ERASED_CANONICAL]
    );
    return r.rows[0]?.id || null;
  }

  // ── Identity unification ────────────────────────────────────────────────────
  // One person can end up split across several canonical users: their native
  // (@user:<server>) identity, each linked platform, streamplace/discord, etc.
  // gatherIdentity returns every canonical reachable from a website (matrix)
  // account; mergeCanonicals folds a set of canonicals into one, carrying all of
  // their data over so the bot (and the site profile) see one coherent person.

  async function gatherIdentity(matrixId) {
    if (!matrixId) return [];
    const { rows } = await pool.query(
      `SELECT canonical AS id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1
       UNION SELECT canonical_id AS id FROM site.platform_links WHERE matrix_id = $1`,
      [matrixId]
    );
    // The erased-person row (a deleted account's links kept for a ban) is never an identity.
    return rows.map((r) => r.id).filter((id) => id && id !== ERASED_CANONICAL);
  }

  // Fold `ids` into a single survivor (= most chat activity, tiebreak oldest).
  // Combines impressions in one transaction. Idempotent: <2 distinct ids is a no-op.
  //
  // Every table with an FK to stream.users must be repointed or deleted here, or the
  // closing DELETE FROM stream.users raises an FK violation and rolls the merge back.
  // Keep this list in sync when adding an FK to stream.users:
  //   repointed: chat_log, support_events, links, nameidx
  //   deleted:   user_stats, bot_impressions
  // Votes (keyed by message/author) and message_embeddings (keyed by source) need no repoint.
  async function mergeCanonicals(ids) {
    // The erased-person row (account-erase.js) holds deleted accounts' kept lines and payments;
    // merging it would hand them to a living person.
    let distinct = [...new Set((ids || []).filter((id) => id && id !== ERASED_CANONICAL))];
    // An identity holding a platform id a deleted account left under a ban or an open case
    // (stream.erased_restrictions, account-erase.js) is never folded into anyone: a new site
    // account claiming that platform id must not carry it off the restriction. It stays its own,
    // marked, person.
    if (distinct.length >= 2) {
      const held = (await pool.query(
        `SELECT DISTINCT l.canonical FROM stream.links l
           JOIN stream.erased_restrictions r ON r.platform = l.platform AND r.platform_id = l.platform_id
          WHERE l.canonical = ANY($1) AND (r.expires_at IS NULL OR r.expires_at > NOW())`, [distinct])).rows.map((r) => r.canonical);
      if (held.length) {
        console.warn(`[identity] merge left out ${held.length} identit${held.length === 1 ? 'y' : 'ies'} holding a restricted deleted account's platform id`);
        distinct = distinct.filter((id) => !held.includes(id));
      }
    }
    if (distinct.length < 2) return { ok: true, survivor: distinct[0] || null, merged: 0 };

    const ranked = await pool.query(
      `SELECT u.id, COALESCE(us.activity, 0) AS activity, u.first_seen
         FROM stream.users u
         LEFT JOIN stream.user_stats us ON us.user_id = u.id
        WHERE u.id = ANY($1)`,
      [distinct]
    );
    if (ranked.rows.length < 2) return { ok: true, survivor: ranked.rows[0]?.id || null, merged: 0 };
    ranked.rows.sort(
      (a, b) => (b.activity - a.activity) || (new Date(a.first_seen) - new Date(b.first_seen))
    );
    const survivor = ranked.rows[0].id;
    const victims = ranked.rows.slice(1).map((r) => r.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const v of victims) {
        await client.query('UPDATE stream.chat_log SET user_id = $1 WHERE user_id = $2', [survivor, v]);
        // support_events.user_id is NOT NULL REFERENCES stream.users(id) (schema.sql:49), so the
        // DELETE FROM stream.users below raises an FK violation and rolls the whole merge back
        // unless this repoint runs first. Omitting it silently broke merges for every user who
        // had ever paid — the exact people most worth merging. Lost from migrate-v5.sql:36.
        await client.query('UPDATE stream.support_events SET user_id = $1 WHERE user_id = $2', [survivor, v]);
        await client.query('UPDATE stream.links SET canonical = $1 WHERE canonical = $2', [survivor, v]);
        await client.query('UPDATE stream.nameidx SET canonical = $1 WHERE canonical = $2', [survivor, v]);
        await client.query('UPDATE site.platform_links SET canonical_id = $1 WHERE canonical_id = $2', [survivor, v])
          .catch(() => {});
      }
      // Combine impressions: keep the longest read across survivor+victims, sum
      // interactions, keep any non-null pronouns is N/A (pronouns live on site.users).
      const imps = await client.query(
        'SELECT user_id, impression, interactions FROM stream.bot_impressions WHERE user_id = ANY($1)',
        [[survivor, ...victims]]
      );
      if (imps.rows.length) {
        const best = imps.rows.reduce((a, b) =>
          (b.impression || '').length > (a.impression || '').length ? b : a);
        const totalInteractions = imps.rows.reduce((n, r) => n + (r.interactions || 0), 0);
        await client.query('DELETE FROM stream.bot_impressions WHERE user_id = ANY($1)', [victims]);
        await client.query(
          `INSERT INTO stream.bot_impressions (user_id, impression, interactions, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             impression = EXCLUDED.impression, interactions = EXCLUDED.interactions, updated_at = NOW()`,
          [survivor, best.impression, totalInteractions]
        );
      }
      // Keep a declared pronoun if the survivor doesn't have one but a victim does —
      // with its source, so an alejo.io fill stays overwritable and a
      // person's own choice does not become one.
      await client.query(
        `UPDATE stream.users s SET pronouns = v.pronouns, pronouns_source = v.pronouns_source
           FROM (SELECT pronouns, pronouns_source FROM stream.users
                  WHERE id = ANY($2) AND pronouns IS NOT NULL LIMIT 1) v
          WHERE s.id = $1 AND s.pronouns IS NULL`,
        [survivor, victims]
      );
      // Open moderation marks follow the person: a merge must never clear a restriction. One open
      // mark per subject (the one_open_mark index), so the survivor keeps ONE open mark among all
      // of them (its own, or a victim's moved over) with every mark's evidence; the others are
      // closed as carried into it. The kept one is the earliest mark NOT opened by automod, else
      // the earliest: automod.js's daily job deletes an automatic mark once its evidence is gone,
      // and a carried or hand-placed mark closed into one would go with it.
      const marks = (await client.query(
        `SELECT id, canonical_id FROM site.user_marks
          WHERE canonical_id = ANY($1) AND cleared_at IS NULL ORDER BY (source = 'automod'), created_at, id`, [[survivor, ...victims]])).rows;
      if (marks.length) {
        const keep = marks[0];
        const others = marks.filter((m) => m.id !== keep.id).map((m) => m.id);
        if (others.length) {
          await client.query(
            `UPDATE site.user_marks SET cleared_at = NOW(), cleared_by = 'system', clear_note = $2
              WHERE id = ANY($1)`, [others, `merged into ${survivor}`]);
          await client.query(
            `UPDATE site.user_marks k SET evidence = ARRAY(SELECT DISTINCT e FROM unnest(k.evidence || (
                 SELECT COALESCE(array_agg(e2), '{}') FROM site.user_marks o, unnest(o.evidence) e2 WHERE o.id = ANY($2))) e ORDER BY e)
              WHERE k.id = $1`, [keep.id, others]);
        }
        if (keep.canonical_id !== survivor) {
          await client.query(`UPDATE site.user_marks SET canonical_id = $2 WHERE id = $1`, [keep.id, survivor]);
        }
      }
      await client.query('DELETE FROM stream.user_stats WHERE user_id = ANY($1)', [victims]);
      await client.query('DELETE FROM stream.users WHERE id = ANY($1)', [victims]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    clearIdentityCache();                 // victim canonicals were repointed — drop stale resolves
    requestAggregateRefresh();            // coalesced — a backfill of N merges costs <= 2 rebuilds, not N
    console.log(`[identity] merged ${victims.join(', ')} -> ${survivor}`);
    return { ok: true, survivor, merged: victims.length };
  }

  // Declared pronouns for a person, held on the canonical identity. NULL when unset
  // (the bot defaults to they/them). Every WRITE goes through pronouns.js.
  async function pronounsFor(canonicalId, matrixId) {
    const cid = canonicalId || (matrixId ? await resolveCanonical(null, matrixId) : null);
    if (!cid) return null;
    const { rows } = await pool.query('SELECT pronouns FROM stream.users WHERE id = $1', [cid]);
    return rows[0]?.pronouns || null;
  }

  // ── Timezone / local-time awareness ─────────────────────────────────────────
  // Declared timezone (browser Intl tz) held on the canonical, mirroring pronouns.
  // NULL for platform-only users, where we infer a rough offset from activity.
  async function timezoneFor(canonicalId, matrixId) {
    const cid = canonicalId || (matrixId ? await resolveCanonical(null, matrixId) : null);
    if (!cid) return null;
    const { rows } = await pool.query('SELECT timezone FROM stream.users WHERE id = $1', [cid]);
    return rows[0]?.timezone || null;
  }

  // Validate an IANA tz by trying to format with it (throws on garbage). Keeps us
  // from storing junk a client might send.
  function validTimezone(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
    catch { return false; }
  }

  // The person's current local time as a ready phrase, so the brain never has to do
  // tz math. ONLY from a declared (browser) timezone — accurate. Activity-based
  // clock guessing was tried and dropped: a confidently-wrong time ("isn't it 3am
  // for you?") is worse than saying nothing. null when no declared tz.
  async function personLocalTime(canonicalId, matrixId) {
    const cid = canonicalId || (matrixId ? await resolveCanonical(null, matrixId) : null);
    if (!cid) return null;
    const tz = await timezoneFor(cid, null);
    if (!tz || !validTimezone(tz)) return null;
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
    return { label, source: 'declared', tz };
  }

  // ── Canonical ID resolution ───────────────────────────────────────────────
  // Remember a resolved identity so the next message from the same platform
  // account is a Map hit (0 DB round-trips) instead of a SELECT + name UPDATE.
  function rememberIdentity(platform, userId, canonical, name) {
    if (!userId) return;
    const key = `${platform}:${userId}`;
    identityCache.delete(key);                       // re-set → move to LRU tail
    identityCache.set(key, { canonical, name });
    capMap(identityCache, IDENTITY_CACHE_MAX);
  }

  // A platform account can be OAuth-linked to a site (matrix) identity BEFORE it
  // has ever chatted. In that case no stream.links row exists yet, so a naive
  // resolve would mint a NEW orphan canonical disconnected from the person's site
  // profile + the bot's memory. site.accounts always holds the
  // (provider, provider_account_id) → matrix_id mapping written at link time, so
  // we consult it: if this platform user is a known linked account, resolve to
  // that person's existing canonical (folding any split first). Returns
  //   { matrixId, canonical }  — canonical may be null if the linked person has no
  //                              canonical yet (brand-new site user, never chatted).
  //   null                     — this platform user isn't a linked account.
  async function resolveViaLinkedAccount(platform, userId) {
    if (!userId) return null;
    const acct = await pool.query(
      'SELECT matrix_id FROM site.accounts WHERE provider = $1 AND provider_account_id = $2 LIMIT 1',
      [platform, userId]
    ).catch((e) => {
      // A failed lookup reads exactly like "not a linked account" downstream, so
      // say here that it was an ERROR — the chatter is treated as unlinked.
      console.warn(`[identity] linked-account lookup failed ${platform}:${userId}: ${e.message}`);
      return { rows: [] };
    });
    const matrixId = acct.rows[0]?.matrix_id;
    if (!matrixId) return null;
    const ids = await gatherIdentity(matrixId);
    if (!ids.length) return { matrixId, canonical: null };
    let survivor = ids[0];
    if (ids.length > 1) {
      const m = await mergeCanonicals(ids).catch((e) => {
        console.warn(`[identity] auto-merge failed for ${matrixId} ids=${ids.join(',')}: ${e.message}`);
        return null;
      });
      survivor = m?.survivor || survivor;
    }
    return { matrixId, canonical: survivor };
  }

  // Bind a (matrix_id, platform, platform_id) → canonical mapping in
  // site.platform_links so the native/profile side sees the same person. Best-effort.
  async function bindPlatformLink(matrixId, platform, userId, canonical) {
    if (!matrixId || !canonical) return;
    await pool.query(
      `INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (matrix_id, platform) DO UPDATE SET
         platform_id = EXCLUDED.platform_id, canonical_id = EXCLUDED.canonical_id`,
      [matrixId, platform, userId, canonical]
    ).catch(() => {});
  }

  // Give a site account its own native stream.links row on `canonical`, when it has none. `db` is
  // the pool or a transaction's client. Idempotent: the (platform, platform_id) key makes a second
  // call — a retried sign-in, a concurrent unlink — a no-op.
  function mintNativeLink(db, matrixId, canonical) {
    return db.query(
      `INSERT INTO stream.links (platform, platform_id, canonical)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM stream.users WHERE id = $3)
       ON CONFLICT DO NOTHING`,
      [NATIVE_PLATFORM, matrixId, canonical]);
  }

  async function resolveOrCreate(platform, userId, username) {
    const nameLower = username.toLowerCase().trim();
    // When a linked account has no canonical yet, remember its matrix_id so the
    // canonical we create below gets bound to that person.
    let pendingMatrixId = null;

    // Hot path: known platform account — no DB round trip at all.
    // Nothing here renames the person: names.js owns stream.users.name (site
    // name, else most-used chat name): a donation's username is TYPED, so
    // writing it here would rename the person.
    if (userId) {
      const cached = identityCache.get(`${platform}:${userId}`);
      if (cached) return cached.canonical;
    }

    if (userId) {
      const r = await pool.query(
        'SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2',
        [platform, userId]
      );
      if (r.rows.length) {
        const id = r.rows[0].canonical;
        rememberIdentity(platform, userId, id, username);
        return id;
      }
    }

    // A platform id a DELETED account left under a ban or an open case (account-erase.js): it
    // starts a fresh identity, never bound back to that account, and the fresh identity carries
    // the restriction as an open mark (below).
    let restriction = null;
    if (userId) {
      // A failed lookup THROWS (the caller's retry tries again): minting an unrestricted identity
      // for a platform id that may be under a ban would be the evasion this record exists to stop.
      restriction = (await pool.query(
        'SELECT reason FROM stream.erased_restrictions WHERE platform = $1 AND platform_id = $2 AND (expires_at IS NULL OR expires_at > NOW())', [platform, userId]
      )).rows[0] || null;
    }

    // No stream.links row — but this platform account may be OAuth-linked to a
    // site identity that simply hadn't chatted on this platform yet. Adopt that
    // person's canonical (the strongest signal, ahead of the username heuristic)
    // instead of minting an orphan.
    if (userId && !restriction) {
      const linked = await resolveViaLinkedAccount(platform, userId);
      if (linked && linked.canonical) {
        const id = linked.canonical;
        await pool.query(
          'INSERT INTO stream.links (platform, platform_id, canonical) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [platform, userId, id]
        );
        if (nameLower) {
          await pool.query(
            'INSERT INTO stream.nameidx (name_lower, canonical) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [nameLower, id]
          ).catch(() => {});
        }
        await bindPlatformLink(linked.matrixId, platform, userId, id);
        rememberIdentity(platform, userId, id, username);
        return id;
      }
      if (linked && linked.matrixId) pendingMatrixId = linked.matrixId; // bind after create
    }

    // No username-match adoption. Handles collide across platforms constantly,
    // so adopting the canonical of a matching nameidx row would let a different
    // human registering the same name on Kick inherit the original's stats,
    // social credit and moderation fan-out.
    //
    // Identity requires PROOF — an existing stream.links row, or an OAuth-linked
    // site account (both handled above). A same-handle stranger gets their own
    // canonical. Someone who genuinely uses one name everywhere merges the moment
    // they link the account, via /identity/merge. nameidx is still written below
    // and read by the read-only /profile lookup; it confers no identity.

    const id = crypto.randomBytes(6).toString('hex');
    // A restricted platform id's fresh identity is written in ONE transaction with its mark: an
    // identity without the restriction must never exist, even for a moment.
    const db = restriction ? await pool.connect() : pool;
    try {
      if (restriction) await db.query('BEGIN');
      await db.query(
        'INSERT INTO stream.users (id, name, first_seen, last_seen) VALUES ($1,$2,NOW(),NOW())',
        [id, username]
      );
      if (userId) {
        await db.query(
          'INSERT INTO stream.links (platform, platform_id, canonical) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [platform, userId, id]
        );
      }
      // ON CONFLICT is load-bearing, not defensive. A same-handle stranger gets
      // their own canonical and reaches this insert with a name_lower that already
      // exists. name_lower is the primary key, so a bare INSERT throws, and because
      // resolveOrCreate sits upstream of the ledger write, that throw silently
      // drops the donation's credit (alerts still fire, so it looks fine) and the
      // user's ingest-path messages.
      //
      // Losing this race is the correct outcome: nameidx confers no identity (only
      // the read-only /profile lookup reads it), so first-registrant-keeps-the-entry
      // is the intended semantics.
      if (nameLower) {
        await db.query(
          'INSERT INTO stream.nameidx (name_lower, canonical) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [nameLower, id]
        );
      }
      // The restriction a deleted account left on this platform id follows it to the fresh
      // identity: an open mods-only mark, the same marker automod and the mod panel use.
      if (restriction) {
        await db.query(
          `INSERT INTO site.user_marks (canonical_id, platform, platform_user, reason, source, created_by)
           VALUES ($1, $2, $3, $4, 'carried', 'system')
           ON CONFLICT ((COALESCE(canonical_id, matrix_id))) WHERE cleared_at IS NULL DO NOTHING`,
          [id, platform, String(userId).slice(0, 100),
           `carried from a deleted account under ${restriction.reason === 'ban' ? 'a ban' : 'an open moderation case'}`]);
        await db.query('COMMIT');
      }
    } catch (e) {
      if (restriction) await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      if (restriction) db.release();
    }
    // Linked account whose person had no canonical yet — bind this fresh one so the
    // site profile + later native chat resolve to the same person (no future orphan).
    if (pendingMatrixId) await bindPlatformLink(pendingMatrixId, platform, userId, id);
    rememberIdentity(platform, userId, id, username);
    console.log(`[API] New user (${platform}) → ${id}`); // ids only — never the person's name
    return id;
  }

  // There are no GET twins of these routes: web reads stream.* directly and only
  // writes through here, and the bot gets person-local context inside
  // /bot/retrieve.
  function registerIdentityRoutes(app, { requireInternal, wrap }) {
    // POST /identity/pronouns (+ /identity/pronoun-command) live in pronouns.js.

    // POST /identity/timezone — set/clear declared timezone on the canonical. Body:
    // { timezone, canonicalId?|matrixId?|platform+userId? }. Resolves (never creates)
    // the canonical. timezone null clears.
    app.post('/identity/timezone', requireInternal, wrap(async (req, res) => {
      const { canonicalId, matrixId, platform, userId } = req.body || {};
      let { timezone } = req.body || {};
      if (timezone != null && !validTimezone(timezone)) return res.status(400).json({ error: 'bad timezone' });
      if (timezone == null) timezone = null;
      let cid = canonicalId || null;
      if (!cid && matrixId) cid = await resolveCanonical(null, matrixId);
      if (!cid && platform && userId) {
        const r = await pool.query('SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2', [platform, userId]);
        cid = r.rows[0]?.canonical || null;
      }
      if (!cid) return res.status(404).json({ error: 'no canonical identity' });
      await pool.query('UPDATE stream.users SET timezone = $1 WHERE id = $2', [timezone, cid]);
      res.json({ ok: true, canonicalId: cid, timezone });
    }));

    // POST /identity/resolve — a sign-in on a platform IS the proof the identity
    // model needs; web calls it after the site.users insert on every site
    // sign-in so the person has a canonical before
    // their first chat message. Body: { platform, userId, username }.
    //
    // Same order as /chat/native (chat.js): RESOLVE first — a stream.links
    // native row, else the canonical a linked platform already gave this
    // matrix id (site.platform_links) — and only CREATE when nobody exists.
    // Going straight to resolveOrCreate would mint a second, blank identity for
    // every platform-linked member who has never chatted natively, and rename
    // merged people to their site name. A returning person is never renamed here; the username
    // is only the name a brand-new stream.users row is born with.
    app.post('/identity/resolve', requireInternal, wrap(async (req, res) => {
      const { platform, userId, username } = req.body || {};
      const str = (v) => typeof v === 'string' && v.trim().length > 0;
      if (!str(platform) || !str(userId) || !str(username)) {
        return res.status(400).json({ error: 'platform, userId and username are required' });
      }
      const existing = isNativePlatform(platform) ? await resolveCanonical(null, userId) : null;
      // A person known only through a platform link gets their OWN native row on the canonical they
      // already resolve to. Without it their site identity is borrowed from that platform account:
      // an unlink would find the link alone on its canonical and leave it there, and the next site
      // account to claim the platform account would merge two people. A no-op for a
      // person who already has one (the conflict), and for a stale platform link whose canonical
      // is gone (the EXISTS — links.canonical references stream.users).
      if (existing) await mintNativeLink(pool, userId, existing);
      const canonicalId = existing || (await resolveOrCreate(platform, userId, username));
      res.json({ ok: true, canonicalId, created: !existing });
    }));

    // POST /identity/unlink — undo one platform account's merge into a site person.
    // Body { matrixId, platform, platformId }. In ONE transaction: a fresh canonical is minted
    // and ONLY that platform account's stream.links row moves to it — every sibling link, the
    // person's history and payments stay where they are; the identity cache forgets that one
    // platform id. Answers { ok: true, canonicalId } (the platform account's canonical now).
    // A site account with no native row of its own gets one, in the same transaction, on the
    // canonical it resolves to — so an unlink always separates, even when the account's only
    // platform link is what its site identity sat on.
    // Idempotent: a row alone on its canonical once that is done is answered as it is
    // ({ unchanged: true }) — the retry after a first call committed.
    // 404 when no such platform link exists; 409 when it shares a canonical with other links and
    // that canonical does not belong to this matrixId.
    app.post('/identity/unlink', requireInternal, wrap(async (req, res) => {
      const { matrixId, platform, platformId } = req.body || {};
      const str = (v) => typeof v === 'string' && v.trim().length > 0;
      if (!str(matrixId) || !str(platform) || !str(platformId) || isNativePlatform(platform)) {
        return res.status(400).json({ error: 'matrixId, platform (not the site itself) and platformId are required' });
      }
      const plat = platform.trim().toLowerCase();
      const pid = platformId.trim();
      const client = await pool.connect();
      let out;
      try {
        await client.query('BEGIN');
        const link = (await client.query(
          'SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2 FOR UPDATE', [plat, pid])).rows[0];
        if (!link) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no such platform link' }); }
        const current = link.canonical;
        const mine = (await client.query(
          `SELECT 1 FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1 AND canonical = $2
           UNION SELECT 1 FROM site.platform_links WHERE matrix_id = $1 AND canonical_id = $2`, [matrixId, current])).rowCount;
        // The ONE-link person: a site account with no native row resolves
        // to a platform link's canonical (resolveCanonical's prio 2), so a lone link here can be
        // the very canonical the site person's own chat sits on. Counting siblings alone would answer
        // "already alone" and leave that platform account holding the person's identity. So first,
        // in this transaction, the site account gets its own native row on the canonical it
        // resolves to — the same order resolveCanonical uses — and the count below then sees it.
        // Only for this account's own link: a stranger's link mints nothing for the caller.
        if (mine) {
          const own = (await client.query(
            `SELECT 1 FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1`, [matrixId])).rowCount;
          if (!own) {
            const sitsOn = (await client.query(
              `SELECT canonical_id FROM site.platform_links
                WHERE matrix_id = $1 AND canonical_id <> $2 ORDER BY canonical_id LIMIT 1`,
              [matrixId, ERASED_CANONICAL])).rows[0];
            if (sitsOn) await mintNativeLink(client, matrixId, sitsOn.canonical_id);
          }
        }
        const siblings = Number((await client.query(
          'SELECT COUNT(*) AS n FROM stream.links WHERE canonical = $1', [current])).rows[0].n);
        if (siblings <= 1) {
          // Alone on its canonical and not the site person's identity: already separated — the
          // answer a retry gets after the first call committed (and web's row deletes did not).
          await client.query('COMMIT');
          out = { ok: true, canonicalId: current, unchanged: true };
        } else {
          if (!mine) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'not this account\'s link' }); }
          // Named after what that platform account last chatted as, else the platform id —
          // never the site person's name, which is what the unlink separates it from.
          const last = (await client.query(
            `SELECT username FROM stream.chat_log WHERE user_id = $1 AND platform = $2 ORDER BY id DESC LIMIT 1`,
            [current, plat])).rows[0];
          const id = crypto.randomBytes(6).toString('hex');
          await client.query('INSERT INTO stream.users (id, name, first_seen, last_seen) VALUES ($1, $2, NOW(), NOW())',
            [id, (last && last.username) || pid]);
          await client.query('UPDATE stream.links SET canonical = $1 WHERE platform = $2 AND platform_id = $3', [id, plat, pid]);
          // An unlink is never a way out of a restriction: an open mark on the identity it leaves
          // or on the account itself, an active site ban of the account, or a deleted account's
          // restriction on this platform id is carried to the fresh identity as an open 'carried'
          // mark — in this same transaction.
          const marks = (await client.query(
            `SELECT id, reason FROM site.user_marks
              WHERE cleared_at IS NULL AND (canonical_id = $1 OR matrix_id = $2) ORDER BY created_at, id`,
            [current, matrixId])).rows;
          const ban = (await client.query(
            `SELECT reason FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
            [matrixId])).rows[0];
          const erased = (await client.query(
            'SELECT reason FROM stream.erased_restrictions WHERE platform = $1 AND platform_id = $2 AND (expires_at IS NULL OR expires_at > NOW())', [plat, pid])).rows[0];
          if (marks.length || ban || erased) {
            const why = marks.length
              ? `carried on unlink from open mark #${marks[0].id}: ${String(marks[0].reason).slice(0, 200)}`
              : ban ? 'carried on unlink from an active site ban of the account'
                : `carried from a deleted account under ${erased.reason === 'ban' ? 'a ban' : 'an open moderation case'}`;
            await client.query(
              `INSERT INTO site.user_marks (canonical_id, platform, platform_user, reason, source, created_by)
               VALUES ($1, $2, $3, $4, 'carried', 'system')
               ON CONFLICT ((COALESCE(canonical_id, matrix_id))) WHERE cleared_at IS NULL DO NOTHING`,
              [id, plat, pid.slice(0, 100), why]);
          }
          await client.query('COMMIT');
          out = { ok: true, canonicalId: id };
        }
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      identityCache.delete(`${plat}:${pid}`);
      res.json(out);
    }));

    // POST /identity/merge — unify a person's canonicals. Body: { matrixId } (gather
    // from the website account) and/or { canonicalIds:[…] }. Internal-only.
    app.post('/identity/merge', requireInternal, wrap(async (req, res) => {
      const { matrixId, canonicalIds } = req.body || {};
      const set = new Set(Array.isArray(canonicalIds) ? canonicalIds.filter(Boolean) : []);
      if (matrixId) (await gatherIdentity(matrixId)).forEach((id) => set.add(id));
      if (set.size < 2) return res.json({ ok: true, survivor: [...set][0] || null, merged: 0 });
      res.json(await mergeCanonicals([...set]));
    }));

  }

  return {
    resolveOrCreate, resolveCanonical, gatherIdentity, mergeCanonicals,
    pronounsFor, timezoneFor, personLocalTime, validTimezone,
    clearIdentityCache, forgetCanonicals, registerIdentityRoutes,
  };
}

module.exports = { createIdentity };
