// What the lockdown's account-age lever says it holds, per platform. The age lever never holds a
// platform whose account age cannot be checked (stream-api GET /lockdown/checkable, relayed in the
// lockdown view as `checkable`): Kick publishes no account age, Twitch needs the app's keys, YouTube
// an API key. So the lever names the platforms it holds and says of each other one "age unknown on
// <platform> — not held". Pure.

import { INGEST_PLATFORMS } from "../../lib/lockdownLevers.ts";
import { platformLabel } from "../../lib/platforms.ts";

/** stream-api's answer: per platform, whether an account's age can be read (native is the site's own). */
export type Checkable = Partial<Record<string, boolean>>;

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export type AgeLeverText = {
  /** The lever's line under its name. */
  detail: string;
  /** One line per platform whose age is unknown: "Age unknown on Kick — not held." */
  unknown: string[];
  /** The note after switching it on. */
  armed: (days: number) => string;
};

export function ageLeverText(minAge: number, checkable: Checkable | null | undefined): AgeLeverText {
  const on = minAge > 0;
  if (!checkable) {
    // An answer this page could not read: say what the lever does without naming platforms.
    return {
      detail: on
        ? `Holding platform accounts under ${minAge}d where the platform says how old an account is. Held messages wait in review, not deleted.`
        : "Holds new platform accounts for review, where the platform says how old an account is.",
      unknown: [],
      armed: (d) => `Holding platform accounts under ${d} days where their age is known.`,
    };
  }
  const held = INGEST_PLATFORMS.filter((p) => checkable[p] === true).map(platformLabel);
  const notHeld = INGEST_PLATFORMS.filter((p) => checkable[p] !== true).map(platformLabel);
  const unknown = notHeld.map((name) => `Age unknown on ${name} — not held.`);
  if (!held.length) {
    return {
      detail: "No platform here says how old an account is, so this holds nothing from platform chat.",
      unknown,
      armed: () => "Account-age filter on — but no platform here says how old an account is, so nothing is held.",
    };
  }
  return {
    detail: on
      ? `Holding ${list(held)} accounts under ${minAge}d. Held messages wait in review, not deleted.`
      : `Holds new ${list(held)} accounts for review.`,
    unknown,
    armed: (d) => `Holding ${list(held)} accounts under ${d} days.`,
  };
}
