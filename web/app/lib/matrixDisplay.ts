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

// The shape of a Matrix user id. A name shaped like one is not a name.
const MXID_SHAPE = /^@[^:]+:.+$/;

/** The content a departed member had before their ban or leave event. That event carries no
 *  displayname or avatar_url, so their last name and picture live only in its previous content.
 *  Only a departure borrows: someone still here who cleared their name chose that. */
function departedContent(member: RoomMember | null | undefined): { displayname?: unknown; avatar_url?: unknown } {
  if (member?.membership !== "ban" && member?.membership !== "leave") return {};
  return (member.events?.member?.getPrevContent?.() ?? {}) as { displayname?: unknown; avatar_url?: unknown };
}

const isName = (name: string, userId: string) => !!name && name !== userId && !MXID_SHAPE.test(name);

/** A member's display name, falling back to a departed member's last name, then the localpart of
 *  their user id. An id-shaped name counts as no name: the SDK sets rawDisplayName to the full id
 *  for a member event without a displayname (a ban, a leave), and someone else's id would read as
 *  that person. */
export function memberName(member: RoomMember | null | undefined, userId: string): string {
  // A Matrix display name is attacker-chosen text; strip bidi overrides so it
  // cannot reverse the rendering of anything beside it. See lib/bidi.ts.
  const name = stripBidiControls(member?.rawDisplayName ?? "");
  if (isName(name, userId)) return name;
  const prev = departedContent(member).displayname;
  const last = typeof prev === "string" ? stripBidiControls(prev).trim() : "";
  return isName(last, userId) ? last : stripBidiControls(localpart(userId));
}

/** A member's picture (an mxc URL), falling back to a departed member's last one; null when none. */
export function memberAvatar(member: RoomMember | null | undefined): string | null {
  const now = member?.getMxcAvatarUrl?.();
  if (now) return now;
  const prev = departedContent(member).avatar_url;
  return typeof prev === "string" && prev.startsWith("mxc://") ? prev : null;
}

/** Look the member up in `room` and return their display name (localpart fallback). */
export function getMemberDisplayName(room: Room, userId: string): string {
  return memberName(room.getMember(userId), userId);
}
