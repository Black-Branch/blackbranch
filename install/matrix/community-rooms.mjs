// The three rooms the setup's bootstrap makes (bootstrap.mjs), written exactly as the community
// reconciler (reconcile-core.mjs) keeps them, so its first run after a clean setup puts nothing back:
//   • #general and #forum let in everyone in the community space (restricted to the hub's members),
//     the join rule the core gives a channel anyone may see;
//   • their places in the space sort before every key the Admin Panel makes ("a0" and after, its
//     first channels from setup included), so the import keeps them and they stay at the top.
// Shared by the bootstrap, the reconciler's fixtures and the real-homeserver test. Plain data.

export const ROOM_VERSION = "12";
// The forum flag: an ordinary room with this state event is a forum to the site (web matrixRooms.ts
// isForumRoom, forumReader.ts); other Matrix apps show a normal room.
export const FORUM_FLAG = "app.blackbranch.room_type";
// #general keeps 30 days of messages (the server's allowed range is 1 day – 1 year).
export const GENERAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// m.space.child `order` (compared as strings): valid panel order keys below the panel's first ("a0").
export const GENERAL_ORDER = "Zy";
export const FORUM_ORDER = "Zz";

/** Everyone in the community space may join (Matrix room v8+ "restricted"). */
export const joinedViaHub = (hubId) => ({ join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: hubId }] });

/** createRoom bodies, without the alias (the bootstrap adds its own). */
export function hubBody(name) {
  return { name, preset: "public_chat", visibility: "public", room_version: ROOM_VERSION, creation_content: { type: "m.space" } };
}
export function generalBody(hubId, name = "general") {
  return {
    name, preset: "public_chat", visibility: "public", room_version: ROOM_VERSION,
    initial_state: [
      { type: "m.room.join_rules", state_key: "", content: joinedViaHub(hubId) },
      { type: "m.room.retention", state_key: "", content: { max_lifetime: GENERAL_RETENTION_MS } },
    ],
  };
}
export function forumBody(hubId, name = "forum") {
  return {
    name, topic: "Posts and discussion", preset: "public_chat", visibility: "public", room_version: ROOM_VERSION,
    initial_state: [
      { type: "m.room.join_rules", state_key: "", content: joinedViaHub(hubId) },
      { type: FORUM_FLAG, state_key: "", content: { type: "forum" } },
    ],
  };
}
