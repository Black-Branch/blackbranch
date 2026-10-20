// Server-side helper for calling the internal stream-api service.
//
// stream-api authenticates internal callers by either a trusted source IP or a
// shared bearer secret. This server always sends the secret, whatever host it
// runs on — use these helpers for every stream-api call.
//
// Never import this into a client component — STREAM_API_SECRET must stay
// server-only.

/** STREAM_API_URL, with NO default.
 *
 *  A fallback host would make a missing env not fail — it would send every
 *  call to a machine that may no longer run the service. So it is an error
 *  that names itself, raised at FIRST USE rather than at import: `next build`
 *  evaluates route modules while collecting page data, and a module-load throw
 *  would fail the build on any host whose build env lacks a runtime value.
 *  The boot-time check is `instrumentation.ts`. */
export function streamApiBase(): string {
  const raw = (process.env.STREAM_API_URL ?? "").trim();
  if (!raw) {
    throw new Error("STREAM_API_URL is not set — the web server cannot reach stream-api (no default: set it in .env.local)");
  }
  return raw.replace(/\/$/, "");
}

/** stream-api's internal WebSocket URL: STREAM_API_WS_URL when set, else STREAM_API_URL with its
 *  scheme swapped (http → ws, https → wss) — the socket is served by the same process and port.
 *  So an install that sets only STREAM_API_URL still gets live settings changes (rather than only
 *  the 60 s re-read). "" when neither is set. `env` is injectable for tests. */
export function streamApiWsUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.STREAM_API_WS_URL ?? "").trim();
  if (explicit) return explicit;
  const raw = (env.STREAM_API_URL ?? "").trim();
  return raw ? raw.replace(/\/$/, "").replace(/^http(s?):\/\//i, "ws$1://") : "";
}

/** Headers carrying the shared secret (when configured). Merge into any fetch. */
function streamApiHeaders(extra?: Record<string, string>): Record<string, string> {
  const secret = process.env.STREAM_API_SECRET;
  return {
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    ...(extra ?? {}),
  };
}

// Deadline on every call. "stream-api down" fails fast on its own; this bounds
// "stream-api accepting and not answering", which otherwise holds the caller —
// including a sticker spend with the debit already taken — open for undici's
// default socket lifetime. 10s is generous: same-LAN service, and the slowest
// legitimate handlers are the bot config reads.
const STREAM_API_TIMEOUT_MS = 10_000;

/** fetch() wrapper that targets STREAM_API_URL and attaches the secret.
 *  Always carries a deadline; a caller-supplied `init.signal` still aborts. */
export function streamApiFetch(
  path: string,
  init?: RequestInit,
  timeoutMs: number = STREAM_API_TIMEOUT_MS,
): Promise<Response> {
  let base: string;
  // A REJECTION, never a synchronous throw: callers chain `.catch()` on this
  // and a throw would escape every one of them.
  try { base = streamApiBase(); } catch (e) { return Promise.reject(e); }
  const headers = streamApiHeaders(init?.headers as Record<string, string> | undefined);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(`${base}${path}`, { ...init, headers, signal });
}

/** Nudge chat clients to refetch the badge map so a change shows instantly.
 *  Best-effort by design — a lost nudge costs a page refresh, nothing more.
 *  Money celebrations must NOT use this shape: they go through
 *  chatEventDelivery's broadcastChatEvent, which retries and fails loudly
 *  (a swallowed celebration leaves the bar short real money). */
export function notifyBadgesChanged(): Promise<void> {
  return streamApiFetch("/chat/badges-changed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
    .then(() => undefined)
    .catch(() => undefined);
}
