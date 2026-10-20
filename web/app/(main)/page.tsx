import StreamView from "@/app/components/StreamView";
import { auth } from "@/auth";
import { streamApiFetch } from "@/app/lib/streamApi";
import { getChannelAvatar } from "@/app/lib/streamStatus";
import { getVods } from "@/app/lib/vods";
import { getHomePayloadWithin } from "@/app/lib/homeCache";
import { twitchAppToken, twitchClientId } from "@/app/lib/twitch";
import { latestChatHistory } from "@/app/api/chat/history/route";
import { CHAT_LIVE_CAP } from "@/app/lib/chatCaps";
import { manifestWithin } from "@/app/api/emotes/route";
import { emotesUsedBy } from "@/app/lib/emoteSubset";
import { getUserContext, NO_USER } from "@/app/lib/userContext";
import { instanceList, instanceString } from "@/app/lib/instanceConfigServer";
// The modules not shown, by the module rule (config/modules.mjs "ONE RULE"): the radio's tab
// follows what stream-api RUNS, so it never points at routes that answer 404, and never hides
// while stream-api still runs (and spends on) the station.
import { modulesOff } from "@/app/lib/moduleRunningServer";
import { SupportModulesOff } from "@/app/lib/support/SupportModulesOff";
import { siteName } from "@/app/lib/siteName";

async function getStreamStatus() {
  try {
    const res = await streamApiFetch("/stream/current", {
      next: { revalidate: 30 },
    } as RequestInit);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Module-level caches — persist across requests in standalone mode.
// (The Twitch app token is cached in app/lib/twitch.ts, shared with /api/emotes.)
let twitchFollowerCache: { count: number; fetchedAt: number } | null = null;
let ytSubscriberCache: { count: number; fetchedAt: number } | null = null;

async function getYouTubeSubscriberCount(): Promise<number | null> {
  const apiKey    = instanceString("youtube.apiKey");
  const channelId = instanceString("platform.youtube.channelId");
  if (!apiKey || !channelId) return null;

  if (ytSubscriberCache && Date.now() - ytSubscriberCache.fetchedAt < 5 * 60 * 1000) {
    return ytSubscriberCache.count;
  }

  try {
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`,
      { next: { revalidate: 300 } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const count = parseInt(d.items?.[0]?.statistics?.subscriberCount ?? "", 10);
    if (isNaN(count)) return null;
    ytSubscriberCache = { count, fetchedAt: Date.now() };
    return count;
  } catch {
    return null;
  }
}

async function getTwitchInfo(isLive: boolean): Promise<{
  title: string | null;
  viewerCount: number | null;
  followerCount: number | null;
}> {
  const channel = instanceString("platform.twitch.channel");
  const token   = await twitchAppToken();
  if (!token || !channel) return { title: null, viewerCount: null, followerCount: null };

  try {
    const hdrs = { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() };

    // Fetch stream data and user ID in parallel
    const [streamRes, userRes] = await Promise.all([
      isLive
        ? fetch(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
            headers: hdrs,
            next: { revalidate: 60 },
          })
        : Promise.resolve(null),
      fetch(`https://api.twitch.tv/helix/users?login=${channel}`, {
        headers: hdrs,
        next: { revalidate: 3600 },
      }),
    ]);

    let title: string | null = null;
    let viewerCount: number | null = null;
    if (streamRes?.ok) {
      const sd = await streamRes.json();
      title       = sd.data?.[0]?.title ?? null;
      viewerCount = sd.data?.[0]?.viewer_count ?? null;
    }

    // Follower count — cached for 5 min since it changes slowly
    let followerCount: number | null = null;
    const followerFresh = twitchFollowerCache && Date.now() - twitchFollowerCache.fetchedAt < 5 * 60 * 1000;
    if (followerFresh) {
      followerCount = twitchFollowerCache!.count;
    } else if (userRes?.ok) {
      const ud = await userRes.json();
      const broadcasterId = ud.data?.[0]?.id;
      if (broadcasterId) {
        const fr = await fetch(
          `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}`,
          { headers: hdrs, next: { revalidate: 300 } }
        );
        if (fr.ok) {
          const fd = await fr.json();
          followerCount = fd.total ?? null;
          if (followerCount !== null) twitchFollowerCache = { count: followerCount, fetchedAt: Date.now() };
        }
      }
    }

    return { title, viewerCount, followerCount };
  } catch {
    return { title: null, viewerCount: null, followerCount: null };
  }
}

export default async function StreamPage() {
  // Each read chains off its OWN dependency instead of a staged waterfall:
  // the platform-info reads need only `status`, the signed-in reads only
  // `session`, so a signed-in load never waits for Twitch/YouTube before
  // touching the DB. One barrier at the end.
  const sessionP = auth();
  const statusP = getStreamStatus();
  const vodsP = getVods();
  // The Home body, so the tab's first frame is the page — waited
  // on briefly: a cold cache (a Matrix read) must not hold the page.
  const homeP = getHomePayloadWithin(1500);
  const offP = modulesOff();

  const infoP = statusP.then((status) => {
    const live = !!status?.live;
    return Promise.all([
      getTwitchInfo(live),
      getYouTubeSubscriberCount(),
      instanceString("youtube.apiKey") && instanceString("platform.youtube.channelId")
        ? getChannelAvatar(instanceString("platform.youtube.channelId")!, instanceString("youtube.apiKey")!)
        : Promise.resolve(null),
    ]);
  });
  const userP = sessionP.then((session) =>
    session?.user?.id
      ? getUserContext(session.user.id)
      : NO_USER
  );
  // The newest page of chat history, so the column opens with its rows in the
  // HTML (chatHistorySeed.test.ts). Chained off the user read: a mod's page
  // carries struck-out deletions, and `myVote` needs the viewer. A failure
  // here costs the seed, never the page.
  const historyP = Promise.all([sessionP, userP]).then(([session, ctx]) =>
    latestChatHistory({ me: session?.user?.id ?? null, isMod: ctx.is_mod || ctx.is_admin }, CHAT_LIVE_CAP)
  ).catch(() => []);
  // The emotes those rows use, so they render as <img>s in the HTML and the
  // browser fetches them before any script runs (emoteSubset.ts). The manifest
  // is the route's own cached copy (30-min stale-while-revalidate), waited on
  // only briefly — a cold rebuild must not hold the page.
  const emotesP = Promise.all([historyP, manifestWithin().catch(() => ({}))])
    .then(([rows, manifest]) => emotesUsedBy(rows.map((m) => m.message), manifest));

  const [session, status, vods, [twitchInfo, ytSubscribers, ytAvatar], userCtx, messages, initialEmotes, home, off] =
    await Promise.all([sessionP, statusP, vodsP, infoP, userP, historyP, emotesP, homeP, offP]);

  const isLive = !!status?.live;
  const streamTitle = isLive ? twitchInfo.title ?? (process.env.STREAM_TITLE ?? "") : "";
  // Viewer count = stream-ingest's 60s snapshots via stream-api (all four
  // platforms combined); the Twitch API count is only a fallback. This seeds
  // the render — StreamView keeps it fresh via the 30s status poll.
  const viewerCount = isLive ? status?.viewers?.total ?? twitchInfo.viewerCount : null;
  const followerCount =
    twitchInfo.followerCount !== null || ytSubscribers !== null
      ? (twitchInfo.followerCount ?? 0) + (ytSubscribers ?? 0)
      : null;

  const canonicalId = userCtx.canonicalId;
  const isMod = userCtx.is_mod || userCtx.is_admin;

  return (
    <div className="h-full">
      {/* The page's one heading — visually the stream UI is its own title, but
          the document outline needs a root. */}
      <h1 className="sr-only">{siteName()} — live stream and community chat</h1>
      <SupportModulesOff off={off} />
      <StreamView
        isLive={isLive}
        vods={vods}
        homeInitial={home}
        streamTitle={streamTitle}
        viewerCount={viewerCount}
        initialYtVideoId={isLive && typeof status?.ytVideoId === "string" && status.ytVideoId ? status.ytVideoId : null}
        followerCount={followerCount}
        donateUrl={process.env.DONATE_URL ?? "/donate"}
        subscribeUrl={instanceString("money.subscribeUrl") ?? ""}
        spChannel={instanceString("platform.streamplace.channel") ?? ""}
        ytChannelId={instanceString("platform.youtube.channelId") ?? ""}
        twitchChannel={instanceString("platform.twitch.channel") ?? ""}
        streamerName={instanceString("streamer.displayName") ?? ""}
        streamerAvatar={process.env.STREAMER_AVATAR_URL ?? ytAvatar ?? "/api/streamer/avatar"}
        isSignedIn={!!session?.user}
        userId={session?.user?.id ?? null}
        canonicalId={canonicalId}
        isMod={isMod}
        isAdmin={userCtx.is_admin}
        initialMessages={messages}
        initialEmotes={initialEmotes}
        offModules={off}
        embedsOff={instanceList("player.embedsOff")}
      />
    </div>
  );
}
