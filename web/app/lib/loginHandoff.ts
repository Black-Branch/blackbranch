// The sign-in hand-off: how a finished sign-in callback (mas-callback, matrix-callback) becomes the
// Auth.js session cookie. SERVER ONLY.
//
// The callback writes a site.federated_pending row and sends the browser to
// /auth/federated-complete?token=…, whose page redeems the token through the "federated-completion"
// provider (auth.ts). A token alone must not be enough: whoever completes a sign-in to their own
// account could pass the link to someone else, and that browser would sign in as them (login CSRF).
// So the row is bound to the browser that ran the callback: the callback also
// sets an httpOnly cookie holding a random secret, and the row's key (federated_pending.token) is
// SHA-256 of the link's token AND that secret — neither half alone names a row. The redeem deletes
// the row by that key and its expiry in one atomic statement, so a refused attempt leaves the row
// for the right browser. (The key lives in the existing token column: no schema change.)
//
// The cookie is named per token (two sign-ins in one browser never overwrite each other), sent
// only to the redeem's path, and lives as long as the row (two minutes). A row written before this
// binding holds a bare UUID, which no 64-hex key can equal: never redeemable.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import pool from "../../lib/db.ts";

/** The Auth.js credentials callback the completion page posts to (next-auth/react signIn). */
const HANDOFF_PATH = "/api/auth/callback/federated-completion";
const COOKIE_PREFIX = "bb_handoff_";
const TTL_S = 120; // = the row's expires_at default (migrate-v20.sql)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
const defaultQuery: Query = (sql, params) => pool.query(sql, params);

/** The row key: both halves, so the link without the cookie (or the cookie without the link) names nothing. */
const rowKey = (token: string, secret: string) => createHash("sha256").update(`${token}.${secret}`).digest("hex");

export type LoginHandoff = {
  token: string;
  cookie: {
    name: string;
    value: string;
    options: { httpOnly: true; secure: true; sameSite: "lax"; path: string; maxAge: number };
  };
};

/** Write the pending row for this sign-in and return its token and the cookie that binds it. */
export async function createLoginHandoff(matrixId: string, sessionId: string | null, query: Query = defaultQuery): Promise<LoginHandoff> {
  const token = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO site.federated_pending (token, matrix_id, session_id) VALUES ($1, $2, $3)`,
    [rowKey(token, secret), matrixId, sessionId],
  );
  return {
    token,
    cookie: {
      name: `${COOKIE_PREFIX}${token}`,
      value: secret,
      options: { httpOnly: true, secure: true, sameSite: "lax", path: HANDOFF_PATH, maxAge: TTL_S },
    },
  };
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * Redeem a hand-off from the browser that sent `cookieHeader`. The user to sign in, or null when
 * the token is unknown, expired, used, or this browser does not hold its secret.
 */
export async function consumeLoginHandoff(
  token: unknown,
  cookieHeader: string | null,
  query: Query = defaultQuery,
): Promise<{ id: string; name: string; sessionId?: string } | null> {
  if (typeof token !== "string" || !UUID.test(token)) return null;
  const secret = cookieValue(cookieHeader, `${COOKIE_PREFIX}${token}`);
  if (!secret) return null;
  const { rows } = await query(
    `DELETE FROM site.federated_pending fp
     USING site.users u
     WHERE fp.token = $1 AND fp.expires_at > NOW() AND u.matrix_id = fp.matrix_id
     RETURNING fp.matrix_id, fp.session_id, u.display_name`,
    [rowKey(token, secret)],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const row = rows[0] as { matrix_id: string; session_id: string | null; display_name: string } | undefined;
  if (!row) return null;
  // sessionId binds the Auth.js cookie to its site.user_sessions row (siteSession.ts).
  return { id: row.matrix_id, name: row.display_name, sessionId: row.session_id ?? undefined };
}
