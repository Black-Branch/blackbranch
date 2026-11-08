// What the install's plugin keeps for the signed-in person, forgotten on sign-out — read through
// `@owner/session` (app/(owner)/session.ts, or ./absent/session.ts). Its own area so every page's
// sign-out path stays light: it never loads the plugin's chat parts.
import { signOutHooks } from "@owner/session";
import { forgetFetchedEvents } from "../fetchedEvents.ts";
import { forgetKeyWaits } from "../keyWait.ts";

/**
 * Forget what the plugin keeps for the signed-in person (a sign-out, an account switch, a revoked
 * session) — and the events the site fetched for them (reply quotes, pins). Each hook is guarded
 * on its own: one failing must not stop the sign-out.
 */
export function runSignOutHooks(): void {
  for (const h of [forgetFetchedEvents, forgetKeyWaits, ...signOutHooks]) {
    try { h(); } catch { /* a plugin's cleanup must never block signing out */ }
  }
}
