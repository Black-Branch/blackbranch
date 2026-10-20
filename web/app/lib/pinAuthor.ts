// The pinned message's AUTHOR, resolved live — not the snapshot the pin row
// keeps. `site.pinned_messages` stores a username and the text (what a banner
// needs to be readable at all), and nothing about who wrote it: so the banner
// drew a plain platform-coloured name while the same person's chat rows wore
// their equipped style and badges. Pinned messages inherit custom username
// styles and badges.
//
// Live rather than snapshotted because a style is a thing people buy and swap
// — chat history renders the CURRENT one for the same reason (history route:
// "LIVE identity … not a snapshot frozen at event time"). The query is
// injected so the two SQL shapes are testable without the pool, exactly as
// canonicalIdentity does — and the platform hop is the same one that award
// needed: stream.chat_log.user_id is a canonical id, site.platform_links is
// the bridge to a matrix id.

import type { EquippedStyle } from "./usernameStyles";
import { isNativePlatform } from "./nativePlatform.ts";
import { noOptOutSql } from "./linkConsent.ts";

type PinAuthor = {
  /** The badge lookup key (BadgesContext); null for an unlinked chatter. */
  matrixId: string | null;
  /** The site account's colour, else the platform's own per-user colour
   *  (Twitch's, Kick's) carried on the chat row, else null. */
  usernameColor: string | null;
  usernameStyle: EquippedStyle | null;
};

export type PinAuthorQuery = (
  sql: string, params: unknown[]
) => Promise<{ rows: { matrix_id: string | null; username_color: string | null; username_style: unknown; platform_color?: string | null }[] }>;

const NOBODY: PinAuthor = { matrixId: null, usernameColor: null, usernameStyle: null };

/**
 * Never throws: a pin whose author cannot be resolved is still a pin, and the
 * banner falls back to the plain name it always drew.
 */
export async function pinAuthor(platform: string, messageId: number, query: PinAuthorQuery): Promise<PinAuthor> {
  let rows: Awaited<ReturnType<PinAuthorQuery>>["rows"];
  // A try/catch around the CALL, not a .catch on its promise: "never throws"
  // has to hold for a query that throws synchronously too.
  try {
    ({ rows } = await (isNativePlatform(platform)
      ? query(
          // LEFT JOIN: the badge key is m.matrix_id, which exists whether or
          // not the author still has a site.users row.
          `SELECT m.matrix_id, u.username_color, u.username_style, NULL AS platform_color
             FROM site.chat_messages m
             LEFT JOIN site.users u ON u.matrix_id = m.matrix_id
            WHERE m.id = $1`,
          [messageId],
        )
      : query(
          // One link row per canonical is enough: every row of a person's
          // links names the same account. The banner is public, and a Twitch
          // line wearing its author's SITE badges, colour and style shows the
          // link between them (owner decision 2026-10-17): only an account that
          // shows its links (site.users.show_links) is resolved, and only when every
          // account linked to that line's canonical does — another account's
          // choice is never this person's consent.
          `SELECT u.matrix_id, u.username_color, u.username_style, cl.username_color AS platform_color
             FROM stream.chat_log cl
             LEFT JOIN site.platform_links pl ON pl.canonical_id = cl.user_id
             LEFT JOIN site.users u ON u.matrix_id = pl.matrix_id AND u.show_links
                  AND ${noOptOutSql("cl.user_id")}
            WHERE cl.id = $1 AND cl.platform = $2
            LIMIT 1`,
          [messageId, platform],
        )));
  } catch {
    return NOBODY;
  }
  const r = rows[0];
  if (!r) return NOBODY;
  return {
    matrixId: r.matrix_id ?? null,
    usernameColor: r.username_color ?? r.platform_color ?? null,
    usernameStyle: (r.username_style as EquippedStyle | null) ?? null,
  };
}
