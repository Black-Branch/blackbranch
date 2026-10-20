// The raid panic switch, applied at the two places a site account is born.
//
// There are exactly two: `/api/auth/mas-callback` (the site's own homeserver)
// and `/api/auth/matrix-callback` (a federated homeserver). Both already
// detect "was this a brand-new account" so they can claim a rollover gift
// slot — this gate hangs off the same fact, one step earlier.
//
// EXISTING USERS ARE NEVER BLOCKED. Only the creation of a new `site.users`
// row is refused; sign-in, chat and everything else stay open. Locking the
// community out of the site you are defending is its own kind of outage, and
// it is the obvious way to get this wrong — `matrix-callback` in particular
// upserts on every login to refresh OIDC metadata, so gating "the INSERT"
// rather than "a NEW row" would lock out every federated user on the site.

import pool from "@/lib/db";

export type SignupDecision =
  | { allowed: true; existing: boolean }
  | { allowed: false; reason: "signups_disabled" | "unavailable" };

/**
 * May this matrix id proceed to have a `site.users` row created?
 *
 * ONE query, so existence and the lockdown flag are read at the same instant —
 * two round trips would leave a window where a raider's account is created
 * against a flag that had already flipped, which is precisely the moment the
 * switch is being thrown.
 */
export async function checkSignupAllowed(matrixId: string): Promise<SignupDecision> {
  try {
    const { rows } = await pool.query<{ existing: boolean; locked: boolean | null }>(
      `SELECT EXISTS(SELECT 1 FROM site.users WHERE matrix_id = $1) AS existing,
              (SELECT signups_disabled FROM site.lockdown_now WHERE id = 1) AS locked`,
      [matrixId]
    );
    const existing = rows[0]?.existing ?? false;
    // Returning users are not signups. Check this FIRST — it is the whole
    // safety property, and putting it after the lock check would mean throwing
    // the switch also locks out everyone who already has an account.
    if (existing) return { allowed: true, existing: true };

    // `locked == null` means the query worked but the singleton row is absent:
    // healthy DB, config at defaults, and the default is signups-enabled.
    // Absent config is not the same as an unreadable one.
    if (rows[0]?.locked === true) return { allowed: false, reason: "signups_disabled" };
    return { allowed: true, existing: false };
  } catch (err) {
    // Fail CLOSED. We know nothing, and this gate shares a pool with the
    // `site.users` INSERT that follows — a fault that breaks this read breaks
    // that write too, so refusing here costs a signup that was already going to
    // fail, and buys the guarantee that the switch cannot be defeated by making
    // the database unhappy.
    console.error("[lockdown] signup check failed — refusing signup", err);
    return { allowed: false, reason: "unavailable" };
  }
}

/**
 * Is outbound cross-posting to platforms currently locked?
 *
 * The site is an outbound megaphone, not just a chat room: `/api/chat/send`
 * posts to Twitch/Kick/StreamPlace/YouTube using the sender's own linked OAuth
 * token. A raider who linked an account BEFORE the signup switch was thrown
 * still has that pipe, so the two levers only make sense together.
 *
 * Fails CLOSED, and that choice is cheaper than it looks: a locked cross-post
 * still delivers the message natively on the site (and tells the sender when
 * they picked the destination explicitly). The cost of a false lock is "your
 * message stayed on the site"; the cost of a false unlock is a raider
 * broadcasting through our API under their own name to four platforms.
 */
export async function isCrosspostLocked(): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ crosspost_disabled: boolean | null }>(
      `SELECT crosspost_disabled FROM site.lockdown_now WHERE id = 1`
    );
    // As with signups: an absent row means the query worked and config is at
    // defaults (column default FALSE), which is NOT the same as unreadable.
    return rows[0]?.crosspost_disabled === true;
  } catch (err) {
    console.error("[lockdown] crosspost check failed — blocking cross-post", err);
    return true;
  }
}

/**
 * Is sub-only chat on? Read from site.lockdown_now, so an expired lockdown reads off.
 *
 * Fails OPEN, unlike signups and cross-posting — the same asymmetry as the account-age lever
 * (stream-api account-age.js): this one withholds ordinary conversation, so a database blip that
 * made the read throw would silently mute every non-subscriber with no mod having armed anything.
 */
export async function isSubOnly(): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ sub_only: boolean | null }>(
      `SELECT sub_only FROM site.lockdown_now WHERE id = 1`
    );
    return rows[0]?.sub_only === true;
  } catch (err) {
    console.error("[lockdown] sub-only read failed — treating as off", err);
    return false;
  }
}
