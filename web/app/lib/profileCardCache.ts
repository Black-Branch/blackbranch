// Session cache for the own-view ProfileCard's data payloads, so the font,
// banner and stats do not load up AFTER the profile does.
//
// Six independent fetches on mount, each landing in its own render, would mean
// visible pop-in on every open. This module holds the whole
// payload as ONE unit with stale-while-revalidate semantics:
//   - `read()` — synchronous cached snapshot; the card paints fully populated
//     on open when warm (UserMenu prefetches on avatar hover/focus + idle).
//   - `prefetch()` — coalesces concurrent calls, resolves the whole batch at
//     once (so even a cold first open pops in as one paint, not six), then
//     refreshes the cache in the background on later calls.
// Deliberately NOT a loading gate: the card renders immediately either way and
// state updates silently when data lands.
//
// The factory takes the loader as an argument (the real fetch wiring lives in
// profileCardPrefetch.ts) and this module keeps ZERO runtime imports — the
// `@/`-alias / extensionless-import gotcha breaks `node --test`, same reason
// chatIdentity's policy tests and homeserverTrust are structured this way.

import type { EquippedStyle } from "./usernameStyles";

export type ProfileCardIds = { matrixId: string; canonicalId: string | null };

/** Shape of /api/me's summary payload (response shape unchanged — see route). */
export type MeSummary = {
  displayName?: string | null;
  isMod?: boolean;
  /** Non-null while an own subscription (or staff comp) is active. */
  tier?: string | null;
  memberSince?: string | null;
  /** Own canonical stream id — the stats source when no canonicalId prop was
   *  passed (the /community rail + input mounts pass none). */
  canonicalId?: string | null;
  /** Uploaded profile banner (site.users.banner_mxc, v80), if any. */
  bannerMxc?: string | null;
  /** One-line about (site.users.bio, v126). */
  bio?: string | null;
};

// The public stream-profile stats (same /api/user/[id] source the !rank chat
// command uses — lifted from the deleted MyStats panel, rendered as pills).
export type ProfileStats = {
  found: boolean;
  karma?: number;
  activity?: number;
  streams?: number;
  isMember?: boolean;
  subTier?: string | null;
  intelligenceTier?: string | null;
};

/** Everything the card view renders, resolved as one batch. */
export type ProfileCardData = {
  me: MeSummary | null;
  pronouns: string | null;
  color: string | null;
  style: EquippedStyle | null;
  linkedPlatforms: string[];
  stats: ProfileStats | null;
  credit: number | null;
};

// A prefetch inside this window returns the cached batch without a network
// round-trip — hover → click must not refetch what the hover just loaded.
// Anything older revalidates in the background (read() still serves it
// instantly meanwhile).
const FRESH_MS = 15_000;

export function createProfileCardCache(
  load: (ids: ProfileCardIds) => Promise<ProfileCardData>,
  /** Fires after each successful load — the wiring warms images/fonts here. */
  onLoaded?: (d: ProfileCardData) => void,
) {
  // Keyed by identity so a signed-out/switched account can never read the
  // previous user's card ("|" cannot appear in a matrix id's grammar).
  let cached: { key: string; at: number; data: ProfileCardData } | null = null;
  let inflight: { key: string; promise: Promise<ProfileCardData> } | null = null;
  // Bumped by invalidate(): a load that was already in flight when the data
  // changed must not land its now-stale batch back into the cache.
  let generation = 0;
  const keyOf = (ids: ProfileCardIds) => `${ids.matrixId}|${ids.canonicalId ?? ""}`;

  return {
    /** Cached snapshot for this user, or null (cold / different account). */
    read(matrixId: string): ProfileCardData | null {
      return cached?.key.startsWith(`${matrixId}|`) ? cached.data : null;
    },

    /** Load (or coalesce onto the in-flight load / fresh cache) the full batch. */
    prefetch(ids: ProfileCardIds): Promise<ProfileCardData> {
      const key = keyOf(ids);
      if (cached?.key === key && Date.now() - cached.at < FRESH_MS) {
        return Promise.resolve(cached.data);
      }
      if (inflight?.key === key) return inflight.promise;
      const startedGen = generation;
      const promise = load(ids)
        .then((data) => {
          // A stale in-flight batch (invalidated mid-load) is still returned to
          // the caller — it was accurate when requested — but never cached.
          if (startedGen === generation) {
            cached = { key, at: Date.now(), data };
            onLoaded?.(data);
          }
          return data;
        })
        .finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
      inflight = { key, promise };
      return promise;
    },

    /** Drop the cache (and orphan any in-flight load) — call after a profile
     *  edit whose shape isn't worth mirroring client-side (color, style,
     *  pronouns, display name): the next open refetches, restoring the
     *  pre-cache always-fresh behavior for edited fields. */
    invalidate(): void {
      generation++;
      cached = null;
      inflight = null;
    },

    /** Merge an in-place edit (e.g. the editor's banner upload) into the cached
     *  `me` so the next open doesn't flash the pre-edit value. */
    patchMe(matrixId: string, partial: Partial<MeSummary>): void {
      if (!cached?.key.startsWith(`${matrixId}|`) || !cached.data.me) return;
      cached = {
        ...cached,
        data: { ...cached.data, me: { ...cached.data.me, ...partial } },
      };
    },
  };
}
