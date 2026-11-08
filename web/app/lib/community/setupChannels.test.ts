// The channels setup lists (spec 2026-10-23 §4.6: "Setup lists default channels as editable names").
// The community starts with #general and #forum (install/matrix/bootstrap.mjs makes them); the rest
// of the list is stored as community.setupChannels and becomes rows when the reconciler first takes
// the community's home into the Community page (adoptServer.ts) — no row can exist before that,
// because every channel row needs the home's row and the home row arrives with that import.
// Run: env -u DATABASE_URL node --test app/lib/community/setupChannels.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTING_CHANNELS, DEFAULT_SETUP_CHANNELS, checkSetupChannels, encodeSetupChannels, decodeSetupChannels, setupChannelRows } from "./setupChannels.ts";
import { INSTANCE_KEYS, parseInstanceValue } from "../instanceSchema.generated.mjs";

test("the default list: general, announcements, forum, off-topic — two made at setup, two made next", () => {
  assert.deepEqual([...STARTING_CHANNELS, ...DEFAULT_SETUP_CHANNELS].map((c) => c.name).sort(), ["announcements", "forum", "general", "off-topic"]);
  assert.deepEqual(STARTING_CHANNELS, [{ kind: "text", name: "general" }, { kind: "forum", name: "forum" }]);
  assert.deepEqual(DEFAULT_SETUP_CHANNELS, [{ kind: "announcement", name: "announcements" }, { kind: "text", name: "off-topic" }]);
});

test("stored as the schema's list: '<kind>:<name>', taken by the settings layer as it is, and read back", () => {
  const entry = INSTANCE_KEYS.find((k) => k.key === "community.setupChannels");
  assert.ok(entry, "vacuity: the key is in the schema");
  assert.equal(entry.kind, "list"); assert.deepEqual(entry.default, []); assert.equal(entry.tier, "instance");
  const stored = encodeSetupChannels([...DEFAULT_SETUP_CHANNELS, { kind: "text", name: "clips: memes and more" }]);
  assert.deepEqual(stored, ["announcement:announcements", "text:off-topic", "text:clips: memes and more"]);
  const parsed = parseInstanceValue(entry, stored);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.value, stored, "the settings layer keeps every item as it is");
  assert.deepEqual(decodeSetupChannels(parsed.value), [...DEFAULT_SETUP_CHANNELS, { kind: "text", name: "clips: memes and more" }]);
  // The env form (COMMUNITY_SETUP_CHANNELS) is the same list, split on commas — why a name holds none.
  const fromEnv = parseInstanceValue(entry, "announcement:announcements,text:off-topic");
  assert.ok(fromEnv.ok); assert.deepEqual(decodeSetupChannels(fromEnv.value), DEFAULT_SETUP_CHANNELS);
  // A stored item that is not one is dropped, never guessed into a channel.
  assert.deepEqual(decodeSetupChannels(["voice:lounge", "text:", "nothing", 7, "forum:ideas"]), [{ kind: "forum", name: "ideas" }]);
  assert.deepEqual(decodeSetupChannels(null), []);
  // Read back through the same check as the page's list: an env-sourced list cannot add a second
  // #general or #forum, a name twice, or a leading #; each bad item goes, the rest stay.
  assert.deepEqual(decodeSetupChannels(["text:general", "forum:Forum", "text:clips", "announcement:CLIPS", "text:#news", "text:news"]),
    [{ kind: "text", name: "clips" }, { kind: "text", name: "news" }]);
});

test("checked like the Community page checks a name: trimmed, no leading #, 1 to 100 characters, unique, not one made at setup", () => {
  assert.deepEqual(checkSetupChannels([{ kind: "text", name: "  #clips " }]), { ok: true, channels: [{ kind: "text", name: "clips" }] });
  assert.deepEqual(checkSetupChannels([]), { ok: true, channels: [] }, "none beyond the two is fine");
  for (const [bad, says] of [
    ["x", /a list of channels/],
    [[{ kind: "voice", name: "a" }], /chat, announcements or a forum/],
    [[{ kind: "text", name: "" }], /1 to 100 characters/],
    [[{ kind: "text", name: "#" }], /1 to 100 characters/],
    [[{ kind: "text", name: "a".repeat(101) }], /1 to 100 characters/],
    [[{ kind: "text", name: "a\u0007b" }], /control characters/],
    [[{ kind: "text", name: "clips, memes" }], /cannot hold a comma/],
    [[{ kind: "text", name: "News" }, { kind: "announcement", name: "news" }], /#news is listed twice/],
    [[{ kind: "text", name: "General" }], /#general is made with the community/],
    [[{ kind: "forum", name: "forum" }], /#forum is made with the community/],
    [Array.from({ length: 21 }, (_, i) => ({ kind: "text", name: `c${i}` })), /at most 20/],
  ] as const) {
    const r = checkSetupChannels(bad);
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
    assert.match((r as { error: string }).error, says);
  }
});

test("the rows they become: everyone sees each and it is listed; announcements post Mods and above; chat keeps 30 days, the rest no limit", () => {
  const rows = setupChannelRows([...DEFAULT_SETUP_CHANNELS, { kind: "forum", name: "ideas" }], 365);
  assert.deepEqual(rows, [
    { kind: "announcement", name: "announcements", orderKey: "a0", see: "everyone", post: "mods", retentionDays: null, published: true },
    { kind: "text", name: "off-topic", orderKey: "a1", see: "everyone", post: "everyone", retentionDays: 30, published: true },
    { kind: "forum", name: "ideas", orderKey: "a2", see: "everyone", post: "everyone", retentionDays: null, published: true },
  ]);
  // A cap under 30 days keeps chat within it; no cap (0) keeps the 30 days.
  assert.equal(setupChannelRows([{ kind: "text", name: "x" }], 7)[0]!.retentionDays, 7);
  assert.equal(setupChannelRows([{ kind: "text", name: "x" }], 0)[0]!.retentionDays, 30);
});

test("retry: checking a checked list again gives the same list (a page sent twice stores one list)", () => {
  const once = checkSetupChannels([{ kind: "text", name: "#clips" }, ...DEFAULT_SETUP_CHANNELS]);
  assert.ok(once.ok);
  assert.deepEqual(checkSetupChannels(once.channels), once);
  assert.deepEqual(decodeSetupChannels(encodeSetupChannels(once.channels)), once.channels);
});
