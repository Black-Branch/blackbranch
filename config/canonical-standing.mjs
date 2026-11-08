// The standing of a CANONICAL (a 12-hex chat identity) under moderation: which of its own
// site.mod_log rows still stand. One rule for every reader that asks "is this person banned?":
// web's Allow check (platformRetry.ts bannedNow), stream-api's chat door (ban-hold.js) and a
// merge's carry (identity.js mergeCanonicals).
//
// A person has two truths, never mixed:
//   • an ACCOUNT (matrix id): site.bans — a row is a ban (expires_at NULL) or a running timeout; a
//     deleted row is lifted. Account-targeted mod_log rows are history and are never read for it;
//   • a CANONICAL: its OWN mod_log rows, in insertion order (id), never by created_at:
//       – a 'ban' stands until an 'unban' on the same canonical with a higher id;
//       – a 'timeout' stands while it runs (expires_at > now()) and no higher-id 'unban' follows;
//         a timeout never weakens a ban, and an ended timeout is nothing;
//       – a 'ban' with a higher id than the last 'unban' bans again.
// A person is banned when either truth says so (site.bans of any linked account, or the
// canonical's own standing). Linking changes nothing by itself: web writes a site ban, timeout or
// unban of an account onto the canonicals linked to it AT THAT MOMENT, and a merge carries the
// loser's standing onto the survivor as a new row.
//
// CANONICAL_STANDING selects the standing rows (id, target_id, action, expires_at, created_at). A
// reader wraps it — `FROM (${CANONICAL_STANDING}) s WHERE s.target_id = $1` — and decides from the
// rows: any row = banned now; a 'ban' row = until lifted, else until the latest expires_at.
//
// Do not import this file from a package: each package carries a GENERATED, byte-identical copy
// (`node tools/gen-instance-schema.mjs`; the package's `check:instance-schema` fails when it drifts):
//   stream-api/canonicalStanding.generated.js      (CommonJS)
//   web/app/lib/canonicalStanding.generated.mjs    (ESM)
// So this file imports NOTHING and exports ONE name.

export const CANONICAL_STANDING = `
  SELECT st.id, st.target_id, st.action, st.expires_at, st.created_at
    FROM site.mod_log st
   WHERE st.target_id ~ '^[0-9a-f]{12}$'
     AND (st.action = 'ban' OR (st.action = 'timeout' AND st.expires_at > now()))
     AND NOT EXISTS (SELECT 1 FROM site.mod_log lift
                      WHERE lift.target_id = st.target_id AND lift.action = 'unban' AND lift.id > st.id)`;
