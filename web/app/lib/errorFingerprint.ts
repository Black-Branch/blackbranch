// How a browser error is reduced to an identity, for site.client_errors (v107).
//
// Pure and I/O-free so the decision can be tested DIRECTLY. It lived inside the
// route for about an hour, and testing it from there meant either mirroring it
// (which drifts — and a drifting fingerprint test goes green while production
// merges unrelated errors) or reading the route's source and eval'ing it, which
// is both a code-injection shape and brittle regex surgery on type annotations.
// Extracting it makes both unnecessary. Same move as stream-api/chat-dedup.js.
//
// The fingerprint fails SILENTLY in both directions, which is why it gets its
// own file and its own tests:
//   • too loose  → unrelated errors merge into one row that reads as a single
//                  very frequent bug, and the real second bug is invisible.
//   • too tight  → every deploy's renamed chunks fork every existing error, and
//                  the table becomes the append-only log it was designed not to
//                  be. It would look like "everything broke again after deploy".

import { createHash } from "node:crypto";

/**
 * Collapse the parts of an error that vary between otherwise identical
 * occurrences.
 *
 * Numbers, hex blobs and URLs are what differ: chunk hashes, object ids, line
 * and column offsets, timestamps. Order matters — URLs go first, because a URL
 * contains both hex and digits and rewriting those first would leave a
 * half-mangled path behind.
 */
/** @test-only outside this module. fingerprintOf is the product entry point;
 *  this is exported so clientError.test.ts can pin the ORDER of the rewrites
 *  (URLs before hex before digits) directly — a hash comparison can prove two
 *  inputs differ but not which rewrite did it. */
export function normalizeForFingerprint(s: string): string {
  return s
    .replace(/https?:\/\/[^\s)'"]+/g, "<url>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The first stack frame carries the throw site; everything after it is call
 * context that varies with how the user happened to get there.
 *
 * Two frame formats, not one. V8 (Chrome, Edge, Node) writes `    at fn (url)`
 * under a first line repeating the message; JavaScriptCore (Safari, and every
 * iOS browser, since they are all WebKit) writes `fn@url` with NO message line
 * and no `at`. An `at `-only reader returns "" for every Safari stack, which
 * silently merges all of a Safari user's same-message errors into one row —
 * on the platform where we can least afford to lose the throw site, because
 * it is the one nobody here can reproduce on.
 *
 * @test-only outside this module — exported so the Safari/V8 cases can be
 * asserted as frames rather than inferred from two hashes being unequal, which
 * would stay green if BOTH formats broke in the same way.
 */
export function topFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
  const v8 = lines.find((l) => l.startsWith("at "));
  if (v8) return v8;
  // JSC: the first line IS a frame. Require an `@` so a bare one-line message
  // (a thrown string has no stack at all, but a hand-built one might) is not
  // mistaken for a frame and fingerprinted twice — once as message, once as frame.
  const jsc = lines.find((l) => l.includes("@"));
  return jsc ?? "";
}

/** Stable id for "this bug", across users, sessions and builds.
 *
 * `source === "player"` is deliberately NOT normalized. The generic path strips
 * digits and URLs and keeps only the
 * first stack frame — built for a thrown Error, where the frame is the throw
 * site and the rest is noise. A player report's "stack" is
 * `JSON.stringify(buildPlayerEvent(...))` (playerTelemetry.ts), not a stack
 * trace at all: `topFrame` finds no `at `/`@` line in it and returns "", so
 * normalized, every player row of one reason+state would collapse onto ONE
 * fingerprint and only the latest counters/viewer would survive. One row per
 * reported EVENT is the whole point of this source (a stalled player must
 * leave a trace), so its identity is the raw message + stack verbatim: the attempt
 * number, connection state and counters embedded in them are what keep
 * distinct events distinct, while an exact repeat still hashes the same and
 * aggregates as one row. */
export function fingerprintOf(
  source: string,
  message: string,
  stack: string | null | undefined
): string {
  const basis =
    source === "player"
      ? `${source}\n${message}\n${stack ?? ""}`
      : `${source} ${normalizeForFingerprint(message)} ${normalizeForFingerprint(topFrame(stack))}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}
