// What each /sync asks of the encryption engine, cut to what actually changed.
//
// Every call into the engine's `receiveSyncChanges` commits a store transaction, and the commit
// copies the Account through a pickle round trip that recomputes the public half of EVERY one-time
// key the device holds (one curve25519 base-point multiplication per key). A device holding a few
// thousand keys pays that on every /sync — seconds per sync where WebAssembly runs interpreted
// (GrapheneOS / Vanadium). The SDK makes the call up to three times per sync: the to-device
// messages, the device-list changes, and the key counts (sent by the server on every sync).
//
// Two rules, applied at RustCrypto's own `receiveSyncChanges` (the one door those three use):
//  1. A call that carries no key count (to-device or device-list only) is given the last counts
//     the server reported. The crypto engine in use (18.5.0) reads a MISSING count as "the server
//     holds none", so every sync that carried a to-device message would generate and upload 50
//     more keys — a pile-up that grows the device's key set without bound.
//     Before the first count is known, a count that asks for nothing stands in; the real count
//     arrives later in the same sync (the SDK always processes key counts last).
//  2. A key-count-only call identical to the last one given to the engine is skipped: the engine
//     would store the same numbers and decide the same thing. One still goes through every
//     REFRESH_MS, so time-based upkeep (fallback-key expiry) keeps running.
//
// A third rule lives in `refusedKeyUploadFetch` below (the client's fetch): a one-time-key upload
// the server refuses for holding too many already.
//
// Type-only: nothing here imports the SDK, so the shape is checked against node_modules by
// matrixSyncCrypto.test.ts, which fails when an SDK or engine upgrade changes it.

/** What the SDK's RustCrypto passes to its `receiveSyncChanges`. */
export type SyncChanges = {
  events?: unknown[];
  oneTimeKeysCounts?: Map<string, number>;
  unusedFallbackKeys?: Set<string>;
  devices?: unknown;
};

type CryptoDoor = { receiveSyncChanges?: (changes: SyncChanges) => Promise<unknown[]> };

type SyncDoorState = {
  /** The counts last given to the engine (real or stood in). */
  counts: Map<string, number> | null;
  /** The unused-fallback-key list last given to the engine, as a sorted key. */
  fallback: string | null;
  /** When the engine last received key counts. */
  at: number;
};

const OTK = "signed_curve25519";
/** At or above the engine's one-time-key target (50), so a stood-in count never generates keys. */
const NOTHING_NEEDED = 50;
export const REFRESH_MS = 10 * 60_000;

const freshSyncDoorState = (): SyncDoorState => ({ counts: null, fallback: null, at: -Infinity });

const fallbackKey = (s: Set<string>) => [...s].sort().join(",");
const sameCounts = (a: Map<string, number>, b: Map<string, number> | null) =>
  !!b && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * The call to forward, or null to skip it. Updates `state` for a forwarded call.
 * Pure apart from `state`: the rules above, in one place.
 */
function planSyncChanges(state: SyncDoorState, changes: SyncChanges, now: number): SyncChanges | null {
  const given = changes.oneTimeKeysCounts;
  const counts = new Map(state.counts ?? [[OTK, NOTHING_NEEDED]]);
  for (const [k, v] of given ?? []) counts.set(k, v);
  const keyCountsOnly = !changes.events?.length && changes.devices === undefined;
  const fallback = changes.unusedFallbackKeys ? fallbackKey(changes.unusedFallbackKeys) : null;
  if (keyCountsOnly && given?.has(OTK) && sameCounts(counts, state.counts)
      && (fallback === null || fallback === state.fallback) && now - state.at < REFRESH_MS) {
    return null;
  }
  state.counts = counts;
  if (fallback !== null) state.fallback = fallback;
  state.at = now;
  return { ...changes, oneTimeKeysCounts: counts };
}

/**
 * Put the rules in front of the client's crypto backend (RustCrypto). Call once, right after
 * `initRustCrypto` and before the first sync. Returns false (and changes nothing) when the backend
 * no longer has the method — matrixSyncCrypto.test.ts fails first in that case.
 */
export function installSyncCryptoDoor(crypto: unknown, now: () => number = Date.now): boolean {
  const door = crypto as CryptoDoor | null;
  const original = door?.receiveSyncChanges;
  if (!door || typeof original !== "function") return false;
  const state = freshSyncDoorState();
  door.receiveSyncChanges = function (this: unknown, changes: SyncChanges) {
    const next = planSyncChanges(state, changes ?? {}, now());
    return next ? original.call(this, next) : Promise.resolve([]);
  };
  return true;
}

const KEYS_UPLOAD = /\/_matrix\/client\/(?:v3|r0)\/keys\/upload(?:\?|$)/;

/**
 * `fetch` for createClient. The homeserver caps how many one-time keys a device may hold
 * (Synapse 1.162: 500) and answers a batch that would pass the cap with 400 M_TOO_LARGE. The
 * engine keeps a refused batch unpublished and re-signs and re-sends it after EVERY sync, for as
 * long as the device has keys on the server — which, at the cap, is indefinitely. A refusal of a
 * batch that carries ONLY one-time keys (the engine sends an empty `fallback_keys` beside them) is answered instead with the server's own current counts
 * (an empty upload returns them), so the engine marks the batch done and stops: the server already
 * holds plenty of this device's keys, and the refused 50 are simply never handed out. Anything
 * else — device keys, a fallback key, another error — passes through untouched.
 */
export function refusedKeyUploadFetch(base: typeof fetch = (...a) => globalThis.fetch(...a)): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status !== 400 || (init?.method ?? "GET").toUpperCase() !== "POST") return res;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!KEYS_UPLOAD.test(url) || typeof init?.body !== "string") return res;
    let sent: Record<string, unknown>;
    try { sent = JSON.parse(init.body) as Record<string, unknown>; } catch { return res; }
    const carries = (v: unknown) => v !== null && typeof v === "object" && Object.keys(v).length > 0;
    if (!carries(sent.one_time_keys) || Object.entries(sent).some(([k, v]) => k !== "one_time_keys" && carries(v))) return res;
    const err = await res.clone().json().catch(() => null) as { errcode?: string } | null;
    if (err?.errcode !== "M_TOO_LARGE") return res;
    const counts = await base(input, { ...init, body: "{}" }).catch(() => null);
    if (!counts?.ok) return res;
    console.warn("[Matrix] the server refused 50 more one-time keys (it holds its limit); marking the batch done");
    return counts;
  };
}
