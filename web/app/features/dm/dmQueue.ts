// Which conversation the DM window shows, and which wait behind it. Pure: DmHost holds the state.
import { localpart } from "@/app/lib/matrixDisplay";
import type { DmPerson } from "@/app/lib/dm/bus";
import type { Arrival } from "./dmMatrix";
import type { Convo } from "./DmWindow";

export type DmState = { current: Convo | null; queue: Convo[] };

const QUEUE_MAX = 5;

const personOf = (matrixId: string): DmPerson => ({ matrixId, username: localpart(matrixId), displayName: null });

/** An incoming invite or line: the window for it, or a place in the queue — unless it is for the
 *  conversation already on screen (`onScreen`, the Community timeline the viewer is reading), the
 *  one already showing, or one already waiting. */
export function arriveInto(s: DmState, a: Arrival, onScreen: string | null, nextSeq: () => number): DmState {
  if (a.roomId === onScreen) return s;
  if (s.current?.person.matrixId === a.partner) {
    if (s.current.roomId) return s;
    // A draft with them becomes their conversation — they wrote first — and is answered like any
    // incoming one (Accept · Decline · Block on a request, Reply on a joined room). It never loses
    // the request: the window stays (DmHost's release leaves a no-longer-bindable window open).
    return { ...s, current: { ...s.current, roomId: a.roomId, invite: a.invite, draft: false, incoming: true, accepted: false, notPrivate: undefined } };
  }
  if (s.queue.some((q) => q.person.matrixId === a.partner)) return s;
  const convo: Convo = { seq: nextSeq(), person: personOf(a.partner), phase: "open", incoming: true, accepted: false, roomId: a.roomId, invite: a.invite };
  if (!s.current) return { ...s, current: convo };
  return { ...s, queue: [...s.queue, convo].slice(-QUEUE_MAX) };
}

/** The band's "+1 · name": the first waiting conversation shows, and the one showing waits at the
 *  back (so tapping on cycles through them all). A window that is not a conversation (loading, an
 *  error, a picker, a blocked request) is not one to come back to and goes. */
export function switchToWaiting(s: DmState): DmState {
  const [next, ...rest] = s.queue;
  if (!next) return s;
  const back = s.current && s.current.phase === "open" && !s.current.blocked ? [s.current] : [];
  return { current: next, queue: [...rest, ...back] };
}

/** A line typed for conversation `seq` that was switched away (it waits in the queue): it waits
 *  with it, and comes back to the box when it shows again. Null when `seq` is not waiting. */
export function keepWaiting(s: DmState, seq: number, text: string): DmState | null {
  if (!s.queue.some((q) => q.seq === seq)) return null;
  return { ...s, queue: s.queue.map((q) => (q.seq === seq ? { ...q, kept: text } : q)) };
}

/** Does window `seq` take the chat box's text as it lets go? Only when it let go BY ITSELF: it is
 *  still the one showing and is no longer bindable (their request arrived on my draft, someone else
 *  joined). A window still bindable was let go by the person (✕, the send-to control). */
export function keepsLine(now: Convo | null, seq: number): boolean {
  return !!now && now.seq === seq && !isBindable(now);
}

/** May this conversation hold the chat box? Accepted, open, and either a draft (no room yet — its
 *  first line makes a private one) or a room KNOWN to be private (notPrivate === false, from the
 *  strict check). Never a pending request, never a room whose privacy is unknown or fails — an
 *  accepted group invite shows what it is and offers a private conversation instead. */
export function isBindable(c: Convo): boolean {
  if (!c.accepted || c.phase !== "open" || c.invite) return false;
  return c.roomId ? c.notPrivate === false : !!c.draft;
}
