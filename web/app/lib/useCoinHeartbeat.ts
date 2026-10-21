import { useEffect } from "react";
import { postJson } from "./http";
import { setCoinBalance } from "./useCoinBalance";
import { pushEarnChips } from "./useEarnChip";
import type { EarnChipItem } from "./coins";

// Coin watch-time heartbeat (migrate-v67): signed-in viewers accrue a small
// participation earn while the stream is live and the tab is visible. The
// server verifies liveness and clamps the per-beat delta, so this is purely
// a "yes, still watching" ping; the response carries the fresh balance.
//
// It ALSO carries `chips` — every earn credited since the previous beat,
// grouped by kind. That makes this the delivery channel for the "+2q" chip,
// including awards the viewer did not trigger (someone upvoting their message),
// which no response to a request of their own could ever carry. See
// earnChipsSince in coinsServer.ts for why the chat routes cannot do this.

/** Set by the mounted hook; null when no viewer is beating (signed out, or
 *  off-stream). A module-level handle rather than context because the callers
 *  that want it — a chat send, a vote — are plain async functions in hooks that
 *  have no business taking a heartbeat dependency. */
let beatNow: (() => void) | null = null;

/** How long a poke waits before beating.
 *
 *  THIS DELAY IS THE WHOLE CORRECTNESS ARGUMENT, not a polish tweak. The
 *  chat routes launch their earn with `void` and answer the request without
 *  waiting for it, so at the moment the client can react, the award may not
 *  have committed. Beating instantly would run the chip query against a
 *  snapshot that predates the credit — and because the beat then advances the
 *  cursor past it, that award is not merely late, it is never reported at all
 *  (earnChipsSince explains the cursor). So an eager poke would reliably cause
 *  the rare race it was meant to avoid.
 *
 *  Two seconds is far beyond a local single-row commit (single-digit
 *  milliseconds) while still landing well inside the moment the viewer
 *  connects the chip to what they just did. The failure mode if it were ever
 *  exceeded is a missing animation, never missing coins — the ledger and the
 *  balance are written either way. */
const POKE_DELAY_MS = 2_000;

let pokeTimer: ReturnType<typeof setTimeout> | null = null;

/** Beat soon, instead of waiting out the 60s interval.
 *
 *  WHY: the award for a message you just sent lands a moment after the
 *  response, so without this your own "+1q" would appear up to a minute later,
 *  long after the action that earned it — precisely the connection the chip
 *  exists to draw.
 *
 *  Coalescing matters: sending three messages in quick succession must produce
 *  ONE beat, not three. The chip query groups by kind over the whole window, so
 *  a single beat reports all three anyway, and three would just be two wasted
 *  round trips racing each other for the same cursor.
 *
 *  Fire-and-forget by design: a failed poke means a missed animation. Never
 *  await it from the action it follows. */
export function pokeCoinHeartbeat(): void {
  if (beatNow === null || pokeTimer !== null) return;
  pokeTimer = setTimeout(() => {
    pokeTimer = null;
    beatNow?.();
  }, POKE_DELAY_MS);
}

type HeartbeatResponse = { balance?: number | null; chips?: EarnChipItem[] };

export function useCoinHeartbeat(isSignedIn: boolean, live: boolean) {
  useEffect(() => {
    if (!isSignedIn || !live) return;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      postJson("/api/points/heartbeat", {})
        .then((r) => (r.ok ? r.json() : null))
        .then((d: HeartbeatResponse | null) => {
          if (!d) return;
          if (typeof d.balance === "number") setCoinBalance(d.balance);
          if (Array.isArray(d.chips)) pushEarnChips(d.chips);
        })
        .catch(() => {});
    };
    beat();
    beatNow = beat;
    const id = setInterval(beat, 60_000);
    return () => {
      clearInterval(id);
      // Only surrender the handle if it is still OURS. A module-level slot
      // shared by every mount means an unconditional `beatNow = null` here
      // would silently disarm whichever beat had since claimed it, leaving
      // pokes dead for the rest of the session with nothing to show why.
      if (beatNow === beat) beatNow = null;
    };
  }, [isSignedIn, live]);
}
