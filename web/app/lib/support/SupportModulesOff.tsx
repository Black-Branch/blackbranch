"use client";

import { setSupportFacts, type SupportFacts } from "./flows";
import { setSiteFeatures } from "../siteFeatures";

/**
 * Tells the support panel what this install runs: the modules it does not show (config/modules.mjs
 * "ONE RULE"; the home page reads them) and the facts the answers depend on (supportFactsServer.ts
 * — buying points, the subscription, read-aloud, AI answers). Rendered before the chat so the
 * panel's first answers are already right. Renders nothing.
 */
export function SupportModulesOff({ off, facts }: { off: readonly string[]; facts: Omit<SupportFacts, "off"> }) {
  setSupportFacts({ off, ...facts });
  setSiteFeatures({ off, ...facts });
  return null;
}
