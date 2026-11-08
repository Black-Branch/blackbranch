// The Bans form's defaults and button wording, pure so the test reads them without a DOM.

import type { HistoryWindow } from "@/app/lib/banHistory";

/** Minutes as a string, or "perm" for a permanent ban — the select's values. */
export type BanDuration = "10" | "60" | "1440" | "10080" | "perm";

/** The form opens on the gentlest action: a 10-minute timeout, and no community history deleted
 *  (banHistory.ts; ADR 0116 — the new choice arrives with today's behaviour). */
export const banFormDefaults: { duration: BanDuration; history: HistoryWindow } = { duration: "10", history: "none" };

/** The button names what it will do. */
export function banButtonLabel(d: BanDuration): string {
  if (d === "perm") return "Ban permanently";
  const m = Number(d);
  return `Time out ${m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`}`;
}
