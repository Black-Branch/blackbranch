// What this install runs, for the client parts that offer or refuse something by it — the command
// picker and runner (commands/spec.ts `module`) today. Universal, no imports.
//
// Set once per page by the server render (SupportModulesOff, on the stream page and the popout),
// before the chat mounts, from the same facts the help desk reads (supportFactsServer.ts). Before
// that, everything install-specific reads as OFF: a command is never offered on a guess.
//
// A feature id is a module id from config/modules.mjs (radio, obs, youtube, …), or one of the
// facts below that is not a module switch.

export type SiteFacts = {
  /** Modules this install does not show (config/modules.mjs "ONE RULE"). */
  off: readonly string[];
  /** Points can be bought. */
  purchasable: boolean;
  /** A usable Supporter price: the subscription is offered. */
  subscriptions: boolean;
  /** stream-api speaks paid messages and alerts. */
  tts: boolean;
};

/** The non-module features, by the fact that switches each. */
const FACT_FEATURES = { purchasable: "purchasable", subscriptions: "subscriptions", tts: "tts" } as const;

let OFF: ReadonlySet<string> | null = null;

/** Record what this install runs. */
export function setSiteFeatures(f: SiteFacts): void {
  const off = new Set(f.off);
  for (const [fact, id] of Object.entries(FACT_FEATURES)) if (!f[fact as keyof typeof FACT_FEATURES]) off.add(id);
  OFF = off;
}

/** Is this feature (a module id or a fact feature) available here? Unknown → false until the page
 *  has said. A part with no feature id is always available — pass undefined. */
export function featureOn(id: string | undefined): boolean {
  if (!id) return true;
  return OFF !== null && !OFF.has(id);
}
