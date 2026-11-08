// The community slot (per-platform liveness, Task 9): one YouTube classifier, read by a background
// refresher (never inside a request), a featured streamer who stays until they end, and the viewer's
// choice among the community streamers who are live now. Another channel's SCHEDULED stream is never
// listed (0134 E5); the install's own scheduled stream keeps its countdown (E4).
// Run: node --test app/lib/communityLive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./testTsx.ts";
import { stripComments } from "./testSource.ts";
import { communityTarget } from "./streamView.ts";

const { pickCommunity, mergeCheck, communityAnswer, createCommunityRefresher, avatarFromLivePage } =
  await import("./communityLive.ts");
type Row = import("./communityLive.ts").Row;
type RowCheck = import("./communityLive.ts").RowCheck;

const OWN = "UCownownownownownownown1";
const A = "UCaaaaaaaaaaaaaaaaaaaaa1";
const B = "UCbbbbbbbbbbbbbbbbbbbbb1";
const C = "UCccccccccccccccccccccc1";
const T0 = 1_800_000_000_000;
const MIN = 60_000;

const row = (display_name: string, youtube_channel_id: string | null, priority: number, twitch_login: string | null = null): Row =>
  ({ display_name, youtube_channel_id, twitch_login, ingest_youtube: true, ingest_twitch: true, priority });

const yt = (state: "live" | "upcoming" | "offline" | "unknown", videoId: string, at: number, extra: Partial<NonNullable<RowCheck["yt"]>> = {}) =>
  ({ state, videoId, ownerChannelId: "", scheduledStart: null, evidence: state === "live" ? "is-live" : state, at,
     title: `${videoId} title`, avatar: null, ...extra });
const tw = (state: "live" | "offline" | "unknown", at: number, seenLive = state === "live") =>
  ({ state, title: state === "live" ? "on twitch" : "", avatar: null, at, seenLive });
const check = (y: RowCheck["yt"], t: RowCheck["twitch"] = null): RowCheck => ({ yt: y, twitch: t });

const keysOf = (p: { live: { key: string }[] }) => p.live.map((c) => c.key);

// ── pick (rows 1–7) ───────────────────────────────────────────────────────────

test("row 1: another channel that is live is listed", () => {
  const p = pickCommunity({ rows: [row("A", A, 1)], checks: new Map([[A, check(yt("live", "vidA0000001", T0))]]),
    prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  assert.deepEqual(keysOf(p), [A]);
  assert.equal(p.featured?.key, A);
  assert.equal(p.featured?.video_id, "vidA0000001");
  assert.equal(p.featured?.scheduled, null);
  assert.deepEqual(p.featured?.sources, [{ platform: "youtube", id: "vidA0000001" }]);
});

test("row 2: another channel's scheduled stream is never listed (E5)", () => {
  const p = pickCommunity({ rows: [row("A", A, 1)], checks: new Map([[A, check(yt("upcoming", "vidA0000001", T0, { scheduledStart: T0 + 30 * MIN }))]]),
    prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  assert.deepEqual(keysOf(p), []);
  assert.equal(p.featured, null);
});

test("row 3: the install's own scheduled stream is listed at its priority with its start, playing the upcoming video (E4)", () => {
  const rows = [row("A", A, 1), row("Own", OWN, 2), row("B", B, 3)];
  const checks = new Map([
    [A, check(yt("live", "vidA0000001", T0))],
    [OWN, check(yt("upcoming", "vidOwn00001", T0, { scheduledStart: T0 + 30 * MIN }))],
    [B, check(yt("live", "vidB0000001", T0))],
  ]);
  const p = pickCommunity({ rows, checks, prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  assert.deepEqual(keysOf(p), [A, OWN, B]);
  const own = p.live[1]!;
  assert.deepEqual(own.scheduled, { startsAt: T0 + 30 * MIN });
  assert.equal(own.video_id, "vidOwn00001");
  assert.deepEqual(own.sources, [{ platform: "youtube", id: "vidOwn00001" }]);
});

test("row 4: a featured streamer who is live, or who cannot be read, stays when a higher priority goes live (E9)", () => {
  const rows = [row("A", A, 1), row("B", B, 2)];
  for (const bState of ["live", "unknown"] as const) {
    const checks = new Map([
      [A, check(yt("live", "vidA0000001", T0))],
      [B, check(yt(bState, "vidB0000001", T0 - 20 * MIN))],
    ]);
    const p = pickCommunity({ rows, checks, prevFeaturedKey: B, ownChannelId: OWN, now: T0 });
    assert.equal(p.featured?.key, B, `featured ${bState}`);
    assert.equal(p.featured?.video_id, "vidB0000001", `featured ${bState} keeps its video`);
    assert.deepEqual(keysOf(p), [B, A], "featured first, then priority order");
  }
});

test("row 5: a featured streamer who answers offline gives the slot to the next by priority", () => {
  const rows = [row("A", A, 1), row("B", B, 2), row("C", C, 3)];
  const checks = new Map([
    [A, check(yt("offline", "", T0))],
    [B, check(yt("live", "vidB0000001", T0))],
    [C, check(yt("live", "vidC0000001", T0))],
  ]);
  const p = pickCommunity({ rows, checks, prevFeaturedKey: A, ownChannelId: OWN, now: T0 });
  assert.equal(p.featured?.key, B);
  assert.deepEqual(keysOf(p), [B, C]);
});

test("row 6: our own countdown as featured does not hold the slot — priority decides, as today; both listed", () => {
  const checks = new Map([
    [OWN, check(yt("upcoming", "vidOwn00001", T0, { scheduledStart: T0 + 30 * MIN }))],
    [A, check(yt("live", "vidA0000001", T0))],
  ]);
  const aFirst = pickCommunity({ rows: [row("A", A, 1), row("Own", OWN, 2)], checks, prevFeaturedKey: OWN, ownChannelId: OWN, now: T0 });
  assert.equal(aFirst.featured?.key, A);
  assert.deepEqual(keysOf(aFirst), [A, OWN]);
  const ownFirst = pickCommunity({ rows: [row("Own", OWN, 1), row("A", A, 2)], checks, prevFeaturedKey: OWN, ownChannelId: OWN, now: T0 });
  assert.equal(ownFirst.featured?.key, OWN);
  assert.deepEqual(keysOf(ownFirst), [OWN, A]);
});

test("row 7: a row that never answered is not listed", () => {
  const rows = [row("A", A, 1), row("B", B, 2), row("T", null, 3, "teeone")];
  const checks = new Map<string, RowCheck>([
    [B, check(yt("unknown", "", T0))],
    ["tw:teeone", check(null, tw("unknown", T0))],
  ]);
  const p = pickCommunity({ rows, checks, prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  assert.deepEqual(keysOf(p), []);
  assert.equal(p.featured, null);
});

test("a Twitch-only entry live on Twitch is featured from Twitch alone, keyed tw:<login>", () => {
  const p = pickCommunity({ rows: [row("T", null, 1, "teeone")], checks: new Map([["tw:teeone", check(null, tw("live", T0))]]),
    prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  assert.equal(p.featured?.key, "tw:teeone");
  assert.deepEqual(p.featured?.sources, [{ platform: "twitch", id: "teeone" }]);
  assert.equal(p.featured?.stream_title, "on twitch");
  assert.equal(p.featured?.video_id, null);
});

test("an answer older than the keep window reads as unknown: a non-featured row leaves the list", () => {
  const rows = [row("A", A, 1), row("B", B, 2)];
  const checks = new Map([
    [A, check(yt("live", "vidA0000001", T0 - 11 * MIN))],
    [B, check(yt("live", "vidB0000001", T0))],
  ]);
  assert.deepEqual(keysOf(pickCommunity({ rows, checks, prevFeaturedKey: B, ownChannelId: OWN, now: T0 })), [B]);
  assert.deepEqual(keysOf(pickCommunity({ rows, checks, prevFeaturedKey: B, ownChannelId: OWN, now: T0 - 2 * MIN })), [B, A]);
});

// ── merge (row 8) ─────────────────────────────────────────────────────────────

test("row 8: a Twitch Helix failure keeps the previous answers for up to 10 min, never 'nobody live' (C6)", () => {
  const prev = check(null, tw("live", T0));
  const failed = check(null, tw("unknown", T0 + 3 * MIN));
  const kept = mergeCheck(prev, failed, T0 + 3 * MIN);
  assert.equal(kept.twitch?.state, "live");
  assert.equal(kept.twitch?.at, T0, "the keep window counts from the last real answer");
  const rows = [row("T", null, 1, "teeone")];
  assert.equal(pickCommunity({ rows, checks: new Map([["tw:teeone", kept]]), prevFeaturedKey: null, ownChannelId: OWN, now: T0 + 3 * MIN }).featured?.key,
    "tw:teeone", "still featured through the failure");
  const atTen = mergeCheck(kept, check(null, tw("unknown", T0 + 10 * MIN)), T0 + 10 * MIN);
  assert.equal(atTen.twitch?.state, "live", "kept up to and including 10 min");
  const past = mergeCheck(atTen, check(null, tw("unknown", T0 + 10 * MIN + 1)), T0 + 10 * MIN + 1);
  assert.equal(past.twitch?.state, "unknown", "then it reads unknown, never offline");
});

test("merge: a failed YouTube read (null) keeps the previous answer the same way; a real answer replaces it at once", () => {
  const prev = check(yt("live", "vidA0000001", T0));
  assert.equal(mergeCheck(prev, check(null), T0 + 5 * MIN).yt?.state, "live");
  const expired = mergeCheck(prev, check(null), T0 + 11 * MIN);
  assert.equal(expired.yt?.state, "unknown");
  assert.equal(expired.yt?.videoId, "vidA0000001", "the video it was playing is kept for a featured streamer who stays");
  assert.equal(mergeCheck(prev, check(yt("offline", "", T0 + MIN)), T0 + MIN).yt?.state, "offline");
  assert.equal(mergeCheck(undefined, check(null), T0).yt, null, "nothing to keep: nothing");
});

// ── status (row 9) ────────────────────────────────────────────────────────────

test("row 9: nobody listed → the loop playlist, as today (and only then is it loaded)", async () => {
  let loads = 0;
  const loop = async () => { loads++; return [{ video_id: "loopvid0001", title: "Loop" }]; };
  const empty = await communityAnswer({ featured: null, live: [] }, loop);
  assert.deepEqual(empty, { community: null, communities: [], loopVideos: [{ video_id: "loopvid0001", title: "Loop" }] });
  assert.equal(loads, 1);
  const p = pickCommunity({ rows: [row("A", A, 1)], checks: new Map([[A, check(yt("live", "vidA0000001", T0))]]),
    prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  const some = await communityAnswer(p, loop);
  assert.equal(some.community?.key, A);
  assert.deepEqual(some.communities.map((c) => c.key), [A]);
  assert.equal("loopVideos" in some, false);
  assert.equal(loads, 1, "the loop query runs only when nobody is live");
});

// ── target (rows 10–11) ───────────────────────────────────────────────────────

test("row 10: two live, the featured one ends, the viewer chose the other → the other (Review Focus 4)", () => {
  const rows = [row("A", A, 1), row("B", B, 2)];
  const before = pickCommunity({ rows, checks: new Map([[A, check(yt("live", "vidA0000001", T0))], [B, check(yt("live", "vidB0000001", T0))]]),
    prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  const status1 = { community: before.featured, communities: before.live };
  assert.equal(communityTarget(status1, B)?.key, B);
  const after = pickCommunity({ rows, checks: new Map([[A, check(yt("offline", "", T0 + 3 * MIN))], [B, check(yt("live", "vidB0000001", T0 + 3 * MIN))]]),
    prevFeaturedKey: before.featured!.key, ownChannelId: OWN, now: T0 + 3 * MIN });
  assert.equal(communityTarget({ community: after.featured, communities: after.live }, B)?.key, B);
});

test("row 11: a chosen key that is not in the list → the featured one", () => {
  const p = pickCommunity({ rows: [row("A", A, 1)], checks: new Map([[A, check(yt("live", "vidA0000001", T0))]]),
    prevFeaturedKey: null, ownChannelId: OWN, now: T0 });
  const status = { community: p.featured, communities: p.live };
  assert.equal(communityTarget(status, C)?.key, A);
  assert.equal(communityTarget(status, null)?.key, A);
  assert.equal(communityTarget({ community: null, communities: [] }, A), null);
});

// ── the refresher: one real run, a restart and a retry ────────────────────────

const page = (channelId: string, videoId: string, kind: "live" | "upcoming" | "none") =>
  kind === "none"
    ? `<html><link rel="canonical" href="https://www.youtube.com/channel/${channelId}"></html>`
    : `<html><head><meta name="title" content="${videoId} &amp; friends"><link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"></head>` +
      `<script>var ytInitialPlayerResponse = ${JSON.stringify({
        videoDetails: { videoId, channelId, ...(kind === "live" ? { isLive: true } : { isUpcoming: true }) },
        playabilityStatus: kind === "upcoming"
          ? { status: "LIVE_STREAM_OFFLINE", liveStreamability: { liveStreamabilityRenderer: { offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: String((T0 + 30 * MIN) / 1000) } } } } }
          : { status: "OK" },
      })};</script>` +
      `"videoOwnerRenderer":{"thumbnail":{"thumbnails":[{"url":"https://yt3.ggpht.com/${channelId}=s48"}]}}</html>`;

function fakeIo(opts: { rows: Row[]; pages: Record<string, string | null>; twitch?: Map<string, { title: string; avatar: string | null }> | null | undefined }) {
  const io = {
    clock: T0,
    reads: 0,
    rowsFail: false,
    gate: null as Promise<void> | null,
    pages: opts.pages,
    twitch: "twitch" in opts ? opts.twitch : new Map(),
    rows: opts.rows,
    deps: {
      loadRows: async () => { if (io.rowsFail) throw new Error("db down"); return io.rows; },
      readPage: async (id: string) => { io.reads++; if (io.gate) await io.gate; return io.pages[id] ?? null; },
      twitchLive: async () => io.twitch,
      avatar: async () => null,
      ownChannelId: () => OWN,
      now: () => io.clock,
    },
  };
  return io;
}

test("refresher (real run): classifies every row's page through the one classifier; a scheduled stranger never shows, our own countdown does", async () => {
  const io = fakeIo({
    rows: [row("Own", OWN, 1), row("A", A, 2), row("B", B, 3), row("T", null, 4, "teeone")],
    pages: { [OWN]: page(OWN, "vidOwn00001", "upcoming"), [A]: page(A, "vidA0000001", "live"), [B]: page(B, "vidB0000001", "upcoming") },
    twitch: new Map([["teeone", { title: "on twitch", avatar: null }]]),
  });
  const r = createCommunityRefresher(io.deps);
  assert.deepEqual(r.snapshot(), { featured: null, live: [] }, "nothing before the first refresh");
  await r.refresh();
  const s = r.snapshot();
  assert.deepEqual(keysOf(s), [OWN, A, "tw:teeone"], "B's schedule is not listed");
  assert.deepEqual(s.live[0]!.scheduled, { startsAt: T0 + 30 * MIN });
  assert.equal(s.live[1]!.stream_title, "vidA0000001 & friends", "the title is read off the page, entities decoded");
  assert.equal(s.live[1]!.avatar_url, `https://yt3.ggpht.com/${A}=s48`, "the page's avatar when the API gives none");
});

test("refresher: single-flight — a refresh while one runs joins it instead of fetching again", async () => {
  let open!: () => void;
  const io = fakeIo({ rows: [row("A", A, 1)], pages: { [A]: page(A, "vidA0000001", "live") } });
  io.gate = new Promise<void>((res) => { open = res; });
  const r = createCommunityRefresher(io.deps);
  const one = r.refresh();
  const two = r.refresh();
  open();
  await Promise.all([one, two]);
  assert.equal(io.reads, 1);
});

test("refresher retry: a failed page or a failed row read keeps what is shown; the next round answers again", async () => {
  const io = fakeIo({ rows: [row("A", A, 1), row("B", B, 2)], pages: { [A]: page(A, "vidA0000001", "live"), [B]: page(B, "vidB0000001", "live") } });
  const r = createCommunityRefresher(io.deps);
  await r.refresh();
  assert.deepEqual(keysOf(r.snapshot()), [A, B]);
  io.clock += 3 * MIN;
  io.pages = { [A]: null, [B]: page(B, "vidB0000001", "live") };
  await r.refresh();
  assert.deepEqual(keysOf(r.snapshot()), [A, B], "A's failed read keeps its last answer");
  io.clock += 3 * MIN;
  io.rowsFail = true;
  await r.refresh();
  assert.deepEqual(keysOf(r.snapshot()), [A, B], "a failed row read keeps the picture");
  io.rowsFail = false;
  io.clock += 3 * MIN;
  io.pages = { [A]: page(A, "", "none"), [B]: page(B, "vidB0000001", "live") };
  await r.refresh();
  assert.deepEqual(keysOf(r.snapshot()), [B], "the retry's answer (A ended) is read");
  assert.equal(r.snapshot().featured?.key, B);
});

test("refresher: the featured streamer stays when a higher priority goes live (sticky across rounds)", async () => {
  const io = fakeIo({ rows: [row("A", A, 1), row("B", B, 2)], pages: { [B]: page(B, "vidB0000001", "live"), [A]: page(A, "", "none") } });
  const r = createCommunityRefresher(io.deps);
  await r.refresh();
  assert.equal(r.snapshot().featured?.key, B);
  io.clock += 3 * MIN;
  io.pages = { [A]: page(A, "vidA0000001", "live"), [B]: page(B, "vidB0000001", "live") };
  await r.refresh();
  assert.equal(r.snapshot().featured?.key, B);
  assert.deepEqual(keysOf(r.snapshot()), [B, A]);
});

test("refresher restart: a new process forgets the featured pick and starts empty until its first round", async () => {
  const pages = { [A]: page(A, "vidA0000001", "live"), [B]: page(B, "vidB0000001", "live") };
  const old = createCommunityRefresher(fakeIo({ rows: [row("A", A, 1), row("B", B, 2)], pages: { [B]: pages[B]!, [A]: page(A, "", "none") } }).deps);
  await old.refresh();
  assert.equal(old.snapshot().featured?.key, B);
  const io = fakeIo({ rows: [row("A", A, 1), row("B", B, 2)], pages });
  const fresh = createCommunityRefresher(io.deps);
  assert.equal(fresh.snapshot().featured, null, "a restarted process shows nothing it has not read");
  await fresh.refresh();
  assert.equal(fresh.snapshot().featured?.key, A, "and picks by priority again");
});

// ── round 1: one platform's "can't tell" never holds a streamer the other said has ended ──────────

test("mixed: featured from YouTube, YouTube answers offline, Twitch can't be told → released (never their offline Twitch)", () => {
  const rows = [row("A", A, 1, "alogin"), row("B", B, 2)];
  const checks = new Map<string, RowCheck>([
    [A, check(yt("offline", "", T0), tw("unknown", T0, false))],
    [B, check(yt("live", "vidB0000001", T0))],
  ]);
  const p = pickCommunity({ rows, checks, prevFeaturedKey: A, ownChannelId: OWN, now: T0 });
  assert.equal(p.featured?.key, B);
  assert.deepEqual(keysOf(p), [B]);
});

test("mirror: featured from Twitch, Twitch answers offline, YouTube can't be told → released", () => {
  const rows = [row("A", A, 1, "alogin"), row("B", B, 2)];
  const checks = new Map<string, RowCheck>([
    [A, check(yt("unknown", "", T0), tw("offline", T0))],
    [B, check(yt("live", "vidB0000001", T0))],
  ]);
  const p = pickCommunity({ rows, checks, prevFeaturedKey: A, ownChannelId: OWN, now: T0 });
  assert.equal(p.featured?.key, B);
  assert.deepEqual(keysOf(p), [B]);
});

test("a held row plays only a platform that was live: Twitch never answered live → no Twitch entry", () => {
  const rows = [row("A", A, 1, "alogin")];
  const neverLive = new Map<string, RowCheck>([[A, check(yt("unknown", "", T0), tw("unknown", T0, false))]]);
  assert.equal(pickCommunity({ rows, checks: neverLive, prevFeaturedKey: A, ownChannelId: OWN, now: T0 }).featured, null);
  const wasLive = new Map<string, RowCheck>([[A, check(yt("unknown", "", T0), tw("unknown", T0, true))]]);
  assert.deepEqual(pickCommunity({ rows, checks: wasLive, prevFeaturedKey: A, ownChannelId: OWN, now: T0 }).featured?.sources,
    [{ platform: "twitch", id: "alogin" }]);
});

test("refresher, no Twitch app keys: Twitch is not asked, so A's YouTube end releases the slot to B at once", async () => {
  const io = fakeIo({ rows: [row("A", A, 1, "alogin"), row("B", B, 2)], pages: { [A]: page(A, "vidA0000001", "live"), [B]: page(B, "", "none") },
    twitch: undefined });
  const r = createCommunityRefresher(io.deps);
  await r.refresh();
  assert.equal(r.snapshot().featured?.key, A);
  for (let i = 0; i < 20; i++) {
    io.clock += 3 * MIN;
    io.pages = { [A]: page(A, "", "none"), [B]: page(B, "vidB0000001", "live") };
    await r.refresh();
    assert.equal(r.snapshot().featured?.key, B, `round ${i + 2}: B is featured, A is not held`);
    assert.deepEqual(keysOf(r.snapshot()), [B]);
  }
});

test("refresher: a Helix failure after A ended on YouTube does not hold A (mirror of the review's probe)", async () => {
  const io = fakeIo({ rows: [row("A", A, 1, "alogin"), row("B", B, 2)], pages: { [A]: page(A, "vidA0000001", "live"), [B]: page(B, "", "none") } });
  const r = createCommunityRefresher(io.deps);
  await r.refresh();
  io.twitch = null; // Helix fails from here on
  io.clock += 3 * MIN;
  io.pages = { [A]: page(A, "", "none"), [B]: page(B, "vidB0000001", "live") };
  await r.refresh();
  assert.equal(r.snapshot().featured?.key, B);
});

test("hold cap: every asked platform can't be told — held through the keep window and 30 min more, then released", async () => {
  const io = fakeIo({ rows: [row("A", A, 1), row("B", B, 2)], pages: { [A]: page(A, "vidA0000001", "live"), [B]: page(B, "", "none") } });
  const r = createCommunityRefresher(io.deps);
  await r.refresh();
  assert.equal(r.snapshot().featured?.key, A);
  io.pages = { [A]: null, [B]: page(B, "vidB0000001", "live") }; // A's page fails from here on
  const at: Record<number, string | undefined> = {};
  for (let m = 3; m <= 45; m += 3) {
    io.clock = T0 + m * MIN;
    await r.refresh();
    at[m] = r.snapshot().featured?.key;
  }
  assert.equal(at[9], A, "the last answer is kept 10 min");
  assert.equal(at[36], A, "then held while can't be told (unknown since 12 min)");
  assert.equal(at[42], B, "released 30 min after every platform turned unknown");
  assert.equal(r.snapshot().featured?.video_id, "vidB0000001");
});

// ── the avatar on a live page (moved from communityAvatar.test.ts) ────────────

const ownerPage = (url: string) =>
  `…"videoOwnerRenderer":{"thumbnail":{"thumbnails":[{"url":"${url}","width":48,"height":48}]},"title":{"runs":[]}}…`;

test("the avatar on a live watch page is read without the API", () => {
  assert.equal(avatarFromLivePage(ownerPage("https://yt3.ggpht.com/abc=s48-c-k-c0x00ffffff-no-rj")), "https://yt3.ggpht.com/abc=s48-c-k-c0x00ffffff-no-rj");
  assert.equal(avatarFromLivePage(ownerPage("https://yt3.googleusercontent.com/x=s88")), "https://yt3.googleusercontent.com/x=s88");
});

test("only a YouTube image host over https; a page without the field is null", () => {
  assert.equal(avatarFromLivePage(ownerPage("http://yt3.ggpht.com/abc")), null);
  assert.equal(avatarFromLivePage(ownerPage("https://evil.example/abc")), null);
  assert.equal(avatarFromLivePage(ownerPage("javascript:alert(1)")), null);
  assert.equal(avatarFromLivePage("<html>offline channel home</html>"), null);
});

// ── wiring ────────────────────────────────────────────────────────────────────

test("wiring: the refresher starts in instrumentation; the status loader only reads its snapshot", () => {
  const boot = stripComments(readFileSync(join(import.meta.dirname, "../../instrumentation.ts"), "utf8"));
  assert.match(boot, /const \{ startCommunityRefresher \} = await import\("@\/app\/lib\/communityLive"\);\s*startCommunityRefresher\(\);/);
  assert.ok(boot.indexOf("startCommunityRefresher()") > boot.indexOf("await startInstanceConfig()"), "after the settings layer's first load");
  const live = stripComments(readFileSync(join(import.meta.dirname, "communityLive.ts"), "utf8"));
  assert.match(live, /COMMUNITY_REFRESH_MS = 180_000/);
  assert.match(live, /COMMUNITY_KEEP_MS = 10 \* 60_000/);
  assert.match(live, /COMMUNITY_HOLD_UNKNOWN_MS = 30 \* 60_000/);
  assert.match(live, /setInterval\(\(\) => \{ void community\.refresh\(\); \}, COMMUNITY_REFRESH_MS\)/);
  assert.match(live, /import pool from "@\/lib\/db";/);
  assert.match(live, /const slot: Slot = \(slots\[SLOT_KEY\] \?\?= \{/, "one refresher per process, shared by every bundle's copy");
  assert.match(live, /const SLOT_KEY = Symbol\.for\("bb\.communityLive"\);/);
  // The API's avatar first, the live page's when there is no key or no answer.
  assert.match(live, /\(\(await deps\.avatar\(channelId\)\) \?\? avatarFromLivePage\(html\)\)/);
  assert.match(live, /export function communitySnapshot\(\): CommunityPick \{\s*return community\.snapshot\(\);\s*\}\s*$/, "vacuity: read to the end");
  const status = stripComments(readFileSync(join(import.meta.dirname, "streamStatus.ts"), "utf8"));
  assert.match(status, /await communityAnswer\(communitySnapshot\(\), loadLoop\)/);
  assert.match(status, /export const getStreamStatus = \(\): Promise<StreamStatus> => statusCache\.get\(\);\s*$/, "vacuity: read to the end");
  assert.doesNotMatch(status, /youtube\.com|classifyLivePage|twitchLiveLogins|checkYouTubeLive/, "no platform read on the request path");
});
