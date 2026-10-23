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
  /** The platforms this install is set up with (homePlatforms) — the sign-in logos. [] when the
   *  read failed: no logo is shown on a guess. */
  platforms: string[];
  generatedAt: string;
  /** The Leaderboard's settings (leaderboard.off / leaderboard.hidden), read at every answer,
   *  not cached with the body: a change shows on the next load. Absent = on, every board. */
  leaderboard?: { on: boolean; hidden: string[] };
};

export type HomeLoaders = {
  status: () => Promise<HomeStatus>;
  lastStream: () => Promise<LastStream | null>;
  news: () => Promise<HomeNewsItem[]>;
  vods: () => Promise<Vod[]>;
  threads: () => Promise<HomeThread[]>;
  boards: () => Promise<HomeBoards>;
  platforms: () => Promise<string[]>;
};

/** The platforms this install is set up with, for the Home tab's sign-in logos: the chat
 *  platforms with a channel, YouTube while its module runs with a channel, Discord while the
 *  bridge has a username template, Patreon while its webhook secret is set. Pure. */
export function homePlatforms(i: {
  chat: { twitch: boolean; kick: boolean; streamplace: boolean };
  youtube: boolean;
  discord: boolean;
  patreon: boolean;
}): string[] {
  const out = (Object.keys(i.chat) as (keyof typeof i.chat)[]).filter((k) => i.chat[k]) as string[];
  if (i.youtube) out.push("youtube");
  if (i.discord) out.push("discord");
  if (i.patreon) out.push("patreon");
  return out;
}

/** A loader's failure is that widget's `null`, never a rejection of the whole body. */
async function settle<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

export async function buildHomePayload(loaders: HomeLoaders, nowMs: number = Date.now()): Promise<HomePayload> {
  const [status, lastStream, news, vods, threads, boards, platforms] = await Promise.all([
    settle(loaders.status),
    settle(loaders.lastStream),
    settle(loaders.news),
    settle(loaders.vods),
    settle(loaders.threads),
    settle(loaders.boards),
    settle(loaders.platforms),
  ]);
  return { status, lastStream, news, vods, threads, boards, platforms: platforms ?? [], generatedAt: new Date(nowMs).toISOString() };
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
