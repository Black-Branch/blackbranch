"use client";

// The Twitch automod hold queue, shared by the mod panel and the inline chat bar.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A hold queue rendered only in the mod panel is almost never acted on: Twitch
// drops an unresolved hold after ~5 minutes, and nobody has the mod panel open
// at the moment a message is flagged — most holds simply expire. That is a
// visibility failure, not a broken pipeline, so the fix is not more polling,
// it is putting the queue where mods already are: chat.
//
// ONE poller regardless of how many components mount this. The panel section
// and the inline bar can be on screen at once, and two independent 5s polls
// would double the load AND let the two surfaces disagree about what is pending
// — showing a mod an Allow button for something the other view already resolved.
// The module-level store is what makes them the same queue rather than two
// views of two fetches.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "./http";

export type HeldMessage = {
  id: number;
  /** Twitch's message id — null for every row OUR producers wrote. */
  msgId: string | null;
  userLogin: string | null;
  userName: string | null;
  text: string;
  category: string | null;
  level: number | null;
  heldAt: string;
  /**
   * Which producer wrote the row: 'twitch' (their AutoMod) or one of ours —
   * 'blocklist' | 'account_age' | 'link_gate'. Only Twitch rows have a
   * deadline (the ~5-minute hold window); ours sit until resolved.
   */
  source?: string;
  /**
   * 'pending' — withheld, awaiting allow/deny.
   * 'blocked' — never delivered (severity 4); shown so a mod can act on the
   *             PERSON. Allow/Deny are meaningless for it: there is no message
   *             waiting to be published.
   */
  status?: string;
  /** Which blocklist term fired — the evidence for changing the list. */
  matchedTerm?: string | null;
  matrixId?: string | null;
  /**
   * The sender's id in whatever namespace the producer had: our blocklist rows
   * carry the CANONICAL stream id, Twitch rows carry Twitch's user id. Needed
   * because a platform-only chatter has no `matrixId` — and they are exactly
   * the people a mod most needs to reach.
   */
  userId?: string | null;
  /** Origin platform (the site's own id for native sends — nativePlatform.ts). */
  platform?: string | null;
  /**
   * Set when this Twitch hold is the COPY of a cross-posted native message —
   * the origin site.chat_messages id. Deny on such a row removes the origin
   * (and its other platform copies) too, so the UI must say so.
   */
  siteMsgId?: number | null;
  /** Automod (source 'ai') only: the model's confidence, 0–1. Its reason rides `matchedTerm`. */
  confidence?: number | null;
};

/** Automod's own state, for the "degraded since" header. null = off or unknown. */
export type AutomodState = { degraded: boolean; degradedSince: string | null; holdExpiry?: number | null } | null;

// Twitch expires holds at ~5 minutes, so staleness costs real response time —
// this is deliberately faster than a "background data" poll would be.
const POLL_MS = 5_000;

type Store = { held: HeldMessage[] | null; automod: AutomodState; subs: Set<() => void>; timer: ReturnType<typeof setInterval> | null };
const store: Store = { held: null, automod: null, subs: new Set(), timer: null };

function emit() {
  for (const fn of store.subs) fn();
}

async function refresh(): Promise<void> {
  try {
    const d = await getJson<{ held: HeldMessage[]; automod?: AutomodState }>("/api/mod/automod");
    store.held = d.held;
    store.automod = d.automod ?? null;
    emit();
  } catch {
    // Leave the last known queue in place. Blanking it on a transient failure
    // would read as "nothing held" — the exact wrong answer for this feature.
  }
}

function start() {
  if (store.timer) return;
  void refresh();
  store.timer = setInterval(() => {
    // A hidden tab can't be acted on, and holds expire anyway.
    if (!document.hidden) void refresh();
  }, POLL_MS);
}

function stop() {
  if (store.subs.size > 0 || !store.timer) return;
  clearInterval(store.timer);
  store.timer = null;
}

export type AutomodQueue = {
  /** null until the first fetch resolves — distinct from an empty queue. */
  held: HeldMessage[] | null;
  automod: AutomodState;
  pending: number;
  /** Keyed on the ROW id — a blocklist row has no Twitch message id. */
  resolve: (id: number, action: "allow" | "deny") => Promise<"ok" | "expired" | "failed">;
};

/**
 * @param enabled  Mods only. A non-mod would poll a 403 endpoint forever, so
 *                 callers MUST pass their real mod flag rather than gating the
 *                 render alone — an invisible component that still fetches is
 *                 the classic version of this mistake.
 */
export function useAutomodQueue(enabled: boolean): AutomodQueue {
  const [, force] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const cb = () => force((n) => n + 1);
    store.subs.add(cb);
    start();
    return () => {
      store.subs.delete(cb);
      stop();
    };
  }, [enabled]);

  const resolve = useCallback(
    async (id: number, action: "allow" | "deny"): Promise<"ok" | "expired" | "failed"> => {
      // Drop it locally first: the mod has decided, and leaving the row on
      // screen for up to a poll invites a second click on a resolved hold.
      store.held = (store.held ?? []).filter((m) => m.id !== id);
      emit();
      try {
        const res = await postJson("/api/mod/automod/resolve", { id, action });
        void refresh();
        if (res.status === 410) return "expired";
        return res.ok ? "ok" : "failed";
      } catch {
        void refresh();   // resync — the optimistic removal may have been wrong
        return "failed";
      }
    },
    []
  );

  return { held: store.held, automod: store.automod, pending: store.held?.length ?? 0, resolve };
}

/** A row with nothing waiting to publish — a 'blocked' word hit, or automod's 'flagged' platform
 *  message (already public there). Allow would mean nothing, so it is dismiss-only. */
export function isDismissOnly(m: HeldMessage): boolean {
  return m.status === "blocked" || m.status === "flagged";
}

/** The "degraded" header line, or null. */
export function degradedLine(a: AutomodState): string | null {
  if (!a || !a.degraded) return null;
  const at = a.degradedSince ? new Date(a.degradedSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return `Automod degraded${at ? ` since ${at}` : ""} — messages are being delivered unchecked`;
}
