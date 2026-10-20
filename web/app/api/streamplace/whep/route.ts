import { type NextRequest } from "next/server";
import { createWhepProxy } from "@/app/lib/whepProxy";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { instanceString } from "@/app/lib/instanceConfigServer";

// WHEP signaling proxy for the in-house stream.place player (StreamplaceThinPlayer).
// The browser POSTs its SDP offer here; the policy — discovery, forwarding,
// what to cache — lives in app/lib/whepProxy.ts (unit-tested). This file is the
// HTTP shell: it mints WHEP sessions under the streamer's DID, so it carries a
// rate limit and a body cap.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The streamer's DID is the instance key platform.streamplace.did (env first, then the stored
// value), so the proxy is built for the DID in force — and rebuilt if that changes. (A
// module-level build would capture whatever was set when the module first loaded.)
// STREAMPLACE_HOST_SUFFIX allows overriding the allowlist for a self-hosted node.
let built: { did: string; proxy: ReturnType<typeof createWhepProxy> } | null = null;
function currentProxy() {
  const did = instanceString("platform.streamplace.did");
  if (!did) return null;
  if (built?.did !== did) {
    built = { did, proxy: createWhepProxy({ fetch, did, allowedSuffix: process.env.STREAMPLACE_HOST_SUFFIX || undefined }) };
  }
  return built.proxy;
}

// A legitimate viewer makes a handful of exchanges a minute (a connect, up to
// four retries, rendition switches, manual retries). 120 is a sanity cap on an
// unauthenticated relay, generous because carrier CGNAT puts many viewers
// behind one address.
const isRateLimited = createSlidingWindowLimiter(60_000, 120);
// An SDP offer is a few KB. Anything past this is not an offer. Checked on the
// declared length first (an honest client never gets here) and on the read
// body's byte length again; `req.text()` buffers a lying chunked body in full
// before the second check; the edge's upload limit is the only ceiling in
// front of this line.
const MAX_OFFER_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const proxy = currentProxy();
  if (!proxy) return new Response("stream.place streamer DID not configured", { status: 501 });
  if (isRateLimited(ipKey(req))) return new Response("too many requests", { status: 429 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_OFFER_BYTES) return new Response("offer too large", { status: 413 });
  const offer = await req.text();
  if (!offer) return new Response("missing SDP offer", { status: 400 });
  if (Buffer.byteLength(offer) > MAX_OFFER_BYTES) return new Response("offer too large", { status: 413 });
  const rendition = new URL(req.url).searchParams.get("rendition") || "source";

  const r = await proxy.exchange(offer, rendition, req.signal);
  if (r.kind === "aborted") return new Response(null, { status: 499 });
  if (r.kind === "unreachable") {
    return new Response("playback server unreachable", {
      status: 502,
      headers: { "x-playback-server": r.server },
    });
  }
  return new Response(r.body, {
    status: r.status,
    headers: { "content-type": "application/sdp", "cache-control": "no-store", "x-playback-server": r.server },
  });
}
