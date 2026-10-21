// Tier descriptors → colored pills on the user card.
//
// The card shows up to four stream-derived descriptors ("Constant | Dumb |
// Chatter | Patron"), plus the install plugin's one pill. Rendered as one grey
// run separated by pipes, a warning would read exactly as loud as praise — the
// information there but carrying no weight.
//
// Mapping tone here rather than inline in the component keeps it pure and
// testable, and makes the editorial choices reviewable in one place. The
// vocabulary is closed and comes from stream-api's aggregate refresh:
//
//   intelligence  Smart | Average | Dumb
//   regularity    Constant | Consistent | Familiar | Stranger
//   word count    Writer | Chatter | Reactor
//   support       Blessing | Patron | Contributor | Supporter
//
// The plugin's pill brings its own tone (ProfileExtras.descriptor.tone): its
// values are the plugin's vocabulary, which the product does not know (no
// scorer, no labels).
//
// Deliberate editorial calls:
//   • Nothing here is danger-red. "Dumb" is a percentile bucket, not an accusation
//     — flagging it red would put a mod in a punitive frame over a statistic.
//   • Every support tier shares one violet role, matching the Gift button, so
//     "this person pays for this" reads as a single idea at a glance.
//   • Unknown values fall back to neutral rather than throwing: these strings
//     come from a SQL CASE that has changed before and will change again.

export type PillRole = "positive" | "caution" | "danger" | "info" | "support" | "neutral";

const ROLES: Record<string, PillRole> = {
  // Intelligence — a percentile bucket. See note above: not red.
  Smart: "positive",
  Average: "neutral",
  Dumb: "caution",
  // Regularity — how reliably they show up. Being here a lot is a good thing.
  Constant: "positive",
  Consistent: "info",
  Familiar: "neutral",
  Stranger: "neutral",
  // Word count — a style, not a ranking.
  Writer: "info",
  Chatter: "neutral",
  Reactor: "neutral",
  // Support
  Blessing: "support",
  Patron: "support",
  Contributor: "support",
  Supporter: "support",
};

/** Tone for a descriptor. Unknown strings are neutral, never an error. */
// @test-only exported for userCard.test.ts (the product tones) and a site plugin's test (that it colours none of its labels); the card reaches it through tierChips.
export function pillRole(label: string): PillRole {
  return ROLES[label] ?? "neutral";
}

// Tailwind class pairs per role. Hue utilities (emerald/amber/red/…) are used
// rather than the semantic surface tokens because the design system's ladder is
// deliberately achromatic — it has no "danger" rung — and this file follows the
// convention already established by the card's Reach chips.
const CLASSES: Record<PillRole, string> = {
  positive: "bg-emerald-500/15 text-emerald-300",
  caution: "bg-amber-500/15 text-amber-300",
  danger: "bg-red-500/15 text-red-300",
  info: "bg-sky-500/15 text-sky-300",
  support: "bg-violet-500/15 text-violet-300",
  neutral: "bg-surface-2 text-body-dim",
};

/** Pill classes for a tone. */
export function pillClasses(role: PillRole): string {
  return CLASSES[role];
}

/** One pill on the card: its text and its tone. */
export type TierChip = { text: string; role: PillRole };

/**
 * The card's descriptor list, in display order:
 * regularity | the plugin's descriptor | intelligence | word count | support.
 *
 * Extracted from the component so the ordering and the "None support tier is
 * omitted" rule are pinned by tests. `descriptor` is the install plugin's pill
 * with the plugin's own tone (app/lib/plugins/profile.ts), null for none.
 */
export function tierChips(d: {
  regularityTier?: string | null;
  intelligenceTier?: string | null;
  wordCountTier?: string | null;
  supportTier?: string | null;
}, descriptor: { value: string; role: PillRole } | null): TierChip[] {
  const tier = (text: string): TierChip => ({ text, role: pillRole(text) });
  const chips: TierChip[] = [];
  if (d.regularityTier) chips.push(tier(d.regularityTier));
  if (descriptor !== null) chips.push({ text: descriptor.value, role: descriptor.role });
  if (d.intelligenceTier) chips.push(tier(d.intelligenceTier));
  if (d.wordCountTier) chips.push(tier(d.wordCountTier));
  if (d.supportTier && d.supportTier !== "None") chips.push(tier(d.supportTier));
  return chips;
}
