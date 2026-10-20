import pool from "@/lib/db";
import { auth } from "@/auth";
import { fingerprintOf } from "@/app/lib/errorFingerprint";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { readBodyCapped } from "@/app/lib/boundedBody";
import { streamApiFetch } from "@/app/lib/streamApi";
import { CLIENT_ERROR_PRUNE_SQL, CLIENT_ERROR_RETENTION_DAYS } from "@/app/lib/clientErrorRetention";
import { NextRequest } from "next/server";

// Browser-side error sink — the table is shaped one-row-per-distinct-error
// (see app/lib/clientError.ts for the sender).
//
// UNAUTHENTICATED ON PURPOSE, and that drives most of what follows. Errors
// happen to signed-out visitors, and an error thrown while auth ITSELF is broken
// is the single most valuable one to keep — requiring a session would discard it.
// The cost is an open write endpoint, bounded by four things: the IP limiter
// below, the fingerprint upsert (repeats update a row rather than adding one),
// the column truncations, and the opportunistic prune (clientErrorRetention.ts).

// 10 reports per minute per IP. Derived from the sender's own budget in
// clientError.ts (10 per page load): a well-behaved client cannot reach this
// without reloading, so tripping it means a loop or a script, not a user.
const isRateLimited = createSlidingWindowLimiter(60_000, 10);

// Must match ClientErrorSource in app/lib/clientError.ts — clientError.test.ts
// compares the two, because a source on one side only is a report this route
// 400s and the sender (deliberately) swallows.
const SOURCES = new Set([
  "boundary", "global-boundary", "component-boundary", "onerror", "unhandledrejection", "chrome-token", "player",
]);

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_URL = 500;
const MAX_UA = 300;
const MAX_BODY_BYTES = 16_384;

// ── Escalation ──────────────────────────────────────────────────────────────
// Recording is not surfacing. A table nobody reads catches nothing, so ONE
// fingerprint erupting has to reach a human without anyone thinking to look.
//
// The threshold is deliberately HIGH and it is a placeholder, not a measured
// value — there is no baseline for client-error volume. A channel that floods
// gets muted, and a muted channel reads as covered while being worse than
// none, so it errs toward silence. Everything below this bar is what the SQL
// in the table comment is for. Re-derive it from real data:
//     SELECT occurrences, first_seen, last_seen FROM site.client_errors
//     ORDER BY occurrences DESC LIMIT 20;
const BURST_COUNT = Number(process.env.CLIENT_ERROR_ALARM_BURST || 25);
const BURST_WINDOW_MS = 10 * 60_000;
const burstHits = new Map<string, number[]>();

/** True the moment one fingerprint crosses BURST_COUNT inside the window.
 *  stream-api's notify is cooldowned per key (15 min), so a sustained burst
 *  pages once, not once per request. */
function isBursting(fingerprint: string, now: number): boolean {
  const hits = (burstHits.get(fingerprint) ?? []).filter((t) => now - t < BURST_WINDOW_MS);
  hits.push(now);
  burstHits.set(fingerprint, hits);
  if (burstHits.size > 2000) {
    for (const [k, ts] of burstHits) {
      const last = ts[ts.length - 1];
      if (last === undefined || now - last >= BURST_WINDOW_MS) burstHits.delete(k);
    }
  }
  return hits.length === BURST_COUNT;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function POST(req: NextRequest) {
  if (isRateLimited(ipKey(req))) {
    return new Response("Too Many Requests", { status: 429 });
  }

  // Bounded read: req.json() would buffer a chunked body of any size before
  // anything could measure it. Every field below is truncated far under 16 KB anyway.
  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const source = typeof body?.source === "string" ? body.source : "";
  if (!SOURCES.has(source)) return new Response("Bad Request", { status: 400 });

  const message = str(body?.message, MAX_MESSAGE);
  if (!message) return new Response("Bad Request", { status: 400 });

  const stack = str(body?.stack, MAX_STACK);
  const pageUrl = str(body?.pageUrl, MAX_URL);
  const userAgent = str(req.headers.get("user-agent"), MAX_UA);
  // A Next.js server digest, when the boundary had one. Appended to the message
  // rather than given a column: it is the only handle tying this row to a server
  // log line, and it must therefore survive into the fingerprint, where a
  // separate column would not reach it.
  const digest = str(body?.digest, 64);
  const fullMessage = digest ? `${message} [digest ${digest}]`.slice(0, MAX_MESSAGE) : message;

  // Attribution is best-effort and never gates the write: the common reporter is
  // signed out, and an auth failure is exactly the error worth keeping.
  let matrixId: string | null = null;
  try {
    const session = await auth();
    const id = session?.user?.id;
    matrixId = typeof id === "string" ? id.slice(0, 255) : null;
  } catch {
    /* auth itself may be what broke — record the error anyway */
  }

  const fingerprint = fingerprintOf(source, fullMessage, stack);

  try {
    await pool.query(
      `INSERT INTO site.client_errors
         (fingerprint, source, message, stack, page_url, user_agent, matrix_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (fingerprint) DO UPDATE SET
         occurrences = site.client_errors.occurrences + 1,
         last_seen   = now(),
         -- Keep the MOST RECENT context. An old page_url on a still-firing error
         -- sends you to a page that may no longer reproduce it.
         page_url    = COALESCE(EXCLUDED.page_url, site.client_errors.page_url),
         user_agent  = COALESCE(EXCLUDED.user_agent, site.client_errors.user_agent),
         matrix_id   = COALESCE(EXCLUDED.matrix_id, site.client_errors.matrix_id),
         -- ...but never overwrite a stack we have with one we don't. A report
         -- from a browser that gave no stack must not erase a usable one.
         stack       = COALESCE(EXCLUDED.stack, site.client_errors.stack)`,
      [fingerprint, source, fullMessage, stack, pageUrl, userAgent, matrixId]
    );
  } catch (e) {
    // The sink failing is not the caller's problem and must not turn into a
    // client-side error of its own (which would be reported here, recursively).
    console.warn("[client-error] store failed:", e);
    return Response.json({ ok: false }, { status: 202 });
  }

  if (isBursting(fingerprint, Date.now())) {
    // NO PAYLOAD VALUES. This renders on a lock screen on a device that
    // leaves the house, so it carries the fingerprint (a hash) and a count —
    // enough to find the row, nothing that discloses what a user typed or saw.
    void streamApiFetch("/ops/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: `web.client-error.${fingerprint.slice(0, 12)}`,
        title: "Client errors bursting",
        message: `One error fingerprint hit ${BURST_COUNT} reports in 10 min — see site.client_errors (${fingerprint.slice(0, 12)})`,
      }),
    }).catch(() => undefined);
  }

  void prune();
  return Response.json({ ok: true });
}

// Opportunistic retention. Runs on roughly 1 request in 50 rather than on a
// timer: there is no scheduler in the web process, and a timer in a Next.js
// route module is a second thing to reason about at deploy time. Counted from
// first_seen, so a recurring error's row still goes after
// CLIENT_ERROR_RETENTION_DAYS (clientErrorRetention.ts says why).
/** Days a row is kept, from first seen — the name the legal page reads; the number lives in
 *  clientErrorRetention.ts. */
export const PRUNE_AFTER_DAYS = CLIENT_ERROR_RETENTION_DAYS;
let sinceLastPrune = 0;
async function prune(): Promise<void> {
  if (++sinceLastPrune < 50) return;
  sinceLastPrune = 0;
  try {
    await pool.query(CLIENT_ERROR_PRUNE_SQL);
  } catch (e) {
    console.warn(`[client-error] ${CLIENT_ERROR_RETENTION_DAYS}-day prune failed:`, e instanceof Error ? e.message : e);
  }
}
