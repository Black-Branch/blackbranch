// What GET /api/home answers with: one body for every widget on the Home tab.
// Each part comes from its own loader and each loader fails ALONE — a dead
// feed blanks one widget, never the page. Pure: the route hands in
// the real loaders, the test hands in fakes.
import type { StreamStatus } from "./streamStatus.ts";
import type { RssItem } from "./rssServer.ts";
import type { Vod } from "./vods.ts";
import type { LastStream } from "./lastStream.ts";
import type { HomeThread } from "./forumModel.ts";
import type { HomeBoards } from "./boardFaces.ts";

export type HomeStatus = {
  live: boolean;
  viewers: number | null;
  community: { name: string; avatarUrl: string | null } | null;
};

/** A Home news row IS the feed item: the widget shows its
 *  picture, and a click hands the whole item to the News tab's reader. */
export type HomeNewsItem = RssItem;

export type HomePayload = {
  status: HomeStatus | null;
  lastStream: LastStream | null;
  news: HomeNewsItem[] | null;
  vods: Vod[] | null;
  /** The forums' most active threads, from the forum reader. */
  threads: HomeThread[] | null;
  /** The Leaderboard's top fives, every face × window. */
  boards: HomeBoards | null;
  generatedAt: string;
};

export type HomeLoaders = {
  status: () => Promise<HomeStatus>;
  lastStream: () => Promise<LastStream | null>;
  news: () => Promise<HomeNewsItem[]>;
  vods: () => Promise<Vod[]>;
  threads: () => Promise<HomeThread[]>;
  boards: () => Promise<HomeBoards>;
};

/** A loader's failure is that widget's `null`, never a rejection of the whole body. */
async function settle<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

export async function buildHomePayload(loaders: HomeLoaders, nowMs: number = Date.now()): Promise<HomePayload> {
  const [status, lastStream, news, vods, threads, boards] = await Promise.all([
    settle(loaders.status),
    settle(loaders.lastStream),
    settle(loaders.news),
    settle(loaders.vods),
    settle(loaders.threads),
    settle(loaders.boards),
  ]);
  return { status, lastStream, news, vods, threads, boards, generatedAt: new Date(nowMs).toISOString() };
}

/** The status route's answer, cut down to what Home shows. */
export function statusFromStream(s: StreamStatus): HomeStatus {
  return {
    live: s.live,
    viewers: typeof s.viewers === "number" ? s.viewers : null,
    community: s.community ? { name: s.community.display_name, avatarUrl: s.community.avatar_url ?? null } : null,
  };
}

/** The newest headlines, `limit` of them (the widget's row count by default). */
export function newsFromRss(items: RssItem[], limit = 4): HomeNewsItem[] {
  return items.slice(0, limit);
}
