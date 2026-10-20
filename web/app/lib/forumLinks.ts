// The thread deep link: any surface — Home's Active-threads widget, a chat
// link — asks for a thread with openForumThread(); the host
// that owns the Forums tab for this viewport (the dock on desktop, the phone
// sidebar) claims the event, arms/opens the tab and hands the tab the ref.
//
// `.ts` relative import: node --test loads this module (dockState.ts says why).
import { dispatchClaimable } from "./claimableEvent.ts";

export const OPEN_FORUM_THREAD_EVENT = "bb:open-forum-thread";
export type ThreadRef = { roomId: string; eventId: string };

/** Ask whichever host is mounted to open this thread. True when one claimed it. */
export function openForumThread(ref: ThreadRef): boolean {
  return dispatchClaimable(OPEN_FORUM_THREAD_EVENT, ref);
}

/** The event's detail as a ThreadRef, or null for anything malformed. */
export function readThreadDetail(e: Event): ThreadRef | null {
  const d = (e as CustomEvent<unknown>).detail;
  if (!d || typeof d !== "object") return null;
  const { roomId, eventId } = d as { roomId?: unknown; eventId?: unknown };
  if (typeof roomId !== "string" || !roomId.startsWith("!") || roomId.length > 256) return null;
  if (typeof eventId !== "string" || !eventId.startsWith("$") || eventId.length > 256) return null;
  return { roomId, eventId };
}
