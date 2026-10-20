// Run: node --test app/lib/emotePickerSections.test.ts
//
// Pins the picker's placement rules: the personal set is never sorted to the
// top, and "channel emotes" means emotes owned by ANY specific Twitch channel —
// grouped per channel, each under its channel-name divider — with Twitch
// GLOBALS as the non-channel group at the very bottom. The Twitch tab carries
// all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPickerData } from "./emotePickerSections.ts";
import type { EmoteMap } from "./emoteMap.ts";

const G: EmoteMap = {
  chan7tv: { url: "https://cdn.7tv.app/emote/a/2x.webp", zeroWidth: false },
  chanTw: { url: "https://static-cdn.jtvnw.net/emoticons/v2/9/static/dark/3.0", zeroWidth: false, ar: 1 },
};
const P: EmoteMap = {
  zebraSub: { url: "https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/3.0", zeroWidth: false, ar: 1, ch: "zebra" },
  aardSub: { url: "https://static-cdn.jtvnw.net/emoticons/v2/2/static/dark/3.0", zeroWidth: false, ar: 1, ch: "aardvark" },
  Kappa: { url: "https://static-cdn.jtvnw.net/emoticons/v2/3/static/dark/3.0", zeroWidth: false, ar: 1, ch: null },
  chan7tv: { url: "https://static-cdn.jtvnw.net/emoticons/v2/4/static/dark/3.0", zeroWidth: false, ar: 1, ch: "aardvark" }, // collides → excluded
};

type Args = Parameters<typeof buildPickerData>[0];
const args = (over: Partial<Args> = {}): Args => ({
  emotes: G, personal: P, recent: [], tab: "all", search: "", channelLabel: "hostchannel", ...over,
});

test("All tab: site channel on top, catalog, then per-channel groups, Twitch globals LAST", () => {
  const { sections } = buildPickerData(args());
  assert.deepEqual(sections.map((s) => s.label),
    ["hostchannel", null, "aardvark", "zebra", "Twitch globals"]);
  assert.deepEqual(sections[0]!.items.map(([n]) => n), ["chanTw"]);
  assert.deepEqual(sections[1]!.items.map(([n]) => n), ["chan7tv"]);
  assert.deepEqual(sections[2]!.items.map(([n]) => n), ["aardSub"]); // collision excluded
  assert.deepEqual(sections[4]!.items.map(([n]) => n), ["Kappa"]);
});

test("a personal emote owned by the SITE channel merges into the top channel section", () => {
  const p: EmoteMap = {
    mySiteSub: { url: "u1", zeroWidth: false, ch: "hostchannel" },
  };
  const { sections } = buildPickerData(args({ personal: p }));
  assert.deepEqual(sections.map((s) => s.label), ["hostchannel", null]);
  assert.deepEqual(sections[0]!.items.map(([n]) => n), ["chanTw", "mySiteSub"]);
});

test("Frequent stays first; sections emptied by recents are omitted", () => {
  const { sections } = buildPickerData(args({ recent: ["chanTw", "aardSub"] }));
  assert.deepEqual(sections.map((s) => s.label),
    ["Frequent", null, "zebra", "Twitch globals"]);
});

test('channelLabel null falls back to "Channel emotes" — never a hardcoded owner name', () => {
  const { sections } = buildPickerData(args({ channelLabel: null }));
  assert.equal(sections[0]!.label, "Channel emotes");
});

test("Twitch tab carries ALL Twitch emotes: site channel, per-channel groups, globals last", () => {
  const { sections } = buildPickerData(args({ tab: "twitch" }));
  assert.deepEqual(sections.map((s) => s.label),
    ["hostchannel", "aardvark", "zebra", "Twitch globals"]);
  assert.deepEqual(sections[0]!.items.map(([n]) => n), ["chanTw"]);
  assert.deepEqual(sections[3]!.items.map(([n]) => n), ["Kappa"]);
});

test("Twitch tab search filters every group and omits emptied ones", () => {
  const { sections } = buildPickerData(args({ tab: "twitch", search: "kappa" }));
  assert.deepEqual(sections.map((s) => s.label), ["Twitch globals"]);
  assert.deepEqual(sections[0]!.items.map(([n]) => n), ["Kappa"]);
});

test("unresolved owners group as 'Other channels' between named channels and globals", () => {
  const p: EmoteMap = {
    ghost: { url: "u", zeroWidth: false, ch: "" },
    Kappa: { url: "u2", zeroWidth: false, ch: null },
  };
  const { sections } = buildPickerData(args({ personal: p, tab: "twitch" }));
  assert.deepEqual(sections.map((s) => s.label),
    ["hostchannel", "Other channels", "Twitch globals"]);
});

test("twitch chip exists when the catalog channel set is empty but a personal set exists", () => {
  const noChan: EmoteMap = { chan7tv: G.chan7tv! };
  assert.ok(buildPickerData(args({ emotes: noChan })).tabs.includes("twitch"));
  assert.ok(!buildPickerData(args({ emotes: noChan, personal: {} })).tabs.includes("twitch"));
});

test('"mine" tab exists only when the personal set has non-colliding items; it renders the same grouped view', () => {
  assert.ok(buildPickerData(args()).tabs.includes("mine"));
  assert.ok(!buildPickerData(args({ personal: {} })).tabs.includes("mine"));
  const { sections } = buildPickerData(args({ tab: "mine" }));
  assert.deepEqual(sections.map((s) => s.label), ["aardvark", "zebra", "Twitch globals"]);
});

test("searching All stays flat: catalog results, then personal matches under 'Your emotes'", () => {
  const { sections } = buildPickerData(args({ search: "sub" }));
  assert.deepEqual(sections.map((s) => s.label), ["Your emotes"]);
  assert.deepEqual(sections[0]!.items.map(([n]) => n), ["aardSub", "zebraSub"]);
});

test("no personal set: All is channel + rest only, twitch tab is the channel section alone", () => {
  const all = buildPickerData(args({ personal: {} }));
  assert.deepEqual(all.sections.map((s) => s.label), ["hostchannel", null]);
  const tw = buildPickerData(args({ personal: {}, tab: "twitch" }));
  assert.deepEqual(tw.sections.map((s) => s.label), ["hostchannel"]);
});
