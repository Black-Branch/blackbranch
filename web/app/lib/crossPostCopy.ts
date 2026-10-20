// What a viewer is told about account linking and cross-posting — two separate
// things, said separately, everywhere they are said.
//
// Linking is private (the link is shown only where the person shows it). Posting is
// not: while an account is linked, the chat box's default destination posts every
// message to it too, and a message posted on a platform carries the person's name
// there. The linking panel, About and the legal page carry the same pair, word for
// word, so the three can never describe two different products.
//
// `.ts` extensions: node --test imports this.
import { platformLabel } from "./platforms.ts";
import { siteName } from "./siteName.ts";
import { FOLLOWERS_ONLY, SUBSCRIBERS_ONLY, BANNED_THERE } from "./sendDelivery.ts";

export const LINKING_IS_PRIVATE =
  "Linking an account is private: the link itself is shown only where you choose to show it.";
export const POSTING_IS_SEPARATE =
  "Posting is separate: while an account is linked, your messages here are also posted to that platform unless you pick a different destination in the chat box, and a message posted there carries your name there.";

/**
 * The banner the moment a link lands: what will now happen to the person's
 * messages, and where to change it. `storedDest` is the chat box's saved
 * destination in this window (`null` = never chosen → the default, every linked
 * platform; `"native"` = this site only).
 */
export function linkedBanner(platform: string, opts: { crossPost: boolean; storedDest: string | null; pending: boolean }): string {
  const label = platformLabel(platform);
  const pending = opts.pending ? " Your chat identity will connect the first time you chat there during a stream." : "";
  if (!opts.crossPost) return `${label} linked.${pending}`;
  const d = opts.storedDest;
  if (d === null || d === "all" || d === platform) {
    return `${label} linked. Your messages here will now also be posted to ${label} — change where they go with the Send-to button in the chat box.${pending}`;
  }
  const now = d === "native" ? siteName() : platformLabel(d);
  return `${label} linked. Your chat box is set to send to ${now} only, so nothing goes to ${label} until you pick it (or All) with the Send-to button in the chat box.${pending}`;
}

/**
 * The ONE note a persistent refusal earns per session (platformRefusals.ts): the
 * platform's state and the fix. The line itself is already up here, so nothing
 * in it says "not sent". `reason` is the route's phrase (sendDelivery.ts).
 */
function refusalNote(platform: string, reason: string): string {
  const label = platformLabel(platform);
  if (reason === FOLLOWERS_ONLY) return `${label} is followers-only. Follow on ${label} to post there, or change Send to.`;
  if (reason === SUBSCRIBERS_ONLY) return `${label} is subscribers-only. Subscribe on ${label} to post there, or change Send to.`;
  if (reason === BANNED_THERE) return `You're banned on ${label}, so your messages post here only. Change Send to to stop trying ${label}.`;
  return `${label} won't take your messages (${reason}). Fix it on ${label} to post there, or change Send to.`;
}

/**
 * The note in every length, LONGEST FIRST: the full sentence, a short form with
 * the fix, and a phone form that is the fix alone. The composer shows the longest
 * that fits its field (ChatComposerField `note.forms`) — never a cut sentence —
 * and keeps the full one in the title and for screen readers.
 */
export function refusalNoteForms(platform: string, reason: string): string[] {
  const label = platformLabel(platform);
  const long = refusalNote(platform, reason);
  if (reason === FOLLOWERS_ONLY) return [long, `${label} is followers-only — tap Send to`, `Follow on ${label}`];
  if (reason === SUBSCRIBERS_ONLY) return [long, `${label} is subscribers-only — tap Send to`, `Subscribe on ${label}`];
  if (reason === BANNED_THERE) return [long, `Banned on ${label} — change Send to`, `Banned on ${label}`];
  return [long, `${label} refused — tap Send to`, `Fix it on ${label}`];
}

/**
 * The one line an infrastructure failure earns (ticket #184) — only when the
 * viewer picked that platform alone. Plain on purpose: no code, no cause, no
 * "quota"; the viewer can do nothing about it. Longest first, like the note.
 */
export function unreachableNoteForms(platform: string): string[] {
  const label = platformLabel(platform);
  return [`Couldn't reach ${label} chat right now.`, `Couldn't reach ${label} chat`];
}

/** The platform's state as the Send-to menu shows it beside the name: "Kick: followers-only". */
export function refusalState(reason: string): string {
  return reason === BANNED_THERE ? "banned" : reason;
}
