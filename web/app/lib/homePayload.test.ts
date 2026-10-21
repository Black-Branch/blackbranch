import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHomePayload, statusFromStream, newsFromRss, homePlatforms, type HomeLoaders } from "./homePayload.ts";
import { getLastStream } from "./lastStream.ts";
import { FACE_IDS, WINDOW_IDS, type HomeBoards } from "./boardFaces.ts";

const emptyBoards = (): HomeBoards =>
  Object.fromEntries(FACE_IDS.map((f) => [f, Object.fromEntries(WINDOW_IDS.map((w) => [w, []]))])) as unknown as HomeBoards;

const ok: HomeLoaders = {
  boards: async () => emptyBoards(),
  status: async () => ({ live: false, viewers: null, community: null }),
  lastStream: async () => ({ startedAt: "2026-09-25T01:18:00.000Z", endedAt: "2026-09-25T10:13:00.000Z" }),
  news: async () => [{ id: "a", feedId: 1, feedTitle: "Feed", guid: "g", title: "Headline", link: "https://x/1", summary: null, imageUrl: null, publishedAt: null }],
  vods: async () => [{ id: "v1", title: "Replay", duration: "1:00:00", when: "2d ago" }],
  threads: async () => [{ roomId: "!c", roomName: "Content", eventId: "$e", title: "Stream lead-up videos", replyCount: 1, lastTs: 1788746815623 }],
  platforms: async () => ["twitch", "kick"],
};

test("platforms: the set-up platforms for the sign-in logos; a failed read is [] — never a guess", async () => {
  assert.deepEqual((await buildHomePayload(ok)).platforms, ["twitch", "kick"]);
  assert.deepEqual((await buildHomePayload({ ...ok, platforms: async () => { throw new Error("x"); } })).platforms, []);
  const none = { twitch: false, kick: false, streamplace: false };
  assert.deepEqual(homePlatforms({ chat: none, youtube: false, discord: false, patreon: false }), []);
  assert.deepEqual(homePlatforms({ chat: { ...none, kick: true, streamplace: true }, youtube: true, discord: true, patreon: true }),
    ["kick", "streamplace", "youtube", "discord", "patreon"]);
});

test("every loader answers → every key is filled and generatedAt is the clock", async () => {
  const p = await buildHomePayload(ok, Date.UTC(2026, 8, 25, 12));
  assert.equal(p.status?.live, false);
  assert.equal(p.lastStream?.endedAt, "2026-09-25T10:13:00.000Z");
  assert.equal(p.news?.[0]?.title, "Headline");
  assert.equal(p.vods?.[0]?.id, "v1");
  assert.equal(p.threads?.[0]?.title, "Stream lead-up videos");
  assert.equal(p.generatedAt, "2026-09-25T12:00:00.000Z");
});

test("one loader throwing blanks ONE key — the others still arrive and the call resolves", async () => {
  const p = await buildHomePayload({ ...ok, lastStream: async () => { throw new Error("db down"); } });
  assert.equal(p.lastStream, null);
  assert.equal(p.status?.live, false);
  assert.equal(p.news?.length, 1);
  assert.equal(p.vods?.length, 1);
  assert.equal(p.threads?.length, 1);
});

test("loaders run in parallel, not one after another", async () => {
  const order: string[] = [];
  const slow = (k: string, ms: number) => () => new Promise<never[]>((r) => setTimeout(() => { order.push(k); r([]); }, ms));
  await buildHomePayload({
    status: async () => { order.push("status"); return { live: false, viewers: null, community: null }; },
    lastStream: async () => null,
    news: slow("news", 20) as unknown as HomeLoaders["news"],
    vods: slow("vods", 5) as unknown as HomeLoaders["vods"],
    threads: async () => [],
    boards: async () => emptyBoards(),
    platforms: async () => [],
  });
  assert.deepEqual(order, ["status", "vods", "news"], "vods (5ms) must finish before news (20ms)");
});

test("boards is a part like any other: filled when it answers, null alone when it throws", async () => {
  const p = await buildHomePayload(ok, Date.UTC(2026, 8, 25, 12));
  assert.deepEqual(p.boards?.credit.week, []);
  const q = await buildHomePayload({ ...ok, boards: async () => { throw new Error("db down"); } });
  assert.equal(q.boards, null);
  assert.equal(q.news?.length, 1);
});

test("statusFromStream keeps only what Home shows", () => {
  const s = statusFromStream({
    live: false,
    community: { display_name: "cleo", youtube_channel_id: "UC1", video_id: null, stream_title: "t", avatar_url: "https://a/p.png", twitch_login: null, sources: [{ platform: "youtube", id: "UC1" }] },
  });
  assert.deepEqual(s, { live: false, viewers: null, community: { name: "cleo", avatarUrl: "https://a/p.png" } });
  assert.deepEqual(statusFromStream({ live: true, community: null, viewers: 41 }), { live: true, viewers: 41, community: null });
});

test("newsFromRss keeps the WHOLE feed item (the widget shows its picture, the reader takes it) and trims to the limit", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: `i${i}`, feedId: 1, feedTitle: "Feed", guid: `g${i}`, title: `T${i}`, link: null, summary: "long", imageUrl: null, publishedAt: null,
  }));
  const out = newsFromRss(items, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], items[0]);
  assert.equal(newsFromRss(items).length, 4, "the default is the widget's row count");
});

test("getLastStream reads the newest ENDED session and returns null when there is none", async () => {
  const seen: string[] = [];
  const pool = { query: async (sql: string) => { seen.push(sql); return { rows: [{ started_at: new Date("2026-09-25T01:18:00Z"), ended_at: new Date("2026-09-25T10:13:00Z") }] }; } };
  const r = await getLastStream(pool);
  assert.deepEqual(r, { startedAt: "2026-09-25T01:18:00.000Z", endedAt: "2026-09-25T10:13:00.000Z" });
  assert.match(seen[0]!, /FROM stream\.sessions/);
  assert.match(seen[0]!, /ended_at IS NOT NULL/);
  assert.match(seen[0]!, /ORDER BY ended_at DESC/);
  assert.equal(await getLastStream({ query: async () => ({ rows: [] }) }), null);
});
