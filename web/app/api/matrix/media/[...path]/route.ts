import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { getMatrixSession } from "@/app/lib/matrixSession";
import { proxiedContentType, mediaDisposition, MEDIA_SAFETY_HEADERS } from "@/app/lib/mediaHeaders";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { installValue } from "@/app/lib/installValues";
import { matrixBaseUrl } from "@/app/lib/matrixConfig";
import { relayMedia } from "@/app/lib/mediaRelay";
import { createConcurrencyGate } from "@/app/lib/concurrencyGate";
import { federatedPolicyVersion } from "@/app/lib/federatedSignInSwitch";

// Bound each upstream hop; the loop tries up to 3 URLs, so without this a hung
// homeserver could stack multiple unbounded waits per request.
const UPSTREAM_TIMEOUT_MS = 8000;

// The body is streamed through, never buffered (mediaRelay.ts). The cap sits above Synapse's default max_upload_size (50 MB); the
// deadline above also ends a transfer still running after 8 s. The gate bounds
// open relays and keeps a short
// queue — a chat screen asks for dozens of avatars at once, so a waiter is
// served when a slot frees rather than refused outright.
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
// A relay also ends on its own clock: the viewer's side is pull-based, so one
// that stops reading would otherwise hold its slot until it disconnects. Each
// relay is handed its fetch's deadline signal, which ends it within the 8 s
// above; this bound is the backstop just past that, so no transfer that the
// deadline allows is ever cut by it.
const RELAY_MAX_MS = UPSTREAM_TIMEOUT_MS + 2000;
const mediaGate = createConcurrencyGate({ maxConcurrent: 24, maxQueued: 200, maxWaitMs: 5000 });
// The type is the allowlist's (mediaHeaders.ts): anything it refuses goes out as a download, with
// Synapse's own Content-Disposition kept when it already says attachment.
const mediaHeaders = (upstream: Response): Record<string, string> => {
  const contentType = proxiedContentType(upstream.headers.get("content-type"), "image/jpeg");
  const disposition = mediaDisposition(contentType, upstream.headers.get("content-disposition"));
  return {
    "Content-Type": contentType,
    ...(disposition ? { "Content-Disposition": disposition } : {}),
    "Cache-Control": "private, max-age=86400, immutable",
    "Access-Control-Allow-Origin": installValue("site.origin"),
    ...MEDIA_SAFETY_HEADERS,
  };
};

// In-memory session cache to avoid a session resolve on every media request.
// Keyed by matrixId; short TTL; invalidated on 401/403 from upstream. Carries
// the session's homeserver alongside the token: a federated account's token is
// only valid on its OWN homeserver, so the two must always travel together. Each entry also carries the federated sign-in policy it was
// made under (federatedSignInSwitch.ts): a hit made under another policy is a miss, so a server
// the policy has just refused is never served from here.
const sessionCache = new Map<string, { token: string; homeserver: string; until: number; policy: string }>();
const CACHE_TTL_MS = 60_000;

async function fetchMxSession(): Promise<{ token: string; homeserver: string } | null> {
  try {
    const mx = await getMatrixSession();
    return mx?.accessToken ? { token: mx.accessToken, homeserver: mx.homeserver } : null;
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // Validate the FULL catch-all, not just the first three segments. With only
  // path[0..2] checked, a request like
  //   /download/x/y/../../../../_matrix/client/v3/account/whoami
  // would ride extra `..` segments through; the fetch URL parser normalizes
  // them and ESCAPES the media prefix, making this a bearer-token-attached proxy
  // to arbitrary homeserver endpoints. Validating every segment and capping the
  // length makes the join safe: each part is a known-good token.
  const ALLOWED_OPS = new Set(["download", "thumbnail", "upload"]);
  const op = path[0];
  if (!op || !ALLOWED_OPS.has(op)) return new Response(null, { status: 400 });
  const server = path[1];
  if (server !== undefined && !/^[a-zA-Z0-9.\-]+(:[0-9]+)?$/.test(server)) return new Response(null, { status: 400 });
  const mediaId = path[2];
  if (mediaId !== undefined && !/^[a-zA-Z0-9_\-]+$/.test(mediaId)) return new Response(null, { status: 400 });
  // download may carry an optional trailing filename (path[3]); nothing beyond it
  // is a legitimate Matrix media path. Reject extra segments and any that could
  // traverse. The charset here forbids "/" and "..".
  if (path.length > 4) return new Response(null, { status: 400 });
  const fileName = path[3];
  if (fileName !== undefined && !/^[a-zA-Z0-9._\-]+$/.test(fileName)) return new Response(null, { status: 400 });
  if (fileName === "." || fileName === "..") return new Response(null, { status: 400 });

  const upstreamPath = path.join("/");

  const search = req.nextUrl.search;

  let token: string | null = null;
  // Authenticated fetches go through the session's OWN homeserver — a federated
  // account's token means nothing to our Synapse (it 401s, and the legacy
  // unauthenticated fallback below is refused by modern servers, which would
  // leave external-homeserver users with broken media). Their server pulls
  // our homeserver's media over federation. Unauthenticated fallbacks stay on ours.
  let hsBase = matrixBaseUrl();
  let matrixId: string | null = null;
  try {
    const session = await auth();
    matrixId = session?.user?.id ?? null;
    if (matrixId) {
      const cached = sessionCache.get(matrixId);
      if (cached && cached.until > Date.now() && cached.policy === federatedPolicyVersion()) {
        token = cached.token;
        hsBase = cached.homeserver;
      } else {
        const mx = await fetchMxSession();
        if (mx) {
          token = mx.token;
          hsBase = mx.homeserver;
          sessionCache.set(matrixId, { ...mx, until: Date.now() + CACHE_TTL_MS, policy: federatedPolicyVersion() });
        }
      }
    }
  } catch (e) {
    // Falls back to an unauthenticated media fetch below; log so a broken auth/token
    // path is observable instead of silently degrading every avatar to anonymous.
    console.error("[matrix/media] auth/token failed:", (e as Error).message);
  }

  // Build URL list: authenticated v1 (session's homeserver) first, then legacy
  // unauthenticated fallbacks on ours. The trailing v1 entry only applies to
  // signed-out requests — with a token it would either duplicate the first URL
  // (local session) or attach a foreign token to our server (federated → 401).
  const tryUrls = [
    ...(token
      ? [`${hsBase}/_matrix/client/v1/media/${upstreamPath}${search}`]
      : []),
    `${matrixBaseUrl()}/_matrix/media/v3/${upstreamPath}${search}`,
    ...(token ? [] : [`${matrixBaseUrl()}/_matrix/client/v1/media/${upstreamPath}${search}`]),
  ];

  let tokenRefreshed = false;

  const release = await mediaGate.acquire();
  if (!release) return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
  let handedOff = false;
  try {
    for (const url of tryUrls) {
      const isAuthUrl = url.includes("/_matrix/client/v1/media/") && !!token;
      const headers: Record<string, string> = { Accept: "image/*,*/*" };
      if (isAuthUrl) headers.Authorization = `Bearer ${token}`;

      const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const upstream = await homeserverFetch(url, { headers, signal }).catch(() => null);

      if (!upstream) continue;

      // On 401/403 with a cached token, clear cache and retry with fresh token once.
      if ((upstream.status === 401 || upstream.status === 403) && matrixId && !tokenRefreshed) {
        sessionCache.delete(matrixId);
        const mx = await fetchMxSession();
        if (mx) {
          token = mx.token;
          hsBase = mx.homeserver;
          sessionCache.set(matrixId, { ...mx, until: Date.now() + CACHE_TTL_MS, policy: federatedPolicyVersion() });
          tokenRefreshed = true;
          // Retry this URL with fresh token.
          const retryHeaders: Record<string, string> = { Accept: "image/*,*/*", Authorization: `Bearer ${token}` };
          const retrySignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          const retry = await homeserverFetch(`${hsBase}/_matrix/client/v1/media/${upstreamPath}${search}`, { headers: retryHeaders, signal: retrySignal }).catch(() => null);
          if (retry?.ok) {
            void upstream.body?.cancel().catch(() => {});
            handedOff = true;
            return relayMedia(retry, {
              maxBytes: MEDIA_MAX_BYTES, headers: mediaHeaders(retry), release, maxMs: RELAY_MAX_MS, signal: retrySignal,
            });
          }
          void retry?.body?.cancel().catch(() => {});
        }
        void upstream.body?.cancel().catch(() => {});
        continue;
      }

      if (!upstream.ok) {
        void upstream.body?.cancel().catch(() => {});
        continue;
      }

      // This route serves raw downloads (MatrixFile opens them in a new tab), so the
      // uploader's type is held to the allowlist — a document type would be stored XSS.
      handedOff = true;
      return relayMedia(upstream, {
        maxBytes: MEDIA_MAX_BYTES, headers: mediaHeaders(upstream), release, maxMs: RELAY_MAX_MS, signal,
      });
    }
  } finally {
    // A relay releases its own slot when the transfer ends; every other way
    // out of the loop releases it here.
    if (!handedOff) release();
  }

  return new Response(null, { status: 404 });
}
