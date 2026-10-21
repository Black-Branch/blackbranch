import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { rankOf, windowBounds, faceSql } from "./boards.ts";
import { FACE_IDS, windowsFor } from "./boardFaces.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "boards.ts"), "utf8"));

test("money fence: no money table, no tip/purchase/market kind, no /bot/top; the one ledger filter is earn_", () => {
  for (const banned of ["support_events", "donations", "tip", "purchase", "market", "bot/top", "amount_usd"]) {
    assert.ok(!src.includes(banned), `boards.ts names ${banned}`);
  }
  // The file text carries the escaped backslash; the statement carries the real one.
  assert.match(src, /kind LIKE 'earn\\\\_%'/);
  assert.match(faceSql("points"), /kind LIKE 'earn\\_%'/);
  assert.equal((src.match(/coin_ledger/g) ?? []).length, 1, "one ledger read");
});

test("bots are excluded: every aliased chat_log read carries NOT cl.is_bot, and matrix-keyed people faces drop bot accounts", () => {
  const reads = (src.match(/stream\.chat_log cl\b/g) ?? []).length;
  const guards = (src.match(/NOT cl\.is_bot/g) ?? []).length;
  assert.ok(reads >= 6, `found ${reads} chat_log reads`);
  assert.equal(guards, reads, "one NOT cl.is_bot per chat_log read");
  for (const f of ["points", "credit", "creditRate"] as const) assert.match(faceSql(f), /NOT EXISTS \(SELECT 1 FROM site\.users b WHERE b\.matrix_id = (l\.matrix_id|v\.key|n\.key) AND b\.is_bot\)/, `${f} drops bot accounts`);
});

test("per-window caches: stream 60s, week 5min, month 15min, all 1h — and a separate cache from the Home body", () => {
  assert.match(src, /stream: 60_000/);
  assert.match(src, /week: 5 \* 60_000/);
  assert.match(src, /month: 15 \* 60_000/);
  assert.match(src, /all: 60 \* 60_000/);
  assert.doesNotMatch(src, /homeCache|getHomePayload/);
});

test("windowBounds: week/month are trailing days, all is unbounded, stream is the session", () => {
  const now = Date.UTC(2026, 8, 26, 12);
  assert.deepEqual(windowBounds("all", null, now), [null, null]);
  assert.deepEqual(windowBounds("week", null, now), [new Date(now - 7 * 86_400_000), new Date(now)]);
  assert.deepEqual(windowBounds("month", null, now), [new Date(now - 30 * 86_400_000), new Date(now)]);
  const s = { started_at: new Date(now - 3_600_000), ended_at: null };
  assert.deepEqual(windowBounds("stream", s, now), [s.started_at, new Date(now)]);
  const e = { started_at: new Date(now - 90_000_000), ended_at: new Date(now - 60_000_000) };
  assert.deepEqual(windowBounds("stream", e, now), [e.started_at, e.ended_at]);
  assert.equal(windowBounds("stream", null, now), null, "no session ever → no stream window");
});

test("resolveWindow reads the NEWEST session by started_at (a stale never-ended one still wins if newest)", () => {
  assert.match(src, /FROM stream\.sessions ORDER BY started_at DESC LIMIT 1/);
});

test("every face × window has SQL with the two window params, and the lists end on their cap", () => {
  for (const f of FACE_IDS) for (const w of windowsFor(f)) {
    const q = faceSql(f);
    assert.match(q, /\$1::timestamptz IS NULL OR/, `${f}/${w} has $1`);
    assert.match(q, /\$2::timestamptz IS NULL OR/, `${f}/${w} has $2`);
    assert.match(q, /LIMIT (500|10)\s*$/, `${f} ends on its cap`);
  }
  assert.match(faceSql("credit"), /LIMIT 500\s*$/);
  assert.match(faceSql("messages"), /LIMIT 10\s*$/);
  assert.match(faceSql("emotes"), /LIMIT 10\s*$/);
});

test("native messages are not double counted: a union over both tables takes chat_log only where the platform is not the site's own", () => {
  for (const f of ["credit", "creditRate", "emotes"] as const) {
    const q = faceSql(f);
    assert.match(q, /site\.chat_messages/, `${f} reads chat_messages`);
    assert.match(q, /cl\.platform NOT IN \('native'[^)]*\)/, `${f} guards chat_log`);
  }
});

test("rate faces carry the floor as the third parameter (5 in Stream, 20 elsewhere — floorFor); toxic and smallBrain read from the bottom", () => {
  assert.match(faceSql("creditRate"), /HAVING SUM\(n\) >= \$3::int/);
  for (const f of ["wholesome", "toxic", "bigBrain", "smallBrain"] as const) assert.match(faceSql(f), /HAVING COUNT\(\*\) >= \$3::int/);
  assert.match(src, /const params = SQL\[face\]\.includes\("\$3"\) \? \[\.\.\.bounds, floorFor\(w\)\] : bounds;/, "the floor is passed ONLY to statements that use $3 — pg refuses an unused third parameter at bind time, which takes every non-rate board down");
  assert.match(src, /pool\.query<Raw>\(SQL\[face\], params\)/);
  for (const f of FACE_IDS) {
    const uses = faceSql(f).includes("$3");
    const isRate = ["creditRate", "wholesome", "toxic", "bigBrain", "smallBrain"].includes(f);
    assert.equal(uses, isRate, `${f}: $3 present only on the rate faces`);
  }
  assert.match(faceSql("wholesome"), /ORDER BY AVG\(cl\.karma\) DESC/);
  assert.match(faceSql("toxic"), /ORDER BY AVG\(cl\.karma\) ASC/);
  assert.match(faceSql("bigBrain"), /ORDER BY AVG\(cl\.intelligence\) DESC/);
  assert.match(faceSql("smallBrain"), /ORDER BY AVG\(cl\.intelligence\) ASC/);
});

test("rankOf: the caller's first matching key, by any of their identities", () => {
  const rows = [
    { key: "@a:x", rank: 1, name: "a", color: null, style: null, avatarUrl: null, value: 9 },
    { key: "c:abc", rank: 2, name: "b", color: null, style: null, avatarUrl: null, value: 5 },
  ];
  assert.deepEqual(rankOf(rows, ["@zz:x", "c:abc"]), { rank: 2, value: 5, key: "c:abc" });
  assert.deepEqual(rankOf(rows, ["@a:x"]), { rank: 1, value: 9, key: "@a:x" });
  assert.equal(rankOf(rows, ["@nobody:x"]), null);
  assert.equal(rankOf(rows, []), null);
});

test("END anchor", () => { assert.match(src, /\}\s*$/); });

// ── A board never shows the cross-platform link ─────────────────────────────────────────────
// The SQL below was run against a throwaway Postgres with the baseline schema: a person linked to
// a site account that has NOT opted in ranks as two rows (their site lines under the site
// account, their Twitch lines under 'c:<canonical>|twitch'); an opted-in person ranks as one; the
// erased-person row never appears.

test("a platform line counts for the site account only when that account shows its links", () => {
  // EVERY account on the canonical must agree: two accounts on one canonical,
  // one opted in, ranks the platform line apart — run on the throwaway Postgres too.
  // The one consent predicate (linkConsent.ts — both link tables), for the row and the avatar.
  assert.match(src, /\(MIN\(i\.matrix_id\) IS NOT NULL AND \$\{noOptOutSql\("i\.canonical"\)\}\) AS show_links/);
  assert.match(src, /AND \$\{noOptOutSql\("pl\.canonical_id"\)\}/);
  assert.match(faceSql("streams"), /AND consent_p\.platform_id = consent_l\.platform_id\)\)\) AS show_links/);
  for (const f of ["streams", "wholesome", "creditRate"] as const) {
    assert.match(faceSql(f), /CASE WHEN cl\.platform IN \('native'[^)]*\) OR p\.show_links\s+THEN COALESCE\(p\.matrix_id, 'c:' \|\| cl\.user_id \|\| '\|' \|\| lower\(cl\.platform\)\)\s+ELSE 'c:' \|\| cl\.user_id \|\| '\|' \|\| lower\(cl\.platform\) END/, `${f} merges platforms without the opt-in`);
  }
  assert.match(faceSql("messages"), /COALESCE\(m\.matrix_id, CASE WHEN p\.show_links THEN p\.matrix_id END, 'c:' \|\| cl\.user_id \|\| '\|' \|\| lower\(cl\.platform\)\) AS person_key/);
  assert.match(src, /CASE WHEN u\.show_links THEN\s+\(SELECT su\.avatar_url FROM site\.platform_links pl/, "a linked platform's picture on a site row without the opt-in");
});

test("a board row's key leaves as a public id, never a canonical", async () => {
  process.env.STREAM_API_SECRET ??= "test-secret-for-public-ids";
  const { publicKey } = await import("./boards.ts");
  const { publicIdFor } = await import("./publicIdServer.ts");
  assert.equal(publicKey("@a:site.test"), "@a:site.test");
  const k = publicKey("c:0a1b2c3d4e5f|twitch");
  assert.equal(k, publicIdFor("0a1b2c3d4e5f", "twitch"));
  assert.ok(!k.includes("0a1b2c3d4e5f"));
  assert.match(src, /key: face === "messages" \? r\.key : publicKey\(r\.key\)/);
  const rank = stripComments(readFileSync(join(import.meta.dirname, "..", "api", "home", "rank", "route.ts"), "utf8"));
  assert.match(rank, /rows\.map\(\(r\) => publicIdFor\(r\.canonical, r\.platform\)\)/, "the caller's own keys are public ids too");
  assert.doesNotMatch(rank, /`c:\$\{c\}`/);
});

test("the erased-person row never ranks (the Streams face counted its kept lines as one '(deleted)' person)", () => {
  for (const f of ["streams", "wholesome", "creditRate", "credit"] as const) {
    assert.match(faceSql(f), /cl\.user_id <> '\(erased\)'/, `${f} can rank the erased row`);
  }
});

// ── Edge cases: empty links, authorless rows, unused parameters ───────────────
import { serveWarm } from "./boards.ts";

test("votes on native EVENT cards (donation, cheer, gift, sub…) never count for the credit boards — the board narrows the pill", () => {
  for (const f of ["credit", "creditRate"] as const) {
    const q = faceSql(f);
    assert.match(q, /JOIN site\.chat_messages m ON v\.platform IN \('native'[^)]*\) AND v\.message_id = m\.id\s+WHERE m\.matrix_id IS NOT NULL AND m\.event_kind IS NULL/, `${f}: only authored, non-event rows`);
  }
});

test("the paid 2× clock bonus (earn_bonus, lit by money in stream-api/sponsors.js) is not earned Qorm", () => {
  assert.match(faceSql("points"), /l\.kind LIKE 'earn\\_%' AND l\.kind <> 'earn_bonus'/);
});

test("Gadget never ranks on Top messages: the native message join drops bot accounts", () => {
  assert.match(faceSql("messages"), /NOT EXISTS \(SELECT 1 FROM site\.users b WHERE b\.matrix_id = m\.matrix_id AND b\.is_bot\)/);
});

test("an avatar is served through /api/avatar/user, never the raw mxc:// the users table stores", () => {
  assert.match(src, /avatarUrl: r\.avatar_url \? `\/api\/avatar\/user\/\$\{encodeURIComponent\(r\.key\)\}` : r\.platform_avatar \?\? null/);
  assert.doesNotMatch(src, /avatarUrl: r\.avatar_url,/);
});

test("names are resolved for the TEN rows a face shows, not the 500 it keeps for rank lookups", () => {
  assert.match(src, /rows\.slice\(0, 10\)\.map\(personKey\)/);
  assert.match(src, /l\.slice\(0, 10\)/);
});

test("serveWarm: fresh → the cache's value; cold → null and ONE background load; stale → the last value while ONE refresh runs; a failed face keeps its last list", async () => {
  let fresh: Record<string, number[]> | null = null;
  let loads = 0;
  let resolveLoad: (v: Record<string, number[]>) => void = () => {};
  const cache = { peek: () => fresh, get: () => { loads++; return new Promise<Record<string, number[]>>((r) => { resolveLoad = r; }); } };
  const slot: { last: Record<string, number[]> | null; inflight: Promise<void> | null } = { last: null, inflight: null };
  assert.equal(serveWarm(cache, slot), null, "cold → nothing yet");
  serveWarm(cache, slot);
  assert.equal(loads, 1, "one load shared while cold");
  resolveLoad({ a: [1], b: [2] });
  await slot.inflight;
  fresh = { a: [1], b: [2] }; // a cacheable load makes the cache fresh
  assert.deepEqual(serveWarm(cache, slot), { a: [1], b: [2] }, "fresh → the cache's own value");
  assert.equal(loads, 1, "no load while fresh");
  fresh = null; // the TTL passed
  assert.deepEqual(serveWarm(cache, slot), { a: [1], b: [2] }, "stale → the last value, at once");
  assert.deepEqual(serveWarm(cache, slot), { a: [1], b: [2] });
  assert.equal(loads, 2, "stale → ONE refresh across repeated reads");
  resolveLoad({ a: [3] }); // face b failed this time → absent, and the cache did not remember (peek stays null)
  await slot.inflight;
  assert.deepEqual(slot.last, { a: [3], b: [2] }, "a failed face keeps its last list; the others move on");
  serveWarm(cache, slot);
  assert.equal(loads, 3, "an unremembered (failed) load is retried on the next read");
});

test("a window whose face failed is not remembered by the cache (it retries next read); a cold window is null, never []", () => {
  assert.match(src, /cacheable: complete/);
  assert.match(src, /lists\?\.\[f\] \?\? null/);
  assert.match(src, /\}\s*$/);
});

test("pictures for platform chatters come from stream.users.avatar_url (v127), and a site account with no avatar falls back to its linked platform picture", () => {
  assert.match(src, /JOIN stream\.users su ON su\.id = c\.user_id/);
  assert.match(src, /avatarUrl: r\.avatar_url \?\? null \}\)/, "canonical rows: the platform picture or none");
  assert.match(src, /AS platform_avatar/);
  assert.match(src, /avatarUrl: r\.avatar_url \? `\/api\/avatar\/user\/\$\{encodeURIComponent\(r\.key\)\}` : r\.platform_avatar \?\? null/);
});
