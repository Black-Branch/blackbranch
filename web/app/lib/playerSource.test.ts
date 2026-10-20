// Player source-row model. Run: node --test app/lib/playerSource.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableSources, stateForSource, sourceFromState, fallbackSource, edgeTab, youtubeLiveSrc, SOURCE_META,
  type PlayerState,
} from "./playerSource.ts";

// A registered fallback, as this install's plugin registers the radio (app/(owner)/player.ts).
const FB = ["radio"] as const;

const st = (o: Partial<PlayerState> = {}): PlayerState =>
  ({ tab: "live", active: "sp", spThinPlayer: true, ...o });

test("the live and offline source sets, in order", () => {
  assert.deepEqual(
    availableSources({ live: true, hasCommunity: true, fallbacks: FB }),
    ["native", "streamplace", "youtube", "twitch", "community", "radio"]
  );
  assert.deepEqual(availableSources({ live: false, hasCommunity: true, fallbacks: FB }), ["community", "radio"]);
});

test("community is only offered when one is configured", () => {
  // An icon that plays nothing is worse than no icon.
  assert.deepEqual(availableSources({ live: false, hasCommunity: false, fallbacks: FB }), ["radio"]);
  assert.ok(!availableSources({ live: true, hasCommunity: false, fallbacks: FB }).includes("community"));
});

test("every source round-trips through the legacy state triple", () => {
  for (const s of availableSources({ live: true, hasCommunity: true, fallbacks: FB })) {
    assert.equal(sourceFromState(stateForSource(s, st())), s, `${s} did not round-trip`);
  }
});

test("native and streamplace differ only by the in-house player flag", () => {
  // Both are active:"sp"; spThinPlayer is what picks the WHEP player vs the embed.
  const a = stateForSource("native", st());
  const b = stateForSource("streamplace", st());
  assert.equal(a.active, "sp");
  assert.equal(b.active, "sp");
  assert.equal(a.spThinPlayer, true);
  assert.equal(b.spThinPlayer, false);
});

test("no source reads as selected while replaying a VOD", () => {
  // Highlighting a stale icon would claim something is playing that isn't.
  // (The in-player "vods" browse tab was deleted in cycle 6b — browsing moved
  // to the dock / chat tab bar, so "replay" is the only non-source tab left.)
  assert.equal(sourceFromState(st({ tab: "replay" })), null);
});

test("switching source preserves unrelated state", () => {
  const before = st({ tab: "radio", active: "tw", spThinPlayer: false });
  const after = stateForSource("radio", before);
  assert.equal(after.active, "tw", "picking radio must not clobber the remembered platform");
  assert.equal(after.spThinPlayer, false);
});

test("the live fallback lands where the viewer last watched live and writes nothing back", () => {
  for (const prev of [
    st({ tab: "community", active: "sp", spThinPlayer: true }),
    st({ tab: "community", active: "yt", spThinPlayer: false }),
    st({ tab: "community", active: "tw", spThinPlayer: true }),
  ]) {
    const next = fallbackSource({ live: true, hasCommunity: false, fallbacks: FB }, prev);
    const after = stateForSource(next, prev);
    assert.equal(after.tab, "live");
    assert.equal(after.active, prev.active, `${next} rewrote the remembered platform`);
    assert.equal(after.spThinPlayer, prev.spThinPlayer, `${next} flipped the in-house opt-in`);
  }
});

test("a viewer who never opted in falls back to the embed, never the in-house player", () => {
  assert.equal(fallbackSource({ live: true, hasCommunity: false, fallbacks: FB }, st({ active: "sp", spThinPlayer: false })), "streamplace");
});

test("offline, the fallback prefers a featured community over dead air", () => {
  assert.equal(fallbackSource({ live: false, hasCommunity: true, fallbacks: FB }, st()), "community");
  assert.equal(fallbackSource({ live: false, hasCommunity: false, fallbacks: FB }, st()), "radio");
});

test("the fallback is always itself an available source", () => {
  for (const live of [true, false]) {
    for (const hasCommunity of [true, false]) {
      for (const prev of [st({ active: "sp", spThinPlayer: false }), st({ active: "yt", spThinPlayer: true })]) {
        const opts = { live, hasCommunity, fallbacks: FB };
        assert.ok(
          availableSources(opts).includes(fallbackSource(opts, prev)),
          `fallback for ${JSON.stringify(opts)} from ${prev.active}/${prev.spThinPlayer} is not in the row`
        );
      }
    }
  }
});

test("every source has icon metadata", () => {
  for (const s of availableSources({ live: true, hasCommunity: true, fallbacks: [] }) as (keyof typeof SOURCE_META)[]) {
    assert.ok(SOURCE_META[s]?.label, `${s} has no label`);
  }
  // A registered fallback brings its own label and icon (app/lib/plugins/types.ts PlayerFallback).
  assert.equal("radio" in SOURCE_META, false);
  assert.equal(SOURCE_META.community.platform, "community");
});

// ─── the live/community edge ─────────────────────────────────────────────────

test("Casey going live takes over — even with a playlist keeping 'something is on' true", () => {
  assert.equal(edgeTab({ live: false, primaryOn: false }, { live: true, primaryOn: true }, "radio"), "live");
  assert.equal(edgeTab({ live: false, primaryOn: true }, { live: true, primaryOn: true }, "radio"), "live",
    "a configured playlist must not hide the going-live edge");
});

test("something else coming on with Casey offline lands on the community player", () => {
  assert.equal(edgeTab({ live: false, primaryOn: false }, { live: false, primaryOn: true }, "radio"), "community",
    "a featured stream or the playlist came up — 'live' would be an empty box");
});

test("everything going off falls back to radio", () => {
  assert.equal(edgeTab({ live: true, primaryOn: true }, { live: false, primaryOn: false }, "radio"), "radio");
  assert.equal(edgeTab({ live: false, primaryOn: true }, { live: false, primaryOn: false }, "radio"), "radio");
});

test("no edge, no move — a viewer who chose Radio mid-stream stays there", () => {
  assert.equal(edgeTab({ live: true, primaryOn: true }, { live: true, primaryOn: true }, "radio"), null);
  assert.equal(edgeTab({ live: true, primaryOn: true }, { live: false, primaryOn: true }, "radio"), null,
    "Casey ending while a community stream is on is not an edge; the source fallback handles it");
  assert.equal(edgeTab({ live: false, primaryOn: false }, { live: false, primaryOn: false }, "radio"), null);
  assert.equal(edgeTab({ live: false, primaryOn: true }, { live: false, primaryOn: true }, "radio"), null);
});

// ── youtubeLiveSrc: the id wins, the channel form is the fallback ──

test("a confirmed broadcast id embeds by id — no channel resolution left to YouTube", () => {
  assert.equal(
    youtubeLiveSrc({ videoId: "dQw4w9WgXcQ", channelId: "UCabc", autoMute: false }),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1",
  );
});

test("no id yet → the channel form, with the same flags", () => {
  assert.equal(
    youtubeLiveSrc({ videoId: null, channelId: "UCabc", autoMute: true }),
    "https://www.youtube.com/embed/live_stream?channel=UCabc&autoplay=1&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1&mute=1",
  );
});

test("neither an id nor a channel → no YouTube source at all", () => {
  assert.equal(youtubeLiveSrc({ videoId: null, channelId: "", autoMute: false }), null);
  assert.equal(youtubeLiveSrc({ videoId: "", channelId: "", autoMute: false }), null);
});

test("the id form carries the mute flag exactly like the channel form", () => {
  assert.match(youtubeLiveSrc({ videoId: "dQw4w9WgXcQ", channelId: "", autoMute: true })!, /&mute=1$/);
});

// ── the live source is ONE stored value; the legacy pair is read-only fallback ──

import {
  LIVE_SOURCE_KEY, parseLiveSource, liveSourceFromLegacy, legacyForLiveSource, liveSourceFromState,
  type LiveSource,
} from "./playerSource.ts";

test("parseLiveSource accepts exactly the four live sources and nothing else", () => {
  for (const v of ["native", "streamplace", "youtube", "twitch"]) assert.equal(parseLiveSource(v), v);
  for (const v of [null, "", "sp", "yt", "community", "radio", "1", "NATIVE"]) assert.equal(parseLiveSource(v), null, String(v));
  assert.equal(LIVE_SOURCE_KEY, "player_live_source");
});

test("the legacy pair maps without resetting anyone: opt-in survives, platforms survive, junk → streamplace", () => {
  assert.equal(liveSourceFromLegacy("sp", "1"), "native", "the in-house opt-in must not be lost in the move");
  assert.equal(liveSourceFromLegacy("sp", "0"), "streamplace");
  assert.equal(liveSourceFromLegacy(null, null), "streamplace", "a brand-new visitor");
  assert.equal(liveSourceFromLegacy("yt", "1"), "youtube", "the opt-in only ever applied on sp");
  assert.equal(liveSourceFromLegacy("tw", null), "twitch");
  assert.equal(liveSourceFromLegacy("garbage", "1"), "native", "unknown platform meant sp, exactly as before");
});

test("legacyForLiveSource and liveSourceFromState are inverses over all four values", () => {
  const all: LiveSource[] = ["native", "streamplace", "youtube", "twitch"];
  for (const src of all) assert.equal(liveSourceFromState(legacyForLiveSource(src)), src);
  assert.deepEqual(legacyForLiveSource("native"), { active: "sp", spThinPlayer: true });
  assert.deepEqual(legacyForLiveSource("youtube"), { active: "yt", spThinPlayer: false });
});

test("a pick through stateForSource lands on the value the store would hold", () => {
  const prev = st({ active: "yt", spThinPlayer: false });
  assert.equal(liveSourceFromState(stateForSource("native", prev)), "native");
  assert.equal(liveSourceFromState(stateForSource("twitch", prev)), "twitch");
  // Community / radio picks leave the live choice alone — nothing to write.
  assert.equal(liveSourceFromState(stateForSource("radio", prev)), "youtube");
  assert.equal(liveSourceFromState(stateForSource("community", prev)), "youtube");
});

test("public build: no registered fallback — the row, the fallback and the off edge all do without one", () => {
  const none: readonly string[] = [];
  assert.deepEqual(availableSources({ live: false, hasCommunity: false, fallbacks: none }), []);
  assert.deepEqual(availableSources({ live: false, hasCommunity: true, fallbacks: none }), ["community"]);
  assert.deepEqual(availableSources({ live: true, hasCommunity: false, fallbacks: none }), ["native", "streamplace", "youtube", "twitch"]);
  // Offline with nothing: the viewer's own live source (the Live tab shows the offline card).
  assert.equal(fallbackSource({ live: false, hasCommunity: false, fallbacks: none }, st({ active: "yt", spThinPlayer: false })), "youtube");
  assert.equal(edgeTab({ live: true, primaryOn: true }, { live: false, primaryOn: false }, "live"), "live");
  // A fallback's id is its tab, both ways.
  assert.equal(stateForSource("radio", st()).tab, "radio");
  assert.equal(sourceFromState(st({ tab: "radio" })), "radio");
});
