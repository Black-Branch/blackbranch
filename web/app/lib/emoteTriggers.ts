"use client";

import { useState, useEffect } from "react";
import { lsGet } from "@/app/lib/safeLocalStorage";
import { Q_POINTER_COARSE } from "./deviceQueries";

// The pure trigger detection + value builders live in emoteTriggerLogic.ts (no
// React, caret-aware, unit-tested via `node --test`). Re-exported here so the
// existing imports from "./emoteTriggers" keep working; this file owns only the
// React autosuggest-preference hook.
export type { SavedState, Triggers, TriggerMode } from "./emoteTriggerLogic";
export { detectTriggers, getCurrentTrigger, buildValue, restoreQuery } from "./emoteTriggerLogic";

// Auto-suggest preference + pointer type. When auto-suggest is OFF a plain
// 2+ char word does NOT pop a list on its own: on desktop it waits for Tab
// (matches populate, popup hidden until Tab); on mobile (no Tab key) it's
// suppressed entirely. When ON, plain words auto-open everywhere. The `:`
// colon trigger always auto-opens regardless. Re-reads on the
// `bb:emote-pref` event ChatSettings fires when the toggle changes.
export function useEmotePref(): { autoSuggest: boolean; isCoarse: boolean } {
  const [autoSuggest, setAutoSuggest] = useState(false);
  const [isCoarse, setIsCoarse] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        if (typeof window === "undefined") return;
        setIsCoarse(window.matchMedia(Q_POINTER_COARSE).matches);
        // New key wins; migrate from the legacy `emoteTabOnly` (true/unset =
        // tab-only = auto-suggest off) so existing prefs carry over.
        const v = lsGet("chatStyle_emoteAutoSuggest");
        if (v !== null) { setAutoSuggest(v === "1"); return; }
        const legacy = lsGet("chatStyle_emoteTabOnly");
        setAutoSuggest(legacy === "0"); // legacy off => auto-suggest on
      } catch { setAutoSuggest(false); }
    };
    read();
    window.addEventListener("bb:emote-pref", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("bb:emote-pref", read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return { autoSuggest, isCoarse };
}
