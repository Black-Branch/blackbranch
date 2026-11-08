// Ask the host for a community reconciler run after a site change the reconciler applies (a ban, a
// timeout, a lift). SERVER ONLY. Best effort: the change is saved either way, and the timer's next
// run applies it.
import { requestHost } from "../hostRequests.ts";
import { reconcilerOn } from "./reconcilerOn.ts";

type Ask = () => Promise<{ ok: boolean }>;

/** True when the host was asked. An install without the reconciler is never asked. */
export async function requestReconcile(on: boolean = reconcilerOn(), ask: Ask = () => requestHost("community-reconcile")): Promise<boolean> {
  if (!on) return false;
  try {
    return (await ask()).ok;
  } catch {
    return false;
  }
}
