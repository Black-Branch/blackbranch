// Pure (node --test reads it): the span of a linked identity, for linkFactsServer.ts.
import { NATIVE_SQL } from "./nativePlatform.ts";
import { noOptOutSql } from "./linkConsent.ts";

/** How many platforms the WHOLE linked identity spans — not just the canonical asked about: its own
 *  stream.links rows, the site account(s) joined to it through site.platform_links or its native
 *  link, and every canonical those accounts are linked to. A person whose site account is joined
 *  only through site.platform_links has a canonical with one platform row, yet their stats and
 *  credit are a site account's too; counting the canonical alone called that "one identity" and
 *  let the card show what joins them. Any site.platform_links join at all makes it several.
 *  $1 = the canonical (or NULL), $2 = the Matrix id asked about (or NULL). */
export const IDENTITY_SPAN_SQL = `WITH mx AS (
    SELECT matrix_id FROM site.platform_links WHERE canonical_id = $1
    UNION SELECT platform_id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND canonical = $1
    UNION SELECT $2::text WHERE $2::text IS NOT NULL
  ), canon AS (
    SELECT $1::text AS c WHERE $1::text IS NOT NULL
    UNION SELECT canonical_id FROM site.platform_links WHERE matrix_id IN (SELECT matrix_id FROM mx)
    UNION SELECT canonical FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id IN (SELECT matrix_id FROM mx)
  )
  SELECT (SELECT COUNT(DISTINCT CASE WHEN platform IN ${NATIVE_SQL} THEN 'native' ELSE platform END)
            FROM stream.links WHERE canonical IN (SELECT c FROM canon))::int AS n,
         EXISTS (SELECT 1 FROM site.platform_links
                  WHERE canonical_id IN (SELECT c FROM canon) OR matrix_id IN (SELECT matrix_id FROM mx)) AS via_links,
         -- The link may show only when EVERY site account in the identity has chosen to show it:
         -- another account's choice (a split identity) is never this person's consent.
         -- (linkConsent.ts, the one predicate, for every canonical in the identity; the account
         -- shown must itself have opted in — linkFactsServer ANDs it.)
         NOT EXISTS (SELECT 1 FROM canon WHERE NOT (${noOptOutSql("canon.c")})) AS all_show`;

/** The site account behind a canonical (either link table) — the ONE account a card names. In a
 *  split identity several accounts share the canonical; the caller's OWN account wins when it is
 *  one of them ($2, the person looking at their own card), so one account never reads another's
 *  Matrix id or name off a card. Else the newest account. $1 = the canonical, $2 = the caller's
 *  Matrix id when they are the person (else NULL). */
export const LINK_OWNER_SQL = `SELECT u.matrix_id, u.display_name, u.show_links
     FROM site.users u
    WHERE u.matrix_id IN (
      SELECT platform_id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND canonical = $1
      UNION
      SELECT matrix_id FROM site.platform_links WHERE canonical_id = $1)
    ORDER BY (u.matrix_id = $2::text) DESC NULLS LAST, u.created_at DESC LIMIT 1`;
