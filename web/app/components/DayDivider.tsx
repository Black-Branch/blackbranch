"use client";

import { fullDate } from "@/app/lib/textFormat";

// The date line between days (Discord's), in the thread panel's hairline
// pattern and the site's date format.
export function DayDivider({ ts }: { ts: number }) {
  const label = fullDate(ts);
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 px-4 pt-3 pb-1">
      <div className="h-px flex-1 bg-raised" />
      <span className="text-2xs text-muted shrink-0 font-medium">{label}</span>
      <div className="h-px flex-1 bg-raised" />
    </div>
  );
}

// The "New" line above the first message the reader has not seen.
export function NewMessagesLine() {
  return (
    <div role="separator" aria-label="New messages" className="flex items-center gap-2 px-4 pt-2">
      <div className="h-px flex-1 bg-accent" />
      <span className="text-3xs font-semibold uppercase text-accent shrink-0">New</span>
    </div>
  );
}
