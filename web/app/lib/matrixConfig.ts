import { installValue } from "./installValues.ts";
// This install's Matrix homeserver — the ONE source for "which server is ours".
//
// Install-tier keys (installValues.ts says how they are read): server and client read the same
// object, and instrumentation.ts exits when a required one is missing. Universal and
// dependency-free on purpose — client components (display names, joins, placeholders) and
// `node --test` both import it.
//
// One source matters: a base URL hardcoded per file, or a homeserver DERIVED from the sign-in
// issuer's origin (which would send local whoami to the wrong server when the issuer has its own
// host), or a server name written into SQL and display code, can each disagree with the rest.

/** The `:server` part of this install's account ids, e.g. `example.org`. */
export function matrixServerName(): string {
  return installValue("matrix.serverName");
}

/** "@name:<this server>" → "name": the fallback name when there is no display name. An id on
 *  another server keeps its `:server`, so two people called alice stay distinguishable. */
export function matrixLocalpart(matrixId: string, server: string = matrixServerName()): string {
  const local = matrixId.replace(/^@/, "");
  const own = `:${server}`.toLowerCase();
  return server && local.toLowerCase().endsWith(own) ? local.slice(0, -own.length) : local;
}

/** The homeserver's client-server API origin (no trailing slash). The origin the site trusts. */
export function matrixBaseUrl(): string {
  return installValue("matrix.baseUrl");
}

/** The hostname of matrixBaseUrl() — for host-keyed comparisons (telemetry buckets). */
export function matrixBaseHostname(): string {
  try {
    return new URL(matrixBaseUrl()).hostname;
  } catch {
    return "";
  }
}

/** `host:port` other servers federate with — the `m.server` of `.well-known/matrix/server`.
 *  Unset = the homeserver address's host on its port, 443 by default. */
export function matrixFederationServer(): string {
  const explicit = installValue("matrix.federationServer");
  if (explicit) return explicit;
  try {
    const u = new URL(matrixBaseUrl());
    return `${u.hostname}:${u.port || (u.protocol === "http:" ? "80" : "443")}`;
  } catch {
    return "";
  }
}

/** The OAuth 2.0 issuer the homeserver delegates sign-in to, exactly as configured. */
export function matrixOAuthIssuer(): string {
  return installValue("matrix.oauth.issuer");
}

/** This site's registered client id at the issuer. */
export function matrixOAuthClientId(): string {
  return installValue("matrix.oauth.clientId");
}

/** A full id for a bare localpart on this server: `alice` → `@alice:<server>`. */
export function localMatrixId(localpart: string): string {
  return `@${localpart.replace(/^@/, "")}:${matrixServerName()}`;
}
