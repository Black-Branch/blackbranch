"use client";

import { useCallback, useState } from "react";
import { useChatSocket, type ChatSocketEvent } from "./useChatSocket";
import { keepIfEqual } from "./stableState";
import type { Sponsor } from "./sponsorClock";

// Fund the Night: the live sponsor credit pool. ONE frame feeds this —
// `sponsorState` (sponsors.js `buildFrame()`) — carrying the whole pool,
// sorted biggest weight first.
//
// Pattern: a single-frame `useChatSocket` wrapper hook — but NOT called
// per-consumer the way such a hook normally would be. This hook opens its own
// `useChatSocket` subscription, so it must be called EXACTLY ONCE, from
// `SponsorClockProvider` (SponsorClockContext.tsx) — mirrors BadgesContext.tsx's
// shape for the same reason BadgesContext exists. Called per chat row, every
// mounted row — up to MAX_SCROLLBACK of them — would open its own subscriber
// to the shared socket's fan-out, each receiving every frame type; consumers
// read via `useSponsorClock()` instead.
//
// keepIfEqual: the sponsor pool resyncs on a heartbeat even when unchanged
// (sponsors.js's own change-detection is bucketed, and JSON.parse always
// mints a fresh array/objects regardless) — without this every context
// consumer would re-render on each ~60s resync for nothing, the same class of
// cost BadgesContext's own keepIfEqual comment documents.

const INITIAL: Sponsor[] = [];

export function useSponsorState(): Sponsor[] {
  const [sponsors, setSponsors] = useState<Sponsor[]>(INITIAL);

  const onEvent = useCallback((data: ChatSocketEvent) => {
    if (data.type === "sponsorState") {
      setSponsors(keepIfEqual(Array.isArray(data.sponsors) ? data.sponsors : []));
    }
  }, []);

  useChatSocket(onEvent);

  return sponsors;
}
