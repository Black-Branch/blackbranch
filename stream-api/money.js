// ── Money ───────────────────────────────────────────────────────────────────
// Every route that moves real or virtual money, and the accounting policy that
// governs it. The most consequential invariant in the repo lives here (the
// site's virtual currency works like channel points):
//
//   • buying currency is ONLY a wallet top-up (site.coin_ledger, written web-side)
//     — never the bar, never the timer, never stream.support_events, and
//     never a public event;
//   • SPENDING currency — cheer / sticker / sticker_boost / tts_msg / sound — is
//     spectacle: a card, an overlay, a sound. It moves NOTHING. The night is
//     funded by money GIVEN to it, and a lit sponsor clock is a perk for that
//     money (the 2x earn bonus, web-side) — which is exactly why a spend must
//     never light one: earned currency could be spent to earn faster;
//   • real-money kinds (donation / gift / sub) credit the Stripe NET of the
//     charge, never the gross and never a coin amount;
//   • never credit both ends of the same dollar.
//
// KIND_POLICY below is that model as data. The route handlers derive every
// take-home amount from it via takeHome(), so money-policy.test.js can assert
// the policy and drive the real handler.

const { parseDuration } = require('./timer'); // for /timer/adjust's refusal sentence
const { notify } = require('./notify.js');
const { NATIVE_PLATFORM } = require('./native-platform');
const { createReplayGuard } = require('./webhooks.js');
const { ledgerEventId } = require('./alert.js');
// The pad rule for POST /speak lives with the queue that sleeps for it, not here.
const { clampPadMs, PAD_DEFAULTS } = require('./tts.js');
const { instanceConfig } = require('./instance-config');

/** The zone a Fund-the-Night end time ("4am") is read in: the install's time zone (instance key
 *  site.timeZone, env SITE_TIME_ZONE), else env TIMER_TZ (the older name), else undefined — which
 *  timer.startNight reads as the system zone (UTC in the bundle). Read per start, so a zone saved in
 *  the Admin Panel applies to the next night without a restart. */
function nightTimeZone() {
  return instanceConfig.get('site.timeZone') || process.env.TIMER_TZ || undefined;
}

// The coin-spend kinds /chat/event accepts. A new kind added here WITHOUT an
// explicit KIND_POLICY entry refuses to boot (see the check below) — an
// accounting decision must be made deliberately, never defaulted.
const COIN_KINDS = new Set(['cheer', 'highlight', 'sticker', 'sticker_boost', 'tts_msg', 'sound']);
const MONEY_KINDS = new Set(['gift', 'donation', 'sub']);

// credit: 'face' (coins at 1¢ each) | 'stripe_net' (net of the real charge) |
//         'none' (a sink — no bar, no timer, no ledger).
// announce: 'alert' (full fireStreamEffects fan-out) | 'overlay' (its own WS
//         frame, no alert sound) | 'card' (the chat card and nothing else) |
//         'frame' (a control frame only).
//         Documentation only — nothing reads KIND_POLICY[kind].announce.
//         The fields that are read are credit, refundFlag,
//         precheckStickerTarget and movesExistingCard.
const KIND_POLICY = {
  donation:      { credit: 'stripe_net', announce: 'alert' },
  gift:          { credit: 'stripe_net', announce: 'alert' },
  sub:           { credit: 'stripe_net', announce: 'alert' },
  cheer:         { credit: 'none',       announce: 'card' },
  highlight:     { credit: 'none',       announce: 'card' },
  sticker:       { credit: 'none',       announce: 'overlay' },
  sticker_boost: { credit: 'none',       announce: 'overlay', precheckStickerTarget: true, movesExistingCard: true },
  tts_msg:       { credit: 'none',       refundFlag: 'spoken' },
  sound:         { credit: 'none',       refundFlag: 'played' },
};

// Refuse to boot with an undecided kind — in either direction.
for (const k of [...COIN_KINDS, ...MONEY_KINDS]) {
  if (!KIND_POLICY[k]) throw new Error(`[money] kind '${k}' has no KIND_POLICY entry — decide its accounting explicitly`);
  if (!['face', 'stripe_net', 'none'].includes(KIND_POLICY[k].credit))
    throw new Error(`[money] kind '${k}' has no valid credit decision`);
}
for (const k of Object.keys(KIND_POLICY)) {
  if (!COIN_KINDS.has(k) && !MONEY_KINDS.has(k))
    throw new Error(`[money] KIND_POLICY entry '${k}' is not an accepted kind`);
}

// spendId → the response body its first delivery produced (null while that
// delivery is still running). Full idempotency-key semantics for /chat/event:
// replaying the ORIGINAL body — never a synthetic ok — is what keeps the
// refundFlag kinds honest (a deduped tts_msg retry must carry the real
// `spoken`, because that flag drives a web-side refund). Bounded exactly like
// webhooks.js createSeenStore, for the same reason.
function createOutcomeStore({ ttlMs = 60 * 60 * 1000, max = 5000 } = {}) {
  const store = new Map(); // key -> { body: object|null, exp: epoch ms }
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      if (e.exp <= Date.now()) { store.delete(key); return undefined; }
      return e;
    },
    set(key, body) {
      const now = Date.now();
      if (store.size > max) {
        for (const [k, e] of store) if (e.exp <= now) store.delete(k);
        if (store.size > max) {
          for (const k of store.keys()) { if (store.size <= max) break; store.delete(k); }
        }
      }
      store.set(key, { body, exp: now + ttlMs });
    },
    delete(key) { store.delete(key); },
  };
}

// The platform id a support event resolves identity with: platform-scoped name
// identity for id-less money sources. Identity requires proof (a stream.links
// row or an OAuth-linked account), which is right for chat ingest, where handles
// collide across platforms. But Streamlabs, Ko-fi and YouTube superchats arrive
// with a name and no user id, so without this rule every such donation mints a
// new user and the donor's badges, stats, bot memory and credit weight split
// across one-off ids.
//
// With no platform id, the donor's name IS the platform id — `name:<lower>` —
// so one stable identity per (platform, name). It is not cross-platform
// adoption: a Kick "casey" never inherits the Streamlabs one; only
// /identity/merge links them, by proof. Anonymous donations get no synthetic
// id — pooling every anonymous donor into one "Anonymous" would be a worse lie
// than a fresh row each.
function supportPlatformId({ userId, username }) {
  if (userId) return String(userId);
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name || name.toLowerCase() === 'anonymous') return ''; // mirrors sponsors.js isAnonymous
  return `name:${name.toLowerCase()}`;
}

// Insert a support event. Wired as createAlert's `logSupport` dep (index.js);
// the alert fan-out is its only caller. A factory (rather than part of
// createMoney) because createAlert needs it before the alert instance exists to
// hand to createMoney. `eventId` is the durable dedup key: the in-memory stores
// upstream (/alert's alertSeen, /chat/event's spendOutcomes) accept retries that
// exist to bridge restarts, and a restart empties them, so only the
// partial-unique index on stream.support_events(event_id) stops a bridging
// retry re-running the credit. NULL (no id) stays fail-open, like the in-memory
// guards. `duplicate: true` tells the caller the row already exists, so the
// bar/timer must not move again.
//
// ── Reversals that arrive before their credit (v156) ─────────────────────────────────────
//
// A refund or dispute of a payment the ledger does not hold YET (its ledger write failed and it
// waits in stream.unpriced_support, or its credit is still on its way) is HELD in
// stream.support_reversal_holds, keyed by the original's ledger event_id and the reversal's ref.
// The credit — POST /support/reconcile, or a late delivery of the event — takes every pending hold
// back in the SAME transaction that writes it (then `applied`), so a refunded payment is never
// counted in full. A restore (refund failed, dispute won) marks its hold `cancelled`: a held
// reversal is dropped, and an opening event that arrives after its outcome takes nothing.
//
// The credit and every reversal of one event serialise on ONE transaction-scoped advisory lock,
// always taken FIRST (before any row lock), so the credit/reverse race nets exactly once.

/** Take the per-event lock. `q` is a client inside a transaction. */
function lockSupportEvent(q, eventId) {
  return q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`support:event:${eventId}`]);
}

/** refunded / gross as a share in (0, 1], or null = the whole remainder. */
function reversalShare(refunded, gross) {
  const r = Number(refunded);
  const g = Number(gross);
  return Number.isFinite(r) && r > 0 && Number.isFinite(g) && g > 0 ? Math.min(1, r / g) : null;
}

/**
 * Write one reversal of `orig` (a support_events row): a NEGATIVE row keyed
 * `rev:<originalEventId>:<ref>`, its share of the original and never more than still remains.
 * Caller holds the event lock. { amount, inserted }.
 */
async function writeReversal(q, orig, originalEventId, { ref, share }) {
  const net = Number((await q.query(
    'SELECT COALESCE(SUM(amount_usd), 0) AS s FROM stream.support_events WHERE reverses_id = $1', [orig.id])).rows[0].s);
  const original = Number(orig.amount_usd);
  const remaining = original + net;
  const amount = -Math.min(Math.round(original * (share == null ? 1 : share) * 100) / 100, Math.round(remaining * 100) / 100);
  if (!(Math.abs(amount) > 0)) return { amount: 0, inserted: false };
  const ins = await q.query(
    `INSERT INTO stream.support_events
       (user_id, platform, username, amount_usd, event_type, stream_id, event_id, reverses_id)
     VALUES ($1, $2, $3, $4, 'reversal', NULL, $5, $6)
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [orig.user_id, orig.platform, orig.username, amount, `rev:${originalEventId}:${ref}`, orig.id]);
  return { amount, inserted: (ins.rowCount ?? 0) > 0 };
}

/** Apply every pending hold on a credit that now exists. Caller holds the event lock. Returns the
 *  number of reversals written, whether they took the WHOLE credit back (`refunded`) and, when any
 *  was written, what is left of the credit (`admittedUsd`, never below 0) — which is then stored on
 *  the credit row (v159): the bar and the timer admit the net of a credit
 *  whose refunds were held before it landed, and the bar's restart rebuild sums that same column. */
async function applyHeldReversals(q, originalEventId) {
  const orig = (await q.query(
    `SELECT id, user_id, platform, username, amount_usd FROM stream.support_events
      WHERE event_id = $1 AND reverses_id IS NULL FOR UPDATE`, [originalEventId])).rows[0];
  if (!orig) return { written: 0, refunded: false, admittedUsd: null };
  const holds = (await q.query(
    `SELECT ref, reason, share FROM stream.support_reversal_holds
      WHERE event_id = $1 AND status = 'pending' ORDER BY created_at, ref FOR UPDATE`, [originalEventId])).rows;
  let written = 0;
  for (const h of holds) {
    const out = await writeReversal(q, orig, originalEventId, { ref: h.ref, reason: h.reason, share: h.share == null ? null : Number(h.share) });
    if (out.inserted) {
      written++;
      // Ids and amounts only — never the donor's name.
      console.log('[support] HELD %s applied — event=%s ref=%s amountUsd=%s (original %s)',
        h.reason, originalEventId, h.ref, out.amount.toFixed(2), Number(orig.amount_usd).toFixed(2));
    }
    await q.query(
      `UPDATE stream.support_reversal_holds SET status = 'applied', updated_at = NOW() WHERE event_id = $1 AND ref = $2`,
      [originalEventId, h.ref]);
  }
  if (!written) return { written, refunded: false, admittedUsd: null };
  const left = Number((await q.query(
    'SELECT COALESCE(SUM(amount_usd), 0) AS s FROM stream.support_events WHERE reverses_id = $1', [orig.id])).rows[0].s) + Number(orig.amount_usd);
  const admittedUsd = Math.max(0, Math.round(left * 100) / 100);
  await q.query('UPDATE stream.support_events SET admitted_usd = $2 WHERE id = $1', [orig.id, admittedUsd]);
  return { written, refunded: admittedUsd <= 0, admittedUsd };
}

// An event_id already held in stream.unpriced_support is ALSO "already recorded" — except an OPEN
// (or reconciled) 'ledger_failed' row, which exists precisely so a later delivery can still land;
// a DISMISSED row of any reason keeps blocking, since a person decided it is not credit. The same
// payment re-posted with a price (through /alert or /chat/event) must not celebrate or credit a
// second time. Only POST /support/reconcile writes that key into the ledger, and it says so
// with `reconciles: true` (and the row's own `streamId`, and its transaction's `db`).
//
// A credit with an event id is written under that event's lock, in one transaction with the
// reversals held for it (above). `onReversed` (index.js: the sponsor pool rebuild) runs after a
// commit that applied any.
function makeRecordSupport({ pool, resolveOrCreate, liveState, onReversed = null }) {
  return async function recordSupport({ platform, userId, username, amountUsd, eventType, tier, months, eventId, reconciles = false, streamId, db = pool }) {
    const canonicalId = await resolveOrCreate(platform, supportPlatformId({ userId, username }), username);
    const sid = streamId !== undefined ? streamId : (await liveState()).streamId || null;
    const write = async (q) => {
      if (eventId) await lockSupportEvent(q, eventId);
      const r = await q.query(
        `INSERT INTO stream.support_events
           (user_id, platform, username, amount_usd, event_type, stream_id, tier, months, event_id)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::text
          WHERE $10::boolean OR $9::text IS NULL
             OR NOT EXISTS (SELECT 1 FROM stream.unpriced_support u WHERE u.event_id = $9::text
                              AND NOT (u.reason = 'ledger_failed' AND u.status IN ('open', 'reconciled')))
         ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [canonicalId, platform, username, amountUsd, eventType || null,
         sid, tier || null, months || null, eventId || null, reconciles === true]
      );
      const inserted = (r.rowCount ?? 0) > 0;
      // An event whose earlier delivery could not reach the ledger was kept as a 'ledger_failed'
      // row (alert.js recordFailure); this delivery has now credited it, so that row is settled.
      if (inserted && eventId && !reconciles) {
        await q.query(
          `UPDATE stream.unpriced_support
              SET status = 'reconciled', reconciled_at = NOW(), reconciled_amount_usd = $2
            WHERE event_id = $1 AND reason = 'ledger_failed' AND status = 'open'`, [eventId, amountUsd]);
      }
      const held = inserted && eventId ? await applyHeldReversals(q, eventId) : { written: 0, refunded: false, admittedUsd: null };
      return { r, reversed: held.written, refunded: held.refunded, admittedUsd: held.admittedUsd };
    };
    let out;
    const ownTx = !!eventId && db === pool && typeof pool.connect === 'function';
    if (!ownTx) {
      // No key (nothing can be held for it), or the caller's own transaction (reconcile).
      out = await write(db);
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        out = await write(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
    // Only after a commit this function made: a caller's own transaction (reconcile) rebuilds after
    // ITS commit — a rebuild started here would read the ledger before the reversal is visible.
    if (ownTx && out.reversed > 0 && typeof onReversed === 'function') {
      try { Promise.resolve(onReversed()).catch((e) => console.warn('[support] after a held reversal:', e.message)); }
      catch (e) { console.warn('[support] after a held reversal:', e.message); }
    }
    const { r } = out;
    // `ledgerId`: the row's own id, carried to the sponsor pool so a rebuild that already read the
    // row does not count its live credit a second time (sponsors.js journal).
    // `refunded`: held refunds took the whole credit back the moment it landed — the caller
    // celebrates nothing (alert.js), though the row and its reversal are written.
    // `admittedUsd`: what the bar and the timer take of this credit — the net left after the held
    // refunds (stored on the row as admitted_usd), or null when nothing was held (the whole amount).
    return { canonicalId, duplicate: (r.rowCount ?? 0) === 0, ledgerId: r.rows && r.rows[0] ? String(r.rows[0].id) : null,
      reversed: out.reversed, refunded: out.refunded === true,
      admittedUsd: out.admittedUsd == null ? null : out.admittedUsd };
  };
}

// Insert a payment the ledger could not price into stream.unpriced_support
// (v151). Wired as createAlert's `logUnpriced` dep. Nothing reads this table for
// any total: the bar, timer, sponsor pool and meter only ever sum
// stream.support_events. `event_id` is the same namespaced key the ledger would
// use, so its unique index answers "already recorded" for a replay, and a later
// reconciliation credits through recordSupport with that key — idempotent, and
// never an edit of a financial row in place.
function makeRecordUnpriced({ pool, liveState }) {
  // `reason`: 'unpriced' (no rate for the currency) or 'ledger_failed' (alert.js could not write
  // the ledger row — amountNative is then the take-home in USD).
  return async function recordUnpriced({ platform, eventType, userId, username, amountNative, currency, raw, message, eventId, reason = 'unpriced' }) {
    // An event_id the ledger already holds is "already recorded" here too (the mirror of
    // recordSupport's check): the same payment must not be kept twice under two tables.
    const r = await pool.query(
      `INSERT INTO stream.unpriced_support
         (event_id, platform, event_type, user_id, username, amount_native, currency, raw, message, stream_id, reason)
       SELECT $1::text, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        WHERE $1::text IS NULL
           OR NOT EXISTS (SELECT 1 FROM stream.support_events e WHERE e.event_id = $1::text)
       ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [eventId || null, platform, eventType || null, userId ? String(userId) : null, username || 'Anonymous',
       amountNative, currency, raw || null, message || null, (await liveState()).streamId || null, reason]
    );
    return { duplicate: (r.rowCount ?? 0) === 0 };
  };
}

// Persist a monetization card as a first-class site.chat_messages row so it can
// be replied to / upvoted-downvoted / mod-deleted / pinned like any chat line.
// Returns the numeric id (the caller then broadcasts the card as
// the site's own platform id with this id), or null if it couldn't persist (the card then
// stays ephemeral with its string id + platform 'system' — graceful degrade).
// External-platform alerts have no matrix author, so matrix_id is null.
// Same factory reasoning as makeRecordSupport: createAlert/createPoll take it
// as their persistCard dep.
function makePersistEventCard(pool) {
  return async function persistEventCard(card) {
    const kind = card.system;
    const actor =
      kind === 'gift'     ? (card.gifterMatrixId     || null) :
      kind === 'sub'      ? (card.subscriberMatrixId  || null) :
      kind === 'donation' ? (card.donorMatrixId       || null) :
      // `highlight` shares `cheer`'s arm here for the same reason it shares
      // `cheer`'s branch in alert.js's buildEventCard: same card shape, same
      // cheererMatrixId field; without it a highlight card persists with a
      // NULL matrix_id despite carrying the right identity.
      (kind === 'cheer' || kind === 'highlight') ? (card.cheererMatrixId || null) :
      ['sticker', 'tts_msg', 'sound'].includes(kind)
                          ? (card.senderMatrixId      || null) : null;
    const payload = JSON.stringify(card);
    const ins = (mx) => pool.query(
      `INSERT INTO site.chat_messages (matrix_id, message, event_kind, event_json, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [mx, String(card.message || ''), kind, payload]
    );
    try {
      const r = await ins(actor);
      return parseInt(r.rows[0].id, 10);
    } catch (e) {
      // Most likely a matrix_id FK miss (actor isn't a site.users row) — retry
      // authorless so the card still becomes interactive.
      if (actor) {
        try { const r = await ins(null); return parseInt(r.rows[0].id, 10); }
        catch (e2) { console.warn(`[card persist] retry failed kind=${kind} actor=${actor}: ${e2.message}`); return null; }
      }
      console.warn(`[card persist] failed kind=${kind} (no actor): ${e.message}`);
      return null;
    }
  };
}

// Fund the Night: NightConfigError's `.code` values (timer.js) that /timer/night
// turns into a 400. The class itself is deliberately not exported — this Set is
// the only contract the route reads. Anything else thrown reaches `wrap` (500).
const NIGHT_CONFIG_ERROR_CODES = new Set([
  'INVALID_END_LOCAL', 'INVALID_TZ', 'NO_BLOCKS', 'NO_NIGHT', 'BAD_TARGET',
]);

// POST /speak body validation. A SHAPE check only — tts.noisePath is the authority that
// also touches disk, and a clip that is simply not there is warned about and skipped
// there (`[tts] clip not found: <id>`), never an error to the caller. This keeps garbage
// out of a serialized audio queue.
const NOISE_ID_RE = /^[\w-]+\.v[0-2]$/;

/**
 * Parse a /speak body into the turn tts.speak takes.
 *
 * A malformed clip id is DROPPED rather than refused: his line still going out without a
 * throat clear is strictly better than the reply being lost over a decoration. A body
 * with nothing left to say after that is the one 400.
 *
 * @param {object} body
 * @returns {{error:string}|{turn:object}}
 */
function parseSpeakBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const text = String(b.text || '').trim();
  const turn = {};
  if (text) turn.text = text;
  for (const field of ['noise', 'noiseBefore', 'noiseAfter']) {
    const id = typeof b[field] === 'string' ? b[field] : '';
    if (NOISE_ID_RE.test(id)) turn[field] = id;
  }
  if (!turn.text && !turn.noise) return { error: 'text or noise required' };
  // Pads are a sleep THIS process performs on a serialized queue, so they are clamped —
  // with tts.js's own clampPadMs, so the boundary and the queue cannot drift apart about
  // what `'350'`, `null` or `600000` means. tts.js clamps again on its side, because
  // /speak is not its only caller.
  if (b.padBeforeMs !== undefined) turn.padBeforeMs = clampPadMs(b.padBeforeMs, PAD_DEFAULTS.before);
  if (b.padAfterMs !== undefined) turn.padAfterMs = clampPadMs(b.padAfterMs, PAD_DEFAULTS.after);
  return { turn };
}

/**
 * The ledger key a native money kind's /chat/event spendId becomes (before alert.js prefixes
 * `alert:<platform>:`). One function, so the reversal route finds exactly the row the credit
 * wrote. undefined when there is no usable spendId (fail-open, like every id-less guard).
 */
function nativeSpendKey(kind, spendId) {
  return typeof spendId === 'string' && spendId ? `${kind}:${spendId}` : undefined;
}

function createMoney({
  pool, economics, alert, supportBar, timer, meter, tts, sounds, cleanForTTS,
  persistEventCard, maskBlacklist,
  broadcast, bufferPush, bufferReplace,
  // Whether alerts, paid read-aloud and /speak are SPOKEN: tts.js's enabled() (instance key tts.enabled,
  // restart-applied). A getter, so the value the settings layer's first load resolves is the one used.
  ttsEnabled = () => false,
  // Fund the Night: the sponsor credit pool (sponsors.js). Optional — the many
  // money tests that construct this factory for the alert/ledger paths have no
  // reason to know about it, and a missing pool must never 500 a money route.
  sponsors = null,
  // The ledger writer (makeRecordSupport) — POST /support/reconcile credits through it.
  recordSupport = null,
  // async → the stream id live right now, or null (index.js: liveState). POST /support/reconcile
  // moves the live bar only for a credit of THAT stream. Absent = nothing is ever live here.
  getStreamId = null,
}) {
  /**
   * A reconciled credit, after its COMMIT: when the unpriced row's stream is the one live now, the
   * live bar takes the credit's ADMITTED amount (the net of the refunds held for it, v159) through
   * the same supportBar.add alert.js calls — so the timer moves under the bar's own rule and the
   * money bus (sponsor pool, meter) sees it once, with the ledger id the pool's rebuild dedupes by.
   * A past stream's credit counts only in that stream's history. Post-commit and caught, like
   * alert.js: a bar failure never unwinds the ledger — the bar catches up from it on restart.
   * Returns the journal clause (ids and amounts only).
   */
  async function liveCredit(row, rec, amount) {
    if (!row.stream_id) return 'live bar unmoved (no stream on the record)';
    let liveId = null;
    try { liveId = getStreamId ? await getStreamId() : null; }
    catch (e) { return `live bar unmoved (live stream unknown: ${e.message}) — it catches up on restart`; }
    if (liveId !== row.stream_id) return `live bar unmoved (stream ${row.stream_id} is not live)`;
    const barUsd = rec && rec.admittedUsd != null ? Math.max(0, Number(rec.admittedUsd) || 0) : amount;
    if (!(barUsd > 0)) return 'live bar unmoved (held refunds took the whole credit back)';
    if (!supportBar) return 'live bar unmoved (no bar wired)';
    try {
      const r = supportBar.add(barUsd, row.username, rec.canonicalId, rec.ledgerId || null);
      return `live bar +$${barUsd.toFixed(2)} (+${(r && r.deltaSeconds) || 0}s) stream=${row.stream_id}`;
    } catch (e) {
      console.error('[support] supportBar.add failed AFTER the reconcile COMMIT — bar catches up from support_events. ' +
        'event=%s amountUsd=%s err=%s', row.event_id || '?', barUsd, e.message);
      return `live bar NOT moved (bar failed) amountUsd=${barUsd.toFixed(2)}`;
    }
  }

  /**
   * Rebuild the sponsor credit pool from the ledger. Fire-and-forget and
   * caught on both shapes (a synchronous throw and a rejected promise), same
   * reasoning as index.js's guarded `sponsors.ingest` and alert.js's
   * best-effort OBS/lights/TTS calls: the pool is gratitude, not money, and a
   * failed rebuild must never turn a night start or a stream reset into a 500.
   * A stale pool is the degraded state; it self-corrects on the next rebuild or
   * restart.
   */
  function rebuildSponsorPool() {
    if (!sponsors || typeof sponsors.reset !== 'function') return;
    try {
      Promise.resolve(sponsors.reset())
        .catch((e) => console.warn('[sponsors] reset:', e.message));
    } catch (e) { console.warn('[sponsors] reset:', e.message); }
  }
  // Idempotency for POST /alert: stream-ingest retries a failed delivery (a
  // paid event is not droppable), and a retry on a money route is only legal because a duplicate here becomes a no-op.
  // Same bounded store the payment webhooks use for replay; fail-open on a
  // missing id, because the in-process producers never carry one.
  const alertSeen = createReplayGuard();
  const spendOutcomes = createOutcomeStore();
  // The single face-vs-net decision point: every take-home dollar amount that
  // reaches the bar/timer/ledger is derived from KIND_POLICY through here.
  // `reportedNet` is a processor's own reported net — PayPal, via /chat/event's
  // donation handler passing body.netUsd — used when present and sane instead of estimating Stripe's fee against a
  // charge that was never Stripe's.
  function takeHome(kind, usd, reportedNet) {
    const credit = KIND_POLICY[kind].credit;
    if (credit === 'stripe_net') {
      // A processor that reports its own net is the authority on it — PayPal's
      // fee is not Stripe's, and crediting one at the other's rate misstates
      // the night. Guarded, not clamped: a net above the gross is nonsense,
      // never a large tip (take-home is never capped).
      const n = Number(reportedNet);
      // Round the same way the rest of this file does. `round2` lives in
      // economics.js and is NOT exported.
      if (Number.isFinite(n) && n > 0 && n <= usd) return Math.round(n * 100) / 100;
      if (reportedNet !== undefined) {
        console.warn('[money] ignoring an unusable reported net: %o for gross %s', reportedNet, usd);
      }
      return economics.stripeNet(usd);
    }
    if (credit === 'face') return usd;
    throw new Error(`[money] kind '${kind}' is a sink — nothing to credit`);
  }
  const centsUsd = (v) => (Number(v) || 0) / 100;

  // ── Per-kind effects ────────────────────────────────────────────────────────
  // Each handler returns { r?, spoken?, played? }; the route copies
  // r.addedSeconds onto the card and applies the refund gates. Money amounts
  // always go through takeHome() — the policy table is load-bearing.
  //
  // `amount` is cents in the session's settlement currency. The checkout routes
  // only mint USD sessions, so a non-USD amount here means something upstream
  // changed (adaptive pricing, a new route), and crediting foreign cents as USD
  // moves real value by a number in the wrong unit. Like web's
  // recordCoinPurchase: credit nothing automatically, page critically,
  // reconcile by hand from site.donations (which stores the true currency). The
  // chat card still posts — the celebration is not the ledger. Absent currency
  // means USD (fail-open, like the dedup's NULL). This is not a take-home cap: a
  // cap silently keeps a wrong number; this refuses to invent one, loudly.
  // Reads the raw body, not the card: per-kind card validation keeps only
  // display fields, so `currency` does not survive onto some kinds' msg.
  function refuseNonUsd(kind, body) {
    const cur = typeof body.currency === 'string' ? body.currency.toLowerCase() : 'usd';
    if (cur === 'usd') return false;
    notify(
      'money.non-usd-amount',
      'Non-USD money event — credit refused',
      `${kind} amount=${body.amount} currency=${cur} — bar/timer NOT moved; reconcile from site.donations`,
      { critical: true },
    );
    return true;
  }

  const effectHandlers = {
    donation: async ({ msg, body }) => {
      if (refuseNonUsd('donation', body)) return { r: null };
      const usd = centsUsd(msg.amount); // msg.amount is cents
      return { r: await alert.fireStreamEffects({
        // userId = the sender's matrix id — the identity proof resolveOrCreate
        // needs. Without it every native donation/gift/sub mints a fresh
        // canonical id for the donor.
        platform: NATIVE_PLATFORM, eventType: 'donation', username: msg.username,
        userId: msg.donorMatrixId || undefined, // the card's key (buildEventCard), same as the persistence map below
        amount: economics.formatUSD(usd), message: msg.message || '', label: 'tipped',
        grossUSD: usd, // gross paid (USD) — what the spoken-length tier keys on
        // body.netUsd: PayPal's own reported net (its webhook reaches
        // /chat/event). Absent or unusable → stripeNet(usd).
        takeHomeUSD: takeHome('donation', usd, body.netUsd),
        eventId: nativeSpendKey('donation', body.spendId),
      }) };
    },
    gift: async ({ msg, body }) => {
      if (refuseNonUsd('gift', body)) return { r: null };
      const usd = centsUsd(body.amount); // gross paid for this announce (cents)
      return { r: await alert.fireStreamEffects({
        platform: NATIVE_PLATFORM, eventType: 'gift', username: msg.gifter,
        userId: msg.gifterMatrixId || undefined, // the GIFTER pays (see the donation note above)
        recipient: msg.count === 1 && msg.recipients[0] ? msg.recipients[0].name : '',
        label: `gifted ${msg.count} sub${msg.count === 1 ? '' : 's'}`,
        months: msg.months,
        takeHomeUSD: takeHome('gift', usd),
        eventId: nativeSpendKey('gift', body.spendId),
      }) };
    },
    sub: async ({ msg, body }) => {
      if (refuseNonUsd('sub', body)) return { r: null };
      const usd = centsUsd(msg.amount); // sub price (cents)
      return { r: await alert.fireStreamEffects({
        platform: NATIVE_PLATFORM, eventType: 'sub', username: msg.username,
        userId: msg.subscriberMatrixId || undefined, // see the donation note above
        // months > 1 = a renewal (web's invoice.paid path sends the tenure).
        message: msg.message || '', label: msg.months > 1 ? 'resubscribed' : 'subscribed', tier: msg.tier, months: msg.months,
        takeHomeUSD: takeHome('sub', usd, body.netUsd),
        eventId: nativeSpendKey('sub', body.spendId),
      }) };
    },
    // A highlight is a chat card and nothing else. The coloured background is
    // a WEB rendering of any event row (ChatMessage.tsx's isEventRow), so
    // stream-api's only job here is to let the card through: no alert, no
    // sound, no TTS, no bar, no timer.
    //
    // `cheer` is aliased to this handler rather than deleted: nothing sells a
    // cheer, but a spend accepted before the kind was retired can still be
    // retried against it, and a 500 there strands a viewer who has already been
    // debited.
    highlight: async () => ({ r: { addedSeconds: 0 } }),
    cheer: async () => ({ r: { addedSeconds: 0 } }),
    sticker: async ({ msg }) => {
      // Big emote: chat line + dedicated overlay frame. Spectacle only — a
      // sticker funds nothing. No alert sound.
      broadcast({ type: 'showSticker', emoteUrl: msg.emoteUrl, emoteName: msg.emoteName, username: msg.username, ts: msg.ts });
      return {};
    },
    sticker_boost: async ({ msg }) => {
      // Re-trigger the same overlay pop as a fresh sticker send (the OBS
      // source just pops in again). Credits nothing, like the sticker.
      broadcast({ type: 'showSticker', emoteUrl: msg.emoteUrl, emoteName: msg.emoteName, username: msg.username, ts: msg.ts });
      return {};
    },
    tts_msg: async ({ msg }) => {
      // Paid TTS: speak the card's MASKED text (blacklisted words never voiced).
      // spoken:false when the global gate is off → the web route refunds.
      const text = cleanForTTS(msg.message || '');
      const spoken = !!(ttsEnabled() && text);
      if (spoken) tts.speak(text);
      return { spoken };
    },
    sound: async ({ msg }) => {
      const played = await sounds.play(msg.soundId);
      // !played → refunded web-side; the card is kept out of chat below.
      return { played };
    },
  };
  for (const k of Object.keys(KIND_POLICY)) {
    if (!effectHandlers[k]) throw new Error(`[money] kind '${k}' has no effect handler`);
  }

  let systemSeq = 0;

  /** Why timer.adjust() applied nothing — see the /timer/adjust route. */
  function adjustRefusalReason(input, sign, snap) {
    if (!(parseDuration(input) > 0)) {
      return 'No change — give a duration like 30m or 1h.';
    }
    if (snap?.night?.active) {
      return sign < 0
        ? 'No change — during a night only sold time can be subtracted; the free seed hours stay.'
        : 'No change — the night is funded to its end. Extend the night to add more.';
    }
    return sign < 0
      ? 'No change — the timer is already at zero.'
      : 'No change — the timer is locked at zero or at its cap.';
  }

  // Without the secret gate wired, a requireSecret route refuses rather than open up.
  const refuseUnwired = (_req, res) => res.status(403).json({ error: 'forbidden' });
  function registerMoneyRoutes(app, { requireInternal, requireSecret = refuseUnwired, wrap }) {
    // There is no direct-ledger-write route: backfills go through psql on
    // stream.support_events, where they are visible in shell history.

    // POST /alert — external-platform monetization events (stream-ingest's four
    // platform normalizers, plus tools/simulate-event.js). The in-process producers
    // — Ko-fi, Patreon and Streamlabs in webhooks.js — call alert.dispatch()
    // DIRECTLY and never pass through here, which is why the money guard lives at
    // the choke point in alert.js rather than in this handler.
    //
    // Validation is deliberately minimal and permissive. It rejects a body that
    // cannot describe an event at all — `dispatch({})` would broadcast three
    // frames and persist a card, putting a junk alert in live chat and a row in
    // the DB. `platform` and `eventType` are the two fields everything downstream
    // switches on, and every real producer sets both.
    //
    // What this does not do, on purpose: there is no single amount field to
    // validate. Patreon sends `cents`, Twitch `bits`, Kick `kicks`, Ko-fi/YouTube/
    // Streamlabs `amount`, and sub/gift events carry only `months`/`count`/`tier`
    // with take-home derived server-side. A rule that required "an amount" would
    // silently drop real donations — worse than no validation. It also does not
    // check `platform` against a known list: an unknown platform already yields
    // take-home 0 safely, and a whitelist would 400 the day a platform is added.
    app.post('/alert', requireInternal, wrap(async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'alert body must be an object' });
      }
      const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
      const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
      if (!platform || !eventType) {
        console.warn('[alert] rejected: platform=%j eventType=%j — a producer is sending an ' +
          'incomplete payload; this would have broadcast a junk card',
          body.platform, body.eventType);
        // Rate-limited by key inside notify(): a producer sending a bad shape
        // sends it for every event, and a push per event gets the channel muted.
        notify(
          'alert.rejected-envelope',
          '/alert envelope rejected',
          'a producer is POSTing an incomplete alert — alerts from it are being dropped',
          { critical: true },   // an alert dropped is a viewer's moment lost
        );
        return res.status(400).json({ error: 'alert requires a non-empty platform and eventType' });
      }
      // Keyed platform-first — never trust a producer to prefix its own ids;
      // the same raw id on two platforms must stay two events.
      //
      // Acknowledgement (stream-ingest's postAlert): a 2xx is sent only once dispatch has
      // resolved — the ledger answered and the celebration fired or was a duplicate. A
      // second delivery of an id still in flight WAITS for the first (never "deduped"
      // early), and an id is remembered only after its dispatch succeeded: a dispatch that
      // throws answers 500 (wrap) and is forgotten, so postAlert's retry runs it again.
      // postAlert retries a 5xx or a network error twice (1 s, 3 s) with an 8 s deadline per
      // attempt, and never a 4xx. A held celebration outlives that deadline: the first
      // delivery keeps running here, and the late retry joins it.
      const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
      const out = await alertSeen.run(eventId ? `${platform}:${eventId}` : '', () => alert.dispatch(body));
      res.json(out.replay ? { ok: true, deduped: true } : { ok: true });
    }));

    // POST /speak — the bot's TTS route (gated by tts.enabled like every spoken line).
    // Body: { text?, noise?, noiseBefore?, noiseAfter?, padBeforeMs?, padAfterMs? }.
    app.post('/speak', requireInternal, wrap(async (req, res) => {
      const parsed = parseSpeakBody(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (!ttsEnabled()) return res.json({ ok: true, skipped: 'tts disabled' });
      // `wait`: answer when his audio has REALLY finished, with its start and end — the
      // brain times his next line off that instead of guessing. Everyone else (alerts,
      // paid TTS) is answered the moment the turn is queued.
      if (req.body && req.body.wait === true) {
        const played = await tts.speak(parsed.turn);
        const t = parsed.turn;
        return res.json(played && t.endedAt
          ? { ok: true, played: true, startedAt: t.startedAt, endedAt: t.endedAt, synthMs: t.synthMs, quietBeforeMs: t.quietBeforeMs }
          : { ok: true, played: false });
      }
      tts.speak(parsed.turn);
      res.json({ ok: true });
    }));

    // POST /support/reconcile — settle one stream.unpriced_support row by hand (requireSecret).
    // Body: { id, amountUsd } credits it, or { id, dismiss: true } closes it with no credit.
    // A credit is written through the ledger writer under the row's STORED event_id and its
    // own stream, with no celebration: no alert, sound, lights, TTS or card (the event was
    // celebrated when it arrived). When that stream is the one LIVE now, the live bar and the timer
    // take the credit's admitted amount after the COMMIT (liveCredit below) — the bar's restart
    // rebuild sums that stream's rows, so a credit left off the live bar would jump it at the next
    // restart. A past stream's credit counts in its own history only. Idempotent: the event_id's
    // unique index makes a second credit a no-op, and a
    // settled row answers with what it was settled as. A refund or dispute held for this event
    // (stream.support_reversal_holds — it arrived while the row waited here) is taken back in the
    // same transaction, so a refunded payment is never credited in full.
    app.post('/support/reconcile', requireSecret, wrap(async (req, res) => {
      const b = req.body || {};
      const id = Number(b.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
      const dismiss = b.dismiss === true;
      const amountUsd = Number(b.amountUsd);
      // No ceiling — a large payment is the case this path exists for.
      if (!dismiss && !(Number.isFinite(amountUsd) && amountUsd > 0)) {
        return res.status(400).json({ error: 'amountUsd must be a positive number (or send dismiss: true)' });
      }
      if (!dismiss && !recordSupport) return res.status(503).json({ error: 'ledger writer not wired' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The event's lock comes FIRST (before the row lock), the order every writer of this event
        // takes — the reversal route and a late delivery (recordSupport) — so the credit and a
        // refund racing it serialise instead of deadlocking. An event_id never changes.
        const key = (await client.query(`SELECT event_id FROM stream.unpriced_support WHERE id = $1`, [id])).rows[0];
        if (key && key.event_id) await lockSupportEvent(client, key.event_id);
        const { rows } = await client.query(
          `SELECT id, event_id, platform, event_type, user_id, username, stream_id, status, reason, reconciled_amount_usd
             FROM stream.unpriced_support WHERE id = $1 FOR UPDATE`, [id]);
        const row = rows[0];
        if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no such unpriced payment' }); }
        if (row.reason === 'ledger_failed' && !row.event_id) {
          await client.query('ROLLBACK');
          // No key to make the credit idempotent against a later delivery of the same event.
          return res.status(409).json({ error: 'a failed-ledger record with no event id cannot be reconciled here — credit it by hand' });
        }
        if (row.status !== 'open') {
          await client.query('ROLLBACK');
          return res.json({ ok: true, deduped: true, status: row.status,
            amountUsd: row.reconciled_amount_usd == null ? null : Number(row.reconciled_amount_usd) });
        }
        let credited = false;
        let reversed = 0;
        let rec = null;
        if (!dismiss) {
          const amount = Math.round(amountUsd * 100) / 100;
          rec = await recordSupport({
            platform: row.platform, userId: row.user_id || undefined, username: row.username,
            amountUsd: amount, eventType: row.event_type, eventId: row.event_id,
            reconciles: true, streamId: row.stream_id || null, db: client,
          });
          credited = !rec.duplicate;
          reversed = rec.reversed || 0;
        }
        await client.query(
          `UPDATE stream.unpriced_support
              SET status = $2, reconciled_at = NOW(), reconciled_amount_usd = $3
            WHERE id = $1`,
          [id, dismiss ? 'dismissed' : 'reconciled', dismiss ? null : Math.round(amountUsd * 100) / 100]);
        await client.query('COMMIT');
        const moved = credited ? await liveCredit(row, rec, Math.round(amountUsd * 100) / 100) : null;
        console.log('[support] unpriced payment %s %s — event=%s%s%s%s', id, dismiss ? 'DISMISSED' : 'RECONCILED',
          row.event_id || '?', dismiss ? '' : ` amountUsd=${Math.round(amountUsd * 100) / 100}${credited ? '' : ' (the ledger already held this event)'}`,
          reversed ? ` — ${reversed} held reversal(s) taken back` : '', moved ? ` — ${moved}` : '');
        if (credited) rebuildSponsorPool();
        return res.json({ ok: true, status: dismiss ? 'dismissed' : 'reconciled', credited });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }));

    // POST /support/reverse — a refund or dispute of a NATIVE payment (requireInternal; web's
    // Stripe and PayPal webhooks call it). Body:
    //   { kind: 'donation'|'gift'|'sub', spendId, ref, reason: 'refund'|'dispute', refunded?, gross? }
    //   { kind, spendId, ref, reason: 'restore' }   — the refund failed / the dispute was won
    // `spendId` is the one the payment's /chat/event carried, so the original ledger row is
    // found by the same key. `ref` names this reversal (a refund or dispute id) — the same
    // refund twice is ONE reversal. `refunded`/`gross` are in the payment's own minor units:
    // the reversal is the original take-home × refunded/gross (a partial refund reverses its
    // share only), absent both = the whole remainder. Never more than what is still unreversed.
    //
    // The reversal is a NEGATIVE stream.support_events row (event_type 'reversal',
    // reverses_id → the original, stream_id NULL) with NO effects. What it moves, by design:
    //   • lifetime support, support tiers (aggregates.js sums every row by person) — DOWN;
    //   • sponsor weighting (sponsors.js nets reversals against their original) — DOWN;
    //   • the per-stream bar, the timer, the meter — UNTOUCHED: the bar sums one stream_id
    //     (a reversal has none) and the timer/meter move only on a live credit.
    //
    // A credit the ledger does not hold yet: the reversal is HELD (stream.support_reversal_holds)
    // and answered 202 { held: 'pending' } — the credit takes it back when it lands (reconcile, or a
    // late delivery), and the bar and the timer then admit only its net (admitted_usd, v159).
    // Durable here, so the caller has nothing to redeliver. A restore marks the
    // ref's hold `cancelled` (200 { held: 'cancelled' } when there is no credit yet): an opening
    // event that arrives after its outcome takes nothing.
    app.post('/support/reverse', requireInternal, wrap(async (req, res) => {
      const b = req.body || {};
      const kind = typeof b.kind === 'string' ? b.kind : '';
      const spend = nativeSpendKey(kind, b.spendId);
      const ref = typeof b.ref === 'string' ? b.ref.trim() : '';
      const reason = b.reason;
      if (!MONEY_KINDS.has(kind) || !spend || !ref || ref.length > 200 || !['refund', 'dispute', 'restore'].includes(reason)) {
        return res.status(400).json({ error: 'needs kind (donation|gift|sub), spendId, ref and reason (refund|dispute|restore)' });
      }
      const originalEventId = ledgerEventId(NATIVE_PLATFORM, spend);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockSupportEvent(client, originalEventId);
        const orig = (await client.query(
          `SELECT id, user_id, platform, username, amount_usd FROM stream.support_events
            WHERE event_id = $1 AND reverses_id IS NULL FOR UPDATE`, [originalEventId])).rows[0];
        const hold = (await client.query(
          `SELECT status FROM stream.support_reversal_holds WHERE event_id = $1 AND ref = $2`, [originalEventId, ref])).rows[0];
        if (reason === 'restore') {
          // Terminal whatever came before: a held reversal is dropped, a late opening event takes nothing.
          await client.query(
            `INSERT INTO stream.support_reversal_holds (event_id, ref, status) VALUES ($1, $2, 'cancelled')
             ON CONFLICT (event_id, ref) DO UPDATE SET status = 'cancelled', updated_at = NOW()`, [originalEventId, ref]);
          if (!orig) {
            await client.query('COMMIT');
            console.log('[support] restore before any credit — event=%s ref=%s: %s', originalEventId, ref,
              hold && hold.status === 'pending' ? 'its held reversal is dropped' : 'a later opening event takes nothing');
            return res.json({ ok: true, held: 'cancelled' });
          }
        } else if (hold && hold.status === 'cancelled') {
          // Its outcome (refund failed / dispute won) came first.
          await client.query('COMMIT');
          return res.json({ ok: true, amountUsd: 0 });
        } else if (!orig) {
          const share = reversalShare(b.refunded, b.gross);
          const ins = await client.query(
            `INSERT INTO stream.support_reversal_holds (event_id, ref, reason, share, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT (event_id, ref) DO NOTHING`, [originalEventId, ref, reason, share]);
          const waiting = (await client.query(
            `SELECT id, reason, status FROM stream.unpriced_support WHERE event_id = $1`, [originalEventId])).rows[0];
          await client.query('COMMIT');
          if ((ins.rowCount ?? 0) > 0) {
            if (waiting) {
              console.warn('[support] %s HELD — event=%s ref=%s: the ledger has no credit yet; unpriced_support #%s (%s, %s) nets it when it is reconciled',
                reason, originalEventId, ref, waiting.id, waiting.reason, waiting.status);
            } else {
              // Loud: nothing anywhere holds this payment. The hold applies if its credit ever lands.
              console.error('[support] %s HELD for a payment found NOWHERE — event=%s ref=%s: no ledger credit and no unpriced record. Taken back if the credit lands; check the payment by hand.',
                reason, originalEventId, ref);
            }
          }
          return res.status(202).json({ ok: true, held: 'pending' });
        }
        let amount;
        let eventId;
        let inserted;
        if (reason === 'restore') {
          const rev = (await client.query(
            `SELECT amount_usd FROM stream.support_events WHERE event_id = $1`, [`rev:${originalEventId}:${ref}`])).rows[0];
          amount = rev ? -Number(rev.amount_usd) : 0;
          eventId = `restore:${originalEventId}:${ref}`;
          if (Math.abs(amount) > 0) {
            const ins = await client.query(
              `INSERT INTO stream.support_events
                 (user_id, platform, username, amount_usd, event_type, stream_id, event_id, reverses_id)
               VALUES ($1, $2, $3, $4, 'reversal-restore', NULL, $5, $6)
               ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
               RETURNING id`,
              [orig.user_id, orig.platform, orig.username, amount, eventId, orig.id]);
            inserted = (ins.rowCount ?? 0) > 0;
          }
        } else {
          const out = await writeReversal(client, orig, originalEventId, { ref, reason, share: reversalShare(b.refunded, b.gross) });
          amount = out.amount;
          inserted = out.inserted;
        }
        await client.query('COMMIT');
        if (!(Math.abs(amount) > 0)) return res.json({ ok: true, amountUsd: 0 });
        if (!inserted) return res.json({ ok: true, deduped: true });
        const original = Number(orig.amount_usd);
        // Ids and amounts only — never the donor's name.
        console.log('[support] %s %s — event=%s ref=%s amountUsd=%s (original %s) — lifetime/tier/sponsor totals adjusted; bar and timer untouched',
          reason === 'restore' ? 'RESTORE of reversal' : reason === 'refund' ? 'REFUND' : 'DISPUTE',
          kind, originalEventId, ref, amount.toFixed(2), original.toFixed(2));
        rebuildSponsorPool();
        return res.json({ ok: true, amountUsd: amount });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }));

    // POST /support-bar/reset — start a fresh stream (zeroes the bar + timer,
    // rebuilds the sponsor pool, clears overlays).
    app.post('/support-bar/reset', requireInternal, wrap(async (req, res) => {
      // Not during a night. `timer.reset()` sets the gap to `baseSec` (3h of
      // UNSOLD frontier handed out for free — the one number only money may
      // move), pauses the clock, and leaves the night active; the pool rebuild
      // then drops the night's funders. "A fresh stream" and "a night in
      // progress" contradict, so the route refuses with a sentence instead.
      if (timer.snapshot().night.active) {
        return res.status(400).json({ error: 'A night is running — end it before resetting the bar and timer.' });
      }
      supportBar.reset();
      timer.reset();
      // The credit line is per-stream too: without this a fresh stream opens
      // with the previous one's funders still rotating at full weight.
      rebuildSponsorPool();
      res.json({ ok: true });
    }));

    // ── Stream timer endpoints. stream-ingest + the website hit these. ────────
    // !a / !s — relative adjust. body: { input, sign }  (sign -1 for !s)
    //
    // A refusal is `{ ok: false, seconds: 0 }` — a 200, not an error — and it
    // says why in `reason`, a sentence the mod panel and the /timer slash
    // command show verbatim. There is one writer of that sentence, here, from
    // the timer's own state: during a night `lockAtZero` does not apply, and the
    // refusals are the seed floor (only sold time can be subtracted — `nightFloor`)
    // and the funded ceiling.
    app.post('/timer/adjust', requireInternal, wrap(async (req, res) => {
      const sign = Number(req.body?.sign) || 1;
      const applied = timer.adjust(req.body?.input, sign);
      if (applied !== 0) return res.json({ ok: true, seconds: applied });
      res.json({ ok: false, seconds: 0, reason: adjustRefusalReason(req.body?.input, sign, timer.snapshot()) });
    }));
    // !set — absolute remaining. body: { input }
    app.post('/timer/set', requireInternal, wrap(async (req, res) => {
      const seconds = timer.set(req.body?.input);
      res.json({ ok: seconds > 0, seconds });
    }));
    // !start / !pause (or scene-driven). body: { action: 'play' | 'pause' }
    app.post('/timer/control', requireInternal, wrap(async (req, res) => {
      const ok = timer.control(req.body?.action);
      res.json({ ok });
    }));
    // !cap / !hr / !fill — marathon config. body: { cap?: 'on'|'off'|'<dur>', hr?, fill? }
    app.post('/timer/config', requireInternal, wrap(async (req, res) => {
      const b = req.body || {};
      const cfg = timer.setConfig({
        cap:  typeof b.cap === 'string' ? b.cap : undefined,
        hr:   b.hr != null ? Number(b.hr) : undefined,
        fill: b.fill != null ? Number(b.fill) : undefined,
        baseSec: b.baseSec != null ? Number(b.baseSec) : undefined,
        lockAtZero: typeof b.lockAtZero === 'boolean' ? b.lockAtZero : undefined,
        lowPulseEnabled: typeof b.lowPulseEnabled === 'boolean' ? b.lowPulseEnabled : undefined,
        lowThresholdSec: b.lowThresholdSec != null ? Number(b.lowThresholdSec) : undefined,
        lowRampRate: b.lowRampRate != null ? Number(b.lowRampRate) : undefined,
        lowGlowMax: b.lowGlowMax != null ? Number(b.lowGlowMax) : undefined,
      });
      // A refused knob is a caller error, not a partial success — say which and
      // how to fix it. A bare "10" is refused rather than read as ten seconds,
      // which would otherwise be accepted silently as a cap.
      if (cfg.refused?.includes('cap')) {
        return res.status(400).json({ error: "cap needs a unit — e.g. '10h' or '90m' — or 'on'/'off'" });
      }
      const segments = cfg.usdPerHour > 0 ? Math.max(1, Math.ceil(cfg.fillUsd / cfg.usdPerHour)) : 1;
      res.json({ ok: true, config: cfg, segments });
    }));
    // Fund the Night: open/extend/end the bedtime-priced night.
    // timer.js's startNight/extendNight/endNight hold the lifecycle + money→time math;
    // this route is just the wire shape + the NightConfigError→400 translation.
    // body: { action: 'start'|'extend'|'end'|'target', end?, hours?, priceCents?, seedSec? }
    // `target`: re-price the RUNNING night at `priceCents` —
    // same U curve, new total — for the nights the meter's required-$/day is
    // wrong and a big donation would otherwise buy insultingly little time.
    app.post('/timer/night', requireInternal, wrap(async (req, res) => {
      const b = req.body || {};
      try {
        if (b.action === 'start') {
          // A second `start` over a running night would silently replace it,
          // losing the funded frontier, ember and overflow. A re-press, a
          // re-typed bedtime and a slash retry all land here, so it is refused
          // with the sentence the panel shows; `force: true` is the deliberate
          // replacement.
          if (timer.snapshot().night.active && b.force !== true) {
            return res.status(400).json({ error: 'A night is already running — end it first (or send force: true to replace it).' });
          }
          // meter.requiredCentsPerDay() is nullable (no snapshot read yet) —
          // startNight's price floor wants a number, not "unknown".
          const required = meter.requiredCentsPerDay();
          const snap = timer.startNight({
            endLocal: b.end,
            tz: nightTimeZone(),
            requiredCentsPerDay: required ?? 0,
            seedSec: b.seedSec,
            priceCents: b.priceCents,
          });
          // A new night is a new pool (sponsors.reset's docblock has the why).
          // AFTER startNight, never before: the rebuild reads the night's own
          // state, so running it first would rebuild against the night that
          // just ended. `extend`/`end` deliberately do NOT — they are the same
          // night, and a rebuild there would drop live-keyed rows for nothing.
          rebuildSponsorPool();
          return res.json(snap);
        }
        if (b.action === 'extend') {
          const hours = Number(b.hours);
          if (!Number.isFinite(hours) || hours <= 0) {
            return res.status(400).json({ error: 'extend requires hours > 0' });
          }
          return res.json(timer.extendNight(hours));
        }
        if (b.action === 'end') return res.json(timer.endNight());
        if (b.action === 'target') return res.json(timer.repriceNight(b.priceCents));
      } catch (e) {
        // A misread end time or an encore with nothing to extend from is a
        // caller error, not a server fault — NIGHT_CONFIG_ERROR_CODES is the
        // exhaustive list; anything else rethrows to `wrap`'s 500.
        if (NIGHT_CONFIG_ERROR_CODES.has(e.code)) return res.status(400).json({ error: e.message });
        throw e;
      }
      res.status(400).json({ error: 'action must be start|extend|end|target' });
    }));

    // GET /tts/status — { enabled, keySet, voiceSet, sink }. The coin store
    // greys the paid-TTS tile while `enabled` is off (never charge for a silent no-op; see
    // /chat/event tts_msg); the doctor fails `enabled` without a key and a voice. Never a value:
    // the key and the voice ids are reported as set / not set.
    app.get('/tts/status', requireInternal, (req, res) => {
      const s = typeof tts?.status === 'function' ? tts.status() : {};
      res.json({ enabled: ttsEnabled(), keySet: s.keySet === true, voiceSet: s.voiceSet === true, sink: s.sink || null });
    });

    // GET /sounds/manifest — clip catalog for the coin store ({enabled, sounds}).
    app.get('/sounds/manifest', requireInternal, (req, res) => {
      res.json(sounds.manifest());
    });

    // Coin-store sticker overlay (transparent page; add as
    // http://<stream-api host>:3001/overlay/sticker in OBS). Consumes showSticker frames.
    // With its CSP / nosniff / no-framing headers (overlay-page.js).
    app.get('/overlay/sticker', (req, res) => require('./overlay-page').sendOverlayPage(res, require('path').join(__dirname, 'overlay-sticker.html')));

    // POST /chat/event — broadcast a celebratory system event (gift / donation /
    // sub / coin spend) into chat. Called by the Next.js billing webhook AFTER it
    // has granted the gift / recorded the donation (the webhook is the only
    // writer of that state), and by the coin-store spend routes. Cards for
    // gift/donation/sub/cheer/sticker are persisted as first-class messages;
    // effect flags (spoken/played) are returned so a paid effect that could NOT
    // run is refunded web-side — never keep coins for a silent no-op.
    app.post('/chat/event', requireInternal, wrap(async (req, res) => {
      const kind = req.body?.kind;
      if (!MONEY_KINDS.has(kind) && !COIN_KINDS.has(kind))
        return res.status(400).json({ error: 'bad kind' });

      // Idempotency: the web's deadline aborts
      // its WAIT, not this handler's WORK — so an aborted spend is RETRIED by
      // the web (same spendId = its coin-ledger ref) instead of refunded
      // blind, and this store turns the retry into a replay instead of a
      // second credit. Refusals are deliberately NOT recorded — a refusal
      // credited nothing, so the retry must re-process and a refund stays
      // legal. A key with no body yet means the first delivery is mid-work
      // (or died mid-work): 409, because re-running could double-credit and
      // replaying would invent an outcome. Fail-open with no spendId — the
      // billing webhook's gift/donation/sub cards carry their own replay
      // guard upstream.
      const spendId = typeof req.body?.spendId === 'string' ? req.body.spendId.trim() : '';
      const spendKey = spendId ? `${kind}:${spendId}` : '';
      if (spendKey) {
        const prior = spendOutcomes.get(spendKey);
        if (prior) {
          // Replay the original status as well as the body: a settled refusal
          // replayed as a 200 reads as "delivered" to the web's classifier,
          // turning a refund-legal outcome into a kept spend on retry.
          if (prior.body) return res.status(prior.body.status).json({ ...prior.body.json, deduped: true });
          return res.status(409).json({ error: 'in_flight' });
        }
        spendOutcomes.set(spendKey, null);
      }
      const settle = (body, status = 200) => { if (spendKey) spendOutcomes.set(spendKey, { status, json: body }); return body; };
      const unsettle = () => { if (spendKey) spendOutcomes.delete(spendKey); };

      // Synthetic, collision-proof id for the (platform,id) dedupe + scroll key. These
      // rows never hit the DB, so the id only needs to be unique within the buffer.
      const id = `${kind[0]}${Date.now()}-${systemSeq++}`;
      const base = { type: 'message', platform: 'system', id, system: kind, ts: Date.now() };

      // Card construction is a pure builder in alert.js (gift/donation/sub) so it can
      // be unit-tested; null => gift with no recipients, nothing to announce.
      let msg;
      try {
        msg = alert.buildEventCard(kind, req.body, base, maskBlacklist);
      } catch (e) {
        // Nothing has run yet — no credit, no card, no broadcast. Release the
        // key so a retry re-processes; a null left behind would hold the
        // spendId as in_flight for its whole TTL.
        unsettle();
        throw e;
      }
      if (!msg) return res.json(settle({ ok: true, skipped: 'nothing to announce' }));

      // Verify before the effect (policy: precheckStickerTarget). The UPDATE ...
      // RETURNING below also validates a sticker_boost's target, but the effects
      // block fires the overlay pop first, so without this check a boost aimed
      // at a bad id pops the overlay and then 404s while the web refunds it. The
      // UPDATE still re-asserts `event_kind = 'sticker'`; the window between
      // them is not exploitable, because a row cannot stop being a sticker.
      if (KIND_POLICY[kind].precheckStickerTarget) {
        const messageId = parseInt(req.body.originalMessageId, 10);
        if (!Number.isInteger(messageId) || messageId <= 0) {
          unsettle();
          return res.status(400).json({ error: 'bad messageId' });
        }
        const exists = await pool
          .query(`SELECT 1 FROM site.chat_messages WHERE id = $1 AND event_kind = 'sticker'`, [messageId])
          .catch((e) => { console.error('[chat/event] sticker_boost precheck:', e.message); return null; });
        // A failed precheck query is NOT a pass — refuse rather than fire the effect blind.
        if (!exists || exists.rowCount === 0) {
          unsettle();
          return res.status(404).json({ error: 'not_a_sticker' });
        }
      }

      // Effects run BEFORE the broadcast so the card carries `addedSeconds`.
      let spoken;
      let played;
      let effectsThrew = false;
      let ledgerFailed = false;
      let ledgerDuplicate = false;
      let ledgerRefunded = false;
      try {
        const out = await effectHandlers[kind]({ msg, body: req.body || {} });
        spoken = out.spoken;
        played = out.played;
        msg.addedSeconds = (out.r && out.r.addedSeconds) || 0;
        ledgerDuplicate = !!(out.r && out.r.duplicate);
        ledgerRefunded = !!(out.r && out.r.refunded);
      } catch (e) {
        effectsThrew = true;
        ledgerFailed = !!(e && e.code === 'LEDGER_WRITE_FAILED');
        console.error('[chat/event] %s effects threw: %s', kind, e.message);
      }

      // The LEDGER could not record a money event (alert.js LedgerWriteError): nothing fired,
      // nothing was credited, and the event may sit in stream.unpriced_support as
      // 'ledger_failed'. That is NOT effects_failed — web reads effects_failed as "refused,
      // refund-legal". ledger_unavailable is a 503 web retries and never refunds on; the key is
      // released so the retry re-processes, and a retry that lands settles the ledger_failed row.
      if (ledgerFailed) {
        unsettle();
        return res.status(503).json({ ok: false, error: 'ledger_unavailable', kind });
      }

      // A handler that THREW never reached its effect. Answer with an error so
      // the web spend routes refund — UNLESS the kind reports its own outcome
      // through a refundFlag (tts_msg/sound), which the flag flow below
      // handles.
      if (effectsThrew && !KIND_POLICY[kind].refundFlag) {
        // "nothing was credited" is guaranteed here: cheer/sticker/sticker_boost
        // never credit anything, tts_msg/sound are
        // excluded by the refundFlag check above, and donation/gift/sub's
        // fireStreamEffects swallows its own post-ledger failures (alert.js), and
        // a LEDGER failure was answered above as ledger_unavailable — so an
        // escaping throw here can only mean the effect itself failed, never
        // the money. This refusal is safe to forget: the retry may re-process,
        // the refund may proceed.
        unsettle();
        return res.status(500).json({ ok: false, error: 'effects_failed', kind });
      }

      // A paid effect that couldn't run posts NO card — the web route refunds the
      // spend, and a card announcing something that never happened would be a lie.
      // These ARE recorded outcomes (settle, not unsettle): the flag is the
      // answer, and a retry must hear the same flag, not run the effect again.
      if (kind === 'tts_msg' && !spoken) return res.json(settle({ ok: false, spoken: false }));
      if (kind === 'sound' && !played) return res.json(settle({ ok: false, played: false }));

      // The ledger already holds this spendId's event (a retry that bridged a
      // restart, so the in-memory spendOutcomes above was empty): the first
      // delivery posted the card, and fireStreamEffects fired nothing this time.
      // A second card would be a second row and a second line in chat.
      if (ledgerDuplicate) return res.json(settle({ ok: true, deduped: true }));
      // Credited and refunded in one go (refunds held for it took it all back): no card, like no
      // celebration (alert.js). Settled, so a retry hears the same answer.
      if (ledgerRefunded) return res.json(settle({ ok: true, refunded: true }));

      // A boost updates the EXISTING sticker row in place (bump boostCoins, bump
      // created_at so it re-sorts to the bottom) instead of persisting a new row —
      // one sticker message for its whole life, never duplicated. Broadcasts
      // `stickerMove` (not `message`) so already-connected clients remove the row
      // from wherever it sits and re-append it, rather than blindly appending a
      // second copy.
      if (KIND_POLICY[kind].movesExistingCard) {
        const messageId = parseInt(req.body.originalMessageId, 10);
        if (!Number.isInteger(messageId) || messageId <= 0) {
          unsettle();
          return res.status(400).json({ error: 'bad messageId' });
        }
        const upd = await pool.query(
          `UPDATE site.chat_messages
             SET event_json = event_json || jsonb_build_object('boostCoins', $2::int),
                 created_at = NOW()
           WHERE id = $1 AND event_kind = 'sticker'
           RETURNING id, event_json`,
          [messageId, msg.boostCoins]
        ).catch((e) => { console.error('[chat/event] sticker_boost update failed AFTER the effect:', e.message); return null; });
        // A DB error is not a refusal: the effects block has
        // already fired the overlay pop — the boost was already accepted, so
        // answering a settled 404 would tell the web to refund coins for a
        // boost that already showed. Answer an unclassifiable 5xx (→
        // unconfirmed web-side, NO refund) and leave the key in flight:
        // replaying would invent an outcome the effects never confirmed.
        if (!upd) return res.status(503).json({ error: 'boost_unconfirmed' });
        const row = upd.rows[0];
        // NOT unsettle(): by this point the effects block has already fired
        // the overlay pop for the boost — a forgotten key would let a retry
        // re-run the effects a second time. The recorded refusal is the
        // honest outcome, and it replays WITH its 404 status.
        if (!row) return res.status(404).json(settle({ error: 'not_a_sticker' }, 404));
        // event_json carries WHATEVER platform/id/type the card had baked in at
        // persist time — for a sticker that's the pre-persist synthetic values
        // ('system'/'s<ts>-<seq>'), since persistEventCard's local `msg.id =
        // numericId` reassignment happens AFTER JSON.stringify(card). Spread
        // event_json FIRST so the real, current identity below always wins.
        const moved = { ...row.event_json, type: 'message', id: parseInt(row.id, 10), platform: NATIVE_PLATFORM, ts: Date.now() };
        bufferReplace(moved); // drop the pre-boost buffered snapshot — one entry per sticker, ever
        broadcast({ ...moved, type: 'stickerMove' }); // live clients: remove + re-append
        return res.json(settle({ ok: true, id: moved.id }));
      }

      // Persist so the card is a first-class message (reply/vote/delete/pin) — on
      // success switch it to a real numeric id + the site's own platform id.
      const numericId = await persistEventCard(msg);
      if (numericId != null) { msg.id = numericId; msg.platform = NATIVE_PLATFORM; }

      bufferPush(msg);
      broadcast(msg);
      res.json(settle({ ok: true, id: msg.id, ...(spoken !== undefined ? { spoken } : {}), ...(played !== undefined ? { played } : {}) }));
    }));
  }

  return { registerMoneyRoutes };
}

module.exports = {
  createMoney, makeRecordSupport, makeRecordUnpriced, makePersistEventCard, supportPlatformId,
  parseSpeakBody,
  KIND_POLICY, COIN_KINDS, MONEY_KINDS,
};
