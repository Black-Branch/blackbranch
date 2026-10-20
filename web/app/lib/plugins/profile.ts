// What the install's plugin adds to a person's profile card (`profileExtras`) — read through
// `@owner/profile` (app/(owner)/profile.ts, or ./absent/profile.ts with no owner folder).
import { profileExtras } from "@owner/profile";
import type { ProfileFacts } from "./types.ts";
import type { PillRole } from "../tierPills.ts";

/** The plugin's descriptor pill for this profile — its label, value and tone — or null for none. */
export function profileDescriptor(profile: ProfileFacts): { label: string; value: string; role: PillRole } | null {
  const d = profileExtras.descriptor;
  if (!d) return null;
  const value = d.value(profile);
  return { label: d.label, value, role: d.tone?.(value) ?? "neutral" };
}

/** The lookup fields the installed plugin wants forwarded to the card — none without a plugin. */
export function pluginProfileFields(): readonly string[] {
  return profileExtras.publicFields ?? [];
}

/** The plugin's read of the person, or null for none. */
export function profileRead(profile: ProfileFacts): string | null {
  return profileExtras.read?.(profile) ?? null;
}
