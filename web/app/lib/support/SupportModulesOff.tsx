"use client";

import { setSupportModulesOff } from "./flows";

/**
 * Tells the support panel which modules this install does not show (config/modules.mjs "ONE
 * RULE"; the home page reads them). Rendered before the chat so the panel's first answers are
 * already right. Renders nothing.
 */
export function SupportModulesOff({ off }: { off: readonly string[] }) {
  setSupportModulesOff(off);
  return null;
}
