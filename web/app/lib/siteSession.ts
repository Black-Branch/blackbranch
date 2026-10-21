// Is this site cookie still a live sign-in? Asked by Auth.js's session callback (auth.ts) on every
// auth(), so it gates every site API: plain routes, requireUser, requireMod/requireAdmin, the proxy.
// SERVER ONLY.
//
// The cookie is a stateless JWT; what makes a sign-in revocable is its site.user_sessions row.
// Logging out (destroyMatrixSession), a refresh grant the homeserver refuses, re-signing-in on the
// same device (the callbacks rotate session_id) and deleting the account each remove or replace
// that row — so a COPY of the cookie taken before any of them authorizes nothing afterwards.
// Without this check the copy would keep working until the JWT expired.
//
// Four answers:
//   live        — the row exists for this account, and the account is not deleted.
//   revoked     — no such row (or no session id at all: a JWT older than per-session rows, which
//                 every sign-in since migration v24 carries), or the account is deleted.
//   unavailable — the database did not answer. Fails CLOSED: no user, and the shared guards answer
//                 503 so a client retries rather than treating it as a sign-out. Never a throw:
//                 @auth/core clears the session cookie when the callback throws, which would sign
//                 every viewer out over a database blip.
//
// One indexed query per call: the session's primary key, joined to its user.

import type { Session } from "next-auth";
import pool from "../../lib/db.ts";
import { isMarkedDeleted } from "./deletedAccounts.ts";
import { federatedSessionAllowed } from "./federatedSignInSwitch.ts";

//   refused     — the account is on another Matrix server that the sign-in policy no longer admits
//                 (federatedSignInSwitch.ts). Signed out, but not revoked: the row is kept and the
//                 browser's crypto store is left alone, so re-opening the server restores it.
type SiteSessionState = "live" | "revoked" | "unavailable" | "refused";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: { deleted: boolean }[] }>;
const defaultQuery: Query = (sql, params) => pool.query<{ deleted: boolean }>(sql, params);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function siteSessionState(sub: unknown, sessionId: unknown, query: Query, allowed: (matrixId: string) => boolean): Promise<SiteSessionState> {
  if (typeof sub !== "string" || !sub) return "revoked";
  // A malformed id is refused here: sent to the uuid column it would error, and read as "unavailable".
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return "revoked";
  if (isMarkedDeleted(sub)) return "revoked";
  // Asked on every request, from memory: a server the policy stops admitting loses access at once.
  if (!allowed(sub)) return "refused";
  try {
    const { rows } = await query(
      `SELECT u.deleted_at IS NOT NULL AS deleted
       FROM site.user_sessions s JOIN site.users u USING (matrix_id)
       WHERE s.session_id = $1 AND s.matrix_id = $2`,
      [sessionId, sub],
    );
    return rows[0] && !rows[0].deleted ? "live" : "revoked";
  } catch {
    return "unavailable";
  }
}

/**
 * The session callback's body. A live sign-in gets its user id and session id; anything else gets
 * neither, and `authState` says why — so a guard can answer 503 for an outage (authRefusal) and the
 * Matrix token route can tell the browser its session was revoked (matrixSession.ts).
 */
export async function sessionFromToken(
  session: Session,
  token: { sub?: unknown; sessionId?: unknown },
  query: Query = defaultQuery,
  allowed: (matrixId: string) => boolean = federatedSessionAllowed,
): Promise<Session> {
  const state = await siteSessionState(token.sub, token.sessionId, query, allowed);
  if (state === "live") {
    session.user.id = token.sub as string;
    session.sessionId = token.sessionId as string;
  } else {
    session.authState = state;
  }
  return session;
}

/** The answer for a request whose session did not authenticate because the check could not run:
 *  503 with a short Retry-After. Null otherwise — the caller's own 401 stands. */
export function authRefusal(session: { authState?: string } | null | undefined): Response | null {
  if (session?.authState !== "unavailable") return null;
  return new Response("Sign-in check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
}
