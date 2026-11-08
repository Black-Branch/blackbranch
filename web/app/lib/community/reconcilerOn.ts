// Does this install have the community reconciler (install key community.reconciler)? Then the
// reconciler alone places room bans and power levels, and the browser syncs stand down. Server and
// browser read the same install value; it changes only with a restart.
import { installValue } from "../installValues.ts";

export function reconcilerOn(): boolean {
  return installValue("community.reconciler") === "true";
}
