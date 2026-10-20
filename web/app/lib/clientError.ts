// Browser-side error reporting — the client half of site.client_errors.
//
// Without client telemetry a failure in someone's browser leaves no copy
// anywhere: a report reads "it said failed to send" with no detail, because
// the reporter cannot read the error and neither can we.
//
// THIS MODULE MUST NEVER THROW. It runs inside error boundaries and inside
// window.onerror — the two places already handling a failure. An exception here
// would replace a diagnosable error with an undiagnosable one, and in
// global-error.tsx it would take out the last boundary standing between a root
// layout throw and a blank white page. Every entry point is wrapped.

// Explicit .ts extension so this module is directly importable by node --test
// (the codebase already does this wherever a lib module is unit-tested).
import { postJson } from "./http.ts";

/** Where the error was caught. Kept short — it is stored verbatim. */
export type ClientErrorSource =
  | "boundary"           // app/error.tsx — a route segment threw
  | "global-boundary"    // app/global-error.tsx — the ROOT layout threw
  | "component-boundary" // components/ErrorBoundary — a wrapped subtree threw
  | "onerror"            // an uncaught throw that reached window
  | "unhandledrejection"
  | "chrome-token"       // lib/chrome/chromeTokens — a registered <length> token read back as calc() text (no @property support); the dock fell back to the initial value
  | "player";            // features/player — a stall, reconnect or end the in-house player decided on (playerTelemetry.ts)

// ── Client-side throttles ───────────────────────────────────────────────────
// The server rate-limits by IP, but a render loop can fire hundreds of times a
// second and there is no reason to spend the user's bandwidth discovering that
// the server is refusing us. These two bounds are about the SENDER's manners;
// the route's limiter is the actual defence.
//
// The per-load budget is PER SOURCE, not one shared pool: a flapping player
// can report far more than 10 times in one bad stream, and a shared counter
// would let it spend the whole budget and silence a genuine JS error for the
// rest of the load. `"player"` gets its own, larger budget; every other source
// still shares the general one.
const REPEAT_MS = 30_000;         // same message: at most one report per this long
const MAX_PER_LOAD = 10;          // general reports per page load
const MAX_PLAYER_PER_LOAD = 20;   // player reports per page load — counted separately

const lastSent = new Map<string, number>();
let sentThisLoad = 0;
let playerSentThisLoad = 0;

/** @test-only clientError.test.ts feeds reportClientError a list of hostile
 *  values in one process; without a reset between them the per-load budget
 *  would silence every case after the first and the test would pass vacuously. */
export function _resetClientErrorThrottle(): void {
  lastSent.clear();
  sentThisLoad = 0;
  playerSentThisLoad = 0;
}

/** Has this message been reported too recently, or have we sent too many —
 *  counting against the player budget for a player report, the general one
 *  for everything else? */
function shouldSkip(source: string, key: string, now: number): boolean {
  if (source === "player") {
    if (playerSentThisLoad >= MAX_PLAYER_PER_LOAD) return true;
  } else if (sentThisLoad >= MAX_PER_LOAD) {
    return true;
  }
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < REPEAT_MS) return true;
  return false;
}

/** Best-effort message + stack out of whatever was actually thrown.
 *  A rejected promise can carry ANYTHING — a string, a Response, undefined —
 *  so this must not assume Error. */
function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message || err.name || "Error", ...(err.stack ? { stack: err.stack } : {}) };
  }
  if (typeof err === "string") return { message: err };
  try {
    const s = JSON.stringify(err);
    // "{}" carries nothing; say so rather than storing a row that looks empty.
    return { message: s && s !== "{}" ? s : `non-Error thrown: ${typeof err}` };
  } catch {
    return { message: `non-Error thrown: ${typeof err}` };
  }
}

const RECENT_MAX = 50;
const recent: { at: number; source: string; message: string }[] = [];
/** The last errors this page caught, oldest first — the terminal's /var/log/dmesg. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function recentClientErrors(): { at: number; source: string; message: string }[] {
  return [...recent];
}

/**
 * Report a client-side error. Fire-and-forget; never rejects, never throws.
 *
 * `digest` is Next.js's server-side error digest when one is available — it is
 * the only handle that ties a client boundary render back to a server log line.
 *
 * Sent with `keepalive: true`: `ErrorBoundary`'s chunk-load recovery calls
 * `window.location.reload()` right after this, and an ordinary fetch can be
 * cut off mid-flight by that navigation — losing the one count that says how
 * often a deploy strands an open tab. `keepalive` is the browser's own
 * mechanism for a request that must outlive the page that started it.
 */
export function reportClientError(
  source: ClientErrorSource,
  err: unknown,
  digest?: string
): void {
  try {
    if (typeof window === "undefined") return;
    const { message, stack } = describe(err);
    const now = Date.now();
    // Kept on the page too, throttled or not: the terminal's `dmesg` reads it.
    recent.push({ at: now, source, message: message.slice(0, 300) });
    if (recent.length > RECENT_MAX) recent.shift();
    const key = `${source}:${message}`;
    if (shouldSkip(source, key, now)) return;
    lastSent.set(key, now);
    if (source === "player") playerSentThisLoad += 1;
    else sentThisLoad += 1;

    void postJson("/api/client-error", {
      source,
      // Generous but bounded — the server truncates authoritatively. Sending a
      // megabyte stack from a loop helps nobody.
      message: message.slice(0, 1000),
      ...(stack ? { stack: stack.slice(0, 8000) } : {}),
      ...(digest ? { digest } : {}),
      pageUrl: window.location?.href?.slice(0, 500),
    }, "POST", { keepalive: true }).catch(() => {
      // Reporting an error must not produce one. If the sink is down, the
      // console line that every call site still writes is what is left.
    });
  } catch {
    /* see the note at the top of this file */
  }
}

/**
 * Install the window-level listeners. Returns an uninstall function.
 *
 * `error` and `unhandledrejection` do NOT bubble the way ordinary events do
 * and are not caught by React error boundaries — an async throw or a floating
 * promise reaches neither app/error.tsx nor global-error.tsx. Those two
 * boundaries and these two listeners are four distinct paths, and all four are
 * wired, because "the boundary covers it" is exactly the assumption that leaves
 * the interesting failures unrecorded.
 */
/**
 * "Script error." with no error object is what a browser hands `window.onerror`
 * for a throw inside a CROSS-ORIGIN script (an embed's player code, an
 * extension): the message, file, line and stack are all withheld by design. It
 * names nothing we can act on — a single browser can log it a hundred times a
 * night — so it is dropped here rather than stored.
 *
 * @test-only exported for clientError.test.ts; installGlobalErrorReporting
 * below is its only runtime caller, and a same-file call does not count as a
 * reference here.
 */
export function isOpaqueCrossOriginError(e: { error?: unknown; message?: string }): boolean {
  return e.error == null && /^Script error\.?$/i.test(String(e.message ?? "").trim());
}

export function installGlobalErrorReporting(): () => void {
  const onError = (e: ErrorEvent) => {
    if (isOpaqueCrossOriginError(e)) return;
    reportClientError("onerror", e.error ?? e.message);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    reportClientError("unhandledrejection", e.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
