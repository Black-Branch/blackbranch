// The Stream tab's Platforms section: one row per platform — set up or not, its embed switch, its
// current title where a key the site already holds can READ it, and the platform's own page for
// changing it. Nothing here writes to a platform: no token the site holds can. Server only (the
// app tokens and the API key never leave it).
import { instanceList, instanceString } from "./instanceConfigServer";
import { twitchAppToken, twitchBroadcasterId, twitchClientId } from "./twitch";
import { liveSourcesOn, type LiveSource } from "./playerSource";
import type { PlatformKey, PlatformRow } from "./streamStats";

const TITLE_TTL_MS = 2 * 60_000;
const YT_TITLE_TTL_MS = 5 * 60_000;
let titleCache: { at: number; twitch: Title; kick: Title } | null = null;
let ytCache: { at: number; videoId: string; title: Title } | null = null;
type Title = { title: string | null; category: string | null; note: string };

const NOT_SET: Title = { title: null, category: null, note: "Not set up" };

async function twitchTitle(): Promise<Title> {
  const channel = instanceString("platform.twitch.channel");
  if (!channel) return NOT_SET;
  const token = await twitchAppToken();
  if (!token) return { title: null, category: null, note: "Needs the Twitch app credentials (Admin → Platforms → Twitch)" };
  const headers = { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() };
  try {
    let id = twitchBroadcasterId();
    if (!id) {
      const u = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`, { headers, signal: AbortSignal.timeout(5000), cache: "no-store" });
      id = u.ok ? ((await u.json()) as { data?: { id?: string }[] }).data?.[0]?.id ?? null : null;
    }
    if (!id) return { title: null, category: null, note: "Twitch did not find the channel" };
    const r = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!r.ok) return { title: null, category: null, note: `Twitch answered ${r.status}` };
    const c = ((await r.json()) as { data?: { title?: string; game_name?: string }[] }).data?.[0];
    return { title: c?.title || null, category: c?.game_name || null, note: "From Twitch" };
  } catch {
    return { title: null, category: null, note: "Twitch did not answer" };
  }
}

// Kick's public API takes an APP token (client credentials) — the same pair the site's Kick sign-in
// uses, which web already holds. Cached until a minute before it expires.
let kickToken: { value: string; expiresAt: number } | null = null;
async function kickAppToken(): Promise<string | null> {
  if (kickToken && Date.now() < kickToken.expiresAt) return kickToken.value;
  const id = instanceString("kick.clientId");
  const secret = instanceString("kick.clientSecret");
  if (!id || !secret) return null;
  try {
    const res = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
      signal: AbortSignal.timeout(5000), cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    kickToken = { value: j.access_token, expiresAt: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return kickToken.value;
  } catch {
    return null;
  }
}

async function kickTitle(): Promise<Title> {
  const slug = instanceString("platform.kick.slug");
  if (!slug) return NOT_SET;
  const token = await kickAppToken();
  if (!token) return { title: null, category: null, note: "Needs the Kick app credentials (Admin → Platforms → Kick)" };
  try {
    const r = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(5000), cache: "no-store",
    });
    if (r.status === 401) kickToken = null;
    if (!r.ok) return { title: null, category: null, note: `Kick answered ${r.status}` };
    const c = ((await r.json()) as { data?: { stream_title?: string; category?: { name?: string } }[] }).data?.[0];
    return { title: c?.stream_title || null, category: c?.category?.name || null, note: "From Kick" };
  } catch {
    return { title: null, category: null, note: "Kick did not answer" };
  }
}

// YouTube: only the live broadcast's title, by its confirmed id — one quota unit, at most once per
// five minutes per server. Offline there is no broadcast to read.
async function youtubeTitle(videoId: string | null): Promise<Title> {
  if (!instanceString("platform.youtube.channelId")) return NOT_SET;
  if (!videoId) return { title: null, category: null, note: "Read while live on YouTube" };
  const key = instanceString("youtube.apiKey");
  if (!key) return { title: null, category: null, note: "Needs the YouTube API key (Admin → Platforms → YouTube)" };
  if (ytCache && ytCache.videoId === videoId && Date.now() - ytCache.at < YT_TITLE_TTL_MS) return ytCache.title;
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    const sn = r.ok ? ((await r.json()) as { items?: { snippet?: { title?: string } }[] }).items?.[0]?.snippet : undefined;
    const title: Title = r.ok ? { title: sn?.title || null, category: null, note: "From YouTube" } : { title: null, category: null, note: `YouTube answered ${r.status}` };
    ytCache = { at: Date.now(), videoId, title };
    return title;
  } catch {
    return { title: null, category: null, note: "YouTube did not answer" };
  }
}

/** The chat platforms set up on this install — one rule for the Stream tab's rows and the About
 *  page's chat list. YouTube is the module's (moduleRunningServer.ts), not here. */
export function chatPlatformsSetUp(): { twitch: boolean; kick: boolean; streamplace: boolean } {
  return {
    twitch: !!instanceString("platform.twitch.channel"),
    kick: !!instanceString("platform.kick.slug"),
    streamplace: !!(instanceString("platform.streamplace.did") || instanceString("platform.streamplace.channel")),
  };
}

/** Every platform's row. `ytVideoId` is the confirmed live broadcast (stream-api /stream/current). */
export async function platformRows(ytVideoId: string | null): Promise<PlatformRow[]> {
  if (!titleCache || Date.now() - titleCache.at > TITLE_TTL_MS) {
    const [twitch, kick] = await Promise.all([twitchTitle(), kickTitle()]);
    titleCache = { at: Date.now(), twitch, kick };
  }
  const yt = await youtubeTitle(ytVideoId);
  const on = liveSourcesOn(instanceList("player.embedsOff"));
  const embed = (source: LiveSource) => ({ source, on: on.includes(source) });
  const twitchChannel = instanceString("platform.twitch.channel");
  const ytChannel = instanceString("platform.youtube.channelId");
  const setUp = chatPlatformsSetUp();
  const spSetUp = setUp.streamplace;
  const none = (note: string): Title => ({ title: null, category: null, note });
  const sp = spSetUp ? none("Not read") : NOT_SET;
  const row = (key: PlatformKey, label: string, setUp: boolean, e: PlatformRow["embed"], t: Title, manageUrl: string | null, sub: string): PlatformRow =>
    ({ key, label, setUp, embed: e, title: t.title, category: t.category, titleNote: t.note, manageUrl, setupHref: `/admin/platforms?sub=${sub}` });
  return [
    row("twitch", "Twitch", setUp.twitch, embed("twitch"), titleCache.twitch,
      twitchChannel ? `https://dashboard.twitch.tv/u/${encodeURIComponent(twitchChannel)}/stream-manager` : null, "twitch"),
    row("youtube", "YouTube", !!ytChannel, embed("youtube"), yt,
      ytChannel ? `https://studio.youtube.com/channel/${encodeURIComponent(ytChannel)}/livestreaming` : null, "youtube"),
    row("kick", "Kick", setUp.kick, null, titleCache.kick,
      instanceString("platform.kick.slug") ? "https://dashboard.kick.com/" : null, "kick"),
    row("streamplace", "stream.place", spSetUp, embed("streamplace"), sp, null, "streamplace"),
    row("native", "Site player", spSetUp, embed("native"), spSetUp ? none("Plays the stream.place stream") : NOT_SET, null, "streamplace"),
  ];
}
