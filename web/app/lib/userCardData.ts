"use client";

// The user card's data, fetched ONCE per person and shared by every consumer —
// the pointerdown prefetch, ChatSidebar's open gate, and UserCard's own
// fallback fetch all read through here.
//
// Why this module exists: the card is content-fit, so its height IS its data.
// Opening the window before the lookup resolves means the panel measures a
// spinner-sized loading block and every later byte moves layout — the
// entry-height freeze (Window.tsx) stops that from re-targeting the slide,
// but the growth still lands as a visible pop. The professional discipline is
// to have the data BEFORE the surface becomes visible: prefetch at
// pointer-down (the press→click gap is a free head start), gate the open on
// the promise with a short cap, and seed the card so its first frame is the
// finished card at its true height.

// .ts extensions on purpose: this module runs under `node --test` (via its own
// test), and Node's strip-only type loading resolves no extensionless paths.
import { getJson } from "./http.ts";
import { userLookupKey } from "./avatarSrc.ts";

// The /api/user/[id] profile shape (moved here from UserCard.tsx so both the
// component and this cache can name it without lib importing a component).
export type Lookup = {
  found: boolean;
  name?: string;
  intelligenceTier?: string | null;
  regularityTier?: string | null;
  wordCountTier?: string | null;
  supportTier?: string | null;
  isMember?: boolean;
  subTier?: string | null;
  // Factual counts rendered as stat pills, mirroring ProfileCard's own-view card.
  activity?: number;
  streams?: number;
  // he/him · she/her · they/them — the words behind the chat row's symbol.
  pronouns?: string | null;
  // Mods only: the linked site account behind this canonical identity (the
  // /api/user/[id] route omits it for everyone else). Lets the card offer the
  // full site-level mod actions on a platform-origin message.
  matrixId?: string | null;
  // The linked site account's display name, when this canonical has one.
  // A platform-origin card renders THIS rather than the platform-local handle
  // (cross-platform users default to their site user-card).
  siteName?: string | null;
  // Which platforms that account has linked — the icon row beside the name.
  linkedPlatforms?: string[];
  // The actual username on each platform. MOD-ONLY, and the SERVER decides:
  // /api/user/[id] omits this field entirely for everyone else, so a person's
  // cross-platform identity graph is never shipped to a viewer who shouldn't
  // have it. Never re-derive it client-side.
  platformHandles?: { platform: string; username: string }[];
  // Uploaded profile banner (site.users.banner_mxc via the linked site account),
  // rendered over the hash gradient. Public — everyone sees each other's banners.
  bannerMxc?: string | null;
};

/** What a card needs before it is visible: the profile lookup + social credit.
 * The mod-only reads (ban state, reach, platform actions) are NOT here — they
 * render inside the collapsed tools section, so their arrival never moves the
 * card's visible layout. */
export type UserCardData = { lookup: Lookup; credit: number };

/** The msg fields the fetches key on — ChatMsg satisfies this. */
export type UserCardSubject = { publicId?: string | null; matrixId?: string | null };

// Settled-or-in-flight promises per person. Short TTL: long enough to bridge
// press→open→card-mount (and an immediate re-open), short enough that a mod
// re-checking someone after acting sees fresh membership/impression data.
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; p: Promise<UserCardData> }>();

/** @test-only — each test starts from an empty cache. */
export function _resetUserCardCacheForTests(): void {
  cache.clear();
}

function fetchCardData(msg: UserCardSubject): Promise<UserCardData> {
  // Both fields degrade independently, exactly as UserCard's two original
  // effects did — but a degraded result is marked so the cache can evict it:
  // a network blip must not pin "No stream record" onto 15s of re-opens.
  let degraded = false;
  const lookupId = userLookupKey(msg);
  const lookupP: Promise<Lookup> = lookupId
    ? getJson<Lookup>(`/api/user/${encodeURIComponent(lookupId)}`)
        .catch(() => { degraded = true; return { found: false }; })
    : Promise.resolve({ found: false });
  let creditP: Promise<number>;
  if (!lookupId) {
    creditP = Promise.resolve(0);
  } else {
    const q = new URLSearchParams();
    q.set("id", lookupId);
    creditP = getJson<{ credit?: number }>(`/api/user/credit?${q}`)
      .then((d) => (typeof d?.credit === "number" ? d.credit : 0))
      .catch(() => { degraded = true; return 0; });
  }
  return Promise.all([lookupP, creditP]).then(([lookup, credit]) => {
    if (degraded) cache.delete(cacheKey(msg));
    return { lookup, credit };
  });
}

function cacheKey(msg: UserCardSubject): string {
  return `${msg.publicId ?? ""}|${msg.matrixId ?? ""}`;
}

/** Start (or join) the card-data fetch for this person. Called at
 * pointer-down on a username — by the time the click completes and the host
 * awaits the same promise, the network round-trip has a head start. */
export function prefetchUserCard(msg: UserCardSubject): Promise<UserCardData> {
  const key = cacheKey(msg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = fetchCardData(msg);
  cache.set(key, { at: Date.now(), p });
  return p;
}

/** How long an open gate waits on the data before opening with the loading
 * block anyway. Derived from its terms, not taste: the pointerdown prefetch
 * has already covered the press→click gap (~60–120ms on touch) before the
 * gate even starts, our API round trips land well inside 150ms, and past
 * ~250ms a pressed control with nothing visible starts reading as a dead
 * tap — the cap sits at that perception bound. */
export const USER_CARD_OPEN_CAP_MS = 250;

/** The open gate: the data, or null once the cap expires. A null opens the
 * card with its loading block — the pre-gate behavior, now the rare cold-and-
 * slow path — and the card's own read-through fetch finishes the job. The cap
 * keeps the press→card latency bounded no matter what the network does. */
export function userCardDataWithin(msg: UserCardSubject, capMs: number): Promise<UserCardData | null> {
  return Promise.race([
    prefetchUserCard(msg),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), capMs); }),
  ]);
}
