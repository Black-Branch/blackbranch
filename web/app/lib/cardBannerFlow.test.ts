// Public-card banner data flow (feedback round 2, issue 1).
//
// The bug: both combined-history routes emitted `NULL AS canonical_id` for
// native rows, so every native message restored from scroll-back — which is
// ALL messages on page load — opened a UserCard with no lookup key. The card
// then never queried /api/user/[id] at all: no banner, no stat pills, no
// Gadget read. Live WS frames DO carry canonicalId (stream-api resolves it in
// /chat/native), which masked the gap whenever testing happened against a
// freshly-sent message.
//
// The chain, pinned link by link:
//   history SQL resolves canonical for native rows (via canonicalFromMatrixSql)
//     → UserCard falls back to matrixId when canonicalId is still absent
//     → /api/user/[id] accepts the matrix-id shape and returns the banner even
//       when the stream lookup found nothing.
// The route SQL can't run against Postgres here, so the route files are pinned
// as source (same pragmatic guard style as emoteRes/renderText); the fragment
// builder itself is exercised for real.
//
// Run: node --test app/lib/cardBannerFlow.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalFromMatrixSql } from "./canonicalFromMatrix.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("canonicalFromMatrixSql tries the corpus link first, then platform_links", () => {
  const sql = canonicalFromMatrixSql("m.matrix_id");
  assert.match(sql, /COALESCE/);
  const links = sql.indexOf("stream.links");
  const platformLinks = sql.indexOf("site.platform_links");
  assert.ok(links >= 0 && platformLinks >= 0, "both hops must be present");
  assert.ok(links < platformLinks, "the native stream.links row (written by /chat/native itself) outranks the linking table");
  assert.match(sql, /platform IN \('native'[^)]*\)/);
  // The expression must key BOTH hops — a fragment that only parameterized one
  // would silently resolve someone else's canonical.
  assert.equal(sql.split("m.matrix_id").length - 1, 2);
});

for (const route of ["../api/chat/history/route.ts", "../api/mod/chat-history/route.ts"]) {
  test(`${route} resolves canonical_id for native rows`, () => {
    const src = read(route);
    assert.ok(
      !src.includes("NULL AS canonical_id"),
      "native history rows must carry a canonical id — NULL here strips the UserCard of its profile lookup key (the round-2 banner bug)"
    );
    assert.match(src, /canonicalFromMatrixSql\("m\.matrix_id"\)/);
  });
}

test("/api/user/[id] accepts the matrix-id shape and never gates the banner on the stream lookup", () => {
  const src = read("../api/user/[id]/route.ts");
  assert.match(src, /startsWith\("@"\)/, "matrix-shaped ids must be recognized");
  assert.match(src, /canonicalFromMatrixSql\("\$1"\)/, "matrix→canonical resolution must reuse the shared hop");
  assert.match(
    src,
    /getBannerMxc\(matrixKey\)/,
    "matrix-keyed queries read the banner via the shared getBannerMxc helper"
  );
  assert.match(
    read("./bannerServer.ts"),
    /banner_mxc FROM site\.users WHERE matrix_id = \$1/,
    "getBannerMxc reads the banner directly off site.users"
  );
  assert.ok(
    src.includes("{ found: false, ...(bannerMxc"),
    "a failed/absent stream lookup must still return the banner (pure-site users, stream-api down)"
  );
});

test("UserCard falls back to the matrix id as its lookup key", () => {
  // The fetch lives in the shared prefetch cache (userCardData.ts) — the
  // property this pins is the same, one hop down: the card reads through the
  // cache, and the cache keys its lookup on the shared canonical→matrix
  // fallback helper.
  const card = read("../components/UserCard.tsx");
  assert.match(card, /prefetchUserCard\(msg\)/, "the card must read through the shared cache, not fetch on its own");
  const data = read("./userCardData.ts");
  assert.match(data, /userLookupKey\(msg\)/, "the cache must use the shared fallback helper, not msg.canonicalId alone");
});
