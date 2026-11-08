// The reason written on a room ban made for a site ban: how the site's own room bans are told from a
// moderator's. ONE source, read by the browser sync (siteBanSync.ts) and sent to the community
// reconciler in its feed (community/desiredServer.ts, `siteBanReason`), which writes it on every room ban
// it makes and lifts only room bans whose reason is exactly this. Neutral (no "use client"), so the
// server can import the value itself rather than a client reference.
export const SITE_BAN_REASON = "Banned on the site";
