// Shared Matrix display helpers. Previously the "member display name" fallback
// (room display name → localpart) was copy-pasted verbatim across the message
// row, member list, channel column, thread panels, and forum view; this is the
// single source of truth.

import type { Room, RoomMember } from "matrix-js-sdk";
import { stripBidiControls } from "./bidi.ts";
import { matrixServerName } from "./matrixConfig.ts";

// localpart lives HERE (not matrixRooms) on purpose: this module's SDK imports
// are type-only (erased at compile), so eager components (ChatMessage, UserCard,
// ChatSidebar, ProfileEditor) can use it without pulling matrix-js-sdk into the
// first-load bundle. matrixRooms has runtime SDK imports and re-exports it.
/** The localpart of a Matrix user id: `@alice:example.org` → `alice`. */
export function localpart(userId: string): string {
  return userId.startsWith("@") ? (userId.split(":")[0] ?? "").slice(1) : userId;
}

/** A Matrix id as the site displays the own account: `@k:<this server>` → `k`,
 *  off-server ids keep their server (`@k:matrix.org` → `k:matrix.org`).
 *  (Moved from UserMenu — the avatar button and the profile card share it.) */
export function formatMxid(mxid: string): string {
  if (!mxid.startsWith("@")) return mxid;
  const colon = mxid.indexOf(":", 1);
  if (colon < 0) return mxid.slice(1);
  const local = mxid.slice(1, colon);
  const server = mxid.slice(colon + 1);
  return server === matrixServerName() ? local : `${local}:${server}`;
}

/** A member's display name, falling back to the localpart of their user id. */
export function memberName(member: RoomMember | null | undefined, userId: string): string {
  // A Matrix display name is attacker-chosen text; strip bidi overrides so it
  // cannot reverse the rendering of anything beside it. See lib/bidi.ts.
  return stripBidiControls(member?.rawDisplayName || localpart(userId));
}

/** Look the member up in `room` and return their display name (localpart fallback). */
export function getMemberDisplayName(room: Room, userId: string): string {
  return memberName(room.getMember(userId), userId);
}
