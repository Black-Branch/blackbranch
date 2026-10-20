// The public avatar cache — the one place that serves an avatar to somebody with
// no Matrix session at all.
//
// Two things carry real risk here and both are pinned below: the ALLOWLIST (this
// route answers to the unauthenticated public, so anything it will fetch is
// world-readable and enumerable), and the FAILURE SHAPE (a missing or expired
// token must degrade to today's letter fallback, never to a broken image or a
// poisoned hour-long cache entry).
//
// Run: node --test app/lib/publicAvatar.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  publicAvatar, isPublicAvatarId, publicAvatarIds, publicAvatarIdForRole, __resetPublicAvatarCache,
} from "./publicAvatar.ts";

// The two accounts are CONFIGURED (instance keys). The streamer under the
// ALIAS name, to pin that the alias still works.
process.env.BROADCASTER_MATRIX_ID = "@casey:site.test";
process.env.BOT_MATRIX_ID = "@helperbot:site.test";

const here = dirname(fileURLToPath(import.meta.url));

const PROFILE = /\/_matrix\/client\/v3\/profile\//;
const MEDIA = /\/_matrix\/client\/v1\/media\/thumbnail\//;

/** Swap global fetch for a scripted one, counting calls per kind. */
function stubFetch(opts: { profile?: unknown; media?: "ok" | "fail" } = {}) {
  const calls = { profile: 0, media: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (PROFILE.test(url)) {
      calls.profile++;
      if (opts.profile === undefined) return new Response("no", { status: 404 });
      return new Response(JSON.stringify(opts.profile), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (MEDIA.test(url)) {
      calls.media++;
      if (opts.media !== "ok") return new Response("nope", { status: 401 });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200, headers: { "content-type": "image/png" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const GOOD = { avatar_url: "mxc://site.test/VaxeOwOsMtMJtqYqHiykOtvs" };
const GADGET = "@helperbot:site.test";

beforeEach(() => {
  __resetPublicAvatarCache();
  process.env.STREAMER_MEDIA_TOKEN = "mct_test";
});

test("the allowlist is exactly the broadcaster and Gadget", () => {
  assert.equal(publicAvatarIds().length, 2, "the allowlist grew — this route answers to the public");
  assert.equal(publicAvatarIdForRole("bot"), "@helperbot:site.test");
  assert.equal(publicAvatarIdForRole("streamer"), "@casey:site.test");
  assert.equal(publicAvatarIdForRole("admin"), null, "only the two roles");
  assert.ok(isPublicAvatarId(GADGET));
  assert.ok(isPublicAvatarId("@casey:site.test"));
});

test("a non-allowlisted id is refused without any upstream call", async () => {
  // Not merely "returns null": it must not become an oracle for whether an
  // account exists, and it must not let a stranger drive our homeserver traffic.
  const f = stubFetch({ profile: GOOD, media: "ok" });
  try {
    assert.equal(await publicAvatar("@rosalind:site.test"), null);
    assert.equal(await publicAvatar("@someone:matrix.org"), null);
    assert.equal(f.calls.profile + f.calls.media, 0, "a refused id still hit the homeserver");
  } finally { f.restore(); }
});

test("the allowlist is case- and whitespace-insensitive", async () => {
  assert.ok(isPublicAvatarId("  @Helperbot:SITE.TEST  "));
});

test("a hit is cached — a second read does not re-fetch", async () => {
  const f = stubFetch({ profile: GOOD, media: "ok" });
  try {
    const a = await publicAvatar(GADGET);
    assert.ok(a && a.body.byteLength === 4, "no bytes returned");
    assert.equal(a.type, "image/png");
    const before = f.calls.media;
    for (let i = 0; i < 5; i++) await publicAvatar(GADGET);
    assert.equal(f.calls.media, before, "a cached avatar was re-fetched");
  } finally { f.restore(); }
});

test("concurrent first paints collapse to ONE upstream fetch", async () => {
  const f = stubFetch({ profile: GOOD, media: "ok" });
  try {
    await Promise.all(Array.from({ length: 8 }, () => publicAvatar(GADGET)));
    assert.equal(f.calls.media, 1, "a cold cache fanned out one upstream request per caller");
  } finally { f.restore(); }
});

test("a FAILURE is never cached — an expired token must not pin the fallback for an hour", async () => {
  const bad = stubFetch({ profile: GOOD, media: "fail" });
  try {
    assert.equal(await publicAvatar(GADGET), null);
    assert.equal(await publicAvatar(GADGET), null);
    assert.equal(bad.calls.media, 2, "the miss was cached — recovery would wait a full TTL");
  } finally { bad.restore(); }

  // …and the moment upstream recovers, the very next read succeeds.
  const good = stubFetch({ profile: GOOD, media: "ok" });
  try {
    assert.ok(await publicAvatar(GADGET), "did not recover after upstream came back");
  } finally { good.restore(); }
});

test("no token configured → null, and no request at all", async () => {
  delete process.env.STREAMER_MEDIA_TOKEN;
  const f = stubFetch({ profile: GOOD, media: "ok" });
  try {
    assert.equal(await publicAvatar(GADGET), null);
    assert.equal(f.calls.profile, 0, "it went looking before checking it had a credential");
  } finally { f.restore(); }
});

test("a malformed mxc is refused rather than pasted into a URL", async () => {
  for (const avatar_url of [
    "https://evil.test/x.png",
    "mxc://site.test/../../secret",
    "mxc://lyb eck.io/abc",
    "",
  ]) {
    __resetPublicAvatarCache();
    const f = stubFetch({ profile: { avatar_url }, media: "ok" });
    try {
      assert.equal(await publicAvatar(GADGET), null, `accepted ${avatar_url}`);
      assert.equal(f.calls.media, 0, `fetched media for ${avatar_url}`);
    } finally { f.restore(); }
  }
});

test("the route 404s instead of inventing a placeholder, and caches PUBLIC", () => {
  // The sibling /api/avatar/user route answers 200 with a letter avatar. This one
  // must not: its callers already have fallbacks, and a route that always answers
  // 200 cannot be told apart from one that is working.
  const src = stripComments(
    readFileSync(join(here, "../api/avatar/public/[id]/route.ts"), "utf8")
  );
  assert.match(src, /status: 404/, "the public avatar route no longer 404s on a miss");
  assert.doesNotMatch(src, /letterAvatar/, "it grew a placeholder — a miss must stay visible");
  assert.match(src, /"public, max-age=3600"/, "the response is not publicly cacheable");
  assert.match(src, /isPublicAvatarId/, "the allowlist is not enforced at the route boundary");
});

test("the broadcaster route is a WRAPPER, not a second copy of the fetch logic", () => {
  // It carried its own profile lookup, mxc parse, cache and token handling. That
  // duplication is what made "do the same for Gadget" look like a copy job.
  const src = stripComments(
    readFileSync(join(here, "../api/streamer/avatar/route.ts"), "utf8")
  );
  assert.match(src, /publicAvatar\(/, "the streamer route no longer delegates");
  assert.doesNotMatch(src, /_matrix\/client\/v3\/profile/, "it re-implements the profile lookup");
  assert.doesNotMatch(src, /_matrix\/client\/v1\/media/, "it re-implements the media fetch");
  assert.doesNotMatch(src, /let cache/, "it kept its own single-slot cache");
});

test("both Gadget surfaces use the PUBLIC route, not the per-viewer one", () => {
  for (const [rel, what] of [
    ["../components/SendToButton.tsx", "the Gadget indicator button"],
    ["../features/chat/support/SupportPanel.tsx", "the support panel"],
  ] as const) {
    const src = stripComments(readFileSync(join(here, rel), "utf8"));
    assert.match(
      src, /\/api\/avatar\/public\//,
      `${what} does not use the public avatar route — signed-out viewers see a letter circle`
    );
    assert.doesNotMatch(
      src, /\/api\/avatar\/user\//,
      `${what} is back on the per-viewer route, which needs a Matrix session`
    );
  }
});
