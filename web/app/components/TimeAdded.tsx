"use client";

import { formatChipDuration } from "@/app/lib/chatFormat";

// Small "added X to the timer" chip — rendered inline on any row that carries
// addedSeconds (monetization events); a no-op on an ordinary message.
export function TimeAdded({ seconds }: { seconds?: number }) {
  if (!seconds || seconds <= 0) return null;
  return (
    <span className="ml-1.5 whitespace-nowrap text-secondary" style={{ fontSize: "0.82em" }}>
      ⏱ +{formatChipDuration(seconds)}
    </span>
  );
}
