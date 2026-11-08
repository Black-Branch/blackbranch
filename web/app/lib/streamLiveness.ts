// The per-platform liveness the site reads: stream-api's /stream/current `liveness` (Task 6 of the
// per-platform liveness plan), cut again at this trust boundary through the ONE sanitizer,
// PLATFORM_LIVENESS.publicSnapshot — only state, since and YouTube's scheduled start pass, whatever
// stream-api sent. Pure; streamStatus.ts is its caller (it cannot load in a test: it imports the pool).

import { PLATFORM_LIVENESS } from "./platformLiveness.generated.mjs";
import type { PublicSnapshot } from "./platformLiveness.generated.mjs";

/** `cur.liveness` as a PublicSnapshot; undefined when there is none or it has no numeric `at`. */
export function livenessOf(cur: unknown): PublicSnapshot | undefined {
  if (!cur || typeof cur !== "object") return undefined;
  const l = (cur as { liveness?: unknown }).liveness;
  if (!l || typeof l !== "object") return undefined;
  const { at, platforms } = l as { at?: unknown; platforms?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return PLATFORM_LIVENESS.publicSnapshot(platforms, at);
}
