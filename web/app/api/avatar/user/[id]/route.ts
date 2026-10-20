import { NextRequest } from "next/server";
import { getMatrixSession } from "@/app/lib/matrixSession";
import { avatarBg } from "@/app/lib/avatarColor";
import { imageContentType, MEDIA_SAFETY_HEADERS } from "@/app/lib/mediaHeaders";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { makeMicroCache } from "@/app/lib/avatarMicroCache";
import { matrixBaseUrl } from "@/app/lib/matrixConfig";
import { isLocalHomeserverUrl } from "@/app/lib/homeserverTrust";
import { createConcurrencyGate } from "@/app/lib/concurrencyGate";
import {
  createAvatarThumbLoader, AVATAR_CACHE_MAX_BYTES, AVATAR_GATE_LIMITS, AVATAR_REMOTE_GATE_LIMITS, type AvatarBytes,
} from "@/app/lib/avatarThumb";
import { readJsonCapped, MATRIX_JSON_MAX_BYTES } from "@/app/lib/boundedBody";

// Bound each upstream hop — a hung homeserver must not stall the request
// (federated sessions make this a fetch to an arbitrary remote server).
const UPSTREAM_TIMEOUT_MS = 8000;

// In-process burst collapse: without it every request pays a
// full profile resolve + thumbnail fetch against Synapse (both no-store), and
// the response cache is private — so N viewers opening one profile card cost
// 2N Synapse hits. 60s keeps the route's live-profile intent (the comment on
// resolveAvatarMxc rejects the 1h mirror; a minute of lag is invisible).
// The avatar is the target user's PUBLIC profile image, so serving one
// signed-in viewer's fetch to another signed-in viewer leaks nothing — but
// the lookup sits AFTER the token gate: signed-out viewers keep the letter
// fallback by design. Only our own homeserver's bytes go in (avatarThumb.ts).
const avatarCache = makeMicroCache<AvatarBytes>({
  ttlMs: 60_000,
  max: 500,
  weigh: (v) => v.bytes.byteLength,
  maxWeight: AVATAR_CACHE_MAX_BYTES,
});

// Bounds the bytes held in flight; fetches through a homeserver that is not
// ours also pass a smaller share of their own, so a stalled federated server
// cannot hold every slot (the limits and why: avatarThumb.ts).
const avatarGate = createConcurrencyGate(AVATAR_GATE_LIMITS);

// Deterministic letter-circle SVG, matching the client-side fallback (avatarBg +
// first initial). Returned with 200 for the no-avatar / no-token / fetch-fail
// cases so the <img> always resolves to a valid image — no console 404/401 and no
// broken-image onError. Short cache so it flips to a real avatar promptly once the
// user sets one.
function letterAvatar(matrixId: string): Response {
  const local = matrixId.replace(/^@/, "").replace(/:.*$/, "") || "?";
  const letter = (local.trim().charAt(0) || "?").toUpperCase();
  const esc = letter.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="${avatarBg(local)}"/>` +
    `<text x="48" y="48" font-family="system-ui,sans-serif" font-size="48" font-weight="600" ` +
    `fill="#fff" text-anchor="middle" dominant-baseline="central">${esc}</text></svg>`;
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=300" },
  });
}

// Always read the LIVE Matrix profile so an externally-changed avatar shows
// immediately. site.users.avatar_url is still mirrored by reconcile + upload for a
// future bulk member-list endpoint, but the single-image route stays live (a cached
// column behind the 1h reconcile throttle would lag avatars by up to an hour).
async function resolveAvatarMxc(matrixId: string): Promise<string | null> {
  const prof = await fetch(
    `${matrixBaseUrl()}/_matrix/client/v3/profile/${encodeURIComponent(matrixId)}/avatar_url`,
    { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
  ).catch(() => null);
  if (!prof || !prof.ok) return null;
  const data = (await readJsonCapped(prof, MATRIX_JSON_MAX_BYTES)) as { avatar_url?: unknown } | null;
  const mxc = data?.avatar_url;
  return typeof mxc === "string" && mxc.startsWith("mxc://") ? mxc : null;
}

const loadAvatarThumb = createAvatarThumbLoader({
  resolveMxc: resolveAvatarMxc,
  fetch: homeserverFetch,
  isLocal: (hs) => isLocalHomeserverUrl(hs),
  gate: avatarGate,
  remoteGate: createConcurrencyGate(AVATAR_REMOTE_GATE_LIMITS),
  cache: avatarCache,
  contentType: imageContentType,
  timeoutMs: UPSTREAM_TIMEOUT_MS,
});

// GET /api/avatar/user/[id] — avatar thumbnail for any Matrix user, for the
// profile card. The mxc URL comes from the public profile endpoint; the media
// itself needs an authenticated fetch, so the signed-in viewer's token is used,
// against the viewer's OWN homeserver (a federated token is only valid there).
// Signed-out viewers, and every failure, get the letter circle.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const matrixId = decodeURIComponent(id ?? "");
  if (!/^@[^\s:/]+:[A-Za-z0-9.-]+$/.test(matrixId)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Signed-out viewers (no token) can't fetch protected media — fall back to the
  // letter avatar instead of a 401 so the image still resolves cleanly.
  const mx = await getMatrixSession().catch(() => null);
  if (!mx?.accessToken) return letterAvatar(matrixId);

  const thumb = await loadAvatarThumb(matrixId, { homeserver: mx.homeserver, accessToken: mx.accessToken });
  if (thumb) {
    return new Response(thumb.bytes, {
      headers: {
        // Image-only route (Matrix thumbnail endpoint) — never reflect a
        // non-image upstream type, and mark the body inert if opened directly.
        "Content-Type": thumb.contentType,
        "Cache-Control": "private, max-age=600",
        ...MEDIA_SAFETY_HEADERS,
      },
    });
  }
  return letterAvatar(matrixId);
}
