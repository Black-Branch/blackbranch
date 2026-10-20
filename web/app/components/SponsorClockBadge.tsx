"use client";

import { useMemo } from "react";
import { useSponsorClock } from "@/app/lib/SponsorClockContext";
import { clockRemainSecFor, clockFracFor } from "@/app/lib/sponsorClock";
import { useStorePrices } from "@/app/lib/useStorePrices";
import { DEFAULT_EARN_RULES } from "@/app/lib/earnRules";
import { currencyName } from "@/app/lib/currency";

// Fund the Night: a tiny green clock glyph at the upper-right corner of a chat
// row's username, shown while that viewer's donation is currently keeping
// tonight's clock funded (`clockRemainSec > 0` for their name in the live
// `sponsorState` pool — sponsors.js `buildFrame()`).
//
// It is a SWEEP ring: the lit arc is `clockRemainSec / clockTotalSec` of their
// badge window, draining as the funded time runs down — the icon carries a
// real signal, not just presence. The credit overlay renders this same
// component (web-served /overlay/credit), so the two surfaces cannot drift.
//
// A LEAF component, mounted once PER CHAT ROW — but it must NEVER open its own
// `useChatSocket` subscription: up to MAX_SCROLLBACK concurrent rows would each
// subscribe to the shared socket's fan-out, each receiving every frame type.
// It reads the pool from `SponsorClockContext` instead — ONE subscription for
// the whole page (mounted in layout.tsx alongside BadgesProvider), fanned out
// via React context the same way BadgesContext already fans out badge state
// to every ChatMessage row. Pinned: wsSocketShare.test.ts enumerates every
// direct `useChatSocket(` caller and asserts this file is not one of them.
//
// No settings gate: this is a platform surface (who is funding the clock right
// now), not a per-viewer preference.
//
// Sized in `em` off the INHERITED font-size (the username's own chat font
// size), so it scales with the chat font-size setting for free. INLINE, sitting
// between the name and its colon and raised like a superscript (an absolutely
// positioned corner version lands on the colon's slot). It widens the name by
// ~0.6em while worn — a one-time change per row when the pool updates,
// accepted over the overlap.
export function SponsorClockBadge({ username }: { username: string | null | undefined }) {
  const sponsors = useSponsorClock();
  const { clockRemainSec, frac } = useMemo(
    () => ({ clockRemainSec: clockRemainSecFor(sponsors, username), frac: clockFracFor(sponsors, username) }),
    [sponsors, username]
  );

  if (clockRemainSec <= 0) return null;
  return <LitClock frac={frac} />;
}

/** Only a LIT clock reads the store table (for the multiplier) — every chat row renders a
 *  SponsorClockBadge, and a subscription per row would be hundreds for one number. */
function LitClock({ frac }: { frac: number }) {
  // The real multiplier (a setting). Until the store table's first read lands, the
  // product's own — the tooltip is only read on hover, by which time the read has landed.
  const multiplier = useStorePrices().clockMultiplier ?? DEFAULT_EARN_RULES.clockMultiplier;
  // The sweep: a ring whose lit arc is the
  // fraction of this donor's badge window still ahead — it drains clockwise
  // from 12 as their funded time runs down. A conic gradient paints the arc;
  // a radial MASK cuts the centre out so the ring is a true ring over any row
  // background (hover tint, own-message tint, highlights) rather than a fake
  // inner disc that only matches one of them.
  const pct = `${Math.round(frac * 1000) / 10}%`;
  const ring = "radial-gradient(farthest-side, transparent calc(100% - 0.11em), #000 calc(100% - 0.11em))";
  return (
    <span
      aria-hidden="true"
      title={`Keeping tonight's clock funded · earning ${multiplier}× ${currencyName()} while lit`}
      style={{
        display: "inline-block",
        verticalAlign: "0.45em",
        marginLeft: "0.12em",
        width: "0.5em",
        height: "0.5em",
        borderRadius: "50%",
        background: `conic-gradient(#3fae6f 0 ${pct}, rgba(63,174,111,0.22) ${pct} 100%)`,
        WebkitMaskImage: ring,
        maskImage: ring,
        filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.55))",
        pointerEvents: "none",
      }}
    />
  );
}
