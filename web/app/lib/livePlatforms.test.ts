// The Live row follows each platform's live state (per-platform liveness, Task 7): a source whose
// platform is offline or scheduled is not offered, the card says where the stream is or that it
// ended, and the page reads the per-platform snapshot stream-api publishes (/stream/current
// `liveness` for the first paint, the `platformStates` frame and the 30 s status poll after it).
// Run: node --test app/lib/livePlatforms.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stripComments } from "./testSource.ts";
import { SOURCE_PLATFORM, liveSourcesLive, liveCardReason, newest } from "./livePlatforms.ts";
import { liveSourceOn, liveSourcesOn } from "./playerSource.ts";
import type { PublicSnapshot } from "./platformLiveness.generated.mjs";
import { livenessOf } from "./streamLiveness.ts";

const require = createRequire(import.meta.url);
const { createPlatformStates } = require("../../../stream-api/platform-states.js") as {
  createPlatformStates: (d: { broadcast: (f: unknown) => void; now: () => number }) => {
    accept: (body: unknown) => boolean; snapshot: () => PublicSnapshot; stop: () => void;
  };
};

const ALL = ["native", "streamplace", "youtube", "twitch"] as const;
const st = (state: "live" | "offline" | "unknown" | "upcoming") => ({ state, since: 1 });

test("each live source names the platform whose state decides it", () => {
  assert.deepEqual(SOURCE_PLATFORM, { native: "streamplace", streamplace: "streamplace", youtube: "youtube", twitch: "twitch", kick: "kick" });
});

test("unknown and missing platforms keep their sources (nothing known is no reason to hide a player)", () => {
  assert.deepEqual(liveSourcesLive(ALL, {}), [...ALL]);
  assert.deepEqual(liveSourcesLive(ALL, { twitch: st("unknown"), youtube: st("unknown") }), [...ALL]);
  assert.deepEqual(liveSourcesLive(ALL, { twitch: st("live"), streamplace: st("live") }), [...ALL]);
});

test("an offline stream.place drops the site's player and the stream.place embed together", () => {
  assert.deepEqual(liveSourcesLive(ALL, { streamplace: st("offline"), twitch: st("live") }), ["youtube", "twitch"]);
});

test("an upcoming (scheduled) YouTube broadcast is not offered as a player", () => {
  assert.deepEqual(liveSourcesLive(ALL, { youtube: st("upcoming"), twitch: st("live") }), ["native", "streamplace", "twitch"]);
});

test("a switched-off source never comes back because its platform is live", () => {
  const on = liveSourcesOn(["twitch"]);
  assert.deepEqual(liveSourcesLive(on, { twitch: st("live"), youtube: st("offline") }), ["native", "streamplace", "kick"]);
});

test("every platform offline → no source at all; there is no fail-open, the card shows", () => {
  const off = { streamplace: st("offline"), youtube: st("offline"), twitch: st("upcoming") };
  assert.deepEqual(liveSourcesLive(ALL, off), []);
  // liveSourceOn on [] keeps the viewer's stored pick, so it is theirs again when the platform returns.
  assert.equal(liveSourceOn("youtube", []), "youtube");
});

test("a stored pick that is not offered plays the first one that is", () => {
  assert.equal(liveSourceOn("youtube", ["twitch"]), "twitch");
});

// Retry: a platform that comes back is offered again, and the viewer's own pick with it.
test("retry: YouTube offline then live again — the source returns and the stored pick plays", () => {
  const offline = liveSourcesLive(ALL, { youtube: st("offline"), twitch: st("live") });
  assert.equal(liveSourceOn("youtube", offline), "native");
  const back = liveSourcesLive(ALL, { youtube: st("live"), twitch: st("live") });
  assert.equal(liveSourceOn("youtube", back), "youtube");
});

test("the card: live elsewhere, ended, or no player set up", () => {
  assert.deepEqual(liveCardReason([], [], { kick: st("live") }), { kind: "elsewhere", platform: "kick" });
  assert.deepEqual(liveCardReason(["youtube", "twitch"], [], { youtube: st("offline"), twitch: st("upcoming") }), { kind: "ended" });
  assert.deepEqual(liveCardReason(["native", "streamplace"], [], { streamplace: st("offline") }), { kind: "ended" });
  assert.deepEqual(liveCardReason([], [], {}), { kind: "none" });
  assert.deepEqual(liveCardReason([], [], { kick: st("offline") }), { kind: "none" }, "nothing set up is not an ended stream");
  assert.deepEqual(liveCardReason(["twitch", "youtube"], [], { twitch: st("unknown"), youtube: st("offline") }), { kind: "none" }, "an unknown platform has not ended");
  assert.deepEqual(liveCardReason(["twitch"], ["twitch"], { twitch: st("live") }), { kind: "none" }, "a live platform with a shown source is not elsewhere");
});

test("precedence: Kick live with no source while YouTube is offline reads as live elsewhere, not ended", () => {
  assert.deepEqual(liveCardReason(["youtube"], [], { kick: st("live"), youtube: st("offline") }), { kind: "elsewhere", platform: "kick" });
});

test("newest: the SSR seed until a newer snapshot arrives; an older one never wins", () => {
  const seed: PublicSnapshot = { at: 100, platforms: { youtube: { state: "offline", since: 1 } } };
  assert.equal(newest(seed, null), seed);
  assert.equal(newest(seed, undefined), seed);
  assert.equal(newest(seed, { at: 99, platforms: {} }), seed);
  assert.equal(newest(seed, { at: 100, platforms: {} }), seed, "same moment: keep what is shown");
  const fresh: PublicSnapshot = { at: 101, platforms: { youtube: { state: "live", since: 101 } } };
  assert.equal(newest(seed, fresh), fresh);
});

// Restart: a restarted stream-api reads `{ at, platforms: {} }` until its first report. That is
// newer, and empty keeps every source — a restart never hides a player.
test("restart: stream-api's empty snapshot after a restart replaces the old one and keeps every source", () => {
  const before: PublicSnapshot = { at: 100, platforms: { youtube: { state: "offline", since: 1 } } };
  const after = newest(before, { at: 200, platforms: {} });
  assert.deepEqual(liveSourcesLive(ALL, after.platforms), [...ALL]);
});

// stream-api's silence (no poller report for ≥ 180 s → every platform `unknown`) must reach a page
// that is already open: through the real relay, the boundary read and newest(), not a hand-made pair.
test("silence: an open page holding a report applies stream-api's silence of that same report (a hidden source comes back)", () => {
  let t = 1_000_000;
  const ps = createPlatformStates({ broadcast: () => {}, now: () => t });
  try {
    ps.accept({ at: t, nextInMs: 60_000, platforms: { twitch: { state: "live", since: 1 }, youtube: { state: "offline", since: 1 } } });
    const held = livenessOf({ liveness: ps.snapshot() })!;
    assert.deepEqual(liveSourcesLive(ALL, held.platforms), ["native", "streamplace", "twitch"], "YouTube offline: hidden");
    t += 181_000;
    const silence = livenessOf({ liveness: ps.snapshot() })!;
    assert.equal(silence.platforms.youtube?.state, "unknown");
    const shown = newest(held, silence);
    assert.equal(shown, silence, "the silence replaces the held report");
    assert.deepEqual(liveSourcesLive(ALL, shown.platforms), [...ALL], "can't tell: every source offered again");
    // The poll answering the same silence again changes nothing.
    assert.equal(newest(shown, livenessOf({ liveness: ps.snapshot() })), shown);
  } finally {
    ps.stop();
  }
});

// ── Kick's embed (Task 8): Kick is a live source, decided by Kick's own state ────────────────────

test("an offline Kick drops the Kick source", () => {
  assert.deepEqual(liveSourcesLive(["kick"], { kick: { state: "offline", since: 1 } }), []);
  assert.deepEqual(liveSourcesLive(["twitch", "kick"], { kick: st("upcoming"), twitch: st("live") }), ["twitch"]);
  assert.deepEqual(liveSourcesLive(["kick"], { kick: st("unknown") }), ["kick"], "can't tell keeps the player");
});

test("the Kick card's link shows only with Kick's switch off: switched off and live → live elsewhere", () => {
  const setUp = liveSourcesOn([], ["twitch", "kick"]);
  const platforms = { kick: st("live"), twitch: st("offline") };
  const shownOff = liveSourcesLive(liveSourcesOn(["kick"], setUp), platforms);
  assert.deepEqual(shownOff, [], "Twitch offline, Kick switched off: nothing to play");
  assert.deepEqual(liveCardReason(setUp, shownOff, platforms), { kind: "elsewhere", platform: "kick" });
});

test("with Kick's switch on, a live Kick plays in the player: no card", () => {
  const setUp = liveSourcesOn([], ["twitch", "kick"]);
  const platforms = { kick: st("live"), twitch: st("offline") };
  const shownOn = liveSourcesLive(liveSourcesOn([], setUp), platforms);
  assert.deepEqual(shownOn, ["kick"]);
  assert.equal(liveSourceOn("twitch", shownOn), "kick", "a viewer whose pick went offline lands on Kick");
  assert.notEqual(liveCardReason(setUp, shownOn, platforms).kind, "elsewhere", "Kick is played, not elsewhere");
});

test("a Kick-only install with Kick offline shows the ended card", () => {
  const setUp = liveSourcesOn([], ["kick"]);
  const platforms = { kick: st("offline") };
  const shown = liveSourcesLive(setUp, platforms);
  assert.deepEqual(shown, []);
  assert.deepEqual(liveCardReason(setUp, shown, platforms), { kind: "ended" });
});

// Retry: Kick ends, then the streamer goes live on Kick again — the source comes back with the pick.
test("retry: Kick offline then live again — the Kick source returns and a stored Kick pick plays", () => {
  const off = liveSourcesLive(["twitch", "kick"], { kick: st("offline"), twitch: st("live") });
  assert.equal(liveSourceOn("kick", off), "twitch");
  const back = liveSourcesLive(["twitch", "kick"], { kick: st("live"), twitch: st("live") });
  assert.equal(liveSourceOn("kick", back), "kick");
});

/** Stripped, with the raw file's last line proven to close the stripped text (a lost tail fails). */
const read = (rel: string) => {
  const raw = readFileSync(join(process.cwd(), rel), "utf8");
  const src = stripComments(raw);
  const last = raw.trimEnd().split("\n").pop()!;
  assert.ok(src.trimEnd().endsWith(last.trim()), `${rel}: the read lost the end of the file`);
  return src;
};

test("wiring: the page seeds the snapshot; StreamView reads it once and filters the Live row by it", () => {
  const page = read("app/(main)/page.tsx");
  assert.match(page, /initialLiveness=\{status\?\.liveness \?\? \{ at: 0, platforms: \{\} \}\}/);
  const view = read("app/components/StreamView.tsx");
  assert.equal(view.match(/usePlatformStates\(/g)?.length, 1, "called once");
  assert.match(view, /const platforms = usePlatformStates\(initialLiveness, liveness\);/);
  assert.match(view, /liveSourcesLive\(liveSourcesOn\(embedsOffKey \? embedsOffKey\.split\(","\) : \[\], setUpList\), platforms\)/);
  assert.match(view, /liveCard=\{liveCard\}/);
  assert.match(view, /liveCardReason\(liveSourcesOn\(\[\], setUpList\), liveOn, platforms\)/);
  const hook = read("app/lib/usePlatformStates.ts");
  assert.match(hook, /useState\(\(\) => newest\(initial, null\)\)/, "seeded from the SSR snapshot");
  assert.match(hook, /data\.type !== "platformStates"/, "narrows the frame on its type");
  const poll = read("app/lib/useStreamStatusPoll.ts");
  assert.match(poll, /return \{ live, community, communities, liveViewers, loopVideos, ytVideoId, liveness \};/);
  const area = read("app/features/player/StreamPlayerArea.tsx");
  assert.match(area, /The stream has ended\./);
  assert.match(area, /Live on \{platformLabel\(liveCard\.platform\)\}\./);
});
