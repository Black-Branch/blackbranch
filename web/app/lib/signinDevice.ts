// Did the homeserver bind the new token to the device the site asked for?
//
// Both sign-in callbacks ask for a specific device id (the
// `…client:device:<id>` scope) and then store that id as the session's
// device. The browser keeps a crypto store keyed by the SAME id, and the
// Matrix crypto invariant is that one device id belongs to exactly one crypto
// store for life. If a server ignored the requested id and minted its own, the
// site would record a device the token is not bound to — a crypto store paired
// with the wrong device, which is the corruption that invariant exists to
// prevent.
//
// MAS honours the requested id, so on a MAS server this never fires. It is
// here so a misbehaving (or outside) server produces a clean sign-in error
// instead of a silently mismatched session.

/** The `whoami` fields this reads; anything else in the response is ignored. */
export type WhoamiDevice = { device_id?: unknown } | null | undefined;

/**
 * Why this sign-in must be refused, or null when the device is the one asked for.
 *
 * Refuses when either side is missing, not only when they differ: a requested
 * id we cannot compare against is not a match, and a session must never be
 * written for a device the site cannot name.
 */
export function deviceMismatch(requested: string | undefined | null, whoami: WhoamiDevice): string | null {
  if (typeof requested !== "string" || requested === "") return "no device id was requested";
  const granted = whoami?.device_id;
  if (typeof granted !== "string" || granted === "") return "the homeserver reported no device id";
  if (granted !== requested) return "the homeserver bound the token to a different device";
  return null;
}
