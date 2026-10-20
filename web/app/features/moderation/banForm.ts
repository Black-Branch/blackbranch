// The Bans form's defaults and button wording, pure so the test reads them without a DOM.

/** Minutes as a string, or "perm" for a permanent ban — the select's values. */
export type BanDuration = "10" | "60" | "1440" | "10080" | "perm";

/** The form opens on the gentlest action: a 10-minute timeout. */
export const banFormDefaults: { duration: BanDuration } = { duration: "10" };

/** The button names what it will do. */
export function banButtonLabel(d: BanDuration): string {
  if (d === "perm") return "Ban permanently";
  const m = Number(d);
  return `Time out ${m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`}`;
}
