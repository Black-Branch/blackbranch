// The streamer's switch for the highlight (#250; Admin Panel › Site › Site › Streamer highlight).
// The pure decisions, dependency-free so node --test runs them (spotlightSwitch.test.ts); the
// server reads and the stream-api call are spotlightServer.ts.
import type { SpotlightPick } from "./chatSpotlight.ts";

/** The instance key: true = the highlight is off for everyone. */
export const SPOTLIGHT_OFF_KEY = "chat.spotlight.off";

/** What the web route forwards to stream-api for a click: the pick as asked, or — with the
 *  highlight switched off — a clear, so nothing reaches a viewer and a stale pick goes too. */
export function spotlightToForward(requested: SpotlightPick, off: boolean): SpotlightPick {
  return off ? null : requested;
}

/** After `key` was saved or cleared: whether the pick showing now must be taken down. */
export function takesDownSpotlight(key: string, offNow: boolean): boolean {
  return key === SPOTLIGHT_OFF_KEY && offNow;
}
