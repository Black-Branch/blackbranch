// The DM window's and the announcement's signals.
// Core cannot import a feature (check-structure rule 4), so the `/dm` command, the user card's Message
// button and the chat socket WRITE here and the feature (app/features/dm) LISTENS. Module-level
// stores, the dismissStack house pattern: no provider, node-testable.
// Pure: no React, no DOM.

/** A person a DM can go to — from /api/dm/resolve, or a user card. */
export type DmPerson = { matrixId: string; username: string; displayName: string | null };

export type DmRequest =
  /** Open (or make) the conversation with `to`; send `text` into it first when given. */
  | { kind: "open"; to: DmPerson; text?: string }
  /** The name matched several people: the window opens on a short picker. */
  | { kind: "pick"; query: string; people: DmPerson[]; text?: string };

/** A mod's announcement as the socket delivered it (wsFrames `announce`). */
export type Announcement = { id: string; text: string; by: string; at: number };

function channel<T>() {
  const fns = new Set<(v: T) => void>();
  return {
    emit: (v: T) => { for (const fn of fns) fn(v); },
    on: (fn: (v: T) => void): (() => void) => { fns.add(fn); return () => { fns.delete(fn); }; },
  };
}

const requests = channel<DmRequest>();
const announcements = channel<Announcement>();

/** Ask the DM window to open. With no listener (a page without the chat column) nothing happens,
 *  which the caller learns from the return value. */
export function requestDm(r: DmRequest): boolean {
  if (!hasDmHost()) return false;
  requests.emit(r);
  return true;
}
export const onDmRequest = requests.on;

let hosts = 0;
/** The DM host's mount: while one is mounted, requestDm has somewhere to go. */
export function registerDmHost(): () => void {
  hosts++;
  return () => { hosts = Math.max(0, hosts - 1); };
}
function hasDmHost(): boolean {
  return hosts > 0;
}

export const publishAnnouncement = announcements.emit;
export const onAnnouncement = announcements.on;
