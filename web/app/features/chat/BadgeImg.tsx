"use client";

import { rowBasisCalc } from "@/app/lib/chatFont";
import { useStillFrame } from "@/app/lib/stillFrame";

// A chat-row badge. With animated emotes off, an animated badge shows its
// first frame (drawn once per badge and shared by every row — stillFrame.ts,
// round 2b). Its own file: defined inside ChatMessage.tsx it made the React
// Compiler skip that component's memoization.
export function BadgeImg({ badge, still }: { badge: { name: string; imageUrl: string }; still: boolean }) {
  const src = useStillFrame(badge.imageUrl, still);
  return (
    <img
      src={src}
      alt={badge.name}
      title={badge.name}
      style={{ height: rowBasisCalc('1.10 * var(--chat-badge-scale, 1)'), width: "auto", display: "inline-block", verticalAlign: "middle" }}
    />
  );
}
