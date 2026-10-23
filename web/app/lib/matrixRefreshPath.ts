// Which token endpoint refreshes a session: chosen by the ACCOUNT'S SERVER, not by the stored
// per-user OIDC columns. SERVER ONLY (read by matrixSession.ts).
//
// An account on this install's own server ALWAYS refreshes through the local client (our MAS,
// discovered — matrixSession.ts localRefresh), whatever site.users.oidc_token_endpoint /
// oidc_client_id hold. Those columns describe how an OUTSIDE server's account signed in
// (federatedSignIn.ts); on an own-server row they are stale leftovers, and trusting them sent five
// accounts' refreshes to our MAS as an old public client — `client id mismatch`, invalid_grant, the
// session row deleted, a sign-out every five minutes (2026-10-21, vault systems/web-session.md).
import { normalizeServerName, serverNameOf } from "./federatedSignInSwitch.ts";
import { matrixServerName } from "./matrixConfig.ts";

export type RefreshPath =
  | { kind: "local" }
  | { kind: "federated"; tokenEndpoint: string; clientId: string };

type Row = { matrix_id: string; oidc_token_endpoint: string | null; oidc_client_id: string | null };

/** Local for our own server's accounts (and for a foreign row missing a column, as before);
 *  the stored endpoint + client id for an outside server's account. */
export function refreshPathFor(row: Row, own: string = matrixServerName()): RefreshPath {
  const server = serverNameOf(row.matrix_id);
  const ours = server !== null && server === normalizeServerName(own);
  if (ours || !row.oidc_token_endpoint || !row.oidc_client_id) return { kind: "local" };
  return { kind: "federated", tokenEndpoint: row.oidc_token_endpoint, clientId: row.oidc_client_id };
}
