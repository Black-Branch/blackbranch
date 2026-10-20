// Tests for the raid panic switch's decision logic (static, node --test).
//
// `checkSignupAllowed` talks to the pool, so this pins the properties that
// matter at the SOURCE level rather than mocking pg. They are all properties
// where being wrong is expensive and silent:
//   • an existing user is never refused (a lockout of the whole community)
//   • the lock is checked, and checked AFTER existence
//   • one query, so existence and the flag can't be read at different instants
//   • errors fail CLOSED
//   • both signup routes actually call it
//
// Run: node --test app/lib/lockdown.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

// Comments are not source — this file's own prose names the very things being
// checked. (Same trap wsFrames/composerLayout/timerVisibility all document.)

const gate = stripComments(read("app/lib/lockdown.ts"));

test("an existing user is waved through before the lock is ever consulted", () => {
  // THE safety property. Throwing the switch must not lock out the community
  // it is protecting — and `matrix-callback` upserts on every login, so a gate
  // that keyed off "the INSERT" instead of "a NEW row" would do exactly that.
  const existingIdx = gate.indexOf("if (existing)");
  const lockIdx = gate.indexOf("signups_disabled");
  assert.ok(existingIdx !== -1, "gate must short-circuit on an existing account");
  assert.ok(lockIdx !== -1, "gate must read the lockdown flag");
  assert.ok(
    existingIdx < gate.indexOf("=== true"),
    "the existing-user check must precede the locked check"
  );
});

test("existence and the flag are read in ONE query", () => {
  // Two round trips leave a window where an account is created against a flag
  // that had already flipped — i.e. exactly while the switch is being thrown.
  // Scoped to checkSignupAllowed — the module also holds isCrosspostLocked,
  // which has its own (separate, deliberate) query.
  const fn = gate.slice(
    gate.indexOf("export async function checkSignupAllowed"),
    gate.indexOf("export async function isCrosspostLocked")
  );
  const queries = fn.match(/pool\.query/g) ?? [];
  assert.equal(queries.length, 1, `expected a single query, found ${queries.length}`);
  const sql = fn.slice(fn.indexOf("pool.query"));
  assert.match(sql, /EXISTS\(SELECT 1 FROM site\.users/, "must check existence");
  assert.match(sql, /FROM site\.lockdown/, "must read the lockdown row in the same statement");
});

test("errors fail CLOSED", () => {
  // A panic switch that can be defeated by making the database unhappy is not
  // a panic switch.
  const katch = gate.slice(gate.indexOf("catch"));
  assert.match(katch, /allowed:\s*false/, "the catch must refuse, not allow");
  assert.doesNotMatch(katch, /allowed:\s*true/, "the catch must never allow a signup");
});

test("an absent config row is OPEN, not locked", () => {
  // Distinct from an unreadable one: the query WORKED, the DB is healthy, and
  // the column default is signups-enabled. Treating "no row" as locked would
  // turn any config anomaly into a silent, unnoticed signup outage.
  assert.match(
    gate,
    /locked === true/,
    "must lock only on an explicit true, so null/absent reads as open"
  );
});

test("both account-creation paths are gated", () => {
  // There are exactly two places a site.users row is born. Missing one leaves
  // the switch trivially bypassable via the other, with nothing to notice.
  for (const route of [
    "app/api/auth/mas-callback/route.ts",
    "app/api/auth/matrix-callback/route.ts",
  ]) {
    const src = stripComments(read(route));
    assert.match(src, /checkSignupAllowed\(/, `${route} does not call the gate`);
    const gateIdx = src.indexOf("checkSignupAllowed(");
    const insertIdx = src.indexOf("INSERT INTO site.users");
    assert.ok(insertIdx !== -1, `${route} should still create the account`);
    assert.ok(
      gateIdx < insertIdx,
      `${route} calls the gate AFTER creating the row — the account already exists by then`
    );
  }
});

test("the mod route upserts the singleton rather than blind-UPDATEing it", () => {
  // An UPDATE against a missing row affects zero rows and reports success: the
  // UI would show "locked" while the row the gate reads stays absent. A panic
  // button that silently no-ops is worse than none.
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  const write = route.slice(route.indexOf("export async function POST"));
  // v147: an insert-if-missing, then the UPDATE that writes the levers — the row always exists
  // before the write, so the UPDATE can never be a zero-row no-op.
  const ins = write.indexOf("INSERT INTO site.lockdown (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  const upd = write.indexOf("UPDATE site.lockdown l SET");
  assert.ok(ins !== -1 && upd > ins, "the singleton must be ensured before the levers are written");
});

// ── Outbound half (v83): cross-post lock ─────────────────────────────────────

test("the cross-post check fails CLOSED", () => {
  // Cheaper than it sounds: a locked cross-post still delivers natively, so a
  // false lock costs "your message stayed on the site". A false UNLOCK costs a
  // raider broadcasting through our API, under their own name, to four
  // platforms.
  const fn = gate.slice(gate.indexOf("export async function isCrosspostLocked"));
  const katch = fn.slice(fn.indexOf("catch"));
  assert.match(katch, /return true/, "the catch must block cross-posting, not allow it");
});

test("cross-posting is gated in the send route, before the platform send", () => {
  const src = stripComments(read("app/api/chat/send/route.ts"));
  assert.match(src, /isCrosspostLocked\(\)/, "send route must consult the lock");
  // FIRST occurrence of sendToPlatform — there are TWO outbound paths (the
  // "all" fan-out and the single target), and the lock must precede BOTH.
  // Gating only the later one is the bug this assertion catches.
  const lockIdx = src.indexOf("isCrosspostLocked()");
  const sendIdx = src.indexOf("sendToPlatform(");
  assert.ok(sendIdx !== -1, "send route should still cross-post when unlocked");
  assert.ok(lockIdx < sendIdx, "an outbound send happens BEFORE the lock is consulted");

  // The ordering assertion above is NOT sufficient on its own: deleting
  // `&& !crosspostLocked` from the fan-out condition leaves the lock still
  // *computed* early, so ordering holds and the suite stays green while
  // `send to: all` broadcasts freely. Ordering shows the lock is available;
  // these show it is USED — once per outbound path.
  assert.match(
    src,
    /forced_destination === "all" && !isReply && !crosspostLocked/,
    "the 'all' fan-out branch must itself be gated on the lock"
  );
  assert.match(
    src,
    /platformTarget = crosspostLocked \|\|[^;]*\? null : requestedTarget/,
    "the single-target path must itself be gated on the lock"
  );
});

test("a locked cross-post degrades to native rather than losing the message", () => {
  // The lock nulls the target so it takes the SAME path a CROSSPOST_DISABLED
  // platform already takes — delivered on site.test instead of erroring.
  const src = stripComments(read("app/api/chat/send/route.ts"));
  // Matches the LOCK's term, not the whole expression: other reasons to keep
  // a message native share this line (commandText), and pinning the
  // exact text would make an unrelated addition fail this test.
  assert.match(
    src,
    /const platformTarget = crosspostLocked[^;]*\? null : requestedTarget/,
    "a locked cross-post must null the platform target, not throw"
  );
});

test("an explicitly chosen destination is TOLD it didn't leave the site", () => {
  // Silently keeping a message the user asked to send to Twitch is a lie, and
  // the route already surfaces platform-send failures for explicit
  // destinations — this must match that, not the quiet reply-routing path.
  const src = stripComments(read("app/api/chat/send/route.ts"));
  assert.match(src, /crosspost_locked/, "needs a distinguishable reason code");
  // BOTH explicit shapes must be told, and the second is the easy one to miss:
  // `send to: all` carries no `forcedSingle`, so `explicitDestination` is false
  // for it — on its own it would let the fan-out case fall through silently and
  // the user would believe it reached four platforms.
  assert.match(src, /explicitDestination \|\| blockedAll/, "the 'all' fan-out case must also be reported");
  assert.match(
    src,
    /blockedAll = crosspostLocked && forced_destination === "all"/,
    "blockedAll must be derived from the locked 'all' destination"
  );
});

test("each lever is optional and independently written", () => {
  // The panel flips one without restating the other, so a stale client can
  // never silently re-open a lever a mod just closed.
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route, /signups_disabled\s+= COALESCE\(\$1, CASE WHEN x\.expired THEN FALSE ELSE l\.signups_disabled END\)/);
  assert.match(route, /crosspost_disabled\s+= COALESCE\(\$2, CASE WHEN x\.expired THEN FALSE ELSE l\.crosspost_disabled END\)/);
  assert.match(route, /ingest_paused\s+= COALESCE\(\$4::text\[\], CASE WHEN x\.expired THEN '\{\}'::text\[\] ELSE l\.ingest_paused END\)/);
  assert.match(route, /sub_only\s+= COALESCE\(\$5, CASE WHEN x\.expired THEN FALSE ELSE l\.sub_only END\)/);
});

// ── Age half (v85): minimum account age ─────────────────────────────────────

test("the age lever is written independently, like the other two", () => {
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route, /min_account_age_days = COALESCE\(\$3, CASE WHEN x\.expired THEN 0 ELSE l\.min_account_age_days END\)/);
});

test("0 is a real value, distinguishable from 'not mentioned'", () => {
  // The bug this shape prevents. The other two levers are booleans, where
  // `typeof x === "boolean"` cleanly separates "absent" from "false". A NUMBER
  // has no such luck: a truthiness check would read 0 (disarmed — a deliberate,
  // meaningful setting) as "the request didn't mention it", so DISARMING the
  // filter would silently do nothing and the panel would snap back to armed.
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route, /minAccountAgeDays !== undefined && body\.minAccountAgeDays !== null/,
    "presence must be tested explicitly, never by truthiness");
  assert.doesNotMatch(route, /if \(body\.minAccountAgeDays\)\s*\{/,
    "a truthy check here would make 0 unsettable");
});

test("a nonsense threshold disarms rather than arming harder", () => {
  // Clamped, not trusted. The failure directions are not symmetric: an absurdly
  // high value would hold literally everyone, so the ceiling matters more than
  // the floor.
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route, /Math\.min\(Math\.floor\(n\), 3650\)/, "must clamp the upper bound");
  assert.match(route, /n < 0/, "must reject negatives");
});

test("the mod log records the THRESHOLD, not just that someone touched it", () => {
  // "min_account_age_set" alone can't answer the only question a post-raid
  // review asks — how strict was it, and when did that change?
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route, /min age \$\{minAge\}d|min age \$\{minAge\}/,
    "the logged reason must carry the number");
  assert.match(route, /min age off/, "and must distinguish disarmed from a threshold");
});

test("the panel warns that Kick is held wholesale, at the switch itself", () => {
  // Unknown-age accounts are withheld, and Kick publishes NO creation
  // date — so arming this holds every Kick viewer.
  // That consequence has to be readable where the decision is made; discovered
  // afterwards it just looks like Kick broke.
  const section = stripComments(read("app/features/moderation/sections/LockdownSection.tsx"));
  assert.match(section, /Kick/, "the age lever must name Kick");
  assert.match(section, /minAccountAgeDays: ageOn \? 0 : DEFAULT_MIN_AGE_DAYS/,
    "the lever must actually toggle the threshold");
  assert.match(section, /no account age/i, "and must say WHY Kick is affected");
});

test("lifting the lockdown clears the age lever too", () => {
  // The master button sets all three; if it lifted only the booleans, "Lift
  // lockdown" would report everything open while chat stayed silently held —
  // the same class of silent-partial-state as an ungated fan-out.
  const section = stripComments(read("app/features/moderation/sections/LockdownSection.tsx"));
  const lift = section.slice(section.indexOf("Lift lockdown") - 600, section.indexOf("Lift lockdown"));
  assert.match(lift, /minAccountAgeDays: 0/, "lifting must disarm the age filter");
  assert.match(section, /minAccountAgeDays: DEFAULT_MIN_AGE_DAYS[\s\S]{0,200}?lock everything|Confirm — lock everything/,
    "and locking everything must arm it");
});

test("reading the lockdown state is mod-gated too", () => {
  // "Are signups closed yet?" tells a raider whether they have been noticed,
  // and therefore whether to burn the identities they still hold.
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(get, /requireMod\(\)/, "GET must require a mod");
});

// ── Ingest per platform, sub only, expiry ───────────────────────────────────────

test("every gate reads the lockdown AS IT HOLDS NOW (site.lockdown_now), so an expiry needs no writer", () => {
  const lib = stripComments(read("app/lib/lockdown.ts"));
  assert.match(lib, /SELECT signups_disabled FROM site\.lockdown_now WHERE id = 1/);
  assert.match(lib, /SELECT crosspost_disabled FROM site\.lockdown_now WHERE id = 1/);
  assert.match(lib, /SELECT sub_only FROM site\.lockdown_now WHERE id = 1/);
  const age = readFileSync(join(webRoot, "..", "stream-api", "account-age.js"), "utf8");
  assert.match(age, /SELECT min_account_age_days FROM site\.lockdown_now WHERE id = 1/);
  const ingest = readFileSync(join(webRoot, "..", "stream-api", "ingest-pause.js"), "utf8");
  assert.match(ingest, /SELECT ingest_paused FROM site\.lockdown_now WHERE id = 1/);
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST")), /FROM site\.lockdown_now WHERE id = 1/);
});

test("sub only fails OPEN and is checked right after the ban", () => {
  const lib = stripComments(read("app/lib/lockdown.ts"));
  const fn = lib.slice(lib.indexOf("export async function isSubOnly"));
  assert.match(fn, /catch \(err\) \{[\s\S]*return false;/);
  const send = stripComments(read("app/api/chat/send/route.ts"));
  const ban = send.indexOf('error: "banned"');
  const sub = send.indexOf("await isSubOnly()");
  assert.ok(ban !== -1 && sub > ban, "sub-only is checked after the ban check");
  assert.match(send.slice(sub, sub + 300), /if \(!tier && !u\?\.is_mod && !u\?\.is_admin\)/);
});

test("the panel shows the reason line only after a lever is thrown, and offers an expiry", () => {
  const section = stripComments(read("app/features/moderation/sections/LockdownSection.tsx"));
  assert.match(section, /\{askReason && anyOn && \(/);
  assert.match(section, /if \(thrown\) setAskReason\(true\);/);
  assert.match(section, /LOCKDOWN_EXPIRY\.map/);
  assert.match(section, /INGEST_PLATFORMS\.map/);
  assert.match(section, /subOnly: !subOnly/);
  assert.match(section, /function Lever\(/);
});

test("the migration's view lifts every lever once expired, and passes the link gate through", () => {
  const sql = readFileSync(join(webRoot, "..", "migrations", "migrate-v147.sql"), "utf8");
  assert.match(sql, /CREATE OR REPLACE VIEW site\.lockdown_now AS/);
  for (const col of ["signups_disabled", "crosspost_disabled", "sub_only"]) assert.match(sql, new RegExp(`\\(l\\.${col} AND NOT x\\.expired\\)\\s+AS ${col}`));
  assert.match(sql, /CASE WHEN x\.expired THEN 0 ELSE l\.min_account_age_days END/);
  assert.match(sql, /CASE WHEN x\.expired THEN '\{\}'::text\[\] ELSE l\.ingest_paused END/);
  assert.match(sql, /l\.link_gate,/);
  assert.match(sql, /INSERT INTO public\.schema_migrations \(version, note\)\s+VALUES \(147,[\s\S]*COMMIT;\s*$/);
});

// ── Until the stream ends + the expiry presets ─────────────────────────────────────────────────

test("expiry presets: 15 min, 1 hour, until the stream ends (only while live), a custom moment, none", async () => {
  const { LOCKDOWN_EXPIRY, expiryBody } = await import("./lockdownLevers.ts");
  assert.deepEqual(LOCKDOWN_EXPIRY.map((x) => x.label), ["No expiry", "15 min", "1 hour", "Until the stream ends", "Custom…"]);
  const now = Date.parse("2026-10-12T10:00:00Z");
  assert.deepEqual(expiryBody("15", { now }), { expiresInMinutes: 15 });
  assert.deepEqual(expiryBody("none", { now }), { expiresInMinutes: null });
  assert.deepEqual(expiryBody("stream", { live: true, now }), { untilStreamEnd: true });
  assert.deepEqual(expiryBody("stream", { live: false, now }), { error: "No stream is live." });
  assert.deepEqual(expiryBody("custom", { customAt: "2026-10-12T12:30:00Z", now }), { expiresInMinutes: 150 });
  assert.deepEqual(expiryBody("custom", { customAt: "2026-10-12T09:00:00Z", now }), { error: "Pick a moment in the future." });
  assert.deepEqual(expiryBody("custom", { customAt: "2026-10-30T09:00:00Z", now }), { error: "At most 7 days ahead." });
  assert.deepEqual(expiryBody("custom", { now }), { error: "Pick a date and time." });
});

test("v148: the view reads every lever off once the tied stream ends; the route ties it only to a live stream", () => {
  const sql = readFileSync(join(webRoot, "..", "migrations", "migrate-v148.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS until_stream text;/);
  assert.match(sql, /l\.until_stream IS NOT NULL AND NOT EXISTS \(\s*SELECT 1 FROM stream\.sessions s WHERE s\.stream_id = l\.until_stream AND s\.ended_at IS NULL\)/);
  assert.match(sql, /INSERT INTO public\.schema_migrations \(version, note\)\s+VALUES \(148,[\s\S]*COMMIT;\s*$/);
  const route = stripComments(read("app/api/mod/lockdown/route.ts"));
  assert.match(route, /if \(!live\[0\]\) return Response\.json\(\{ error: "no stream is live" \}, \{ status: 409 \}\);/);
  assert.match(route, /FROM \(SELECT expired FROM site\.lockdown_now WHERE id = 1\) x/, "the writer clears stale levers by the view's own rule");
});
