// The production wiring of "end a Matrix session at its account server" (matrixSessionCore.ts
// endUpstream) — ONE set, used by sign-out (matrixSession.ts) and account deletion
// (accountDeletion.ts), so both end a session the same way: the REFRESH token revoked at the
// session's own issuer (ours, or an outside one), /logout only as the fallback. SERVER ONLY.
import { oauthRevokeOutcome, revokeAtOutcome } from "./matrixOAuthClient.ts";
import { homeserverFetch } from "./homeserverFetch.ts";
import { safeFetch } from "./ssrf.ts";
import { matrixBaseUrl, matrixServerName } from "./matrixConfig.ts";
import { discoverServer } from "./federatedSignIn.ts";
import { discoveredRevocationEndpoint, logoutAt, type UpstreamDeps } from "./matrixSessionCore.ts";
import { createSessionAlarms } from "./matrixSessionWatch.ts";
import { streamApiFetch } from "./streamApi.ts";

/** The process's refusal alarms: refused refreshes (matrixSession.ts) and re-sign-in revocations
 *  that were not confirmed (both callbacks). Accounts on this install's server and on outside
 *  servers are counted apart, under two push keys — an outside server cannot fire, or mask, ours. */
export const sessionRefusals = createSessionAlarms({
  now: () => Date.now(),
  localKey: "web.matrix-session-refusals",
  outsideKey: "web.matrix-session-outside-refusals",
  notify: (key, title, message) => {
    console.error(`[matrix-session] ALARM ${title}: ${message}`);
    void streamApiFetch("/ops/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, title, message }),
    }).catch(() => undefined);
  },
});

export function upstreamDeps(dec: UpstreamDeps["dec"]): UpstreamDeps {
  return {
    dec,
    revokeLocal: (refresh) => oauthRevokeOutcome(refresh, "refresh_token"),
    // An outside issuer's endpoint and homeserver are stored, user-influenced values: the
    // SSRF-guarded transport, as for its refresh.
    revokeFederated: (endpoint, clientId, refresh) =>
      revokeAtOutcome(endpoint, null, refresh, "refresh_token", { client_id: clientId }, (url, init) => homeserverFetch(url, init)),
    logout: (homeserver, access) => logoutAt(homeserver, access, (url, init) => homeserverFetch(url, init)),
    homeserverFor: (r) => r.homeserver ?? matrixBaseUrl(),
    ownServer: matrixServerName(),
    log: (line) => console.warn(line),
    // A session from before v168 recorded no revocation endpoint: ask the account's server now,
    // the way sign-in discovers it (from its NAME, SSRF-guarded).
    discoverRevocation: (row, tokenEndpoint) =>
      discoveredRevocationEndpoint(row.matrix_id, tokenEndpoint, (server) => discoverServer(server, (url, init) => safeFetch(url, init))),
  };
}
