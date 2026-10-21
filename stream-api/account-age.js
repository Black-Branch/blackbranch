// Minimum-account-age gate for platform-origin chatters.
//
// The third raid-lockdown lever, after closing signups and closing the
// cross-post megaphone. Those two stop a raid growing; this one is about the
// accounts already talking. Account age is the one signal that separates a raid
// from an audience, because raid accounts are minted for the raid.
//
// Why this is lockdown-only and not an always-on filter: establishing an age
// means an HTTP call to Twitch or YouTube, while the word blocklist and the link
// gate before it in chat.js (word → link → age) are synchronous and I/O-free so
// sending never feels sluggish. At minAgeDays = 0 — the default —
// `checkAccountAge` returns allow on its first line and nothing else here runs:
// no fetch, no per-message DB read. A mod arms the lever during a raid and
// accepts the latency knowingly. Checking ages unconditionally and caching
// would put the fetch on the hot path for the first message of every new
// chatter.
//
// New site accounts are not gated here (the signup lever does that). This is
// about people arriving from Twitch/YouTube/Kick who never sign up at all.

const PLATFORM_FOUNDED = {
  youtube: Date.UTC(2005, 1, 14),
  twitch: Date.UTC(2011, 5, 6),
  kick: Date.UTC(2022, 9, 1),
};

// How long a cached answer stands. Unknowns expire sooner than knowns: a
// creation date never changes, but "the platform wouldn't tell us" can be a
// transient 500 as easily as a permanent absence, and a raid-era negative cache
// should not outlive the raid.
const KNOWN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const UNKNOWN_TTL_MS = 60 * 60 * 1000;         // 1 hour

// The armed/disarmed read is per-MESSAGE, so it cannot be a query. 5s is short
// enough that throwing the switch takes effect while a mod is still looking at
// the panel, and long enough that the disarmed case (every ordinary stream)
// costs one trivial query per 5 seconds for the whole service.
const LEVER_TTL_MS = 5_000;

/**
 * Normalise a platform-reported creation date. Pure.
 *
 * A bogus creation date does not arrive as null — it arrives as
 * 1970-01-01T00:00:00Z, which computes as decades old, i.e. maximally trusted.
 * YouTube's `snippet.publishedAt` returns exactly that for some channels. A gate
 * that trusted it would wave through precisely the accounts whose age it had
 * failed to establish.
 *
 * An account cannot predate the platform it is on, so anything earlier than the
 * platform's founding date is a data bug, and a data bug reads as UNKNOWN.
 */
function normalizeCreatedAt(platform, raw) {
  if (!raw) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const floor = PLATFORM_FOUNDED[String(platform).toLowerCase()];
  if (floor !== undefined && ms < floor) return null;
  return new Date(ms);
}

/**
 * The decision itself. Pure — no I/O, no clock of its own, so it is testable
 * without stubbing either.
 *
 * `unknown` is a first-class outcome, NOT folded into allow or deny here. The
 * caller decides what unknown means, because that is a product choice (the
 * current choice is withhold) and burying it in this function would hide it.
 */
function ageVerdict({ createdAt, minAgeDays, now }) {
  if (!(minAgeDays > 0)) return 'allow';
  if (!createdAt) return 'unknown';
  const ageDays = (now - createdAt.getTime()) / 86_400_000;
  return ageDays >= minAgeDays ? 'allow' : 'too_new';
}

// ── Platform lookups ────────────────────────────────────────────────────────
//
// Each returns an ISO string, or null for "this platform cannot tell us".
// Never throws — a lookup failure is an unknown, and unknown is handled.

// The app token is owned by twitch-app.js — ONE cache for the whole service, so
// account-age and the avatar resolver cannot mint two tokens or disagree about
// whether the current one has been rejected. The 4xx handling below stays HERE,
// because the same status means different things to different callers: a 400 is
// "this identifier is unverifiable" for account age, and merely "no picture" for
// the avatar resolver.
const { getAppToken: twitchAppToken, invalidateAppToken } = require('./twitch-app.js');
const { instanceConfig } = require('./instance-config');
const { NATIVE_PLATFORM, isNativePlatform } = require('./native-platform');

async function fetchTwitch(platformId) {
  const id = instanceConfig.get('twitch.clientId');
  const token = await twitchAppToken();
  if (!token) return null;
  const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(platformId)}`, {
    headers: { 'Client-Id': id, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) { invalidateAppToken(); throw new Error('twitch 401 (app token rejected)'); }
  // 400 is a statement about the IDENTIFIER, not about us. Twitch answers
  // "Bad Identifiers" for an id it cannot parse, which means this account is
  // unverifiable — the same situation as Kick, and therefore an UNKNOWN (which
  // the lever withholds), not a degraded lookup (which it allows).
  //
  // Treating that 400 as a thrown error would send a malformed id down the
  // degraded path, which allows it. The rule: 4xx about
  // the identifier = unknown; 401/403 (our credentials) and 5xx/timeout (their
  // infrastructure) = degraded.
  if (res.status === 400) return null;
  if (!res.ok) throw new Error(`twitch users HTTP ${res.status}`);
  const j = await res.json();
  // 200 with an empty array is an account that simply is not there — also
  // unverifiable, also unknown.
  return j?.data?.[0]?.created_at ?? null;
}

async function fetchYouTube(platformId) {
  const key = instanceConfig.get('youtube.apiKey');
  if (!key) return null;
  // part=snippet, 1 quota unit. (The unit is per CALL, not per id — batching is
  // available if this ever needs it, but per-account caching already collapses a
  // raid to one call per account, well inside quota.)
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(platformId)}&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  // Same rule as Twitch: a 400 is about the channel id, so the account is
  // unverifiable (unknown), not a degraded lookup. 403 is the quota/key error
  // and IS about us, so it throws and degrades.
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`youtube channels HTTP ${res.status}`);
  const j = await res.json();
  return j?.items?.[0]?.snippet?.publishedAt ?? null;
}

// Kick publishes no account creation date:
// `GET https://api.kick.com/public/v1/users?id=` returns exactly
// { user_id, name, email, profile_picture } and the channels payload carries no
// date field either. This is not a missing scope or an unfinished lookup — the
// data does not exist, so every Kick answer is legitimately unknown.
async function fetchKick() {
  return null;
}

const FETCHERS = { twitch: fetchTwitch, youtube: fetchYouTube, kick: fetchKick };

/** Platforms whose account age this install can establish, right now (served as
 *  GET /lockdown/checkable). Twitch needs the app's client id + secret; YouTube an API key; Kick
 *  publishes no creation date at all; stream.place has no lookup here. `native` is the site's own
 *  accounts, which this lever never gates (the signup lever does). Read per call: a key saved in
 *  the Admin Panel makes a platform checkable without a restart.
 *
 *  The lever never holds a platform that is not checkable — an unknown age there is a fact about
 *  the platform or this install's keys, not about the chatter, and holding on it muted whole
 *  audiences (all of Kick; all of Twitch without app keys; all of YouTube without an API key). */
function checkablePlatforms() {
  const twitch = Boolean(
    instanceConfig.get('twitch.clientId') &&
    instanceConfig.get('twitch.clientSecret')
  );
  return { twitch, kick: false, youtube: Boolean(instanceConfig.get('youtube.apiKey')), streamplace: false, [NATIVE_PLATFORM]: true };
}

/** GET /lockdown/checkable (requireInternal) — the moderation panel's per-platform line ("age
 *  unknown on Kick — not held"). */
function registerLockdownRoutes(app, { requireInternal }) {
  app.get('/lockdown/checkable', requireInternal, (_req, res) => res.json(checkablePlatforms()));
}

// ── Cache ───────────────────────────────────────────────────────────────────

// In-flight dedup. A raid arrives as a burst, and without this the same account's
// first five messages each fire their own identical lookup.
const inflight = new Map();

async function lookupCreatedAt({ pool, platform, platformId, now }) {
  const key = `${platform}:${platformId}`;

  // Join an in-flight lookup BEFORE the cache read. A raid burst lands
  // several messages from one account inside the window where the first
  // message's platform call is still running and the cache row is not yet
  // written — checked after the SELECT, each of those missed cache and fired
  // its own duplicate lookup (harmless, the upsert is idempotent, but it is
  // exactly the duplicate this map exists to prevent).
  if (inflight.has(key)) return inflight.get(key);

  const { rows } = await pool.query(
    `SELECT account_created_at, checked_at FROM site.platform_account_age
      WHERE platform = $1 AND platform_id = $2`,
    [platform, platformId]
  );
  const hit = rows[0];
  if (hit) {
    const age = now - new Date(hit.checked_at).getTime();
    const ttl = hit.account_created_at ? KNOWN_TTL_MS : UNKNOWN_TTL_MS;
    if (age < ttl) {
      return {
        createdAt: hit.account_created_at ? new Date(hit.account_created_at) : null,
        failed: false,
      };
    }
  }

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    let iso = null;
    try {
      const fetcher = FETCHERS[String(platform).toLowerCase()];
      if (fetcher) iso = await fetcher(platformId);
    } catch (e) {
      // A FAILED lookup is NOT the same as an absent one, and conflating them
      // is the trap this branch exists to avoid.
      //
      // "This channel has no usable date" is a fact about one account on a
      // checkable platform, and its messages are withheld (a platform with no
      // dates at all, like Kick, never reaches here — checkAccountAge lets it
      // through). "Twitch rejected our credentials" is a fact about
      // OUR configuration — withholding on that silently mutes an entire
      // audience because of a typo in a .env (for example a TWITCH_CLIENT_ID
      // that differs from the web app's), with the panel still reporting the
      // lever as working.
      //
      // So a failure surfaces as `failed`, the caller allows, and the panel's
      // health row is what makes the misconfiguration visible instead of silent.
      // Not cached either — the next message retries rather than a transient 500
      // pinning this account for an hour.
      console.error('[account-age] LOOKUP FAILED (allowing through)', platform, e.message);
      return { createdAt: null, failed: true };
    }
    const created = normalizeCreatedAt(platform, iso);
    await pool.query(
      `INSERT INTO site.platform_account_age (platform, platform_id, account_created_at, checked_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (platform, platform_id) DO UPDATE SET
         account_created_at = EXCLUDED.account_created_at,
         checked_at         = now()`,
      [platform, platformId, created]
    ).catch((e) => console.error('[account-age] cache write failed', e.message));
    return { createdAt: created, failed: false };
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// ── The lever ───────────────────────────────────────────────────────────────

let lever = { value: 0, at: 0 };

async function getMinAccountAgeDays(pool) {
  const now = Date.now();
  if (now - lever.at < LEVER_TTL_MS) return lever.value;
  try {
    const { rows } = await pool.query(
      `SELECT min_account_age_days FROM site.lockdown_now WHERE id = 1`
    );
    lever = { value: Number(rows[0]?.min_account_age_days) || 0, at: now };
  } catch (e) {
    // Fail OPEN, unlike the signup and cross-post levers — the asymmetry is deliberate. Those gates
    // fail closed because refusing costs one signup or one cross-post. This one
    // withholds ordinary conversation, so a database blip that made every read
    // throw would silently mute the entire chat with no mod having armed
    // anything. The lever being unreadable is not evidence of a raid.
    console.error('[account-age] lever read failed — treating as disarmed', e.message);
    lever = { value: 0, at: now };
  }
  return lever.value;
}

/** Test seam: drop the memoised lever + token so a test isn't order-dependent. */
function _resetCaches() {
  lever = { value: 0, at: 0 };
  invalidateAppToken();
  inflight.clear();
}

/**
 * Should this platform-origin message be withheld for being too new?
 *
 * Returns { action: 'allow' } or { action: 'withhold', reason, minAgeDays,
 * accountCreatedAt }. Never throws — a gate that can crash the ingest path is
 * worse than the raid.
 */
async function checkAccountAge({ pool, platform, platformId, now = Date.now() }) {
  const minAgeDays = await getMinAccountAgeDays(pool);
  if (!(minAgeDays > 0)) return { action: 'allow' };

  // A platform this install cannot check is never held (checkablePlatforms says why). The site's
  // own accounts are not this lever's to gate either. Both pass with no lookup.
  const plat = String(platform || '').toLowerCase();
  if (isNativePlatform(plat) || checkablePlatforms()[plat] !== true) return { action: 'allow', uncheckable: true };

  // No id on a checkable platform means we cannot even ask about THIS account: unknown.
  if (!platformId) {
    return { action: 'withhold', reason: 'unknown_age', minAgeDays, accountCreatedAt: null };
  }

  let createdAt = null;
  let failed = false;
  try {
    ({ createdAt, failed } = await lookupCreatedAt({ pool, platform, platformId, now }));
  } catch (e) {
    console.error('[account-age] check failed (allowing through)', e.message);
    failed = true;
  }

  // A broken lookup allows. See the long note in lookupCreatedAt — withholding
  // on our own misconfiguration mutes an audience for a reason no mod chose.
  if (failed) return { action: 'allow', degraded: true };

  const verdict = ageVerdict({ createdAt, minAgeDays, now });
  if (verdict === 'allow') return { action: 'allow' };
  return {
    action: 'withhold',
    // Distinct reasons because they are different problems: too_new is the
    // filter working, unknown_age is the filter unable to work. During a raid a
    // mod needs to tell "I turned away 40 fresh accounts" from "I turned away my
    // entire Kick audience".
    reason: verdict === 'too_new' ? 'too_new' : 'unknown_age',
    minAgeDays,
    accountCreatedAt: createdAt,
  };
}

module.exports = {
  checkAccountAge,
  getMinAccountAgeDays,
  checkablePlatforms,
  registerLockdownRoutes,
  // exported for tests — the pure core is the part worth pinning
  ageVerdict,
  normalizeCreatedAt,
  PLATFORM_FOUNDED,
  _resetCaches,
};
