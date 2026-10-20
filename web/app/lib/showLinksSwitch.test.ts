// The person's own "show my linked platforms on my profile" switch (site.users.show_links, v153;
// owner decision 2026-10-17), and the linking UI that says what is shown and when. Source scans:
// the route's aliased imports keep it out of node --test; the decision it feeds is pinned
// behaviourally in profileView.test.ts.
// Run: node --test app/lib/showLinksSwitch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const route = stripComments(readFileSync(join(process.cwd(), "app", "api", "account-links", "route.ts"), "utf8"));
const panel = readFileSync(join(process.cwd(), "app", "components", "AccountLinkPanel.tsx"), "utf8");

test("PATCH saves only the caller's own switch, as a boolean, at most once per few seconds", () => {
  const at = route.indexOf("export async function PATCH(");
  assert.ok(at > 0, "the switch route is gone");
  const body = route.slice(at);
  assert.match(body, /const matrixId = await requireUser\(\);/);
  assert.match(body, /if \(typeof body\?\.showLinks !== "boolean"\) return Response\.json\(/);
  assert.match(body, /if \(showLinksCooldown\.hit\(matrixId\)\) \{/);
  assert.match(body, /UPDATE site\.users SET show_links = \$2 WHERE matrix_id = \$1`, \[matrixId, body\.showLinks\]/);
});

test("saving the switch tells stream-api, so the credit line follows at once", () => {
  const body = route.slice(route.indexOf("export async function PATCH("));
  assert.ok(body.indexOf('"/sponsors/links-changed"') > body.indexOf("UPDATE site.users SET show_links"),
    "stream-api must be told AFTER the value is saved, or its rebuild reads the old one");
  assert.match(route, /const showLinksCooldown = createCooldown\(3_000\);/);
});

test("GET returns the switch so the panel shows its real state", () => {
  assert.match(route, /SELECT show_links FROM site\.users WHERE matrix_id = \$1/);
  assert.match(route, /return Response\.json\(\{ accounts, configuredPlatforms, pendingPlatforms, showLinks \}\);/);
});

test("the linking UI says linking is private by default, what mods see, when it shows, and how to hide it", () => {
  for (const words of ["{LINKING_IS_PRIVATE}", "Moderators can see which accounts are linked",
    "{POSTING_IS_SEPARATE}", "Show my linked platforms on my profile", "hides it again"]) {
    assert.ok(panel.includes(words), `the panel no longer says: ${words}`);
  }
  assert.match(panel, /await postJson\("\/api\/account-links", \{ showLinks: next \}, "PATCH"\);\s*if \(!res\.ok\) throw new Error\("save failed"\);\s*setShowLinks\(next\);/,
    "the switch must show the saved state, never flip before the save");
  assert.match(route, /\}\s*$/, "END anchor");
});
