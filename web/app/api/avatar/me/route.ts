import { getMatrixSession } from "@/app/lib/matrixSession";
import { imageContentType, MEDIA_SAFETY_HEADERS } from "@/app/lib/mediaHeaders";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { readBytesCapped, readJsonCapped, MATRIX_JSON_MAX_BYTES } from "@/app/lib/boundedBody";
import { AVATAR_MAX_BYTES } from "@/app/lib/avatarThumb";

// Bound each upstream hop — a hung homeserver must not stall the request
// (federated sessions make this a fetch to an arbitrary remote server).
const UPSTREAM_TIMEOUT_MS = 8000;

// Always read the LIVE Matrix profile so an avatar changed elsewhere (Element,
// mobile) shows immediately. site.users.avatar_url is still mirrored by reconcile
// + upload (for the future bulk member-list endpoint), but the single-image routes
// must stay live — a cached column behind the 1h reconcile throttle would lag the
// user's own pfp by up to an hour.
async function resolveAvatarMxc(homeserver: string, matrixId: string): Promise<string | null> {
  const prof = await homeserverFetch(
    `${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(matrixId)}/avatar_url`,
    { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
  ).catch(() => null);
  if (!prof || !prof.ok) return null;
  const data = (await readJsonCapped(prof, MATRIX_JSON_MAX_BYTES)) as { avatar_url?: unknown } | null;
  const mxc = data?.avatar_url;
  return typeof mxc === "string" && mxc.startsWith("mxc://") ? mxc : null;
}

export async function GET() {
  const mx = await getMatrixSession().catch(() => null);
  if (!mx) return new Response("Unauthorized", { status: 401 });
  const matrixId = mx.matrixId;
  const token: string | null = mx.accessToken;
  const homeserver = mx.homeserver;

  try {
    const avatar_url = await resolveAvatarMxc(homeserver, matrixId);
    if (!avatar_url) return new Response("No avatar", { status: 404 });

    // mxc://server/mediaId → authenticated thumbnail
    const [, , server, mediaId] = avatar_url.split("/");
    if (!server || !mediaId) return new Response("No avatar", { status: 404 });
    if (!token) return new Response("No token", { status: 404 });
    // Fetch the thumbnail via the session's OWN homeserver — a federated
    // account's token is only valid there, and their server pulls our hosted
    // media over federation. Hardcoding our homeserver here 502'd every
    // external-homeserver user (their token means nothing to our Synapse).
    const media = await homeserverFetch(
      `${homeserver}/_matrix/client/v1/media/thumbnail/${server}/${mediaId}?width=96&height=96&method=crop`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
    );
    if (!media.ok) return new Response("Media fetch failed", { status: 502 });
    // Read with the thumbnail ceiling: a federated homeserver decides what it sends.
    const bytes = await readBytesCapped(media, AVATAR_MAX_BYTES);
    if (!bytes) return new Response("Media fetch failed", { status: 502 });

    return new Response(bytes, {
      headers: {
        // Image-only route (Matrix thumbnail endpoint) — never reflect a
        // non-image upstream type, and mark the body inert if opened directly.
        "Content-Type": imageContentType(media.headers.get("content-type")),
        "Cache-Control": "private, max-age=600",
        ...MEDIA_SAFETY_HEADERS,
      },
    });
  } catch {
    return new Response("Error", { status: 500 });
  }
}
