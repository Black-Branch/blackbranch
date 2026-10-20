"use client";

import type { PresenceState } from "@/app/lib/presenceState";

// The one mapping from a presence state to a dot. Tailwind palette
// classes only — check-tokens bans raw colours. `site` is a ring: here, but
// not in the community (no message can reach them live).
// offline uses the semantic grey role (check-tokens' raw-zinc rule bans the
// literal utility; the token in globals.css is defined AS that same shade).
const DOT: Record<PresenceState, string> = {
  community: "bg-emerald-500",
  site: "bg-canvas ring-2 ring-inset ring-emerald-500",
  elsewhere: "bg-sky-400",
  away: "bg-amber-400",
  dnd: "bg-red-500",
  offline: "bg-muted",
};

export function PresenceDot({ state, size = 10, title }: { state: PresenceState; size?: number; title?: string }) {
  return (
    <span
      data-presence={state}
      title={title}
      className={`inline-block rounded-full border-2 border-canvas ${DOT[state]}`}
      style={{ width: size, height: size }}
    />
  );
}
