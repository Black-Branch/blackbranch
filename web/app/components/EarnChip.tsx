"use client";

// The "+2q" chip: a small badge that surfaces above the viewer's own avatar in
// the composer when Qorm lands, then fades.
//
// It exists to make the earning loop legible: there are several different
// participation awards, and a balance that silently ticks up teaches nobody
// which action paid.
//
// ANCHORING: renders `absolute`, so the caller must be a positioned ancestor.
// It is mounted next to UserMenu in ChatInput's composer row — a surface that
// renders once. Never inside ChatMessage: that is memoized and rendered once
// per message in the backlog, and subscribing it to a store that ticks every
// 1.5s would re-render the entire history on every award.
//
// The store owns the timing (useEarnChip.ts); this file owns only the look.
//
// NO LABEL, and no `whitespace-nowrap`. A label ("+5q first message") would be
// most of the chip's width and hang well past the 34px avatar it is centred
// on, off the edge of a narrow composer. Without it the chip is about the
// avatar's own width, so staying inside is structural rather than lucky.
//
// It is CENTRED on a 34px avatar that sits at the left end of the composer,
// so its safety depends on staying narrow: about 54px before it would cross the
// composer's left edge. "+9q" is ~38px and the largest realistic window is a
// couple of digits (watch is capped at 30/stream and participation arrives a
// few Qorm at a time), so the bound holds with room. If the chip ever gains
// content again, anchor it `left-0` instead of centring — and move the -50%
// out of both keyframe blocks, which is where the centring actually lives.
//
// aria-hidden: this is a 1.5s flourish that can fire several times a minute,
// and a live region announcing "+1q message" over and over would bury whatever
// a screen-reader user was actually reading. The balance is the authoritative
// surface and it is plain text in the profile card; nothing is only here.

import { useEffect } from "react";
import { formatCoinsShort, EARN_KINDS, type EarnKind } from "@/app/lib/coins";
import { EARN_CHIP_MS, pushEarnChips, useEarnChip } from "@/app/lib/useEarnChip";

/** `?chipdebug=1` — replay the full chip sequence on demand.
 *
 *  Awards are live-gated at every layer, so the chip cannot fire unless a
 *  stream is running; this lets it be inspected off-air. Same shape as
 *  `?kbdebug=1` and `?pressdebug=1`.
 *
 *  It pushes to the CLIENT store only. No request is made, no ledger row is
 *  written, no Qorm exists. It cannot be used to fake earnings — the wallet is
 *  server-side and this never speaks to it. That is what makes it safe to ship
 *  rather than gate behind an admin check. */
function useChipDebug() {
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("chipdebug")) return;
    // Record<EarnKind, ...>, not Record<string, ...> — a new earn kind that
    // forgets to add itself here is a COMPILE error, not a silent `?? 1`
    // fallback that quietly demos the wrong amount forever.
    const amounts: Record<EarnKind, number> = {
      earn_first: 5, earn_chat: 1, earn_upvote: 2, earn_vote: 1, earn_watch: 1, earn_bonus: 1,
    };
    const play = () => pushEarnChips(EARN_KINDS.map((k) => ({ kind: k, points: amounts[k] })));
    play();
    // Loops so it can be watched, screenshotted and compared without reloading.
    // Short loop on purpose: comparing motions means seeing one repeatedly.
    const id = setInterval(play, EARN_CHIP_MS + 900);
    return () => clearInterval(id);
  }, []);
}

export function EarnChip() {
  const { points, seq } = useEarnChip();
  useChipDebug();
  if (points === 0) return null;
  return (
    <span
      // Keyed on the sequence number, not the content: two consecutive "+1q
      // message" awards are different events, and without a changing key React
      // would reuse the element and the second one would never animate.
      key={seq}
      // NO `-translate-x-1/2` utility. The horizontal centring lives in the
      // `earn-chip` keyframes instead: Tailwind 4's translate utilities write
      // the `translate` PROPERTY, which composes with `transform` rather than
      // replacing it, so the two would stack and throw the chip a full width
      // off the avatar. One owner for the offset, and it has to be the
      // keyframes — they animate transform and would win regardless.
      className="earn-chip pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 rounded-full border border-edge bg-surface-2 px-1.5 py-0.5 text-xs font-medium tabular-nums text-yellow-500 shadow-sm"
      // The duration comes from the store's constant rather than the
      // stylesheet, so the animation and the queue's hand-off cannot drift: a
      // chip that outlived its slot would overlap its successor, and one that
      // finished early would leave a gap.
      style={{ animationDuration: `${EARN_CHIP_MS}ms` }}
      aria-hidden="true"
    >
      +{formatCoinsShort(points)}
    </span>
  );
}
