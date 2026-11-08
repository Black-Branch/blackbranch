"use client";

import { CHAT_FONT } from "@/app/lib/chatFont";

// The message area's one loading picture (TimelineBody): four grey rows standing on the bottom
// edge, where the newest messages will be. Each row is built from the REAL row's classes
// (.mx-row / .mx-body / .mx-main / .mx-head / .mx-avatar, globals.css Community), so its height
// is the timeline's own row height in every layout — Cozy's gutter picture, Compact's inline
// one, the pane's 32px — with nothing measured or copied here.
// aria-hidden: TimelineBody's region says "Loading messages" once; the bars say nothing.

const WIDTHS = ["72%", "48%", "64%", "36%"] as const;

export function TimelineSkeleton() {
  return (
    <div aria-hidden="true" data-timeline-skeleton=""
      className="pointer-events-none absolute inset-x-0 bottom-0 flex max-h-full flex-col justify-end overflow-hidden py-1">
      {WIDTHS.map((w, i) => (
        <div key={i} data-skeleton-row="" data-head="" className="mx-row pb-0.5">
          <div className="mx-body">
            <div className="min-w-0 pr-6">
              <div className="mx-main">
                <div className="mx-head flex items-baseline gap-1.5 leading-tight">
                  <span className="mx-avatar shrink-0 self-center">
                    <span className="block rounded-full bg-raised"
                      style={{ width: "var(--mx-avatar-box, 1.35em)", height: "var(--mx-avatar-box, 1.35em)" }} />
                  </span>
                  <span className="inline-block rounded bg-raised" style={{ fontSize: CHAT_FONT, width: "6em" }}>&nbsp;</span>
                </div>
                <div style={{ fontSize: CHAT_FONT }}>
                  <span className="inline-block rounded bg-raised/70" style={{ width: w }}>&nbsp;</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
