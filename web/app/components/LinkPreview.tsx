"use client";

import { useState, useEffect } from "react";
import { getJson } from "@/app/lib/http";
import { fitMediaBox } from "@/app/lib/mediaFit";
import { previewImageUrl } from "@/app/lib/previewImage";

// ─── URL embed preview ────────────────────────────────────────────────────────

type OGData = {
  title?: string | null; description?: string | null; image?: string | null; siteName?: string | null;
  /** A first-party post card (tweetCard.ts) — rendered as a post, not a side-image card. */
  kind?: "post";
  avatar?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  stats?: string;
};

// Process-lifetime OG cache so re-rendering / re-entering a room shows embeds
// instantly instead of re-fetching and popping them in after the chat. `null`
// is a negative result (fetched, no usable preview); in-flight fetches are
// shared so duplicate URLs only hit /api/og once.
const ogCache = new Map<string, OGData | null>();
const ogInflight = new Map<string, Promise<OGData | null>>();

function fetchOG(url: string): Promise<OGData | null> {
  if (ogCache.has(url)) return Promise.resolve(ogCache.get(url) ?? null);
  let p = ogInflight.get(url);
  if (!p) {
    p = getJson<OGData | null>(`/api/og?url=${encodeURIComponent(url)}`)
      .then((raw) => {
        // The image URLs come from an arbitrary page: only absolute http(s) ones are rendered — a
        // relative og:image would be a same-origin GET with the viewer's cookies (previewImage.ts).
        const d = raw ? { ...raw, image: previewImageUrl(raw.image), avatar: previewImageUrl(raw.avatar) } : null;
        const val = d && (d.title || d.image) ? d : null;
        ogCache.set(url, val);
        ogInflight.delete(url);
        return val;
      })
      .catch(() => { ogCache.set(url, null); ogInflight.delete(url); return null; });
    ogInflight.set(url, p);
  }
  return p;
}

// Reusable OG fetch for callers that want just the data (e.g. forum cards
// rendering an embed thumbnail). Pass null to skip. Reads the shared cache so
// it never refetches a URL the timeline already resolved.
export function useOgData(url: string | null): OGData | null {
  const [data, setData] = useState<OGData | null>(() => (url ? ogCache.get(url) ?? null : null));
  // URL change re-seeds from the shared cache at render time; the effect only
  // fetches misses (setData fires in the .then callback).
  const [prevUrl, setPrevUrl] = useState(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setData(url ? ogCache.get(url) ?? null : null);
  }
  useEffect(() => {
    if (!url || ogCache.has(url)) return;
    let active = true;
    fetchOG(url).then(d => { if (active) setData(d); });
    return () => { active = false; };
  }, [url]);
  return data;
}

// A post (e.g. a tweet): author line, the text, ONE image in the same box an
// attachment gets, and the counts. Discord's FixTweet embed, first-party.
function PostCard({ url, data }: { url: string; data: OGData }) {
  const fit = fitMediaBox(data.imageWidth, data.imageHeight);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 block max-w-[34rem] rounded-lg border border-edge bg-surface-1 hover:bg-surface-2 transition-colors p-3"
      style={{ borderLeft: "3px solid var(--accent)" }}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 min-w-0">
        {data.avatar && (
          <img src={data.avatar} alt="" className="h-6 w-6 rounded-full shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
        )}
        <p className="text-sm font-semibold text-heading truncate">{data.title}</p>
        {data.siteName && <p className="text-3xs text-muted uppercase tracking-wide shrink-0">{data.siteName}</p>}
      </div>
      {data.description && <p className="text-sm text-body mt-1 whitespace-pre-line line-clamp-6">{data.description}</p>}
      {data.image && (
        <img
          src={data.image}
          alt=""
          className="rounded-md mt-2 block img-shadow-chat"
          style={fit ? { width: fit.width, aspectRatio: fit.aspect, maxWidth: "100%", height: "auto" } : { maxWidth: "100%", maxHeight: "18rem", height: "auto" }}
          onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      {data.stats && <p className="text-xs text-muted mt-2">{data.stats}</p>}
    </a>
  );
}

export function LinkPreview({ url }: { url: string }) {
  // Seed synchronously from cache so a known embed renders on first paint.
  const [data, setData] = useState<OGData | null>(() => ogCache.get(url) ?? null);
  const [resolved, setResolved] = useState<boolean>(() => ogCache.has(url));

  // URL change re-seeds from the shared cache at render time; the effect only
  // fetches misses (setStates fire in the .then callback).
  const [prevUrl, setPrevUrl] = useState(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setData(ogCache.get(url) ?? null);
    setResolved(ogCache.has(url));
  }
  useEffect(() => {
    if (ogCache.has(url)) return;
    let active = true;
    fetchOG(url).then(d => { if (active) { setData(d); setResolved(true); } });
    return () => { active = false; };
  }, [url]);

  if (!data || (!data.title && !data.image)) {
    // Once resolved with no usable preview, render nothing. While still loading,
    // reserve the embed's height so it doesn't shove the message down on arrival.
    if (resolved) return null;
    // Skeleton reserves the SAME height as the resolved card so OG data
    // arriving later doesn't shove the message down (no layout shift).
    return (
      <div
        aria-hidden
        className="mt-2 max-w-lg h-32 rounded-lg border border-edge bg-surface-1 animate-pulse"
        style={{ borderLeft: "3px solid var(--accent)" }}
      />
    );
  }

  if (data.kind === "post") return <PostCard url={url} data={data} />;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 flex h-32 max-w-lg rounded-lg border border-edge bg-surface-1 hover:bg-surface-2 transition-colors overflow-hidden"
      style={{ borderLeft: "3px solid var(--accent)" }}
      onClick={e => e.stopPropagation()}
    >
      <div className="min-w-0 flex-1 self-center p-3">
        {data.siteName && (
          <p className="text-3xs text-muted uppercase tracking-wide mb-0.5 truncate">{data.siteName}</p>
        )}
        {data.title && (
          <p className="text-sm font-semibold text-heading leading-snug line-clamp-2">{data.title}</p>
        )}
        {data.description && (
          <p className="text-xs text-secondary mt-1 line-clamp-2">{data.description}</p>
        )}
      </div>
      {data.image && (
        <img
          src={data.image}
          alt=""
          className="h-full w-32 object-cover shrink-0 img-shadow-chat"
          onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
    </a>
  );
}
