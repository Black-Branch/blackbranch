// The grace days every service's access runs past the end the service last reported (spec §3.4):
// a cancel or end event lost for good — a webhook down, a module switched off past the service's
// retries — cannot leave access open for ever. The spec's install key `subscriptions.graceDays`
// (§11, default 7) does not exist yet; until it lands, this is its default.
export const GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

/** `end` plus the grace days; null when there is no end to add them to. */
export function withGrace(end: Date | null, graceDays: number = GRACE_DAYS): Date | null {
  return end ? new Date(end.getTime() + graceDays * DAY_MS) : null;
}
