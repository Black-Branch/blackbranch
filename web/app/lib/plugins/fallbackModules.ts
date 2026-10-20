// Which registered fallback player modes are switched on. Pure, so node --test can load it
// without the `@owner/*` alias. A fallback that names a module (`modules.<id>`) is offered only
// while that switch is on; one that names none is always offered.
import type { PlayerFallback } from "./types.ts";

export function fallbacksOn<F extends Pick<PlayerFallback, "id" | "module">>(all: readonly F[], offModules: readonly string[]): F[] {
  return all.filter((f) => !f.module || !offModules.includes(f.module));
}
