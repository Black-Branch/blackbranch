"use client";

// The Display section of the mod panel, extracted from ModPanel.tsx.
// Internal to the `moderation` feature — nothing outside can import it.

import { card, h2 } from "../shared";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { MOD_SHOW_DELETED_LS_KEY } from "@/app/lib/useChatMessages";

// ─── Display prefs ─────────────────────────────────────────────────────────────

// Per-viewer, not a site setting — a mod who's just clearing spam doesn't want
// to keep seeing what they removed, but a mod reviewing moderation for
// transparency wants the struck-out copies. Off by default (see useChatMessages.ts).
export default function DisplaySection() {
  const [showDeleted, setShowDeleted] = useLocalStorageString(MOD_SHOW_DELETED_LS_KEY);
  const on = showDeleted === "1";
  return (
    <section className={card}>
      <h2 className={h2}>Display</h2>
      <label className="flex items-center gap-2.5 text-sm text-body-dim select-none cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setShowDeleted(e.target.checked ? "1" : "0")}
        />
        Show deleted messages (struck out, your view only)
      </label>
    </section>
  );
}
