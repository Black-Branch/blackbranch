'use strict';
// Fund-the-Night: the sponsor credit pool + clock badges. A leaf like meter.js:
// reads stream.support_events + stream.timer_state, folds in the live timer
// through an injected `timer`, and broadcasts a `sponsorState` frame. One HTTP
// route: GET /sponsors/clock (registerSponsorRoutes).
//
// Two surfaces read that frame: the credit-line overlay (tonight's funders,
// biggest weight first) and the web chat clock badge (how much of tonight's
// clock a viewer's money is keeping alive). Both derive from ONE pool:
// identity -> `{ name, weightSec, clockUntilElapsed }`.
//
//   - weightSec is the ranking currency: NOTIONAL seconds on the night's curve
//     (the quantity timer.convertNotional computes), so a donation's worth does
//     not depend on whether the timer was capped or locked when it landed.
//     Every row is in the same unit; mixing cents with seconds would distort the
//     previous cohort's 0.25x weight by the night's price. With no active
//     night, replay uses the flat usdPerHour rate, the same conversion the live
//     path quotes in that case.
//   - clockUntilElapsed is a NIGHT-ELAPSED timestamp, not wall clock, so a
//     paused night pauses every badge. Stacking is additive: a second donation
//     while a badge runs extends it — `max(current, nightElapsedNow) + notionalSec`.
//
// Live (ingest()) and restart (init()) key identity the same way: the canonical
// `stream.users` id. The live path receives it from supportbar's onAdd payload
// as `userId`; a payload without one falls back to the username key.
//
// The name on the wire is the name the money arrived under — the platform's donation name —
// unless the person has chosen to show their linked platforms (site.users.show_links, v153). The
// link between a platform account and a site account is shown only where the person shows it:
// naming a Twitch donation by the site account behind it, or listing a person's other donation
// names beside it, publishes that link to everyone watching the credit
// line. So a donor who has NOT opted in is credited one row per donation name, each under that
// name, with no aliases; a donor who HAS opted in is credited under their site display_name with
// their donation names riding along as `aliases`, so a chat line sent from the donating platform
// still finds its clock badge. The web credit overlay's style lookup matches on display_name, so
// the opt-in is also what gives a linked donor's platform credit their site colour and style.
//
// Anonymous donations are stored with username 'Anonymous' and are excluded
// from the pool everywhere identity is keyed, live and replayed alike.
//
// Currency-spend rows (cheer/sticker/…, index.js's SPEND_EVENT_TYPES) are excluded
// from every read here: a spend is spectacle, not support, and never lights a
// clock.

const { convertCents } = require('./night-math');
const { instanceConfig } = require('./instance-config');
const { NATIVE_SQL } = require('./native-platform');
const { ERASED_NAME } = require('./account-erase');
const { noOptOutSql } = require('./pseudonym');

const HEARTBEAT_MS = 15_000;
const HB_RESYNC_EVERY = 4; // still broadcast every 4th unchanged tick (60s at 15s ticks)
const RECHECK_EVERY = 4;   // re-ask the shown site names' opt-in every 4th tick (60s at 15s ticks)
const MAX_SPONSORS = 50;   // the overlay cycles through the list; a hard cap keeps the frame bounded
const PREVIOUS_SESSION_WEIGHT = 0.25;

function isAnonymous(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === 'anonymous';
}
// A payment whose person deleted their account (account-erase.js renames it to ERASED_NAME): the
// money stays in the ledger, the credit leaves the pool, like an anonymous one.
function isErased(name) { return name === ERASED_NAME; }
// Fallback key for a payload that carries no canonical id.
function keyForUsername(username) { return `n:${String(username).trim().toLowerCase()}`; }
// The canonical, stable key — preferred whenever it is available. With a donation name it is the
// key of ONE of the person's donation names (a donor who has not opted in to showing their links:
// each name its own row, so the pool never pairs two of their names); without one it is the
// person's single row (opted in: one row under the site name).
function keyForUserId(userId, donationName = null) {
  return donationName == null ? `u:${userId}` : `u:${userId}|${String(donationName).trim().replace(/^@+/, '').toLowerCase()}`;
}
// Every pool key that belongs to one canonical id, in either form.
function keyBelongsTo(key, userId) { return key === `u:${userId}` || key.startsWith(`u:${userId}|`); }

// jsonb comes back already parsed from node-pg; this guards against a `json`
// column, another driver, or a fixture handing back raw text, so `blocks` is
// never a STRING that a walk would iterate character by character.
function parseBlocks(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  }
  return null;
}

function createSponsors({ pool, broadcast, timer, getStreamId, excludeEventTypes = [] }) {
  const state = new Map(); // key -> { name, aliases, weightSec, clockUntilElapsed, clockStartElapsed }

  // canonical id -> site display_name of an account that SHOWS its links, or null once looked up
  // and found to have none (no site account, or one that has not opted in). Cleared with the pool
  // on init()/reset() so a
  // renamed account is picked up by the next rebuild; a FAILED lookup is not
  // cached, so the next contribution retries it.
  const displayNames = new Map();

  // One query for a batch of canonicals: the site account behind each, via
  // either join the identity model offers (see the header). Home-homeserver
  // account first on ties, then the newest — the same tiebreak used when
  // duplicate links are reconciled. Bots and blank names never win, and neither does an account
  // that has not chosen to show its links. Answers canonical id -> site display name for those of
  // `ids` whose account shows its links NOW; throws on a database error (the callers decide what
  // a failure means).
  async function lookupSiteNames(ids) {
    const r = await pool.query(
        `SELECT DISTINCT ON (x.canonical_id) x.canonical_id, u.display_name
           FROM (
             SELECT canonical_id, matrix_id FROM site.platform_links WHERE canonical_id = ANY($1::text[])
             UNION ALL
             SELECT canonical AS canonical_id, platform_id AS matrix_id
               FROM stream.links WHERE platform IN ${NATIVE_SQL} AND canonical = ANY($1::text[])
           ) x
           JOIN site.users u ON u.matrix_id = x.matrix_id
          WHERE u.show_links AND NOT COALESCE(u.is_bot, false) AND COALESCE(u.display_name, '') <> ''
            -- No account linked to this canonical has opted out: another account's choice (a
            -- split identity) is never this person's consent. The one predicate (pseudonym.js).
            AND ${noOptOutSql('x.canonical_id')}
          ORDER BY x.canonical_id, (u.matrix_id LIKE '%:' || $2::text) DESC NULLS LAST, u.created_at DESC`,
        // This install's own accounts first (matrix.serverName, env MATRIX_SERVER_NAME). Unset →
        // NULL for every row, so the preference is simply absent, never inverted.
        [ids, instanceConfig.get('matrix.serverName')]
    );
    const out = new Map();
    for (const row of r.rows) {
      const name = String(row.display_name || '').trim();
      if (name) out.set(row.canonical_id, name);
    }
    return out;
  }

  // `into` is the cache to fill: the live one, or a rebuild's own (init builds aside and swaps).
  async function resolveDisplayNames(userIds, into = displayNames) {
    const ids = [...new Set((userIds || []).filter((id) => id != null && id !== '' && !into.has(id)))];
    if (!ids.length || !pool) return;
    try {
      const names = await lookupSiteNames(ids);
      for (const id of ids) into.set(id, names.get(id) || null);
    } catch (e) {
      console.warn('[sponsors] display-name lookup failed (donation names stand):', e.message);
    }
  }
  function nameFor(userId, donationName, names = displayNames) {
    return (userId != null && names.get(userId)) || donationName;
  }
  // The pool key for a payload with a canonical: the person's one row when they show their links
  // (their site name is known), else the row of this donation name alone.
  function keyFor(userId, donationName, names = displayNames) {
    return names.get(userId) ? keyForUserId(userId) : keyForUserId(userId, donationName);
  }
  function bareName(name) { return String(name || '').trim().replace(/^@+/, ''); }
  // A name this identity was credited under that is NOT the shown one.
  function addAlias(entry, name) {
    const bare = bareName(name);
    if (!bare || bare.toLowerCase() === bareName(entry.name).toLowerCase()) return;
    entry.aliases.set(bare.toLowerCase(), bare);
  }

  // The live, ever-advancing "now" for badge math: night-elapsed time, not
  // wall time, so a paused night holds every badge exactly where it was.
  function liveNightElapsed() {
    try {
      const snap = timer.snapshot();
      return Number(snap && snap.night && snap.night.elapsedSec) || 0;
    } catch { return 0; }
  }
  // Is there a clock for a badge to be denominated in at all? Same defensive
  // read as above — an unreadable timer is "no night", which mints nothing.
  function nightActive() {
    try {
      const snap = timer.snapshot();
      return !!(snap && snap.night && snap.night.active);
    } catch { return false; }
  }

  // One mint rule for both paths (live ingest + restart replay): the badge
  // window ends at max(current end, now) + notional; if the badge had EXPIRED
  // (or never existed) the window STARTS now, else the existing start holds —
  // that is what makes `clockTotalSec` the span of one continuous stretch.
  function mintBadge(entry, nowElapsed, notionalSec) {
    if (entry.clockUntilElapsed <= nowElapsed) entry.clockStartElapsed = nowElapsed;
    entry.clockUntilElapsed = Math.max(entry.clockUntilElapsed, nowElapsed) + notionalSec;
  }

  function getOrCreate(key, displayName, donationName = null, into = state) {
    let entry = into.get(key);
    if (!entry) {
      entry = { name: displayName, aliases: new Map(), weightSec: 0, clockUntilElapsed: 0, clockStartElapsed: 0 };
      into.set(key, entry);
    } else {
      // Latest-seen display name wins; the one it replaces is kept as an
      // alias (a site rename mid-night, or the replay's donation name being
      // upgraded to the site name). Set the name FIRST — addAlias refuses
      // the shown name itself.
      const previous = entry.name;
      entry.name = displayName;
      if (previous !== displayName) addAlias(entry, previous);
    }
    if (donationName != null) addAlias(entry, donationName);
    return entry;
  }

  function buildFrame() {
    const nowElapsed = liveNightElapsed();
    // Deterministic tiebreak by name: weightSec ties are common, and without a
    // second sort key the order follows Map insertion (DB row order, not stable
    // on exact created_at ties), so the 50-cap could select a different set of
    // sponsors across two restarts of identical data.
    // One row per name on the wire. The pool is keyed on IDENTITY, and one
    // person can hold several ids; the frame is for viewers, so rows whose
    // display names match (case-insensitive) merge here: weight sums, the badge
    // window is the union (latest end; the earliest start among windows still
    // running, so a merged sweep never reads fuller than either part). The
    // identity keys stay separate underneath; money attribution is untouched.
    // A leading '@' is not part of a name: donation platforms spell the same
    // donor both ways, so the bare spelling is shown and merged.
    const byName = new Map();
    for (const e of state.values()) {
      const bare = bareName(e.name);
      const k = bare.toLowerCase();
      const m = byName.get(k);
      // Aliases union across the merged identities; the shown name is never
      // its own alias. Entries a test seeds by hand may carry no alias map.
      const aliases = new Map(e.aliases instanceof Map ? e.aliases : []);
      aliases.delete(k);
      if (!m) { byName.set(k, { name: bare, aliases, weightSec: e.weightSec, clockUntilElapsed: e.clockUntilElapsed, clockStartElapsed: e.clockStartElapsed }); continue; }
      for (const [ak, av] of aliases) m.aliases.set(ak, av);
      m.weightSec += e.weightSec;
      const aLive = m.clockUntilElapsed > nowElapsed, bLive = e.clockUntilElapsed > nowElapsed;
      if (aLive && bLive) m.clockStartElapsed = Math.min(m.clockStartElapsed, e.clockStartElapsed);
      else if (bLive) m.clockStartElapsed = e.clockStartElapsed;
      m.clockUntilElapsed = Math.max(m.clockUntilElapsed, e.clockUntilElapsed);
    }
    const rows = [...byName.values()]
      .sort((a, b) => b.weightSec - a.weightSec || a.name.localeCompare(b.name));
    const totalWeight = rows.reduce((sum, e) => sum + e.weightSec, 0);
    let sponsors = rows.map((e) => ({
      name: e.name,
      // Other names this person was credited under (platform donation names
      // when `name` is their site display name) — for the chat clock badge to
      // match a message they send from that platform. Empty for most rows.
      aliases: [...e.aliases.values()],
      // Share of the FULL pool, computed before capping: weightPct means
      // "share of everyone", so a capped frame's percentages can sum to less
      // than 100.
      weightPct: totalWeight > 0 ? Math.round((e.weightSec / totalWeight) * 1000) / 10 : 0,
      clockRemainSec: Math.max(0, Math.round(e.clockUntilElapsed - nowElapsed)),
      // The length of the current unbroken badge window: the chat badge is a
      // sweep ring whose fill is remain/total. A stacking donation extends the
      // window; a donation after the badge expired starts a fresh one.
      clockTotalSec: Math.max(0, Math.round(e.clockUntilElapsed - e.clockStartElapsed)),
    }));
    if (sponsors.length > MAX_SPONSORS) {
      console.log(`[sponsors] capped sponsor list at ${MAX_SPONSORS} (${sponsors.length} in the pool)`);
      sponsors = sponsors.slice(0, MAX_SPONSORS);
    }
    return { type: 'sponsorState', sponsors };
  }

  // Change-detection key for the heartbeat — not the frame itself.
  // `clockRemainSec` ticks down every second a night runs, so hashing its
  // exact value would make one live badge force a broadcast on every tick.
  // It is bucketed to a full resync window (HB_RESYNC_EVERY heartbeats); the
  // periodic resync delivers the exact value. Zero is always its own bucket
  // (`Math.ceil(0/W) === 0`), so a badge running out still broadcasts at once.
  const CLOCK_BUCKET_SEC = HB_RESYNC_EVERY * (HEARTBEAT_MS / 1000);
  function frameKey(frame) {
    return JSON.stringify({
      type: frame.type,
      sponsors: frame.sponsors.map((s) => ({
        name: s.name,
        weightPct: s.weightPct,
        clockBucket: Math.ceil(s.clockRemainSec / CLOCK_BUCKET_SEC),
      })),
    });
  }

  // Heartbeat change-detection (same shape as timer.js's heartbeatTick and
  // meter.js's heartbeatTick): unchanged state -> skip the broadcast, EXCEPT
  // every HB_RESYNC_EVERY-th tick fires regardless of change.
  //
  // sponsorState is never bufferPush'd, so it is not in ws-hub's `history`
  // replay; the periodic resync is what keeps every connected client current
  // without waiting for the pool to change.
  let hbKey = null;
  let hbSkipped = 0;

  /** The frame as it stands — pushed to a client the moment it connects
   *  (ws-hub `connectFrames`), because `sponsorState` is not in the `history`
   *  replay and the resync floor would otherwise leave a freshly loaded
   *  credit line blank for up to a minute. */
  function currentFrame() { return buildFrame(); }

  function emit() {
    const frame = buildFrame();
    broadcast(frame);
    hbKey = frameKey(frame);
    hbSkipped = 0;
    return frame;
  }

  let ticks = 0;
  function heartbeatTick() {
    ticks += 1;
    if (ticks % RECHECK_EVERY === 0) recheckOptIns().catch(() => {});
    const frame = buildFrame();
    const key = frameKey(frame);
    if (key !== hbKey) {
      broadcast(frame);
      hbKey = key;
      hbSkipped = 0;
      return;
    }
    hbSkipped += 1;
    if (hbSkipped >= HB_RESYNC_EVERY) {
      hbSkipped = 0;
      broadcast(frame);
    }
  }

  function startHeartbeat(ms = HEARTBEAT_MS) {
    const t = setInterval(heartbeatTick, ms);
    if (t.unref) t.unref();
    return t;
  }

  // ── Live path: appended by supportbar.js's enriched onAdd, no DB read ──────
  //
  // Weight always; the badge only during a night. Off-air money earns
  // next-stream credit-pool weight but no badge: `clockUntilElapsed` is
  // denominated in `night.elapsedSec`, which never advances without a night, so
  // a badge minted here would never count down — and the replay, which mints
  // no badge without an active night, would disagree about the same donation.
  // One live credit, applied to a pool (the live one, or a rebuild's own when the journal is
  // replayed onto it). `night` is read once, when the credit arrived.
  function applyCredit(c, ctx = { state, displayNames }) {
    const hasId = c.userId != null && c.userId !== '';
    const key = hasId ? keyFor(c.userId, c.username, ctx.displayNames) : keyForUsername(c.username);
    const entry = getOrCreate(key, nameFor(c.userId, c.username, ctx.displayNames), c.username, ctx.state);
    entry.weightSec += c.notionalSec;
    if (c.nightActive) mintBadge(entry, c.nowElapsed, c.notionalSec);
    return { key, entry };
  }

  function ingest({ username, userId = null, cents, notionalSec, ledgerId = null } = {}) {
    if (!username || isAnonymous(username)) return;
    if (!(Number(cents) > 0)) return;
    const notional = Number(notionalSec);
    const safeNotional = Number.isFinite(notional) && notional > 0 ? notional : 0;
    const hasId = userId != null && userId !== '';

    const active = nightActive();
    const credit = {
      username, userId: hasId ? userId : null, notionalSec: safeNotional,
      nightActive: active, nowElapsed: active ? liveNightElapsed() : 0,
      ledgerId: ledgerId != null && ledgerId !== '' ? String(ledgerId) : null,
    };
    const { key, entry } = applyCredit(credit);
    // A rebuild is reading the ledger right now: its swap must not drop this credit (journal).
    if (rebuilding) journal.push({ kind: 'credit', credit });
    emit();

    // First sighting of this canonical since the last rebuild: the frame
    // above went out under the donation name so the credit is never late;
    // the site name (if any) follows on the next frame, the donation name
    // demoted to an alias. Nothing to do when the cache already answered.
    if (hasId && !displayNames.has(userId) && pool) {
      const gen = generation;
      resolveDisplayNames([userId]).then(() => {
        // A rebuild swapped the pool in meanwhile: this entry is not in it any more, and the
        // rebuild named everyone from the ledger itself. A late write would only be stale.
        if (gen !== generation) return;
        const site = displayNames.get(userId);
        if (site && entry.name !== site) {
          const previous = entry.name;
          entry.name = site;
          addAlias(entry, previous);
          // The person shows their links: the row moves to their one person key, where their
          // later contributions land too (keyFor). If that key is somehow taken already, both
          // rows carry the site name and the frame merges them by name.
          const personKey = keyForUserId(userId);
          if (key !== personKey && !state.has(personKey) && state.get(key) === entry) {
            state.delete(key);
            state.set(personKey, entry);
          }
          emit();
        }
      }).catch((e) => console.warn('[sponsors] ingest rename:', e.message));
    }
  }

  // ── Restart recompute ───────────────────────────────────────────────────────

  // The current night's structural state, read from the persisted row rather
  // than `timer.snapshot()`: the snapshot does not carry `night.blocks` or
  // `night.priceCents` (pricing internals), and the replay needs them to walk
  // the curve. Read-only here, as in supportbar.js and meter.js; timer.js owns
  // the writes.
  async function loadNightRow() {
    const r = await pool.query(
      `SELECT night_active, night_duration_sec, night_elapsed_sec, night_seed_sec,
              night_price_cents, night_blocks, night_started_at
         FROM stream.timer_state WHERE id = 1`
    );
    const row = r.rows[0];
    if (!row) return { active: false, durationSec: 0, elapsedSec: 0, seedSec: 0, blocks: null, startedAt: null };
    return {
      active: !!row.night_active,
      durationSec: Number(row.night_duration_sec) || 0,
      elapsedSec: Number(row.night_elapsed_sec) || 0,
      seedSec: Number(row.night_seed_sec) || 0,
      blocks: parseBlocks(row.night_blocks),
      startedAt: row.night_started_at ? new Date(row.night_started_at) : null,
    };
  }

  /**
   * The curve-walk for one donation, mirroring timer.js's convertNotional
   * rather than its addMoneyNight — this is a QUOTE (what
   * the money is WORTH), not a credit, so overflow past the last block is
   * valued at the FINAL block's per-second rate and folded in as an "encore"
   * instead of being discarded.
   *
   * The overflow must be folded in: a donor whose contribution landed after
   * the night went gold (the frontier already at `durationSec`, nothing left
   * to buy) would otherwise replay as zero weight and zero badge after a
   * restart, while the same donation live (timer.convertNotional) credits the
   * full notional.
   *
   * `blocks` may be empty (an active night whose seed covers the whole
   * clock — nothing sellable, ever) — then `res.overflowCents` has no last
   * block to rate from, and this quotes 0 (matching convertNotional's own
   * `if (!blocks.length) return 0`), not an encore against nothing.
   */
  function curveNotionalSec(cents, frontierRef, blocks, durationSec) {
    const res = convertCents(cents, frontierRef.value, blocks, durationSec);
    frontierRef.value += res.seconds; // only the REAL walk advances the frontier; an encore buys nothing further
    let notional = res.seconds;
    if (res.overflowCents > 0 && blocks.length) {
      const last = blocks[blocks.length - 1];
      const finalRate = last.cents / last.lenSec; // cents per second
      const encore = finalRate > 0 ? Math.round(res.overflowCents / finalRate) : 0;
      notional += encore;
    }
    return notional;
  }

  // The latest CLOSED session that started before `currentStreamId`'s own
  // session. A subquery rather
  // than two round trips: the current session's own started_at is the only
  // thing needed to bound "before".
  //
  // "Previous" means the previous session with supporters. A session with no
  // support_events is invisible here: short test or restart sessions sit
  // between real streams, and taking the literal latest one would make the
  // seed cohort empty — no credit line before the night starts.
  async function previousSessionId(currentStreamId) {
    // e.event_type is nullable and a blank kind is stored as NULL — bare
    // `<> ALL(...)` against NULL is NULL, and WHERE drops that row, so a
    // session whose only rows are untyped would wrongly read as unsupported.
    // COALESCE treats an untyped row as funding, same as everywhere else here.
    //
    // Platform-scoped like every other fold here: the site-platform test is
    // load-bearing, not decoration — a session whose ONLY row is an external
    // platform's donation carrying event_type='cheer' (a coincidence, not a
    // currency spend) must still count as supported.
    const r = await pool.query(
      `SELECT s.stream_id FROM stream.sessions s
        WHERE s.ended_at IS NOT NULL
          AND s.started_at < (SELECT started_at FROM stream.sessions WHERE stream_id = $1)
          AND EXISTS (SELECT 1 FROM stream.support_events e
                       WHERE e.stream_id = s.stream_id
                         AND NOT (e.platform IN ${NATIVE_SQL} AND COALESCE(e.event_type, '') = ANY($2::text[])))
        ORDER BY s.started_at DESC LIMIT 1`,
      [currentStreamId, excludeEventTypes]
    );
    return r.rows[0]?.stream_id || null;
  }
  // Off-stream there is no "current" session to be previous to: the most
  // recent closed session with supporters IS the cohort the credit line should
  // be showing (the pre-show seed narrative), not an empty pool.
  async function latestSupportedSessionId() {
    // Same NULL trap as previousSessionId above: an untyped row must still
    // count as funding, so the EXISTS check goes through COALESCE too. Same
    // platform scoping too — see the comment there.
    const r = await pool.query(
      `SELECT s.stream_id FROM stream.sessions s
        WHERE s.ended_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM stream.support_events e
                       WHERE e.stream_id = s.stream_id
                         AND NOT (e.platform IN ${NATIVE_SQL} AND COALESCE(e.event_type, '') = ANY($1::text[])))
        ORDER BY s.started_at DESC LIMIT 1`,
      [excludeEventTypes]
    );
    return r.rows[0]?.stream_id || null;
  }

  /**
   * Replay one session's support_events into the pool.
   *
   * @param {string} streamId
   * @param {number} multiplier weight scale (1 for tonight, 0.25 for the
   *   previous session — "join the pool at 0.25x weight")
   * @param {boolean} withBadges only true for tonight's own rows on an active
   *   night; the previous session never gets badges, and
   *   neither does tonight without an active night (no clock to attach one to)
   * @param {object} nightRow from loadNightRow() — the CURRENT/most-recent
   *   night's structural state. The previous session is replayed through
   *   this same curve too, because mixing units (cents vs seconds) is not
   *   acceptable: its own night's block layout is not retained
   *   (stream.timer_state holds only the current/most-recent night), and
   *   approximating it against tonight's curve keeps both cohorts in one
   *   unit, which matters more than historical accuracy.
   * @param {{value:number}} frontierRef mutable frontier accumulator, reset
   *   to a FRESH `{value: nightRow.seedSec}` per session — the previous
   *   cohort buys forward through its own independent walk of tonight's
   *   curve, not a continuation of tonight's own frontier.
   */
  async function replaySession({ streamId, multiplier, withBadges, nightRow, frontierRef, ctx = { state, displayNames } }) {
    // event_type is nullable; an untyped row (money.js stores a blank kind
    // as NULL) must still be replayed as a funding row, so this fold goes
    // through COALESCE like every other one — bare `<> ALL(...)` on NULL is
    // NULL, and WHERE silently drops it. Platform-scoped too — see
    // previousSessionId's comment above for why the site-platform test is
    // load-bearing here.
    // A refund or dispute is a negative row pointing at the payment it reverses (reverses_id,
    // v154) and carrying no stream_id of its own, so it is netted onto its original HERE: a
    // fully refunded payment weighs nothing, a partial refund weighs what was kept.
    const r = await pool.query(
      `SELECT e.id, e.user_id, e.username, e.created_at,
              e.amount_usd + COALESCE((SELECT SUM(x.amount_usd) FROM stream.support_events x WHERE x.reverses_id = e.id), 0) AS amount_usd
         FROM stream.support_events e
        WHERE e.stream_id = $1 AND e.reverses_id IS NULL
          AND NOT (e.platform IN ${NATIVE_SQL} AND COALESCE(e.event_type, '') = ANY($2::text[]))
        ORDER BY e.created_at ASC`,
      [streamId, excludeEventTypes]
    );
    // One lookup for the whole session's donors, before the walk: a replayed
    // row is named by the site account behind its canonical, not by whatever
    // name the platform sent that night.
    await resolveDisplayNames(r.rows.filter((row) => !isAnonymous(row.username) && !isErased(row.username)).map((row) => row.user_id), ctx.displayNames);
    for (const row of r.rows) {
      if (isAnonymous(row.username) || isErased(row.username)) continue;
      const cents = Math.round(Number(row.amount_usd) * 100);
      if (!(cents > 0)) continue;

      let notionalSec;
      if (nightRow.active) {
        // The SAME night-math core timer.js's own addMoneyNight/convertNotional
        // use, walked by hand instead of through timer.convertNotional — that
        // reads the LIVE frontier which by replay time has
        // already moved past every one of these historical events.
        notionalSec = curveNotionalSec(cents, frontierRef, nightRow.blocks || [], nightRow.durationSec);
      } else {
        // No active night at all (legacy/marathon nights — nothing to
        // curve-convert against). Mirrors timer.convertNotional's OWN
        // no-night branch exactly (`usd/usdPerHour*3600`) so a replayed
        // legacy donation lands in the SAME unit (seconds) the live path
        // would have quoted for it. Only when there is no usable rate at all
        // (usdPerHour <= 0, never configured) does this fall further back to
        // raw cents as a last-resort weight unit.
        const usdPerHour = Number(timer.snapshot().usdPerHour) || 0;
        notionalSec = usdPerHour > 0 ? Math.round((cents / 100 / usdPerHour) * 3600) : cents;
      }

      if (ctx.ledgerIds && row.id != null) ctx.ledgerIds.add(String(row.id));
      const entry = getOrCreate(keyFor(row.user_id, row.username, ctx.displayNames), nameFor(row.user_id, row.username, ctx.displayNames), row.username, ctx.state);
      entry.weightSec += notionalSec * multiplier;

      if (withBadges && nightRow.startedAt) {
        // Badge start ~= created_at - night_started_at, clamped into
        // [0, elapsed] — an accepted approximation: real
        // wall time since the night opened, not the night-elapsed time at
        // that moment (which would require replaying every pause too). Close
        // enough for a credit-line badge; not offered as exact.
        const rawStartSec = (new Date(row.created_at).getTime() - nightRow.startedAt.getTime()) / 1000;
        const badgeStart = Math.min(Math.max(rawStartSec, 0), nightRow.elapsedSec);
        mintBadge(entry, badgeStart, notionalSec);
      }
    }
  }

  // ONE rebuild at a time. A trigger that arrives while one runs (a links-changed notice, a night
  // start, the opt-in re-check) asks for exactly one more run after it and awaits the same promise:
  // two rebuilds never interleave their writes, and the last trigger is always reflected. Each run
  // builds into maps of its own and swaps them into the live pool in one synchronous step at the
  // end, bumping `generation` so a late write from before the swap (an ingest's rename) is dropped.
  let generation = 0;
  let rebuilding = null;
  let rebuildAgain = false;
  // What changed the live pool while a rebuild was reading the ledger: credits and erasures. The
  // rebuild's pool was read from a snapshot that may predate them, so before the swap each is
  // replayed onto it, in order — an erasure is never undone by a swap, and a credit is never lost
  // to one. A credit whose ledger row the rebuild already read (same ledgerId) is not added twice.
  let journal = [];
  function init() {
    if (rebuilding) { rebuildAgain = true; return rebuilding; }
    rebuilding = (async () => {
      try {
        do { rebuildAgain = false; await rebuildOnce(); } while (rebuildAgain);
      } finally {
        rebuilding = null;
      }
    })();
    return rebuilding;
  }

  async function rebuildOnce() {
    journal = [];
    const ctx = { state: new Map(), displayNames: new Map(), ledgerIds: new Set() };
    try {
      const currentStreamId = await getStreamId();
      if (currentStreamId) {
        const nightRow = await loadNightRow();

        // Split try/catches: a throw mid-walk on
        // TONIGHT's replay (e.g. a corrupt block layout) must not also cost
        // the previous-session cohort, and vice versa — each cohort's own
        // failure degrades to "not loaded" for itself only.
        try {
          await replaySession({
            streamId: currentStreamId, multiplier: 1, withBadges: nightRow.active,
            nightRow, frontierRef: { value: nightRow.seedSec }, ctx,
          });
        } catch (e) {
          console.warn('[sponsors] init: tonight replay failed:', e.message);
        }

        const prevStreamId = await previousSessionId(currentStreamId);
        if (prevStreamId) {
          try {
            // SAME nightRow, SAME code path, but its OWN fresh frontier —
            // the previous cohort buys forward through tonight's curve
            // independently of tonight's own donors, not stacked after them.
            await replaySession({
              streamId: prevStreamId, multiplier: PREVIOUS_SESSION_WEIGHT, withBadges: false,
              nightRow, frontierRef: { value: nightRow.seedSec }, ctx,
            });
          } catch (e) {
            console.warn('[sponsors] init: previous-session replay failed:', e.message);
          }
        }
        console.log(
          `[sponsors] init loaded ${ctx.state.size} sponsor(s) (stream ${currentStreamId}` +
          `${prevStreamId ? `, previous ${prevStreamId} at 0.25x` : ''}, night=${nightRow.active ? 'active' : 'off'})`
        );
      } else {
        // Off-stream: preload the last supported session so credit.html has
        // names to cycle before the night starts. Full weight —
        // there is no "tonight" for it to be discounted against — and no
        // badges (no clock to denominate one in). startNight's reset() then
        // rebuilds the pool with this same cohort at PREVIOUS_SESSION_WEIGHT.
        const lastStreamId = await latestSupportedSessionId();
        if (lastStreamId) {
          const nightRow = await loadNightRow();
          try {
            await replaySession({
              streamId: lastStreamId, multiplier: 1, withBadges: false,
              nightRow, frontierRef: { value: nightRow.seedSec }, ctx,
            });
          } catch (e) {
            console.warn('[sponsors] init: off-stream preload replay failed:', e.message);
          }
          console.log(`[sponsors] init: no active session — preloaded ${ctx.state.size} sponsor(s) from last supported session ${lastStreamId}`);
        } else {
          console.log('[sponsors] init: no active session and no supported session on record — empty');
        }
      }
    } catch (e) {
      console.warn('[sponsors] init failed:', e.message);
    }
    // The journal, replayed onto the rebuilt pool — still synchronous with the swap below.
    for (const j of journal) {
      if (j.kind === 'credit') {
        if (j.credit.ledgerId && ctx.ledgerIds.has(j.credit.ledgerId)) continue;
        applyCredit(j.credit, ctx);
      } else if (j.kind === 'erase') {
        applyErase(j.who, ctx);
      }
    }
    journal = [];
    // The swap: synchronous, so no frame and no ingest ever sees half a pool.
    generation += 1;
    state.clear();
    for (const [k, v] of ctx.state) state.set(k, v);
    displayNames.clear();
    for (const [k, v] of ctx.displayNames) displayNames.set(k, v);
    emit();
  }

  /**
   * Is a clock lit for any of these canonical ids RIGHT NOW? The same answer
   * the chat badge renders (`clockRemainSec > 0`, buildFrame's arithmetic),
   * read straight from the pool — no frame, no bucket. Several ids = one
   * person under an unmerged split; the frame merges those by NAME on the
   * wire, so ANY live entry counts and remainSec is the max. The perk it
   * feeds (web's 2x participation bonus) keys on the
   * icon being visible — so a paused night, whose elapsedSec does not tick,
   * keeps the answer lit.
   */
  function clockFor(canonicalIds) {
    const nowElapsed = liveNightElapsed();
    let remainSec = 0;
    const ids = Array.isArray(canonicalIds) ? canonicalIds : [];
    for (const [key, e] of state) {
      if (!ids.some((id) => keyBelongsTo(key, id))) continue;
      remainSec = Math.max(remainSec, Math.max(0, Math.round(e.clockUntilElapsed - nowElapsed)));
    }
    return { active: remainSec > 0, remainSec };
  }

  /** matrix id → every canonical this person holds: OAuth-linked platform
   *  accounts (site.platform_links) and the native account itself
   *  (its native stream.links row, platform_id = the matrix id) — the
   *  reverse of resolveDisplayNames' join. Zero rows = never chatted or
   *  linked = no clock. */
  async function canonicalIdsForMatrix(matrixId) {
    const r = await pool.query(
      `SELECT canonical_id AS id FROM site.platform_links WHERE matrix_id = $1
       UNION
       SELECT canonical AS id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1`,
      [matrixId]
    );
    return r.rows.map((row) => row.id).filter(Boolean);
  }

  const MATRIX_ID_RE = /^@[^:\s]+:[^\s]+$/;
  function registerSponsorRoutes(app, { requireInternal, wrap }) {
    // GET /sponsors/clock?matrixId=@x:server — web's earn path asks
    // whether this viewer's clock is lit. Read-only: it
    // mints nothing and moves nothing. Internal, like every other route web
    // calls with the shared secret.
    app.get('/sponsors/clock', requireInternal, wrap(async (req, res) => {
      const raw = req.query && req.query.matrixId;
      const matrixId = typeof raw === 'string' ? raw.trim() : '';
      if (!MATRIX_ID_RE.test(matrixId)) return res.status(400).json({ error: 'bad matrixId' });
      const { active, remainSec } = clockFor(await canonicalIdsForMatrix(matrixId));
      res.json({ ok: true, active, remainSec });
    }));

    // POST /sponsors/links-changed — web saved someone's "show my linked platforms" switch. The
    // pool is rebuilt so the credit line follows the switch now, not at the next restart. Internal,
    // and it takes no argument: anyone able to call it can only make the pool re-read the ledger.
    app.post('/sponsors/links-changed', requireInternal, wrap(async (_req, res) => {
      await linksChanged();
      res.json({ ok: true });
    }));
  }

  /**
   * The pool's NIGHT LIFECYCLE, and the reason it needs one: every quantity in
   * here is scoped to one night. `weightSec` ranks a donor against TONIGHT's
   * cohort (last night's belongs at 0.25x, with no badges), and
   * `clockUntilElapsed` is denominated in `night.elapsedSec` — which
   * `timer.startNight` resets to 0. Left alone across a night boundary in one
   * process, last night's donors therefore open the new night at FULL weight
   * with every badge re-lit from the top: gratitude for money that is already
   * spent, addressed to the wrong night.
   *
   * Rebuilding from the ledger is the whole fix — `init()` already clears the
   * map and replays `support_events` with tonight/previous-session split, the
   * 0.25x weight and the no-badges rule applied by the same code the restart
   * path uses. Callers: `/timer/night` (action `start`) and `/support-bar/reset`.
   *
   * It reads `stream.timer_state` for the night's structure, and `startNight`
   * persists that row without awaiting it — so a rebuild fired immediately
   * after can race one UPDATE and price the previous night's cohort against the
   * old curve. Weights are deliberate approximations (gratitude quantities,
   * not money accounting), and the badge rule that matters here —
   * previous-session rows never get one — does not depend on the row at all.
   */
  function reset() { return init(); }

  /**
   * Someone changed whether they show their links (web's Linked accounts switch calls
   * POST /sponsors/links-changed). The cached answer is dropped and the pool is rebuilt from the
   * ledger, so a person who switched it OFF is split back into one row per donation name — with no
   * site name and no aliases — on the very next frame, and one who switched it on is merged.
   */
  function linksChanged() { return init(); }

  /**
   * The backstop for a switch whose notice never arrived (web down, a missed call): every
   * RECHECK_EVERY heartbeats the accounts the pool currently names by their site account are
   * asked again; if any no longer shows its links (or was renamed), the pool is rebuilt. A
   * failed read changes nothing — the next re-check asks again.
   */
  let rechecking = false;
  async function recheckOptIns() {
    const shown = [...displayNames].filter(([, name]) => name);
    if (!shown.length || !pool || rechecking) return false;
    rechecking = true;
    try {
      const now = await lookupSiteNames(shown.map(([id]) => id));
      if (shown.some(([id, name]) => now.get(id) !== name)) { await init(); return true; }
      return false;
    } catch (e) {
      console.warn('[sponsors] opt-in re-check failed (next heartbeat retries):', e.message);
      return false;
    } finally {
      rechecking = false;
    }
  }

  /**
   * A deleted account (account-erase.js): its entries leave the pool — the ones keyed by its
   * canonicals, and the name-keyed ones a payload without a canonical made under one of its names —
   * so neither its name nor its aliases ride the public frame again. The next frame goes out at
   * once. Returns how many entries left.
   */
  function applyErase({ canonicalIds = [], names = [] }, ctx = { state, displayNames }) {
    let n = 0;
    for (const id of canonicalIds) {
      ctx.displayNames.delete(id);
      for (const key of [...ctx.state.keys()]) {
        if (keyBelongsTo(key, id) && ctx.state.delete(key)) n += 1;
      }
    }
    // Both spellings: a donation platform may have sent the name with or without a leading '@'.
    for (const name of names) {
      for (const key of new Set([keyForUsername(name), keyForUsername(bareName(name)), keyForUsername(`@${bareName(name)}`)])) {
        if (ctx.state.delete(key)) n += 1;
      }
    }
    return n;
  }

  function erase({ canonicalIds = [], names = [] } = {}) {
    const who = { canonicalIds: [...canonicalIds], names: [...names] };
    // A rebuild in flight read the ledger before this erasure may have committed: replay it
    // onto the rebuilt pool before the swap (journal), or the swap would bring the person back.
    if (rebuilding) journal.push({ kind: 'erase', who });
    const n = applyErase(who);
    if (n) emit();
    return n;
  }

  return {
    init, reset, erase, ingest, startHeartbeat, clockFor, registerSponsorRoutes, linksChanged,
    __test: {
      state, buildFrame, heartbeatTick, isAnonymous, keyForUserId, keyForUsername,
      frameKey, CLOCK_BUCKET_SEC, curveNotionalSec, displayNames, resolveDisplayNames, recheckOptIns,
    },
    currentFrame,
  };
}

module.exports = { createSponsors };
