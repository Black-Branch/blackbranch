// Tests for the minimum-account-age lockdown lever.
//
// The valuable part is the pure core: what counts as a real creation date, and
// what a given age means. The fetchers are thin HTTP wrappers whose behaviour
// against the live APIs is recorded in account-age.js — mocking them here would
// only test the mock.
//
// Run: node --test account-age.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ageVerdict,
  normalizeCreatedAt,
  checkAccountAge,
  getMinAccountAgeDays,
  checkablePlatforms,
  PLATFORM_FOUNDED,
  _resetCaches,
} = require('./account-age');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 27);

// ── source-scan helpers ─────────────────────────────────────────────────────
//
// They live in testlib/source.js, with the reasoning — including why the
// anchor is mandatory rather than advisory.
const { scanSource: scan, at } = require('./testlib/source');

// ── The epoch trap ──────────────────────────────────────────────────────────

test('an epoch creation date reads as UNKNOWN, never as ancient', () => {
  // The defect this whole normaliser exists to prevent. YouTube returns
  // 1970-01-01T00:00:00Z for a subset of channels (verified live: 1 of 8
  // sampled). Treated as a real date it computes to ~56 years old — MAXIMALLY
  // TRUSTED — so the gate would wave through exactly the accounts whose age it
  // failed to establish. Inverted, silently, in the raider's favour.
  assert.equal(normalizeCreatedAt('youtube', '1970-01-01T00:00:00Z'), null);
  assert.equal(ageVerdict({ createdAt: null, minAgeDays: 7, now: NOW }), 'unknown');
});

test('any date predating the platform itself is a data bug, not an old account', () => {
  // An account cannot predate the site it is on. This generalises the epoch
  // case, so a future API returning some other bogus sentinel is caught too.
  assert.equal(normalizeCreatedAt('twitch', '2009-05-01T00:00:00Z'), null, 'before Twitch existed');
  assert.equal(normalizeCreatedAt('youtube', '2003-01-01T00:00:00Z'), null, 'before YouTube existed');
  assert.equal(normalizeCreatedAt('kick', '2019-01-01T00:00:00Z'), null, 'before Kick existed');

  // ...and a real date on the same platform still survives.
  assert.ok(normalizeCreatedAt('twitch', '2021-10-22T09:35:26Z') instanceof Date);
});

test('the founding floors are per-platform, not one shared constant', () => {
  // A single floor would have to be the earliest (YouTube 2005), which would let
  // a 2006 "Twitch" account through as genuine.
  assert.ok(PLATFORM_FOUNDED.twitch > PLATFORM_FOUNDED.youtube);
  assert.ok(PLATFORM_FOUNDED.kick > PLATFORM_FOUNDED.twitch);
  assert.equal(normalizeCreatedAt('twitch', '2006-06-01T00:00:00Z'), null,
    'a YouTube-era date on Twitch must not pass');
});

test('garbage and absent dates are unknown, not zero', () => {
  for (const bad of [null, undefined, '', 'not-a-date', 'NaN']) {
    assert.equal(normalizeCreatedAt('twitch', bad), null, `"${bad}" should normalise to null`);
  }
});

// ── The verdict ─────────────────────────────────────────────────────────────

test('disarmed means allow, whatever the account looks like', () => {
  // The default state of every ordinary stream. Even a brand-new account passes,
  // because the lever is what makes age matter at all.
  const fresh = new Date(NOW - 1000);
  assert.equal(ageVerdict({ createdAt: fresh, minAgeDays: 0, now: NOW }), 'allow');
  assert.equal(ageVerdict({ createdAt: null, minAgeDays: 0, now: NOW }), 'allow');
});

test('the threshold is inclusive at the boundary', () => {
  // Exactly-at-threshold must pass: a filter that rejects the boundary turns
  // "7 days or older" into "8 days or older" for everyone who reads the label.
  const exactly7 = new Date(NOW - 7 * DAY);
  assert.equal(ageVerdict({ createdAt: exactly7, minAgeDays: 7, now: NOW }), 'allow');

  const justUnder = new Date(NOW - 7 * DAY + 1000);
  assert.equal(ageVerdict({ createdAt: justUnder, minAgeDays: 7, now: NOW }), 'too_new');
});

test('unknown is its own verdict, distinct from too_new', () => {
  // They mean different things and drive different mod decisions: the filter
  // working vs the filter unable to work. Collapsing them would make "I turned
  // away my whole Kick audience" indistinguishable from "I caught 40 raiders".
  assert.equal(ageVerdict({ createdAt: null, minAgeDays: 7, now: NOW }), 'unknown');
  assert.equal(ageVerdict({ createdAt: new Date(NOW - DAY), minAgeDays: 7, now: NOW }), 'too_new');
});

// ── Kick, which cannot be checked at all ────────────────────────────────────

test('Kick is honestly reported as uncheckable', () => {
  // Kick's public API exposes NO creation date
  // (users?id= returns user_id/name/email/profile_picture only). This is not a
  // TODO — the data does not exist. The panel warns on this so a mod arming the
  // lever knows they are muting the whole Kick audience.
  assert.equal(checkablePlatforms().kick, false);
});

// ── Wiring, with a fake pool ────────────────────────────────────────────────

function fakePool(rows, onQuery) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push(sql);
      if (onQuery) { const r = onQuery(sql, params); if (r) return r; }
      return { rows };
    },
  };
}

test('disarmed does NO lookup at all — not even a cache read', async () => {
  // The latency constraint, enforced structurally. If this ever regresses, every
  // new chatter's first message pays an HTTP round trip forever.
  _resetCaches();
  const pool = fakePool([{ min_account_age_days: 0 }]);
  const out = await checkAccountAge({ pool, platform: 'twitch', platformId: '123', now: NOW });
  assert.equal(out.action, 'allow');
  assert.equal(pool.calls.length, 1, 'expected ONLY the lever read');
  assert.match(pool.calls[0], /min_account_age_days/);
  assert.ok(!pool.calls.some((s) => /platform_account_age/.test(s)),
    'the age cache must not be touched while disarmed');
});

test('the lever read is memoised, so it is not a per-message query', async () => {
  _resetCaches();
  const pool = fakePool([{ min_account_age_days: 0 }]);
  for (let i = 0; i < 25; i++) {
    await checkAccountAge({ pool, platform: 'twitch', platformId: String(i), now: NOW });
  }
  assert.equal(pool.calls.length, 1, `25 messages should share one lever read, made ${pool.calls.length}`);
});

test('an unreadable lever fails OPEN, unlike the v82/v83 switches', async () => {
  // The asymmetry is deliberate and worth pinning. Signups and cross-post fail
  // CLOSED because refusing costs one signup or one relayed message. This lever
  // withholds ordinary conversation, so failing closed would let a database blip
  // silently mute the entire chat with no mod having armed anything — an outage
  // that looks exactly like a working feature.
  _resetCaches();
  const pool = { calls: [], async query() { throw new Error('db down'); } };
  const out = await checkAccountAge({ pool, platform: 'twitch', platformId: '123', now: NOW });
  assert.equal(out.action, 'allow');
  assert.equal(await getMinAccountAgeDays(pool), 0);
});

test('armed + cached fresh account is withheld as too_new, and says so', async () => {
  _resetCaches();
  const created = new Date(NOW - 2 * DAY).toISOString();
  const pool = fakePool([], (sql) => {
    if (/min_account_age_days/.test(sql)) return { rows: [{ min_account_age_days: 7 }] };
    if (/platform_account_age/.test(sql)) {
      return { rows: [{ account_created_at: created, checked_at: new Date(NOW).toISOString() }] };
    }
    return null;
  });
  const out = await checkAccountAge({ pool, platform: 'twitch', platformId: '123', now: NOW });
  assert.equal(out.action, 'withhold');
  assert.equal(out.reason, 'too_new');
  assert.equal(out.minAgeDays, 7);
});

test('armed + cached OLD account passes', async () => {
  _resetCaches();
  const created = new Date(NOW - 900 * DAY).toISOString();
  const pool = fakePool([], (sql) => {
    if (/min_account_age_days/.test(sql)) return { rows: [{ min_account_age_days: 7 }] };
    if (/platform_account_age/.test(sql)) {
      return { rows: [{ account_created_at: created, checked_at: new Date(NOW).toISOString() }] };
    }
    return null;
  });
  const out = await checkAccountAge({ pool, platform: 'twitch', platformId: '123', now: NOW });
  assert.equal(out.action, 'allow');
});

test('armed with no platform id is withheld as unknown, never allowed', async () => {
  // A message with no user id cannot be checked. Allowing it would leave a
  // trivially exploitable hole: omit the id, skip the gate.
  _resetCaches();
  const pool = fakePool([{ min_account_age_days: 7 }]);
  const out = await checkAccountAge({ pool, platform: 'kick', platformId: '', now: NOW });
  assert.equal(out.action, 'withhold');
  assert.equal(out.reason, 'unknown_age');
});

// ── A broken lookup is not an absent one ────────────────────────────────────

test('a FAILED lookup allows through; it does not withhold', async () => {
  // The distinction that keeps this feature from muting an audience by
  // accident. "Kick publishes no date" is a fact about the platform, and those
  // messages are withheld. "Twitch rejected our credentials" is a fact about OUR
  // config: if a thrown lookup withheld, a bad TWITCH_CLIENT_ID would silence
  // ALL of Twitch the first time the lever is armed, while the panel shows a
  // healthy switch.
  _resetCaches();
  const pool = fakePool([], (sql) => {
    if (/min_account_age_days/.test(sql)) return { rows: [{ min_account_age_days: 7 }] };
    if (/SELECT account_created_at/.test(sql)) return { rows: [] };  // cache miss
    return null;
  });
  // No Twitch credentials in the test env → the fetcher throws on token mint.
  const saved = [process.env.TWITCH_OAUTH_CLIENT_ID, process.env.TWITCH_CLIENT_ID];
  delete process.env.TWITCH_OAUTH_CLIENT_ID;
  process.env.TWITCH_CLIENT_ID = 'definitely-not-a-real-client';
  process.env.TWITCH_CLIENT_SECRET = 'nope';
  try {
    const out = await checkAccountAge({ pool, platform: 'twitch', platformId: '123', now: NOW });
    assert.equal(out.action, 'allow', 'a credential failure must not withhold');
    assert.equal(out.degraded, true, 'and it must say it was degraded, not pretend it checked');
  } finally {
    if (saved[0] === undefined) delete process.env.TWITCH_OAUTH_CLIENT_ID;
    else process.env.TWITCH_OAUTH_CLIENT_ID = saved[0];
    if (saved[1] === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = saved[1];
  }
});

test('a platform with no data source still withholds — that is the policy, not a bug', async () => {
  // Kick returns null WITHOUT throwing, which is the whole point of separating
  // the two paths: absent data is a product decision, a failed lookup is not.
  _resetCaches();
  const pool = fakePool([], (sql) => {
    if (/min_account_age_days/.test(sql)) return { rows: [{ min_account_age_days: 7 }] };
    if (/SELECT account_created_at/.test(sql)) return { rows: [] };
    return null;
  });
  const out = await checkAccountAge({ pool, platform: 'kick', platformId: '999', now: NOW });
  assert.equal(out.action, 'withhold');
  assert.equal(out.reason, 'unknown_age');
  assert.notEqual(out.degraded, true, 'Kick is not degraded — it is correctly reporting no data');
});

test('an unverifiable IDENTIFIER is unknown; only auth/infra failures degrade', () => {
  // A malformed Twitch id returns HTTP 400; treated as a thrown error it would
  // hit the degraded path, which allows it. But a 400 says "Bad Identifiers" — it is a statement about the
  // account, not about us, so it belongs with Kick (unknown → withheld).
  //
  // The rule this pins: 4xx about the identifier = unknown. 401/403 (our
  // credentials) and 5xx/timeout (their infrastructure) = degraded.
  const src = scan('account-age.js', /_resetCaches,/);

  const tw = src.slice(at(src, 'async function fetchTwitch'), at(src, 'async function fetchYouTube'));
  assert.match(tw, /res\.status === 400\) return null/, 'Twitch 400 must read as unknown, not throw');
  // Pins the 401 branch's OWN throw, by its distinctive message. A windowed
  // match like /=== 401[\s\S]{0,120}throw/ would reach the NEXT throw, so
  // replacing the 401 branch with `return null` (an auth failure silently
  // reading as unknown, i.e. withholding everyone when our credentials lapse)
  // would leave the suite green.
  assert.match(tw, /res\.status === 401\)[^\n]*throw new Error\('twitch 401/,
    'the Twitch 401 branch must itself throw — an auth failure must degrade, never read as unknown');
  assert.ok(at(tw, '=== 401') < at(tw, '=== 400'),
    '401 must be handled before the generic paths so an auth failure never reads as unknown');

  const yt = src.slice(at(src, 'async function fetchYouTube'), at(src, 'async function fetchKick'));
  assert.match(yt, /res\.status === 400 \|\| res\.status === 404\) return null/,
    'YouTube must treat a bad/absent channel id as unknown');
  assert.match(yt, /if \(!res\.ok\) throw/, 'and still degrade on quota/5xx');
});

// ── The gate is actually applied, not merely available ──────────────────────

test('chat.js APPLIES the age gate to the message path', () => {
  // An ordering assertion proves a guard is COMPUTED early, not that it is USED:
  // deleting the gate's use would leave such a test green. So assert the call site AND the withhold branch,
  // scoped to the source rather than the whole file.
  const src = scan('chat.js', /module\.exports = \{ createChat \}/);

  assert.match(src, /await checkAccountAge\(\{[^}]*platformId: userId/,
    'the gate must be called with the real platform user id, not a placeholder');
  assert.match(src, /ageCheck\.action === 'withhold'[\s\S]{0,400}?recordAgeReview\(/,
    'a withheld message must be recorded for review, not silently dropped');
  assert.match(src, /ageCheck\.action === 'withhold'[\s\S]{0,600}?return res\.json/,
    'a withheld message must not fall through to the chat_log INSERT');

  // The cheap synchronous filter must stay ahead of the one that can do I/O.
  assert.ok(at(src, 'classify(message)') < at(src, 'checkAccountAge('),
    'the free blocklist check must run before the one that may make an HTTP call');
});
