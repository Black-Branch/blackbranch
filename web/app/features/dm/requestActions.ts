// A DM request's Block (Discord's message request: Accept · Ignore · Block). Hiding the person
// puts a site account on the Matrix ignore list (useHiddenIgnoreSync), which the homeserver
// enforces — their later invites and lines never arrive — and the request itself is declined.
// Nothing blocks on its own: this runs only on the viewer's press.
import { hidePerson, type HideResult } from "@/app/lib/behaviorStore";
import type { HideTarget } from "@/app/lib/hideTarget";

const BLOCKED = "Blocked — undo in Settings › Behavior";
const LINES: Record<HideResult, string> = {
  hidden: BLOCKED,
  already: BLOCKED,
  full: "Your hidden list is full — remove someone in Settings › Behavior",
  failed: "Couldn't block — try again",
  self: "That's you — there is no one to block",
};

export async function blockRequest(
  target: HideTarget,
  me: { matrixId?: string | null; ownIds?: readonly string[] | null },
  decline: () => Promise<void>,
  hide: typeof hidePerson = hidePerson,
): Promise<{ line: string; blocked: boolean }> {
  const r = await hide(target, me);
  const blocked = r === "hidden" || r === "already";
  if (blocked) {
    // Already hidden, so the server refuses them from here on; a failed leave only leaves the
    // request in the Community invite list.
    await decline().catch((e: unknown) => console.warn("[dm] decline after block failed:", e));
  }
  return { line: LINES[r], blocked };
}
