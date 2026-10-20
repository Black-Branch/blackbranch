"use client";

// The React adapter over readiness.ts: a thin useSyncExternalStore. The store
// caches the merged view per key signature and returns the same array until
// something changes, which is what makes this adapter cheap — a fresh
// snapshot per read would re-render every reader on every read. Pass a
// module-level constant `keys` array.
import { useSyncExternalStore } from "react";
import { readReadiness, subscribeReadiness, type StageView } from "./readiness";

const NONE: readonly StageView[] = Object.freeze([]);

export function useReadiness(keys: readonly string[]): readonly StageView[] {
  return useSyncExternalStore(subscribeReadiness, () => readReadiness(keys), () => NONE);
}
