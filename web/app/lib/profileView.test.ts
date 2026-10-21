// The public profile card's one disclosure decision (profileView.ts) and the route that follows it.
// The route returns matrixId, siteName and linkedPlatforms only as profileView.ts decides, never for
// ANY canonical to anyone.
// Run: node --test app/lib/profileView.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { profileView, type ProfileFacts } from "./profileView.ts";
import { stripComments } from "./testSource.ts";
import { IDENTITY_STATS_SQL, identityStatsFields, type IdentityStatsRow } from "./publicProfile.ts";
import { LINK_OWNER_SQL } from "./identitySpan.ts";

const stranger: ProfileFacts = { isMod: false, isSelf: false, showLinks: false, siteKey: false };

test("a stranger looking at a platform card: no link, no merged stats, no site account", () => {
  assert.deepEqual(profileView(stranger), { links: false, site: false });
});

test("the site identity keeps its own banner and Matrix id, never the platform list", () => {
  assert.deepEqual(profileView({ ...stranger, siteKey: true }), { links: false, site: true });
});

test("the person, a moderator, or an opt-in: everything", () => {
  for (const k of ["isMod", "isSelf", "showLinks"] as const) {
    assert.deepEqual(profileView({ ...stranger, [k]: true }), { links: true, site: true }, k);
  }
});

const src = stripComments(readFileSync(join(process.cwd(), "app", "api", "user", "[id]", "route.ts"), "utf8"));

test("the route gates every link field, the merged stats and the pronouns on the view", () => {
  assert.match(src, /const view = profileView\(\{/);
  assert.match(src, /const fields = view\.links \? publicProfileFields\(data, pluginProfileFields\(\)\) : identityStats;/);
  assert.match(src, /if \(!canonicalId \|\| !view\.links\) return null;\s*try \{\s*const \{ rows \} = await pool\.query<\{ pronouns: string \| null \}>/, "pronouns are not behind view.links");
  assert.match(src, /if \(!canonicalId \|\| view\.links\) return \{\};\s*try \{\s*const \{ rows \} = await pool\.query<IdentityStatsRow>\(IDENTITY_STATS_SQL, \[canonicalId, siteKey \? null : key\.platform\]\);/);
  for (const f of ["matrixId", "siteName", "linkedPlatforms"]) {
    assert.match(src, new RegExp(`if \\(view\\.links\\)[\\s\\S]*${f}`), `${f} is not behind view.links`);
  }
  assert.match(src, /view\.site \? fetchBanner\(\) : Promise\.resolve\(null\)/, "the banner is not behind view.site");
  assert.match(src, /if \(view\.site && siteKey\) matrixId = /, "the site identity's own Matrix id is not behind view.site");
  assert.match(src, /const \{ owner \} = await linkFacts\(canonicalId, matrixKey, isSelf \? viewer : null\);/, "the own card must name the caller's own account");
  assert.match(src, /profileView\(\{ isMod, isSelf, showLinks: owner\?\.show_links === true, siteKey \}\)/);
  const facts = stripComments(readFileSync(join(process.cwd(), "app", "lib", "linkFactsServer.ts"), "utf8"));
  assert.match(facts, /SELECT u\.matrix_id, u\.display_name, u\.show_links/, "the opt-in is never read");
  assert.match(facts, /await pool\.query<LinkOwner>\(LINK_OWNER_SQL, \[canonical, self\]\)/);
  assert.match(facts, /return \{ owner: null \};\s*\}\s*\}\s*$/, "a failed read must be the most private answer (and END anchor)");
});

test("a raw canonical is answered only for a moderator or the person themselves", () => {
  assert.match(src, /if \(key\.kind === "canonical" && !isMod && !isSelf\) return Response\.json\(\{ found: false \}\);/);
});

test("handles stay mods-only and server-side", () => {
  assert.match(src, /if \(canonicalId && isMod\)/);
  assert.match(src, /\.\.\.\(platformHandles\.length \? \{ platformHandles \} : \{\}\)/);
  assert.match(src, /\}\);\s*\}\s*$/, "vacuity anchor: END of route.ts");
});

// The "one identity" test must not count the canonical's own platform rows only: a person whose
// site account is joined through site.platform_links (no native row on the canonical) would count
// as one and the card would show what joins them. The SQL was run against a throwaway Postgres
// with the baseline schema: a Twitch canonical joined that way spans 2; a site-only account 1.
test("a site account joined only through site.platform_links is in the identity", async () => {
  const { IDENTITY_SPAN_SQL } = await import("./identitySpan.ts");
  assert.match(IDENTITY_SPAN_SQL, /UNION SELECT canonical_id FROM site\.platform_links WHERE matrix_id IN \(SELECT matrix_id FROM mx\)/);
  assert.match(IDENTITY_SPAN_SQL, /EXISTS \(SELECT 1 FROM site\.platform_links\s+WHERE canonical_id IN \(SELECT c FROM canon\) OR matrix_id IN \(SELECT matrix_id FROM mx\)\) AS via_links,/);
});

// One account's opt-in must not publish the link for another account on the same canonical. The cards read show_links as "every account in the identity agrees" (all_show). Run on
// the throwaway Postgres: a canonical carrying an opted-in and a not-opted account gives all_show f.
test("the opt-in counts only when every site account in the identity agrees", async () => {
  const { IDENTITY_SPAN_SQL } = await import("./identitySpan.ts");
  assert.match(IDENTITY_SPAN_SQL, /NOT EXISTS \(SELECT 1 FROM canon WHERE NOT \(NOT EXISTS \(SELECT 1 FROM \(/);
  assert.match(IDENTITY_SPAN_SQL, /UNION SELECT platform_id FROM stream\.links WHERE platform IN \('native'[^)]*\) AND canonical = canon\.c/,
    "an account joined natively is consulted too");
  assert.match(IDENTITY_SPAN_SQL, /AS all_show$/);
  const facts = stripComments(readFileSync(join(process.cwd(), "app", "lib", "linkFactsServer.ts"), "utf8"));
  assert.match(facts, /if \(owner\) owner = \{ \.\.\.owner, show_links: owner\.show_links && rows\[0\]\?\.all_show === true \};/);
});

test("a stranger's card never carries the stream profile's name, and a deleted person has no profile", () => {
  // One identity's fields never include `name` (the canonical's); a platform card is named by platformName.
  assert.equal("name" in identityStatsFields({ activity: 1, streams: 1, karma: 0.5, is_member: false, sub_tier: null }), false);
  assert.match(src, /found: true,\s*\.\.\.fields,/);
  assert.match(src, /if \(!body\?\.error && body\?\.erased !== true\) return body;/, "an erased answer is not a profile");
});

// ── against a real Postgres ─────────────────────────────────────────────────
const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;

test("one identity's stats: per platform, and the same shape whether or not the person is linked", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const base = (process.pid.toString(16) + Date.now().toString(16)).slice(-11);
  const linked = `${base}a`.padStart(12, "0");
  const alone = `${base}b`.padStart(12, "0");
  const sid = Number(String(process.pid) + String(Date.now() % 1e6));
  const clean = async () => {
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id IN ($1, $2)`, [linked, alone]);
    await pool.query(`DELETE FROM stream.users WHERE id IN ($1, $2)`, [linked, alone]);
    await pool.query(`DELETE FROM stream.sessions WHERE stream_id = $1`, [sid]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  await pool.query(`INSERT INTO stream.sessions (stream_id) VALUES ($1)`, [sid]);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'casey'), ($2, 'gadget')`, [linked, alone]);
  // A linked person: three Twitch lines, one YouTube line and one site line on one canonical.
  for (const [plat, k, tier] of [["twitch", 0.9, "1000"], ["twitch", 0.7, "1000"], ["twitch", null, "2000"], ["youtube", 0.1, null], ["native", 0.2, null]] as const) {
    await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message, karma, tier, is_member, stream_id) VALUES ($1, $2, 'casey', 'hi', $3, $4, $5, $6)`,
      [linked, plat, k, tier, plat === "twitch", sid]);
  }
  await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message, karma, stream_id) VALUES ($1, 'twitch', 'gadget', 'hi', 0.4, $2)`, [alone, sid]);
  const stats = async (c: string, p: string | null) => identityStatsFields((await pool.query<IdentityStatsRow>(IDENTITY_STATS_SQL, [c, p])).rows[0]);

  const tw = await stats(linked, "twitch");
  assert.deepEqual(tw, { karma: 0.8, activity: 3, streams: 1, isMember: true, subTier: "2000" });
  assert.deepEqual(await stats(linked, "youtube"), { karma: 0.1, activity: 1, streams: 1, isMember: false, subTier: null }, "the YouTube card shows the Twitch numbers");
  assert.deepEqual(await stats(linked, null), { karma: 0.2, activity: 1, streams: 1, isMember: false, subTier: null }, "the site card shows platform lines");
  // The shape does not depend on the link: an unlinked person's card carries the same keys.
  const solo = await stats(alone, "twitch");
  assert.deepEqual(Object.keys(solo).sort(), Object.keys(tw).sort());
  assert.deepEqual(await stats(alone, "kick"), { karma: 0.5, activity: 0, streams: 0, isMember: false, subTier: null }, "an identity with no lines");
});

test("a split identity: the person's own card names THEIR account, never the other one", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const run = `pvs${process.pid}x${Date.now().toString(36)}`;
  const mine = `@${run}-a:site.test`;
  const theirs = `@${run}-b:site.test`;
  const canon = (process.pid.toString(16) + Date.now().toString(16)).slice(-12).padStart(12, "0");
  const clean = async () => {
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id IN ($1, $2)`, [mine, theirs]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = $1`, [canon]);
    await pool.query(`DELETE FROM stream.users WHERE id = $1`, [canon]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2)`, [mine, theirs]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  // `theirs` is the newer account, so it is what a card names when nobody is "self".
  await pool.query(`INSERT INTO site.users (matrix_id, display_name, created_at) VALUES ($1, 'Mine', now() - interval '1 day'), ($2, 'Theirs', now())`, [mine, theirs]);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [canon]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $3), ('twitch', $2, $3)`, [mine, `${run}-tw`, canon]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3)`, [theirs, `${run}-tw`, canon]);
  const owner = async (self: string | null) => (await pool.query<{ matrix_id: string; display_name: string }>(LINK_OWNER_SQL, [canon, self])).rows[0];
  assert.deepEqual(await owner(mine), { matrix_id: mine, display_name: "Mine", show_links: false }, "one account read the other's Matrix id and name");
  assert.deepEqual(await owner(theirs), { matrix_id: theirs, display_name: "Theirs", show_links: false });
  assert.equal((await owner(null))?.matrix_id, theirs, "nobody self: the newest account, as before");
});
