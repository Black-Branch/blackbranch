// Who a typed name can mean, for `/dm <name>`, its completion and the DM list's "+" (ticket #193):
// EVERY site account — not only the people in chat right now — by username and by display name,
// the typed text anywhere in either, ignoring case. Never yourself, a bot, a deleted account or the
// install's own accounts (the community service account, the forum reader).
//
// Ranked: the full Matrix id → the exact username → an exact display name → a name that starts with
// it → one that holds it anywhere; ties by Matrix id (never by activity: the order says nothing
// about who was online). At most 8. Starts-with and contains need two characters or more.
//
// `exact` says the answer is ONE person the typed name names outright, so `/dm name text` may open
// (and send) without asking: a full Matrix id that exists, or a username of THIS install's server
// that no other account matches exactly — by username or display name (the two together: a display
// name equal to someone's username is a tie). A typed `@name:server` (or `name:server`) is exact
// only as that full id, never as a username.
// A display-name match, another server's username, a near match: the picker, which shows full ids.
// Over-long input is refused, never cut: a cut id can become another id's prefix.

export type Person = { matrixId: string; username: string; displayName: string | null };
export type ResolveAnswer = { people: Person[]; exact: boolean };

type Row = { matrix_id: string; display_name: string | null; rank: number };
export type PeopleQuery = (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;

const LIMIT = 8;
/** The longest query looked up (a full Matrix id is at most 255); longer is refused. */
const MAX_Q = 255;
/** The shortest name a partial (starts-with / contains) match is looked up for. */
const MIN_PARTIAL = 2;

const SQL = `
  SELECT matrix_id, display_name,
         CASE WHEN lower(matrix_id) = lower($1) THEN 0
              WHEN uname = $2 THEN 1
              WHEN dname = $2 THEN 2
              WHEN starts_with(uname, $2) OR starts_with(dname, $2) THEN 3
              ELSE 4 END AS rank
    FROM (SELECT u.matrix_id, u.display_name,
                 lower(split_part(substr(u.matrix_id, 2), ':', 1)) AS uname,
                 lower(coalesce(u.display_name, '')) AS dname
            FROM site.users u
           WHERE u.deleted_at IS NULL AND NOT u.is_bot AND u.matrix_id <> $3
             AND NOT (u.matrix_id = ANY($4::text[]))) c
   WHERE lower(matrix_id) = lower($1) OR uname = $2 OR dname = $2
      OR ($5 AND (strpos(uname, $2) > 0 OR strpos(dname, $2) > 0))
   ORDER BY rank, matrix_id
   LIMIT ${LIMIT}`;

const usernameOf = (matrixId: string) => matrixId.slice(1).split(":")[0] ?? matrixId;

/** The accounts `raw` can mean, for the signed-in `me`; `hidden` are the install's own accounts;
 *  `ownServer` is this install's Matrix server name. */
export async function resolvePeople(query: PeopleQuery, raw: string, me: string, hidden: string[], ownServer: string): Promise<ResolveAnswer> {
  const q = raw.trim();
  if (q.length > MAX_Q) return { people: [], exact: false };
  // A server part makes it an id, with or without its "@": compared as the full id only.
  const fullId = q.includes(":") ? (q.startsWith("@") ? q : `@${q}`) : "";
  const name = (q.replace(/^@/, "").split(":")[0] ?? "").toLowerCase();
  if (!name) return { people: [], exact: false };
  const { rows } = await query(SQL, [fullId, name, me, hidden, name.length >= MIN_PARTIAL]);
  const toPeople = (rs: Row[]) => rs.map((r) => ({ matrixId: r.matrix_id, username: usernameOf(r.matrix_id), displayName: r.display_name }));
  const best = rows[0]?.rank;
  if (best === undefined) return { people: [], exact: false };
  // A full id: that account outright, or — when it does not exist — only near matches, asked.
  if (fullId) return best === 0 ? { people: toPeople(rows.slice(0, 1)), exact: true } : { people: toPeople(rows), exact: false };
  // A name: every exact match (username or display name) is shown; only one, by username, on this
  // server, opens without asking.
  if (best <= 2) {
    const same = rows.filter((r) => r.rank <= 2);
    const only = same.length === 1 ? same[0]! : null;
    return { people: toPeople(same), exact: !!only && only.rank === 1 && only.matrix_id.endsWith(`:${ownServer}`) };
  }
  return { people: toPeople(rows), exact: false };
}
