import { instanceString } from "./instanceConfigServer.ts";
import { vodPlaylist } from "./vodPlaylist.ts";
// Past-broadcast VODs, mirrored from the install's YouTube playlist
// (platform.youtube.vodPlaylist — none set = no VODs, and no YouTube call).
// Curation lives in the playlist itself — add/remove a VOD by managing the
// playlist on YouTube; the site just reflects it.
//
// Primary read is the Data API (playlistItems.list, API key only, ~11 quota
// units per cache refresh): a playlist can hold hundreds of PRIVATE entries
// with new VODs appended near the BOTTOM, so the public playlist page only
// ever server-renders an old top slice and a scrape misses every newly added
// VOD (the list looks frozen). The API pages the whole playlist and we order
// by videoPublishedAt ourselves, so playlist position can't hide entries.
// The zero-quota page scrape (embedded ytInitialData, `lockupViewModel` items)
// remains as the no-key/API-failure fallback.

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type Vod = {
  /** YouTube video id — embed at /embed/{id}. */
  id: string;
  title: string;
  /** Human duration like "9:47:09", or null if YouTube didn't surface it. */
  duration: string | null;
  /** Relative recency like "22h ago" / "3 days ago", or null. */
  when: string | null;
};

// Playlist scrape is stable across requests; cache it for 30 min so the offline
// VOD grid doesn't re-scrape on every render. One playlist, one cache slot.
let cache: { vods: Vod[]; ts: number } | null = null;
const CACHE_MS = 30 * 60 * 1000;

// Deadline on each YouTube call. The VOD list is server-rendered into the page,
// so a hung Data API request would hold the whole render.
const VOD_FETCH_TIMEOUT_MS = 8_000;

// Pull a balanced {...} JSON object out of `html` immediately after `marker`,
// tracking string/escape state so braces inside string values (titles, URLs)
// don't throw off the depth count.
function extractJsonAfter(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

// Depth-first search for every `lockupViewModel` object (each playlist entry).
function collectLockups(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectLockups(v, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.lockupViewModel && typeof obj.lockupViewModel === "object") {
      out.push(obj.lockupViewModel as Record<string, unknown>);
    }
    for (const v of Object.values(obj)) collectLockups(v, out);
  }
}

// First value found for `key` anywhere under `node` (the lockup nests title /
// badges a few levels deep and the exact path drifts between YouTube revisions).
function deepFind(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = deepFind(v, key);
      if (r !== undefined) return r;
    }
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = deepFind(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

// Every string value stored under `key` anywhere within `node`, in document
// order (the lockup's metadata rows live at a few different depths).
function collectStrings(node: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key && typeof v === "string") out.push(v);
      else collectStrings(v, key, out);
    }
  }
  return out;
}

function parseVods(html: string): Vod[] {
  const json = extractJsonAfter(html, "ytInitialData");
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const lockups: Record<string, unknown>[] = [];
  collectLockups(data, lockups);

  const vods: Vod[] = [];
  const seen = new Set<string>();
  for (const lk of lockups) {
    const id = lk.contentId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
    // The metadata rows are, in order: title, channel name, view count, and a
    // recency line ("Streamed 22h ago"). Collect them and pick by shape.
    const rows = collectStrings(lk.metadata, "content");
    const title = rows[0] ?? "";
    const recency = rows.find((s) => /\bago\b/i.test(s)) ?? null;
    // Drop the "Streamed"/"Premiered" lead so the chip stays short ("22h ago").
    const when = recency ? recency.replace(/^(Streamed|Premiered|Started streaming)\s+/i, "") : null;
    // Duration is a thumbnail badge whose text reads like "9:47:09".
    const badges = deepFind(lk, "badges");
    let duration: string | null = null;
    if (Array.isArray(badges)) {
      for (const b of badges) {
        const t = (b as Record<string, unknown>)?.thumbnailBadgeViewModel;
        const text = t && typeof t === "object" ? (t as Record<string, unknown>).text : undefined;
        if (typeof text === "string" && /^\d+(:\d{2})+$/.test(text)) duration = text;
      }
    }
    seen.add(id);
    vods.push({ id, title, duration, when });
  }
  return vods;
}

// "9:47:09" / "47:09" from an ISO 8601 duration ("PT9H47M9S"). Null for the
// zero-length "P0D" YouTube reports while a broadcast is live or upcoming.
function fmtDuration(iso: string | undefined): string | null {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const mm = String(min).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Relative recency in the same style the playlist scrape surfaced ("22h ago",
// "4 days ago", "2 weeks ago", "1 month ago").
function fmtWhen(iso: string): string | null {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const h = ms / 3_600_000;
  const d = h / 24;
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
  if (d < 1) return `${Math.floor(h)}h ago`;
  if (d < 14) return `${Math.floor(d)} day${Math.floor(d) === 1 ? "" : "s"} ago`;
  if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 365) return `${Math.floor(d / 30)} month${Math.floor(d / 30) === 1 ? "" : "s"} ago`;
  return `${Math.floor(d / 365)} year${Math.floor(d / 365) === 1 ? "" : "s"} ago`;
}

const MAX_VODS = 40;

// Page the whole playlist via the Data API (1 unit per 50 items), keep the
// public/unlisted entries, order by real publish date, and read durations for
// the survivors in one videos.list call.
async function fetchVodsViaApi(key: string, playlist: string): Promise<Vod[]> {
  type Item = {
    snippet?: { title?: string };
    contentDetails?: { videoId?: string; videoPublishedAt?: string };
    status?: { privacyStatus?: string };
  };
  const items: Item[] = [];
  let pageToken = "";
  for (let page = 0; page < 12; page++) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", playlist);
    url.searchParams.set("key", key);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { signal: AbortSignal.timeout(VOD_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`playlistItems ${res.status}`);
    const j = (await res.json()) as { items?: Item[]; nextPageToken?: string };
    items.push(...(j.items ?? []));
    pageToken = j.nextPageToken ?? "";
    if (!pageToken) break;
  }

  const visible = items
    .filter(
      (i) =>
        (i.status?.privacyStatus === "public" || i.status?.privacyStatus === "unlisted") &&
        i.contentDetails?.videoId &&
        i.contentDetails.videoPublishedAt,
    )
    .sort((a, b) =>
      b.contentDetails!.videoPublishedAt!.localeCompare(a.contentDetails!.videoPublishedAt!),
    )
    .slice(0, MAX_VODS);
  if (!visible.length) return [];

  const durations = new Map<string, string | null>();
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", visible.map((i) => i.contentDetails!.videoId!).join(","));
    url.searchParams.set("key", key);
    const res = await fetch(url, { signal: AbortSignal.timeout(VOD_FETCH_TIMEOUT_MS) });
    if (res.ok) {
      const j = (await res.json()) as { items?: { id?: string; contentDetails?: { duration?: string } }[] };
      for (const v of j.items ?? []) {
        if (v.id) durations.set(v.id, fmtDuration(v.contentDetails?.duration));
      }
    }
  } catch {
    // durations are cosmetic — the grid renders fine without them
  }

  return visible.map((i) => ({
    id: i.contentDetails!.videoId!,
    title: i.snippet?.title ?? "",
    duration: durations.get(i.contentDetails!.videoId!) ?? null,
    when: fmtWhen(i.contentDetails!.videoPublishedAt!),
  }));
}

async function fetchVodsViaScrape(playlist: string): Promise<Vod[]> {
  const res = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlist)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(VOD_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`playlist page ${res.status}`);
  return parseVods(await res.text());
}

export async function getVods(): Promise<Vod[]> {
  const playlist = vodPlaylist();
  if (!playlist) return [];
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.vods;

  const key = instanceString("youtube.apiKey");
  let vods: Vod[] = [];
  if (key) {
    try {
      vods = await fetchVodsViaApi(key, playlist);
    } catch {
      // quota/network hiccup — fall through to the scrape
    }
  }
  if (!vods.length) {
    try {
      vods = await fetchVodsViaScrape(playlist);
    } catch {
      return cache?.vods ?? [];
    }
  }
  // Only overwrite a good cache on success; a transient empty result keeps
  // serving the last known list rather than blanking the grid.
  if (vods.length || !cache) cache = { vods, ts: Date.now() };
  return cache.vods;
}
