// A code chunk that 404s after a deploy must reload the page, not break it.
//
// The client error looks like "Failed to load chunk
// /_next/static/chunks/<hash>.js from module 177674" — the SAME module id under
// two different chunk hashes. A deploy that syncs .next/static with
// `--delete` erases the previous build's chunks, so a tab held open across a
// deploy 404s the moment it opens anything loaded on demand.
//
// The same holds for a SERVER ACTION: an action id is a hash of the build, so a tab held
// open across the nightly self-update calls an action the new server does not have — "Server
// Action … was not found on the server" / "Failed to find Server Action" / "Server Reference ID
// did not match" (10 rows in 14 days, all on deploy days). Same remedy, same one-reload latch.
//
// A reload costs the viewer their scroll position and an unsent draft. That is
// worth it against a panel that never renders — and it is the only remedy the
// client can apply alone, because the bytes it needs no longer exist.

// Module-private: ErrorBoundary consumes only shouldReloadForChunkError below.
// CHUNK_RELOAD_KEY and isChunkLoadError are exercised through it, never
// imported directly — chunkReload.test.ts calls every assertion through the
// one exported function so this module has exactly one public door.

/** sessionStorage key latching the one reload. */
const CHUNK_RELOAD_KEY = "bb_chunk_reload";

// Every spelling a bundler uses for "the script did not arrive". Turbopack's is
// first — it is the one production actually recorded — and the rest are here so
// a bundler upgrade cannot silently turn this guard off.
const CHUNK_MESSAGES = [
  /Failed to load chunk/i,
  /Loading chunk \S+ failed/i,
  /ChunkLoadError/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  // A server action from the previous build.
  /Server Action "?[^"]*"? was not found on the server/i,
  /Failed to find Server Action/i,
  /Server Reference ID did not match/i,
  /UnrecognizedActionError/i,
];

function isChunkLoadError(err: unknown): boolean {
  // Deliberately NOT duck-typed on `.message` alone: a plain object or a string
  // carrying that text is not a thrown chunk failure, and treating it as one
  // would spend the session's single reload on something a reload cannot fix.
  if (!(err instanceof Error)) return false;
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";
  const text = `${name}: ${message}`;
  return CHUNK_MESSAGES.some((re) => re.test(text));
}

/** True when the caller should reload. Arms the latch as a side effect, so a
 *  chunk that is genuinely gone forever costs exactly one reload per session
 *  rather than an infinite loop. A `null` store (private mode, or a browser
 *  that throws on access) returns false: the boundary's fallback is a worse
 *  experience than a reload, but an unlatched reload loop is far worse still. */
export function shouldReloadForChunkError(err: unknown, store: Storage | null): boolean {
  if (!isChunkLoadError(err)) return false;
  if (!store) return false;
  try {
    if (store.getItem(CHUNK_RELOAD_KEY)) return false;
    store.setItem(CHUNK_RELOAD_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
