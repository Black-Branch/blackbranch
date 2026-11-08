// The page's cache of events fetched one by one (reply quotes, pins — replyTarget.ts), keyed by
// room AND id: an id named in one room must never answer with an event from another. Its own
// light module so the sign-out path (plugins/session.ts) can empty it without loading the SDK.
import type { MatrixEvent } from "matrix-js-sdk";

export type Fetched = MatrixEvent | "unavailable";

/** The fetch in flight, then its result, per `fetchKey`. */
export const fetchedEvents = { inFlight: new Map<string, Promise<Fetched>>(), results: new Map<string, Fetched>() };

export const fetchKey = (roomId: string, id: string): string => `${roomId}\u0000${id}`;

/** Forget everything fetched: called on sign-out, an account switch and a revoked session. */
export function forgetFetchedEvents(): void {
  fetchedEvents.inFlight.clear();
  fetchedEvents.results.clear();
}
