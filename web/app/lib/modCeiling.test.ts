// Unit tests for the mod privilege-ceiling decision. Run with:
//   node --test app/lib/modCeiling.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { moderationCeilingDenied, checkModerationCeiling, type CeilingQuery } from "./modCeiling.ts";
import { NATIVE_SQL } from "./nativePlatform.ts";

const MOD = "@mod:site.test";
const OWNER = "@casey:site.test";

test("a non-admin mod is DENIED from acting on the owner (the whole point)", () => {
  assert.equal(
    moderationCeilingDenied({ actorId: MOD, targetMx: OWNER, actorAdmin: false, targetAdmin: true }),
    true,
  );
});

test("an admin (owner) may act on anyone, including a mod", () => {
  assert.equal(
    moderationCeilingDenied({ actorId: OWNER, targetMx: MOD, actorAdmin: true, targetAdmin: false }),
    false,
  );
});

test("a mod acting on a normal (non-admin) user is allowed", () => {
  assert.equal(
    moderationCeilingDenied({ actorId: MOD, targetMx: "@rando:site.test", actorAdmin: false, targetAdmin: false }),
    false,
  );
});

test("self-action is always allowed (even the owner on themselves)", () => {
  assert.equal(
    moderationCeilingDenied({ actorId: OWNER, targetMx: OWNER, actorAdmin: true, targetAdmin: true }),
    false,
  );
});

test("platform-only target (no matrix id) is allowed — can't be the owner", () => {
  assert.equal(
    moderationCeilingDenied({ actorId: MOD, targetMx: null, actorAdmin: false, targetAdmin: false }),
    false,
  );
});

test("admin-on-admin is allowed (co-owner acting on owner)", () => {
  assert.equal(
    moderationCeilingDenied({ actorId: "@co:site.test", targetMx: OWNER, actorAdmin: true, targetAdmin: true }),
    false,
  );
});

// ── The DB-backed check (admin.ts assertCanModerate) ─────────────────────────
// A failed lookup must REFUSE: read as "no rows", it made the owner look like a
// non-admin (or an unlinked chatter) and let a mod act on them.

const CANON = "0123456789ab";
// `links` = site.platform_links (canonical → matrix id, written by identity
// linking); `native` = stream.links rows on the site's own platform (canonical
// → the matrix id that chats natively). The fake answers the one union lookup
// from both, and finds nothing native unless the lookup names the native platform.
type Db = { links: Record<string, string>; native?: Record<string, string>; admins: string[]; mods?: string[]; failLinks?: boolean; failUsers?: boolean };
function db(d: Db): CeilingQuery {
  return async (sql, params) => {
    if (sql.includes("site.platform_links") || sql.includes("stream.links")) {
      if (d.failLinks) throw new Error("pool gone");
      const c = String(params[0]);
      const rows: { matrix_id: string }[] = [];
      if (sql.includes("site.platform_links") && d.links[c]) rows.push({ matrix_id: d.links[c] });
      if (sql.includes("stream.links") && sql.includes(NATIVE_SQL) && d.native?.[c]) rows.push({ matrix_id: d.native[c] });
      return { rows };
    }
    if (d.failUsers) throw new Error("pool gone");
    const ids = params[0] as string[];
    return { rows: ids.map((id) => ({ matrix_id: id, is_admin: d.admins.includes(id), is_mod: !!d.mods?.includes(id) })) };
  };
}

test("a mod acting on the owner is refused with 403, by matrix id or by the owner's canonical", async () => {
  const q = db({ links: { [CANON]: OWNER }, admins: [OWNER] });
  assert.equal((await checkModerationCeiling(MOD, OWNER, q))?.status, 403);
  assert.equal((await checkModerationCeiling(MOD, CANON, q))?.status, 403);
});

test("an unlinked platform chatter, a non-admin user and self are still allowed", async () => {
  const q = db({ links: {}, admins: [OWNER] });
  assert.equal(await checkModerationCeiling(MOD, "fedcba987654", q), null, "unlinked chatter");
  assert.equal(await checkModerationCeiling(MOD, "@sam:site.test", q), null, "non-admin user");
  assert.equal(await checkModerationCeiling(OWNER, OWNER, q), null, "self");
});

test("a failed user lookup refuses with 503 + Retry-After, never allows", async () => {
  const res = await checkModerationCeiling(MOD, OWNER, db({ links: {}, admins: [OWNER], failUsers: true }));
  assert.equal(res?.status, 503, "a database error let the moderation through");
  assert.ok(res?.headers.get("Retry-After"), "the 503 carries no Retry-After");
});

test("a failed canonical lookup refuses with 503, never reads as an unlinked chatter", async () => {
  const res = await checkModerationCeiling(MOD, CANON, db({ links: { [CANON]: OWNER }, admins: [OWNER], failLinks: true }));
  assert.equal(res?.status, 503, "a failed platform_links lookup read as 'unlinked' and allowed the action");
});

// ── R2-7: the owner's NATIVE canonical ───────────────────────────────────────
// A site account's own canonical lives in stream.links (the site's platform),
// and native chat frames carry it publicly. Resolved through platform_links
// alone, an owner who never linked a platform account read as an unlinked
// chatter — and a mod could merge, ban or purge them by that canonical.

test("a mod acting on the owner's native canonical (no platform link) is refused with 403", async () => {
  const q = db({ links: {}, native: { [CANON]: OWNER }, admins: [OWNER] });
  assert.equal((await checkModerationCeiling(MOD, CANON, q))?.status, 403,
    "the owner's native canonical read as an unlinked chatter");
});

test("every account behind a canonical is checked: one admin among them refuses", async () => {
  const q = db({ links: { [CANON]: "@sam:site.test" }, native: { [CANON]: OWNER }, admins: [OWNER] });
  assert.equal((await checkModerationCeiling(MOD, CANON, q))?.status, 403);
  const q2 = db({ links: { [CANON]: OWNER }, native: { [CANON]: "@sam:site.test" }, admins: [OWNER] });
  assert.equal((await checkModerationCeiling(MOD, CANON, q2))?.status, 403);
});

test("a canonical shared by the mod and the owner is still the owner's", async () => {
  const q = db({ links: { [CANON]: MOD }, native: { [CANON]: OWNER }, admins: [OWNER] });
  assert.equal((await checkModerationCeiling(MOD, CANON, q))?.status, 403, "the mod's own link made it read as self");
});

test("a native canonical of an ordinary viewer, or of the mod themselves, is allowed", async () => {
  assert.equal(await checkModerationCeiling(MOD, CANON, db({ links: {}, native: { [CANON]: "@sam:site.test" }, admins: [OWNER] })), null);
  assert.equal(await checkModerationCeiling(MOD, CANON, db({ links: {}, native: { [CANON]: MOD }, admins: [OWNER] })), null);
});

test("a failed native lookup refuses with 503", async () => {
  const res = await checkModerationCeiling(MOD, CANON, db({ links: {}, native: { [CANON]: OWNER }, admins: [OWNER], failLinks: true }));
  assert.equal(res?.status, 503);
});

// ── Mods on mods: only an admin acts on staff ────────────────────────────────

test("a mod acting on another mod is DENIED; an admin acting on a mod is allowed", () => {
  assert.equal(moderationCeilingDenied({ actorId: MOD, targetMx: "@other:site.test", actorAdmin: false, targetAdmin: false, targetMod: true }), true);
  assert.equal(moderationCeilingDenied({ actorId: OWNER, targetMx: MOD, actorAdmin: true, targetAdmin: false, targetMod: true }), false);
  assert.equal(moderationCeilingDenied({ actorId: MOD, targetMx: MOD, actorAdmin: false, targetAdmin: false, targetMod: true }), false, "self");
});

test("the DB-backed check refuses a mod banning a mod — by matrix id and by their canonical — with its own sentence", async () => {
  const OTHER = "@other:site.test";
  const q = db({ links: { [CANON]: OTHER }, admins: [OWNER], mods: [MOD, OTHER] });
  for (const target of [OTHER, CANON]) {
    const res = await checkModerationCeiling(MOD, target, q);
    assert.equal(res?.status, 403, `${target} was let through`);
    assert.match(await res!.text(), /only an admin can moderate a moderator/);
  }
  assert.equal(await checkModerationCeiling(OWNER, OTHER, q), null, "the owner may act on a mod");
  assert.equal(await checkModerationCeiling(MOD, "@sam:site.test", q), null, "a viewer is still fair game");
});
