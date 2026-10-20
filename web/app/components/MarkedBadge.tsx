"use client";

import { useIsMarked } from "@/app/lib/markedPeople";

/** "Marked" beside a name in chat — mods only (the set is empty for everyone else, see
 *  markedPeople.ts). Automod opened a suspicious mark on this person; the usercard says why. */
export function MarkedBadge({ matrixId, canonicalId }: { matrixId?: string | null; canonicalId?: string | null }) {
  if (!useIsMarked(matrixId, canonicalId)) return null;
  return (
    <span className="ml-1 rounded px-1 text-2xs font-semibold text-amber-300 border border-amber-400/40 align-middle"
      title="Marked by automod — repeated risky messages. Open their card to see why or clear it.">
      Marked
    </span>
  );
}
