// Source scan (the route's aliased imports keep it out of node --test): a retry
// re-runs a stored ban / timeout / unban as the CURRENT mod, so it must pass the
// same privilege ceiling as the original action. It did not: any mod could
// re-run a row by id against the owner — including through the broadcaster
// token fallback, which can ban a platform moderator. The ceiling itself
// (native canonicals, every linked account, 503 on a failed lookup) is pinned
// behaviourally by modCeiling.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../lib/testSource.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("a retry passes the moderation ceiling for the row's target before any platform call", () => {
  const read = src.indexOf("FROM site.platform_mod_actions WHERE id = $1");
  const noTarget = src.indexOf("if (!row.target_id)");
  const check = src.indexOf("await assertCanModerate(mod, row.target_id)");
  assert.ok(read > 0, "the row is read");
  assert.ok(noTarget > read, "a row with no target is refused first");
  assert.ok(check > noTarget, "the ceiling is checked on the stored target");
  assert.match(src.slice(check, check + 120), /if \(denied\) return denied;/, "a refusal (403, or 503 when undecidable) is returned");
  for (const call of ["banOnTwitch(", "banOnKick(", "banOnYouTube(", "unbanOnTwitch(", "unbanOnKick(", "unbanOnYouTube("]) {
    const at = src.indexOf(`await ${call}`);
    assert.ok(at > check, `${call} runs before the ceiling`);
  }
  assert.match(src, /import \{ requireMod, assertCanModerate \} from "@\/app\/lib\/admin";/);
});

test("vacuity anchor: the scan reached the handler's final refusal", () => {
  assert.ok(src.lastIndexOf('return Response.json({ error: "unsupported_retry" }, { status: 422 });') > src.indexOf("unbanOnYouTube("));
  assert.match(src, /\}\s*$/);
});
