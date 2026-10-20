"use client";

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import type { ChatMsg } from "./chatMsg";
import { getJson } from "./http";
import { keepIfEqual } from "./stableState";
import type { BadgeUserState } from "./badgeSlots";
import { MAX_SLOTS } from "./badgeSlots";
import { badgesInRenderOrder } from "./badgeOrder";

// Chat badges — the unlock + equip model (v60). The provider fetches the public
// badge map (catalog + per-user equipped/unlocked/slot state) and the viewer's
// admin flag + own Matrix id. ChatMessage reads it to render the mod badge + a
// user's equipped badges; UserCard/ProfileEditor read it to show/equip slots.
// localStorage isn't involved — shared server state, refreshed after a mutation.

export type BadgeDef = {
  id: number; name: string; imageUrl: string; isSubscriber?: boolean; isMod?: boolean;
  /** Coin-store price (v67); null/absent = not for sale. */
  coinPrice?: number | null;
};

export interface BadgesState {
  catalog: BadgeDef[];
  byId: Record<number, BadgeDef>;
  perUser: Record<string, BadgeUserState>;
  subscriberBadgeId: number | null;
  modBadgeId: number | null;
  maxSlots: number;
  isAdmin: boolean;
  /**
   * Mod OR admin, from the same /api/me read (the route computes it as
   * `is_mod || is_admin`), so every admin is a mod here and a check for mod
   * powers never has to spell out both.
   *
   * NOT interchangeable with isAdmin. Gate a control on whichever power its
   * route enforces (requireMod() vs requireAdmin()), or the UI drifts from the
   * API — a mod-allowed route would render admin-only on screen.
   */
  isMod: boolean;
  /**
   * The viewer's own site-subscription tier, from the SAME /api/me read that
   * already supplies isAdmin — no extra request.
   *
   * Three states, and the third matters: a tier string, `null` for "signed in,
   * no subscription", and `undefined` for NOT YET LOADED. useSendDestination
   * must not prune a stored redaction choice while the answer is still undefined.
   *
   * This is the BILLING answer, not the perk answer — it is null for someone
   * holding a gifted Supporter sub. Gate perks on `supporter`, never on this.
   */
  tier?: string | null;
  /**
   * Does the viewer have Supporter PERKS right now — own subscription, unexpired
   * gift, or staff comp. Mirrors the server's getActiveTier(), which is what
   * /api/chat/send and /api/chat/decrypt actually enforce.
   *
   * Same three states as `tier`, for the same reason: `undefined` means the
   * read has not landed, and must not be treated as "no".
   */
  supporter?: boolean | undefined;
  /** The viewer's own Matrix id (null when signed out) — used to personalize a
   *  gift-sub announcement they're a recipient of, and to edit their own slots. */
  myMatrixId: string | null;
  refresh: () => void;
}

const EMPTY: BadgesState = {
  catalog: [], byId: {}, perUser: {}, subscriberBadgeId: null, modBadgeId: null,
  maxSlots: MAX_SLOTS, isAdmin: false, isMod: false, tier: undefined, supporter: undefined,
  myMatrixId: null, refresh: () => {},
};

const Ctx = createContext<BadgesState>(EMPTY);
export const useBadges = () => useContext(Ctx);

interface BadgesResponse {
  catalog?: BadgeDef[];
  perUser?: Record<string, BadgeUserState>;
  subscriberBadgeId?: number | null;
  modBadgeId?: number | null;
  maxSlots?: number;
}

// The badges to render before a Matrix user's name. The ordering rule lives in
// badgeOrder.ts so it can be tested without React — see the note there on why
// the mod badge is a SUFFIX and why the subscriber badge is not special-cased.
export function badgesForMatrixId(state: BadgesState, matrixId: string | null | undefined): BadgeDef[] {
  return badgesInRenderOrder(state, matrixId) as BadgeDef[];
}

export function badgesForMsg(state: BadgesState, msg: ChatMsg): BadgeDef[] {
  return badgesForMatrixId(state, msg.matrixId);
}

export function BadgesProvider({ children }: { children: React.ReactNode }) {
  const [catalog, setCatalog] = useState<BadgeDef[]>([]);
  const [perUser, setPerUser] = useState<Record<string, BadgeUserState>>({});
  const [subscriberBadgeId, setSubscriberBadgeId] = useState<number | null>(null);
  const [modBadgeId, setModBadgeId] = useState<number | null>(null);
  const [maxSlots, setMaxSlots] = useState<number>(MAX_SLOTS);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMod, setIsMod] = useState(false);
  const [tier, setTier] = useState<string | null | undefined>(undefined);
  const [supporter, setSupporter] = useState<boolean | undefined>(undefined);
  const [myMatrixId, setMyMatrixId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getJson<BadgesResponse>("/api/badges")
      .then((d) => {
        // keepIfEqual: an unchanged payload must keep the previous identity —
        // a fresh array/object here changes the context value, which re-renders
        // every mounted ChatMessage past its memo (up to 1000 rows), every
        // poll, for nothing.
        setCatalog(keepIfEqual(Array.isArray(d.catalog) ? d.catalog : []));
        setPerUser(keepIfEqual(d.perUser ?? {}));
        setSubscriberBadgeId(d.subscriberBadgeId ?? null);
        setModBadgeId(d.modBadgeId ?? null);
        setMaxSlots(typeof d.maxSlots === "number" ? d.maxSlots : MAX_SLOTS);
      })
      .catch(() => {});
    // The viewer's own flags ride the SAME refresh: read on mount only, a new
    // subscription would reach the badge map via the badges_changed push while
    // the Supporter perks (the redacted-message option) waited for a reload.
    // Primitive setters, so an unchanged answer re-renders nothing.
    getJson<{ isAdmin?: boolean; isMod?: boolean; matrixId?: string | null; tier?: string | null; supporter?: boolean }>("/api/me")
      .then((d) => {
        setIsAdmin(!!d?.isAdmin);
        setIsMod(!!d?.isMod);
        setMyMatrixId(d?.matrixId ?? null);
        setTier(d?.tier ?? null);
        setSupporter(!!d?.supporter);
      })
      // A FAILED read changes NOTHING: before the first success `tier` and
      // `supporter` stay undefined ("unknown"), never false ("no
      // subscription") — so a blip hides the encrypted destination for this
      // load rather than pruning a Supporter's stored choice back to native —
      // and after one, the last good answer stands, so a blip on a poll can
      // neither revoke perks nor demote a mod.
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep badges live without a manual reload: poll every 60s and refetch whenever
  // the tab regains focus, so an equip/unlock shows up on its own. (Instant push
  // lands via the badges_changed WS nudge in the chat hook.)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    // Hidden tabs skip the interval; the visibilitychange handler below already
    // refreshes the moment the tab comes back, so nothing goes stale on return.
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const value = useMemo<BadgesState>(() => {
    const byId: Record<number, BadgeDef> = {};
    for (const b of catalog) byId[b.id] = b;
    return { catalog, byId, perUser, subscriberBadgeId, modBadgeId, maxSlots, isAdmin, isMod, tier, supporter, myMatrixId, refresh };
  }, [catalog, perUser, subscriberBadgeId, modBadgeId, maxSlots, isAdmin, isMod, tier, supporter, myMatrixId, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
