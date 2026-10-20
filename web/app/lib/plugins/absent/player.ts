import type { PlayerFallback } from "../types.ts";

// What @owner/player resolves to when this install has no owner folder: no fallback player modes.
// The player is then Live · Community, and offline shows the offline card.
export const playerFallbacks: readonly PlayerFallback[] = [];
