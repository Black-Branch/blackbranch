// The one 60s single-flight build of the Home body, shared by
// GET /api/home and the server render of `/`: a page full of visitors is one
// build a minute, and the first body ships inside the HTML. Each loader fails
// alone (homePayload.ts). The status loader refuses an answer the status cache
// itself would not remember (a stream-api blip reads as "nobody is live"
// there, softly, for the player's sake) — Home would print it as fact, so it
// becomes the widget's "couldn't load" instead, and a body carrying that is
// not remembered for 60s either. Server-only (the DB pool, the forum reader);
// homeCache.test.ts pins the wiring by source scan.
import pool from "@/lib/db";
import { createTtlCache } from "@/app/lib/ttlCache";
import { getStreamStatus, streamStatusFresh } from "@/app/lib/streamStatus";
import { kickRefresh, listItems } from "@/app/lib/rssServer";
import { getVods } from "@/app/lib/vods";
import { getLastStream } from "@/app/lib/lastStream";
import { buildHomePayload, statusFromStream, newsFromRss, homePlatforms, type HomePayload } from "@/app/lib/homePayload";
import { chatPlatformsSetUp } from "@/app/lib/streamPlatformsServer";
import { instanceString, instanceBool, instanceList } from "@/app/lib/instanceConfigServer";
import { modulesOff, servingSnapshot } from "@/app/lib/moduleRunningServer";
import { forumReader } from "@/app/lib/forumReader";
import { topThreads } from "@/app/lib/forumModel";
import { getBoards } from "@/app/lib/boards";
import { boardsWarm } from "@/app/lib/boardFaces";

const cache = createTtlCache<HomePayload>({ ttlMs: 60_000, load: async () => {
  const data = await buildHomePayload({
    status: () => getStreamStatus().then((s) => {
      if (!streamStatusFresh()) throw new Error("status not fresh");
      return statusFromStream(s);
    }),
    lastStream: () => getLastStream(pool),
    news: () => { kickRefresh(); return listItems({ limit: 4 }).then((items) => newsFromRss(items, 4)); },
    vods: () => getVods().then((v) => v.slice(0, 3)),
    // The Leaderboard: boards.ts keeps its own per-window caches,
    // so a slow all-time board never holds this body — settle() blanks the
    // widget alone if it fails.
    boards: () => getBoards(),
    // The sign-in logos: what this install is set up with. Patreon's webhook secret is
    // stream-api's (never sent to web), so its "set" is read from stream-api's /config snapshot.
    platforms: async () => {
      const [off, snap] = await Promise.all([modulesOff(), servingSnapshot()]);
      return homePlatforms({
        chat: chatPlatformsSetUp(),
        youtube: !off.includes("youtube") && !!instanceString("platform.youtube.channelId"),
        discord: !!instanceString("discordBridge.usernameTemplate"),
        patreon: snap?.self?.["patreon.webhookSecret"]?.display != null,
      });
    },
    // The forums' most active threads, through the same reader (and the same
    // 60s per-room cache) the Forums tab reads; votes are not shown here.
    threads: () => forumReader.rooms()
      .then((rooms) => Promise.all(rooms.map((r) => forumReader.posts(r.roomId))))
      .then((lists) => topThreads(lists.flat().map((p) => ({ ...p, thumbnail: null, score: 0, myVote: null, pinned: false })), 4)),
  });
  // Not remembered while the boards are still warming either (a deploy, an
  // expired hourly window): the next build a moment later has them.
  return { data, cacheable: data.status !== null && boardsWarm(data.boards) };
} });

/** The body, fresh within 60s — one build shared by everyone asking — with the Leaderboard's
 *  settings as they are now. */
export function getHomePayload(): Promise<HomePayload> {
  return cache.get().then((p) => ({ ...p, leaderboard: { on: !instanceBool("leaderboard.off"), hidden: instanceList("leaderboard.hidden") } }));
}

/** The body if it arrives within `ms`, else null: the page render must never
 *  wait on a cold cache (a Matrix read can take longer than the whole page).
 *  Never rejects — a failure costs the head start, not the page. */
export function getHomePayloadWithin(ms: number): Promise<HomePayload | null> {
  return Promise.race([
    getHomePayload().catch(() => null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); }),
  ]);
}
