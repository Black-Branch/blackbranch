// The DM window's and /announce's server routes. Source scan: the routes import next-auth and the
// pool, which do not load under node --test. Each file is anchored on its END so a truncated read
// cannot pass.
//
// Run: node --test app/api/dm/dmRoutes.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../lib/testSource.ts";

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
const ANNOUNCE = read("../mod/announce/route.ts");
const PING = read("./ping/route.ts");
const RESOLVE = read("./resolve/route.ts");

test("/api/mod/announce: mods only, checked FIRST; bounded; one per 30 s; logged only once it went out", () => {
  const body = ANNOUNCE.slice(ANNOUNCE.indexOf("export async function POST"));
  assert.match(body, /^export async function POST\(req: NextRequest\) \{\s*const mod = await requireMod\(\);\s*if \(mod instanceof Response\) return mod;/,
    "requireMod is the first thing the handler does — the command's scope is UX, this is the gate");
  assert.match(body, /text\.length > ANNOUNCE_MAX/);
  assert.match(ANNOUNCE, /const perMod = createCooldown\(30_000\);/);
  const sent = body.indexOf('streamApiFetch("/chat/announce"');
  const logged = body.indexOf('appendModLog({ action: "announce", target: "site", by: mod, reason: text })');
  assert.ok(sent > 0 && logged > sent, "the mod_log row is written after stream-api accepted it");
  assert.match(body, /if \(!res\?\.ok\) return Response\.json\(\{ error: "Couldn't reach the chat server — nothing was sent\." \}, \{ status: 502 \}\);/);
  assert.match(ANNOUNCE, /return Response\.json\(\{ ok: true, id \}\);\s*\}\s*$/, "vacuity anchor");
});

// What a nudge must NOT reveal (no public frame, no per-recipient tag) is pinned in
// app/lib/dm/nudgeBox.test.ts, with the adversarial case.
test("/api/dm/ping POST: signed in, never yourself, rate-limited, only a live site account", () => {
  const post = PING.slice(PING.indexOf("export async function POST"));
  assert.match(post, /if \(!me\) return Response\.json\(\{ error: "Sign in first\." \}, \{ status: 401 \}\);/);
  assert.match(post, /to === me\) return/, "never yourself");
  assert.match(post, /if \(perSender\(me\) \|\| perPair\.hit\(`\$\{me\}>\$\{to\}`\)\) return/);
  assert.match(post, /SELECT 1 FROM site\.users WHERE matrix_id = \$1 AND deleted_at IS NULL/, "only a site account can be nudged");
  assert.match(PING, /return Response\.json\(\{ ok: true \}\);\s*\}\s*$/, "vacuity anchor");
});

test("/api/dm/ping GET: a signed-in page learns its own nudges — and only its own", () => {
  const get = PING.slice(PING.indexOf("export async function GET"), PING.indexOf("export async function POST"));
  assert.match(get, /const me = session\?\.user\?\.id;\s*if \(!me\) return/);
  assert.match(get, /dmNudges\.latest\(me\)/, "the nudges of the session's own id, never a requested one");
  assert.doesNotMatch(get, /searchParams|req\./, "takes no input");
});

test("/api/dm/resolve: signed in; never yourself, a bot or a deleted account; an exact username wins outright", () => {
  assert.match(RESOLVE, /if \(!me\) return Response\.json\(\{ error: "Sign in first\." \}, \{ status: 401 \}\);/);
  assert.match(RESOLVE, /WHERE deleted_at IS NULL AND NOT is_bot AND matrix_id <> \$3/);
  assert.match(RESOLVE, /best <= 1 \? rows\.slice\(0, 1\)/);
  assert.match(RESOLVE, /ESCAPE '\\\\'/, "a typed % or _ is a character, not a wildcard");
  assert.match(RESOLVE, /displayName: r\.display_name,\s*\}\)\),\s*\}\);\s*\}\s*$/, "vacuity anchor");
});
