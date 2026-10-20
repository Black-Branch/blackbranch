// Matrix → site reconcile must not pull the username colour back from Matrix: site.users stays the
// colour the UI uses. The colour does reach Matrix, so a Matrix copy left stale by one failed
// fire-and-forget write (me/color) would otherwise overwrite the person's newer choice — or bring
// back a colour they cleared — on the next reconcile.
// Run: node --test app/api/me/profile/reconcile/route.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("the reconcile UPDATE never sets username_color; the site's colour is still returned", () => {
  // END anchor: the route's last line was read, so the negative assertion is not vacuous.
  assert.match(src, /return payload\(true, updated\[0\] \?\? cur\);\s*}\s*$/);
  const update = src.slice(src.indexOf("UPDATE site.users"), src.indexOf("RETURNING"));
  assert.ok(update.length > 100, "the UPDATE statement was found");
  assert.doesNotMatch(update, /username_color/);
  assert.match(src, /RETURNING display_name, avatar_url, username_color/);
});
