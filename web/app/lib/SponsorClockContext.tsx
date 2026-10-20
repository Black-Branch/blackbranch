"use client";

import { createContext, useContext } from "react";
import { useSponsorState } from "./useSponsorState";
import type { Sponsor } from "./sponsorClock";

// Fund the Night: ONE shared sponsor-pool subscription for the whole page —
// mirrors BadgesContext.tsx's shape exactly, mounted once in layout.tsx
// alongside `BadgesProvider`.
//
// Round-1 review finding: `SponsorClockBadge` used to call `useSponsorState()`
// directly, so every mounted chat row (up to MAX_SCROLLBACK concurrent rows)
// opened its own `useChatSocket` subscriber to the shared socket's fan-out,
// each receiving EVERY frame type. This repo has already paid down that exact
// class of cost twice (the connection-sharing rewrite in useChatSocket.ts, and
// BadgesContext.tsx's own poll-to-context hoist) — so the fix here is the
// house's own established shape, not a new pattern: ONE subscription, held in
// a Provider, read via `useContext` by as many leaf consumers as exist.
const Ctx = createContext<Sponsor[]>([]);

/** The live sponsor pool. Empty array until the first `sponsorState` frame
 *  lands (or if the page never mounts `SponsorClockProvider`). */
export const useSponsorClock = () => useContext(Ctx);

export function SponsorClockProvider({ children }: { children: React.ReactNode }) {
  // useSponsorState already applies keepIfEqual (see its own doc comment), so
  // this Provider's `value` keeps referential identity across an unchanged
  // resync — every `useSponsorClock()` consumer bails out via Object.is on a
  // no-op update, same guarantee BadgesContext gives its own consumers.
  const sponsors = useSponsorState();
  return <Ctx.Provider value={sponsors}>{children}</Ctx.Provider>;
}
