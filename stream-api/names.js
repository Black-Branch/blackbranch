// ── A person's name ───────────────────────────────────────────────────────
// stream.users.name is what the bot's lookups, the boards and profiles print.
// It is not "the last name seen": a donation's name is TYPED (a donor can tip
// under any name), so overwriting on every message and donation would rename
// people, and the bot would answer lookups with the typed name.
//
// The rule: a person's name is their SITE display name if they
// have a site account; otherwise the name they have chatted under most in the
// last NAME_WINDOW (ties → the most recent). A donation never names anyone.
// Someone with neither keeps the name they have.
//
// Run from the aggregate refresher (it already runs after activity and after
// every merge), so a platform rename is picked up once the new handle is the
// one they use most.

const { NATIVE_SQL } = require('./native-platform');

const NAME_WINDOW = '14 days';

const NAME_RULE_SQL = `
  WITH used AS (
    SELECT user_id, username, COUNT(*) AS n, MAX(created_at) AS last_at
    FROM stream.chat_log
    WHERE created_at > NOW() - $1::interval AND NOT is_bot AND username IS NOT NULL AND BTRIM(username) <> ''
    GROUP BY user_id, username
  ),
  chat_name AS (
    SELECT DISTINCT ON (user_id) user_id, username AS name
    FROM used
    ORDER BY user_id, n DESC, last_at DESC
  ),
  site_name AS (
    SELECT DISTINCT ON (l.canonical) l.canonical AS user_id, BTRIM(su.display_name) AS name
    FROM stream.links l
    JOIN site.users su ON su.matrix_id = l.platform_id
    WHERE l.platform IN ${NATIVE_SQL} AND BTRIM(COALESCE(su.display_name, '')) <> ''
    ORDER BY l.canonical, su.created_at
  ),
  pick AS (
    SELECT COALESCE(s.user_id, c.user_id) AS user_id, COALESCE(s.name, c.name) AS name
    FROM site_name s
    FULL JOIN chat_name c ON c.user_id = s.user_id
  )
  UPDATE stream.users u
  SET name = pick.name
  FROM pick
  WHERE u.id = pick.user_id AND u.name IS DISTINCT FROM pick.name`;

/** Apply the naming rule; returns how many people's names changed. */
async function refreshNames(pool) {
  const r = await pool.query(NAME_RULE_SQL, [NAME_WINDOW]);
  return r.rowCount ?? 0;
}

module.exports = { refreshNames };
