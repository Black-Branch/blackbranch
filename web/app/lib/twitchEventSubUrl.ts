// Where the automod EventSub socket may connect (automodEventSub.ts). Pure, so it is unit-tested.

/** Twitch's EventSub WebSocket host (dev.twitch.tv/docs/eventsub/handling-websocket-events). */
const EVENTSUB_HOST = "eventsub.wss.twitch.tv";

/** The address a fresh session opens. */
export const EVENTSUB_WS_URL = `wss://${EVENTSUB_HOST}/ws`;

/**
 * May the socket follow this `reconnect_url` from a session_reconnect frame? Only a `wss:`
 * address on Twitch's EventSub host, with no credentials and the default port. The frame
 * arrives over the network, so anything else is refused rather than dialled.
 */
export function isEventSubReconnectUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "wss:" && u.hostname === EVENTSUB_HOST && u.port === "" && !u.username && !u.password;
}
