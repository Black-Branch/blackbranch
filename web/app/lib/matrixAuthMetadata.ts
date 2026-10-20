// Sign-in endpoints DISCOVERED from the homeserver — `GET <base>/_matrix/client/v1/auth_metadata`
// (Matrix spec, OAuth 2.0 API) — instead of paths string-built onto the issuer. SERVER ONLY.
//
// Why: `${issuer}authorize`, `${issuer}oauth2/token`, `${issuer}oauth2/revoke` and
// `${issuer}account` are MAS's URL layout, not the protocol's. A server that implements the spec
// with different paths could never sign anyone in, and the contract would read as "MAS" rather
// than "the Matrix OAuth 2.0 API".
//
// FAILURE IS NEVER A REVOCATION. Every caller treats "no metadata" as a TRANSIENT error. A
// refresh that fails for want of a token endpoint must not look like `invalid_grant`: that path
// deletes the site.user_sessions row and the browser wipes its crypto store — an auth-server
// outage would become a mass sign-out with lost encryption keys.
//
// Cache: fresh for an hour; when a re-fetch fails, the last good copy keeps serving for up to a
// day (endpoints essentially never move, and an outage of the metadata route alone must not stop
// refreshes); a failed fetch with no usable copy is not repeated for 10 s, so a down server is
// not hammered by every request. Each failure logs `[matrix-auth]` and posts one ops notify
// (a reason CODE — never a URL or a value; stream-api rate-limits the key).

import { matrixBaseUrl, matrixOAuthIssuer } from "./matrixConfig.ts";

export type AuthMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Absent when the server publishes none — a revoke is then skipped, loudly. */
  revocationEndpoint: string | null;
  /** The account page (sessions, cross-signing reset approval). */
  accountManagementUri: string | null;
  /** Dynamic client registration — what outside servers need for the federated flow. */
  registrationEndpoint: string | null;
};

export type MetadataProblem =
  | "not_json" | "issuer_mismatch" | "missing_endpoint" | "bad_endpoint"
  | "endpoint_off_issuer_origin" | "no_s256" | "grant_unsupported";

type MetadataErrorCode = MetadataProblem | "unreachable" | "http_error" | "not_configured";

class AuthMetadataError extends Error {
  readonly code: MetadataErrorCode;
  constructor(code: MetadataErrorCode, detail?: string) {
    super(`auth metadata ${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
  }
}

function endpoint(raw: unknown, issuerUrl: URL, sameOriginRequired: boolean, field: string): string {
  if (typeof raw !== "string" || !raw) throw new AuthMetadataError("missing_endpoint", field);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AuthMetadataError("bad_endpoint", field);
  }
  // An https issuer only ever hands out https endpoints; plain http is a dev issuer's only.
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && issuerUrl.protocol === "http:");
  if (!okScheme || u.username || u.password || u.hash) throw new AuthMetadataError("bad_endpoint", field);
  // The token and revocation endpoints receive the client secret, the authorize endpoint
  // receives the browser. All of them belong to the issuer — an endpoint on another origin is
  // refused rather than trusted, so a bad metadata document cannot send the secret elsewhere.
  if (sameOriginRequired && u.origin !== issuerUrl.origin) throw new AuthMetadataError("endpoint_off_issuer_origin", field);
  return u.href;
}

function optionalEndpoint(raw: unknown, issuerUrl: URL, sameOriginRequired: boolean, field: string): string | null {
  return raw === undefined || raw === null || raw === "" ? null : endpoint(raw, issuerUrl, sameOriginRequired, field);
}

/**
 * Validate an auth_metadata document. `expectedIssuer` = our configured issuer (it must match
 * BYTE FOR BYTE — RFC 8414 §3.3: a document naming another issuer is not ours); null = an OUTSIDE
 * server's document (federated sign-in), where the issuer is whatever the server says but the
 * endpoint rules still apply. Throws AuthMetadataError with a fixed code.
 */
export function parseAuthMetadata(json: unknown, expectedIssuer: string | null): AuthMetadata {
  if (!json || typeof json !== "object") throw new AuthMetadataError("not_json");
  const j = json as Record<string, unknown>;
  const issuer = j.issuer;
  if (typeof issuer !== "string" || !issuer) throw new AuthMetadataError("missing_endpoint", "issuer");
  if (expectedIssuer !== null && issuer !== expectedIssuer) throw new AuthMetadataError("issuer_mismatch");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new AuthMetadataError("bad_endpoint", "issuer");
  }
  if (issuerUrl.protocol !== "https:" && issuerUrl.protocol !== "http:") throw new AuthMetadataError("bad_endpoint", "issuer");
  // Listed capabilities must include what this site uses. Absent = not stated = assumed (the
  // spec makes these optional fields; MAS lists them).
  const methods = j.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new AuthMetadataError("no_s256");
  const grants = j.grant_types_supported;
  if (Array.isArray(grants) && !(grants.includes("authorization_code") && grants.includes("refresh_token"))) {
    throw new AuthMetadataError("grant_unsupported");
  }
  return {
    issuer,
    authorizationEndpoint: endpoint(j.authorization_endpoint, issuerUrl, true, "authorization_endpoint"),
    tokenEndpoint: endpoint(j.token_endpoint, issuerUrl, true, "token_endpoint"),
    revocationEndpoint: optionalEndpoint(j.revocation_endpoint, issuerUrl, true, "revocation_endpoint"),
    accountManagementUri: optionalEndpoint(j.account_management_uri, issuerUrl, true, "account_management_uri"),
    registrationEndpoint: optionalEndpoint(j.registration_endpoint, issuerUrl, true, "registration_endpoint"),
  };
}

const FRESH_MS = 60 * 60 * 1000;
const STALE_LIMIT_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;

type Deps = {
  baseUrl: () => string;
  issuer: () => string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  log: Pick<Console, "error" | "warn" | "log">;
  /** One ops push per failure (rate-limited by stream-api). Fire-and-forget. */
  notify: (code: string) => void;
};

/** @test-only the factory takes stub deps; production uses the globalThis singleton below. */
export function createAuthMetadataCache(deps: Deps) {
  let good: { value: AuthMetadata; at: number } | null = null;
  let lastFailure: { at: number; error: AuthMetadataError } | null = null;
  let inFlight: Promise<AuthMetadata> | null = null;

  async function fetchOnce(): Promise<AuthMetadata> {
    const base = deps.baseUrl();
    const issuer = deps.issuer();
    if (!base || !issuer) throw new AuthMetadataError("not_configured");
    let res: Response;
    try {
      res = await deps.fetch(`${base}/_matrix/client/v1/auth_metadata`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new AuthMetadataError("unreachable");
    }
    if (!res.ok) throw new AuthMetadataError("http_error", String(res.status));
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AuthMetadataError("not_json");
    }
    return parseAuthMetadata(json, issuer);
  }

  function refresh(): Promise<AuthMetadata> {
    if (!inFlight) {
      inFlight = fetchOnce()
        .then((value) => {
          if (lastFailure) deps.log.log("[matrix-auth] auth_metadata recovered");
          good = { value, at: deps.now() };
          lastFailure = null;
          return value;
        })
        .catch((e: unknown) => {
          const err = e instanceof AuthMetadataError ? e : new AuthMetadataError("unreachable");
          lastFailure = { at: deps.now(), error: err };
          deps.log.error(`[matrix-auth] auth_metadata FAILED (${err.code}) — sign-in ${good ? "serving the last good copy" : "UNAVAILABLE"}`);
          deps.notify(err.code);
          throw err;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  /** The current endpoints. Throws AuthMetadataError when none are usable — a TRANSIENT error. */
  async function get(): Promise<AuthMetadata> {
    const t = deps.now();
    if (good && t - good.at < FRESH_MS) return good.value;
    if (lastFailure && t - lastFailure.at < FAILURE_BACKOFF_MS) {
      if (good && t - good.at < STALE_LIMIT_MS) return good.value;
      throw lastFailure.error;
    }
    try {
      return await refresh();
    } catch (e) {
      if (good && t - good.at < STALE_LIMIT_MS) return good.value;
      throw e;
    }
  }

  /** Never throws: the endpoints, or null. For callers that degrade (the well-known's `account`). */
  async function peek(): Promise<AuthMetadata | null> {
    return get().catch(() => null);
  }

  return { get, peek };
}

type Cache = ReturnType<typeof createAuthMetadataCache>;
// globalThis, not module scope: Next can bundle this module into more than one chunk, and two
// caches would fetch, fail and notify twice.
const G = globalThis as typeof globalThis & { __matrixAuthMetadata?: Cache };

function cache(): Cache {
  G.__matrixAuthMetadata ??= createAuthMetadataCache({
    baseUrl: matrixBaseUrl,
    issuer: matrixOAuthIssuer,
    // Our own, configured homeserver: the trusted origin, so plain fetch (homeserverFetch.ts).
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    log: console,
    notify: (code) => {
      void import("./streamApi.ts").then(({ streamApiFetch }) =>
        streamApiFetch("/ops/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "web.matrix-auth-metadata",
            title: "Matrix sign-in discovery failing",
            message: `auth_metadata from the homeserver failed (${code}) — sign-in may be unavailable; see the site's logs`,
          }),
        })).catch(() => undefined);
    },
  });
  return G.__matrixAuthMetadata;
}

/** This install's sign-in endpoints. Throws AuthMetadataError (transient) when unavailable. */
export function authMetadata(): Promise<AuthMetadata> {
  return cache().get();
}

/** This install's sign-in endpoints, or null — never throws. */
export function authMetadataOrNull(): Promise<AuthMetadata | null> {
  return cache().peek();
}

/** `Authorization: Basic …` for this site's confidential client (client_secret_basic). */
export function clientBasicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}
