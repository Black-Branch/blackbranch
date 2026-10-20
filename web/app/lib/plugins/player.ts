// The player's registered fallbacks — read from the install's plugin through `@owner/player`
// (app/(owner)/player.ts, or ./absent/player.ts when there is no owner folder). Client components
// read the ones switched ON through usePlayerFallbacks(): the home page reads the module switches
// on the server and StreamView provides the filtered list, so a radio-off install has no Radio
// anywhere in the player. The pure player model (playerSource.ts, playerMode.ts) takes the ids as
// a parameter so node --test can load it.
import { createContext, useContext, useMemo } from "react";
import { playerFallbacks } from "@owner/player";
import type { PlayerFallback } from "./types.ts";
import { fallbacksOn } from "./fallbackModules.ts";

const PLAYER_FALLBACKS: readonly PlayerFallback[] = playerFallbacks;

/** The registered fallbacks whose module switch is on. */
export function fallbacksSwitchedOn(offModules: readonly string[]): readonly PlayerFallback[] {
  return fallbacksOn(PLAYER_FALLBACKS, offModules);
}

const FallbacksContext = createContext<readonly PlayerFallback[]>(PLAYER_FALLBACKS);
export const PlayerFallbacksProvider = FallbacksContext.Provider;

export type PlayerFallbacks = {
  /** Their ids, in rail order. */
  ids: readonly string[];
  /** The fallback a tab names, or null for a built-in tab (or one switched off). */
  fallbackFor: (tab: string) => PlayerFallback | null;
};

export function usePlayerFallbacks(): PlayerFallbacks {
  const list = useContext(FallbacksContext);
  return useMemo(() => ({
    ids: list.map((f) => f.id),
    fallbackFor: (tab: string) => list.find((f) => f.id === tab) ?? null,
  }), [list]);
}
