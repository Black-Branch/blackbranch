// Pure halves of the personal-emote fetcher. Run: node --test app/lib/userEmotesCore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPersonalMap, hasEmoteScope, isPersonalCacheStale, EMOTE_SCOPE } from "./userEmotesCore.ts";

test("buildPersonalMap builds the same CDN shape as the manifest (dark/3.0, ar 1)", () => {
  const map = buildPersonalMap([{ id: "42", name: "myEmote", format: ["static"] }], {});
  assert.deepEqual(map.myEmote, {
    url: "https://static-cdn.jtvnw.net/emoticons/v2/42/static/dark/3.0",
    zeroWidth: false,
    ar: 1,
    ch: null,
  });
});

test("animated format wins the URL segment", () => {
  const map = buildPersonalMap([{ id: "7", name: "dance", format: ["static", "animated"] }], {});
  assert.match(map.dance!.url, /\/animated\//);
});

test("entries missing id or name are skipped, later duplicate name wins", () => {
  const map = buildPersonalMap([
    { id: "", name: "x" },
    { id: "1", name: "" },
    { id: "2", name: "dup" },
    { id: "3", name: "dup" },
  ] as never, {});
  assert.deepEqual(Object.keys(map), ["dup"]);
  assert.match(map.dup!.url, /\/3\//);
});

test("channel attribution: owner resolves to its login, owner 0/absent is a global (ch null), unresolved owner is ch ''", () => {
  const map = buildPersonalMap(
    [
      { id: "1", name: "subEmote", owner_id: "123" },
      { id: "2", name: "Kappa", owner_id: "0" },
      { id: "3", name: "LUL" },
      { id: "4", name: "ghostEmote", owner_id: "999" },
    ],
    { "123": "somechannel" }
  );
  assert.equal(map.subEmote!.ch, "somechannel");
  assert.equal(map.Kappa!.ch, null);
  assert.equal(map.LUL!.ch, null);
  assert.equal(map.ghostEmote!.ch, "");
});

test("isPersonalCacheStale: v1 entries (no ch key) are stale, v2 and empty maps are not", () => {
  assert.equal(isPersonalCacheStale({ a: { url: "u", zeroWidth: false } }), true);
  assert.equal(isPersonalCacheStale({ a: { url: "u", zeroWidth: false, ch: null } }), false);
  assert.equal(isPersonalCacheStale({ a: { url: "u", zeroWidth: false, ch: "x" } }), false);
  assert.equal(isPersonalCacheStale({}), false);
});

test("hasEmoteScope matches the whole token, not substrings", () => {
  assert.equal(hasEmoteScope(`chat:read ${EMOTE_SCOPE} user:write:chat`), true);
  assert.equal(hasEmoteScope("user:read:emotes:extra"), false);
  assert.equal(hasEmoteScope(""), false);
  assert.equal(hasEmoteScope(null), false);
  assert.equal(hasEmoteScope(undefined), false);
});
