// The WHEP signaling relay's policy — playback-server discovery, forwarding the
// SDP offer, and what to remember — over an injected fetch, so it is
// unit-testable. The route (app/api/streamplace/whep) keeps only what is
// HTTP-shaped: the DID check, the rate limit, the body cap, status mapping.
//
// WebRTC media flows over DTLS/UDP and is immune to CORS — only this one SDP
// exchange is an HTTP request a cross-origin browser can't make against
// stream.place directly. Proxying it (a) sidesteps CORS, (b) keeps the
// streamer DID server-side, and (c) hides the playback-server discovery chain.
//
// Contract (base `streamplace` lexicons):
//   GET  place.stream.playback.getPlaybackServer?stream=<DID>  -> { servers: string[] }
//   POST place.stream.playback.whep?streamer=<DID>&rendition=<name>  (SDP in -> SDP out)
//
// Three rules:
//   1. Every upstream request has a deadline, and the forward also carries the
//      CLIENT's abort — the player aborts on every teardown, and an abort that
//      is not forwarded leaves the upstream request running on the one Node
//      process that serves the whole site.
//   2. Discovery is cached on SUCCESS only. A failure uses the node itself for
//      that one exchange and leaves the cache empty; caching the fallback for
//      the full minute would pin a whole reconnect burst to the wrong host
//      after the blip that caused it.
//   3. Only a SERVER-side failure says anything about the server: a network
//      error or a 5xx evicts the cache; a 4xx is this one offer being bad.

export type WhepExchange =
  /** The upstream answered (any status — the caller relays it). */
  | { kind: "answer"; status: number; body: string; server: string }
  /** Network failure or our deadline. */
  | { kind: "unreachable"; server: string }
  /** The client went away before the upstream answered. */
  | { kind: "aborted" };

export type WhepProxyDeps = {
  fetch: typeof globalThis.fetch;
  /** The streamer's DID — server-side only. */
  did: string;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** The stream.place node used for discovery and as the fallback playback server. */
  node?: string;
  /** Discovered servers must be https on this host or a subdomain of it. */
  allowedSuffix?: string;
  /** Deadline for discovery and for the forward. */
  timeoutMs?: number;
};

// Playback-server lookup is stable for a live session; a burst of reconnects /
// rendition switches must not re-hit discovery every time.
const SERVER_TTL_MS = 60_000;

export function createWhepProxy(deps: WhepProxyDeps) {
  const {
    fetch, did, now = Date.now,
    node = "https://stream.place",
    allowedSuffix = "stream.place",
    timeoutMs = 8_000,
  } = deps;

  let serverCache: { server: string; at: number } | null = null;
  let discovery: Promise<string> | null = null;

  // A discovered playback server is only accepted if it is an https host under
  // the allowed suffix. Without this, `servers[0]` from the discovery JSON was
  // used verbatim as the origin of the forwarded POST, so a compromised or
  // misconfigured discovery response could steer the request at an internal
  // address and hand its body back to the browser (read SSRF). stream.place
  // itself is already trusted; this closes "a bad value from a trusted source
  // escalates to an internal target" as defense in depth.
  const allowed = (server: string): boolean => {
    try {
      const u = new URL(server);
      if (u.protocol !== "https:") return false;
      const h = u.hostname.toLowerCase();
      return h === allowedSuffix || h.endsWith(`.${allowedSuffix}`);
    } catch {
      return false;
    }
  };

  // Single-flight, cached on success only (rule 2). Discovery is shared by
  // every caller, so it takes the deadline alone — never one client's abort.
  function resolveServer(): Promise<string> {
    if (serverCache && now() - serverCache.at < SERVER_TTL_MS) return Promise.resolve(serverCache.server);
    if (discovery) return discovery;
    discovery = (async () => {
      try {
        const res = await fetch(
          `${node}/xrpc/place.stream.playback.getPlaybackServer?stream=${encodeURIComponent(did)}`,
          { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) },
        );
        if (!res.ok) return node;
        const j = (await res.json()) as { servers?: unknown };
        const first = Array.isArray(j.servers) ? j.servers[0] : undefined;
        if (typeof first === "string" && allowed(first)) {
          serverCache = { server: first, at: now() };
          return first;
        }
        if (first) console.warn("[whep] discovery returned a non-stream.place server, ignoring:", String(first).slice(0, 120));
        return node;
      } catch {
        // Discovery down / stream offline — the node itself carries this
        // exchange; the forward surfaces the real error to the client.
        return node;
      } finally {
        discovery = null;
      }
    })();
    return discovery;
  }

  return {
    async exchange(offer: string, rendition: string, clientSignal: AbortSignal): Promise<WhepExchange> {
      const server = await resolveServer();
      const url = `${server}/xrpc/place.stream.playback.whep?streamer=${encodeURIComponent(did)}&rendition=${encodeURIComponent(rendition)}`;
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: offer,
          cache: "no-store",
          signal: AbortSignal.any([clientSignal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch {
        if (clientSignal.aborted) return { kind: "aborted" };
        // Network failure or our deadline: a stale cached server may be the
        // cause (the node rotated) — drop it so the next attempt re-discovers.
        serverCache = null;
        console.warn("[whep] playback server unreachable: %s", server);
        return { kind: "unreachable", server };
      }
      let body: string;
      try {
        body = await upstream.text();
      } catch {
        if (clientSignal.aborted) return { kind: "aborted" };
        serverCache = null;
        console.warn("[whep] playback server unreachable: %s", server);
        return { kind: "unreachable", server };
      }
      // Rule 3: a 5xx is the server's; a 4xx is this offer's.
      if (upstream.status >= 500) serverCache = null;
      if (!upstream.ok) console.warn("[whep] upstream %d from %s (rendition %s)", upstream.status, server, rendition);
      return { kind: "answer", status: upstream.status, body, server };
    },
  };
}
