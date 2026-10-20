/**
 * Where a chat author's profile picture comes from.
 *
 * Two sources, in priority order:
 *   1. `avatarUrl` — the platform's own avatar (Twitch/YouTube/Kick), attached
 *      by stream-ingest and passed straight through stream-api onto the live WS
 *      frame.
 *   2. The Matrix avatar route, for native site users, who carry a matrixId
 *      but no platform avatar.
 *
 * `avatarUrl` is LIVE-WS ONLY. `stream.chat_log` has no avatar column, and
 * neither /api/chat/history nor /api/mod/chat-history select one — so a message
 * restored from scroll-back or opened from the mod panel's history has no
 * platform avatar and correctly falls back to the initial circle. That is a
 * data-model fact, not a bug in this helper.
 *
 * Shared by ChatMessage and UserCard: resolving from matrixId alone gives every
 * platform-origin chatter a coloured initial even when their real avatar is on
 * the message object.
 */
export function avatarSrc(msg: { avatarUrl?: string | null; matrixId?: string | null }): string | null {
  return msg.avatarUrl ?? (msg.matrixId ? `/api/avatar/user/${encodeURIComponent(msg.matrixId)}` : null);
}

/**
 * The id a UserCard queries `/api/user/[id]` with: a site line's Matrix id, else the line's
 * per-platform public id (chatMsg.ts personKey). Never a canonical id — the route answers one only
 * for a moderator or the person, and a card keyed by it would merge the person's platforms.
 */
export function userLookupKey(msg: { publicId?: string | null; matrixId?: string | null }): string | null {
  return msg.matrixId ?? msg.publicId ?? null;
}

/**
 * Query string for `/popout/user` — the user card in its own window.
 *
 * Only IDENTITY travels: matrixId/publicId are what every lookup, mod action
 * and history query keys on, and they stay meaningful in a new document. The
 * message id rides along so per-message delete still works when the card was
 * opened from a real message, and is simply absent otherwise.
 *
 * Deliberately does NOT carry mod status. The popout page resolves that from
 * the session — a URL is attacker-controlled, and an `isMod` param would hand
 * the mod UI to anyone who typed one.
 */
export function userCardPopoutUrl(msg: {
  id?: string | number;
  platform?: string;
  username?: string;
  matrixId?: string | null;
  publicId?: string | null;
  avatarUrl?: string | null;
}): string {
  const p = new URLSearchParams();
  if (msg.id !== undefined && msg.id !== "") p.set("mid", String(msg.id));
  if (msg.platform) p.set("platform", msg.platform);
  if (msg.username) p.set("username", msg.username);
  if (msg.matrixId) p.set("matrixId", msg.matrixId);
  if (msg.publicId) p.set("publicId", msg.publicId);
  if (msg.avatarUrl) p.set("avatarUrl", msg.avatarUrl);
  return `/popout/user?${p}`;
}
