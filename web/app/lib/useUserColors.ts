"use client";

import { useEffect, useSyncExternalStore } from "react";
import { userStyleStore, type UserColors } from "@/app/lib/userStyleStore";

const EMPTY: UserColors = {};

// Platform-chosen username colors keyed by matrix_id — the Matrix UI's source of truth for name
// colors (the Matrix profile has no colour field). Holds the ids something has asked for with
// useWantUserStyles; re-renders when an answer lands.
export function useUserColors(): UserColors {
  return useSyncExternalStore(userStyleStore.subscribe, userStyleStore.colors, () => EMPTY);
}

/** Ask for the colours and looks of the names this component draws. */
export function useWantUserStyles(ids: readonly (string | null | undefined)[]): void {
  const key = ids.filter(Boolean).join(",");
  useEffect(() => {
    if (key) userStyleStore.want(key.split(","));
  }, [key]);
}
