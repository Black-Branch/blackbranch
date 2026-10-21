"use client";

// The real fetch/warm wiring for profileCardCache.ts (kept apart so the cache
// core stays dependency-free and node --test-importable).
//
// One prefetch = the whole card, warm: the six JSON payloads batched (two
// waves, one resolution — stats/credit need the canonical id /api/me may have
// to supply), plus the pixels the card paints with:
//   - banner + avatar images via `new Image()` (the media proxy serves the
//     banner `public, max-age=86400, immutable`, so the card's <img> is a
//     cache hit);
//   - the equipped username font face via document.fonts.load — the card's
//     StyledName renders at the same 600 weight chat uses, so if the viewer's
//     own name has already scrolled by in chat the face is warm anyway; this
//     covers the session where it hasn't.

import { getJson } from "@/app/lib/http";
import { mxcToScaled, mxcToDownload } from "@/app/lib/matrixMedia";
import { usernameStyleCSS, type EquippedStyle } from "@/app/lib/usernameStyles";
import { refreshCoinBalance } from "@/app/lib/useCoinBalance";
import {
  createProfileCardCache,
  type MeSummary,
  type ProfileCardData,
  type ProfileCardIds,
  type ProfileStats,
} from "@/app/lib/profileCardCache";

async function loadProfileCard(ids: ProfileCardIds): Promise<ProfileCardData> {
  // Nudge the shared coin-balance store (the card's currency row reads it via
  // useCoinBalance). Inside the loader on purpose: the loader only runs when
  // the batch isn't fresh/coalesced, so hover-spam can't fire repeated
  // balance fetches — it rides the same 15s freshness as everything else.
  refreshCoinBalance();
  // Wave 1 — everything keyed on the session alone. Per-fetch catches match
  // the card's old per-fetch semantics: one failing endpoint degrades that
  // section, never the batch.
  const [me, pronouns, color, style, linkedPlatforms] = await Promise.all([
    getJson<MeSummary>("/api/me").catch(() => null),
    getJson<{ pronouns?: string | null }>("/api/me/pronouns")
      .then((d) => d?.pronouns ?? null).catch(() => null),
    getJson<{ color?: string | null }>("/api/me/color")
      .then((d) => d?.color ?? null).catch(() => null),
    getJson<{ style?: EquippedStyle | null }>("/api/me/style")
      .then((d) => d?.style ?? null).catch(() => null),
    getJson<{ accounts?: { platform: string }[] }>("/api/account-links")
      .then((d) => (d?.accounts ?? []).map((a) => a.platform)).catch(() => [] as string[]),
  ]);

  // Wave 2 — needs the canonical id (prop wins; else the one /api/me returns —
  // same fallback the card used, for the /community mounts that pass none).
  const canonicalId = ids.canonicalId ?? me?.canonicalId ?? null;
  const creditQ = new URLSearchParams({ matrixId: ids.matrixId });
  if (canonicalId) creditQ.set("canonicalId", canonicalId);
  const [stats, credit] = await Promise.all([
    canonicalId
      ? getJson<ProfileStats>(`/api/user/${encodeURIComponent(canonicalId)}`)
          .catch(() => ({ found: false } as ProfileStats))
      : Promise.resolve(null),
    getJson<{ credit?: number }>(`/api/user/credit?${creditQ}`)
      .then((d) => (typeof d?.credit === "number" ? d.credit : 0))
      .catch(() => 0),
  ]);

  return { me, pronouns, color, style, linkedPlatforms, stats, credit };
}

// Monotonic cache-buster for /api/avatar/me, shared by the chat-bar thumbnail,
// the card, and the prefetch warm — one version means the warm always fetches
// the exact URL the card will render, including after an avatar change (a
// card that reset to v=0 on every mount would serve a mid-session change as the
// stale browser-cached image until its max-age expired).
let avatarVersion = 0;
export function currentAvatarVersion(): number {
  return avatarVersion;
}
export function bumpAvatarVersion(): number {
  return ++avatarVersion;
}

/** Pre-DECODE the images the card paints with — the same URLs its <img>s use,
 *  so they share the decoded-image cache. `new Image().src` alone warms only
 *  the bytes: the decode still runs inside the first slide (a production trace
 *  showed 43 + 35 ms on raster threads 117 ms into the entry). decode()
 *  is best-effort — a rejection (a 404, a hidden document) changes nothing,
 *  except for the banner: Synapse refuses to thumbnail an image over its
 *  max_image_pixels (32 MP), and the card's <img> then falls back to the
 *  download (onScaledError). Warming that same url in the thumbnail's catch
 *  puts the oversize decode at idle instead of inside the first slide. */
function warmAssets(d: ProfileCardData): void {
  if (typeof window === "undefined") return;
  const banner = mxcToScaled(d.me?.bannerMxc);
  if (banner) {
    warmImage(banner).catch(() => {
      const full = mxcToDownload(d.me?.bannerMxc);
      if (full) warmImage(full).catch(() => {});
    });
  }
  warmImage(`/api/avatar/me?v=${avatarVersion}`).catch(() => {});
  warmUsernameFont(d.style);
}

function warmImage(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  return img.decode();
}

// Load the viewer's own equipped display face at the weight the card (and
// chat) render it: 600. document.fonts.load can't resolve var() references, so
// the next/font CSS variable is read off the root element first. Each display
// face ships a single file, so one load covers every weight the page uses.
function warmUsernameFont(style: EquippedStyle | null): void {
  if (!style?.font || typeof document === "undefined" || !document.fonts) return;
  const family = usernameStyleCSS(style, "#ffffff").fontFamily;
  const varName = /var\((--[\w-]+)\)/.exec(String(family ?? ""))?.[1];
  if (!varName) return;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!resolved) return;
  document.fonts.load(`600 16px ${resolved}`).catch(() => {});
}

const cache = createProfileCardCache(loadProfileCard, warmAssets);

/** Warm (or coalesce onto) the full card batch. */
export function prefetchProfileCard(ids: ProfileCardIds): Promise<ProfileCardData> {
  return cache.prefetch(ids);
}

/** Synchronous cached snapshot (null when cold / a different account). */
export function readProfileCard(matrixId: string): ProfileCardData | null {
  return cache.read(matrixId);
}

/** Keep the cache honest when the editor changes something in place. */
export function patchProfileCardMe(matrixId: string, partial: Partial<MeSummary>): void {
  cache.patchMe(matrixId, partial);
}

/** Drop the cached batch after a profile edit (color, style, pronouns, display
 *  name) so a close+reopen inside the freshness window refetches instead of
 *  showing the pre-edit values. */
export function invalidateProfileCard(): void {
  cache.invalidate();
}
