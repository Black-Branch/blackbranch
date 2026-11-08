// The Matrix session's decisions, with every dependency injected — the pool's query, the token
// cipher, the account server's endpoints — so matrixSessionCore.test.ts runs them, and
// matrixSession.hs.test.ts runs them against a real account server. SERVER ONLY.
// matrixSession.ts wires them to @/auth, the pg pool and the discovered endpoints.
//
// A session = (Auth.js cookie, site.user_sessions row, device id, token chain), keyed by session.
import { refreshPathFor, type RefreshPath } from "./matrixRefreshPath.ts";
import { readJsonCapped } from "./boundedBody.ts";
import { normalizeServerName, serverNameOf } from "./federatedSignInSwitch.ts";
import type { RevokeOutcome } from "./matrixOAuthClient.ts";
import type { AlarmSide } from "./matrixSessionWatch.ts";

/** Whose server an account lives on: this install's (`local`) or an outside one. By the account
 *  id, never by stored columns. */
function sideOf(matrixId: string, ownServer: string): AlarmSide {
  const server = serverNameOf(matrixId);
  return server !== null && server === normalizeServerName(ownServer) ? "local" : "federated";
}

// ─── How a session can end ────────────────────────────────────────────────────
//
// Only a CONFIRMED revoke wipes the browser's crypto store (vault systems/matrix-crypto.md: a
// device id and its store live and die together; a store whose device still exists holds message
// keys that may not be backed up). Everything else that stops a session is a sign-out of the site
// that keeps the store and device id, so the next sign-in resumes the same device.

/** The account server confirmed this session's device is gone. The row is already deleted; the
 *  browser wipes this device's crypto store and signs out (401 reason "revoked"). */
export class RevokedSessionError extends Error {
  readonly matrixId: string | null;
  readonly deviceId: string | null;
  constructor(matrixId: string | null = null, deviceId: string | null = null) {
    super("SESSION_REVOKED");
    this.matrixId = matrixId;
    this.deviceId = deviceId;
  }
}

/** Signed out of the site, device not known to be gone (401 reason "signed_out"): the browser
 *  signs out and KEEPS its crypto store and device id. */
export class SignedOutSessionError extends Error {
  readonly why: string;
  constructor(why: string) {
    super(`SESSION_SIGNED_OUT: ${why}`);
    this.why = why;
  }
}

/** The token endpoint itself refused the refresh grant (RFC 6749 §5.2) — a refusal, not yet a
 *  verdict: `invalid_grant` also means "issued to another client", which is our own fault.
 *  @test-only exported so the tests can make a refresh stub refuse; the product throws it only
 *  from readRefreshAnswer in this module. */
export class RefreshRefusedError extends Error {
  readonly oauthError: string;
  readonly description: string;
  constructor(oauthError: string, description: string) {
    super(`refresh refused: ${oauthError}`);
    this.oauthError = oauthError;
    this.description = description;
  }
}

/** What the account server says about a device after a refusal. */
export type DeviceStatus = "gone" | "alive" | "unknown";

export type SessionRow = {
  session_id: string;
  matrix_id: string;
  mx_device_id: string;
  mx_access_token: string | null;
  mx_refresh_token: string | null;
  mx_token_expires: string | number | null;
  homeserver: string | null;
  oidc_token_endpoint: string | null;
  oidc_client_id: string | null;
  /** An outside issuer's revocation endpoint, when the sign-in recorded one. */
  oidc_revocation_endpoint?: string | null;
};

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

const ROW_COLUMNS_SQL = `SELECT s.session_id, s.matrix_id, s.mx_device_id, s.mx_access_token,
            s.mx_refresh_token, s.mx_token_expires, u.homeserver,
            s.oidc_token_endpoint AS s_oidc_token_endpoint, s.oidc_client_id AS s_oidc_client_id,
            s.oidc_revocation_endpoint AS s_oidc_revocation_endpoint,
            u.oidc_token_endpoint AS u_oidc_token_endpoint, u.oidc_client_id AS u_oidc_client_id
     FROM site.user_sessions s JOIN site.users u USING (matrix_id)`;
const LOAD_ROW_SQL = `${ROW_COLUMNS_SQL}
     WHERE s.session_id = $1 AND s.matrix_id = $2`;
const LOAD_ACCOUNT_ROWS_SQL = `${ROW_COLUMNS_SQL}
     WHERE s.matrix_id = $1`;

type LoadedRow = Omit<SessionRow, "oidc_token_endpoint" | "oidc_client_id" | "oidc_revocation_endpoint"> & {
  s_oidc_token_endpoint?: string | null; s_oidc_client_id?: string | null; s_oidc_revocation_endpoint?: string | null;
  u_oidc_token_endpoint?: string | null; u_oidc_client_id?: string | null;
};

/**
 * One session row. Its outside-server binding (the client and endpoints its tokens were issued
 * for) is the SESSION's own when the sign-in recorded one (v168) — another device's sign-in can
 * then never change it. A session from before v168 reads the account's columns. Taken whole,
 * never one column from each.
 */
export async function loadSessionRow(query: Query, matrixId: string, sessionId: string): Promise<SessionRow | null> {
  const { rows } = await query(LOAD_ROW_SQL, [sessionId, matrixId]);
  const r = rows[0] as LoadedRow | undefined;
  return r ? withBinding(r) : null;
}

/** Every session of one account, each read as loadSessionRow reads one (account deletion ends
 *  them all upstream). Pass the transaction's query to read them in it. */
export async function loadSessionRowsFor(query: Query, matrixId: string): Promise<SessionRow[]> {
  const { rows } = await query(LOAD_ACCOUNT_ROWS_SQL, [matrixId]);
  return (rows as LoadedRow[]).map(withBinding);
}

function withBinding(r: LoadedRow): SessionRow {
  const { s_oidc_token_endpoint: sT, s_oidc_client_id: sC, s_oidc_revocation_endpoint: sR, u_oidc_token_endpoint: uT, u_oidc_client_id: uC, ...rest } = r;
  const own = !!(sT && sC);
  return {
    ...rest,
    oidc_token_endpoint: (own ? sT : uT) ?? null,
    oidc_client_id: (own ? sC : uC) ?? null,
    oidc_revocation_endpoint: own ? sR ?? null : null,
  };
}

async function deleteSessionRow(query: Query, sessionId: string): Promise<void> {
  await query(`DELETE FROM site.user_sessions WHERE session_id = $1`, [sessionId]);
}

export type UpstreamDeps = {
  dec: (stored: string | null) => string | null;
  /** RFC 7009 revocation of a refresh token at this install's account server; true / ok = confirmed
   *  (an outcome carries the server's reason when it is not). */
  revokeLocal: (refreshToken: string) => Promise<boolean | RevokeOutcome>;
  /** RFC 7009 revocation at an OUTSIDE issuer's revocation endpoint, as our public client there. */
  revokeFederated: (endpoint: string, clientId: string, refreshToken: string) => Promise<boolean | RevokeOutcome>;
  /** `POST <homeserver>/_matrix/client/v3/logout` with the access token; true = 2xx. */
  logout: (homeserver: string, accessToken: string) => Promise<boolean>;
  /** The homeserver a row's account lives on (a NULL column = this install's). */
  homeserverFor: (row: SessionRow) => string;
  ownServer: string;
  log: (line: string) => void;
  /** An outside session that recorded no revocation endpoint (every one from before v168): its
   *  issuer's endpoint found now from the account's server (discoveredRevocationEndpoint), or null. */
  discoverRevocation?: (row: SessionRow, tokenEndpoint: string) => Promise<string | null>;
};

export type EndDeps = UpstreamDeps & { query: Query };

/** The parts of a server discovery this module reads (federatedSignIn.ts discoverServer). */
export type RevocationDiscovery = { ok: true; metadata: { tokenEndpoint: string; revocationEndpoint: string | null } } | { ok: false };

/**
 * The revocation endpoint of the server an outside account lives on, discovered from the server
 * the ACCOUNT names — trusted only when that server's issuer still names the session's own token
 * endpoint (the one its refresh token was issued at). Anything else is null: the refresh token goes
 * nowhere a server has not vouched for.
 */
export async function discoveredRevocationEndpoint(
  matrixId: string, tokenEndpoint: string, discover: (serverName: string) => Promise<RevocationDiscovery>,
): Promise<string | null> {
  const server = normalizeServerName(serverNameOf(matrixId));
  if (!server) return null;
  const found = await discover(server);
  if (!found.ok || found.metadata.tokenEndpoint !== tokenEndpoint) return null;
  return found.metadata.revocationEndpoint ?? null;
}

/** The client-server logout, with an injectable transport. */
export async function logoutAt(homeserver: string, accessToken: string, fetchFn: (url: string, init: RequestInit) => Promise<Response>): Promise<boolean> {
  try {
    const r = await fetchFn(`${homeserver.replace(/\/+$/, "")}/_matrix/client/v3/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    await r.body?.cancel().catch(() => {});
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Sign-out: end the session at its account server, then delete the row. Every path keeps an
 * upstream end:
 *  - the REFRESH token is revoked (RFC 7009) — at our account server, or at an outside issuer's
 *    revocation endpoint when the session recorded one. It needs no live access token, and ending
 *    the grant is what finishes the session and removes the device. (`/logout` alone cannot: MAS
 *    refuses an OAuth 2.0 session's token there, and the stored one is usually expired.)
 *  - when that is not confirmed, or there is no usable refresh token, `/logout` with the stored
 *    access token at the account's homeserver.
 * The row goes in any case: the site sign-out never waits on the account server.
 */
export async function endSession(deps: EndDeps, row: SessionRow): Promise<void> {
  await endUpstream(deps, row);
  await deleteSessionRow(deps.query, row.session_id).catch(() => {});
}

/**
 * The upstream half of endSession, for callers that own the row themselves (an account deletion
 * that erases it). true = the account server confirmed the end. An outside session that recorded
 * no revocation endpoint has it discovered (UpstreamDeps.discoverRevocation).
 *
 * `logoutFallback: false` revokes the refresh token and nothing else: `/logout` deletes the DEVICE
 * at the homeserver, which is right when the device goes with the session (sign-out, deletion) and
 * wrong when a newer session keeps the same device id (a re-sign-in — endReplacedSession).
 */
export async function endUpstream(deps: UpstreamDeps, row: SessionRow, opts: { logoutFallback?: boolean } = {}): Promise<boolean> {
  const logoutFallback = opts.logoutFallback ?? true;
  const refresh = deps.dec(row.mx_refresh_token);
  const access = deps.dec(row.mx_access_token);
  const path = refreshPathFor(row, deps.ownServer);
  let revoke: RevokeOutcome;
  if (!refresh) revoke = { ok: false, error: row.mx_refresh_token == null ? "no_refresh_token" : "refresh_token_unreadable" };
  else if (path.kind === "local") revoke = asOutcome(await deps.revokeLocal(refresh));
  else {
    const endpoint = row.oidc_revocation_endpoint
      ?? await (deps.discoverRevocation?.(row, path.tokenEndpoint) ?? Promise.resolve(null)).catch(() => null);
    revoke = endpoint
      ? { endpoint, ...asOutcome(await deps.revokeFederated(endpoint, path.clientId, refresh)) }
      : { ok: false, error: "no_revocation_endpoint", endpoint: path.tokenEndpoint };
  }
  let ended = revoke.ok;
  if (!ended && access && logoutFallback) ended = await deps.logout(deps.homeserverFor(row), access);
  if (ended) return true;
  if (logoutFallback) {
    deps.log(`[matrix-session] sign-out: the account server did not confirm the end of the session (path=${path.kind} device ${row.mx_device_id}); it may stay listed there`);
  } else {
    // A re-sign-in: the old refresh token is still live at its issuer and no row holds it now.
    const why = revoke.ok ? { error: "", description: "" } : { error: revoke.error, description: revoke.description ?? "" };
    deps.log(`[matrix-session] re-sign-in: old chain NOT revoked path=${path.kind} issuer=${originOf(revoke.endpoint)} device=${row.mx_device_id} oauth_error=${oneLine(why.error)} desc="${oneLine(why.description)}" → left live at the account server (no /logout: the device is the new session's)`);
  }
  return false;
}

function asOutcome(r: boolean | RevokeOutcome): RevokeOutcome {
  if (typeof r !== "boolean") return r;
  return r ? { ok: true } : { ok: false, error: "unconfirmed" };
}

/** The issuer's origin for the journal (never a path or query), or "?" when unknown. */
function originOf(url: string | undefined): string {
  if (!url) return "?";
  try { return new URL(url).origin; } catch { return "?"; }
}

/**
 * A re-sign-in on a device that already has a row: revoke the OLD chain's refresh token at its own
 * issuer before the row is replaced, so the server is not left holding a live session no row
 * points at. Revoke ONLY — never /logout: the new session keeps this device id, and /logout would
 * delete the device and its keys under the browser's crypto store. Best-effort: never throws.
 * true = the old chain was confirmed ended. An old chain that could NOT be revoked is logged (path,
 * issuer, the server's error) and reported to `onUnconfirmed` with its side — the burst alarms, as
 * for refusals; an outside server's failures never count toward this install's own alarm.
 * Retrying it later is not done here (a pending-revocation record belongs with the orphaned-session
 * clean-up decision).
 */
export async function endReplacedSession(
  deps: UpstreamDeps & { query: Query; onUnconfirmed?: (matrixId: string, side: AlarmSide) => void },
  matrixId: string, deviceId: string, newRefreshToken: string | null,
): Promise<boolean> {
  let prior: SessionRow | null;
  try {
    const { rows } = await deps.query(
      `SELECT session_id FROM site.user_sessions WHERE matrix_id = $1 AND mx_device_id = $2`, [matrixId, deviceId]);
    const sid = (rows[0] as { session_id?: string } | undefined)?.session_id;
    prior = sid ? await loadSessionRow(deps.query, matrixId, sid) : null;
  } catch {
    deps.log(`[matrix-session] re-sign-in: the old chain could not be read (device=${deviceId}); if one existed it is left live at the account server`);
    deps.onUnconfirmed?.(matrixId, sideOf(matrixId, deps.ownServer));
    return false;
  }
  if (!prior || deps.dec(prior.mx_refresh_token) === newRefreshToken) return false;
  const ended = await endUpstream(deps, prior, { logoutFallback: false }).catch(() => false);
  if (!ended) deps.onUnconfirmed?.(matrixId, sideOf(matrixId, deps.ownServer));
  return ended;
}
// ─── Resolving the access token ───────────────────────────────────────────────

export type FreshTokens = { access_token: string; refresh_token?: string; expires_in?: number };

export type ResolveDeps = {
  query: Query;
  dec: (stored: string | null) => string | null;
  enc: (plain: string | null) => string | null;
  now: () => number;
  ownServer: string;
  /** One refresh grant on `path`. Throws RefreshRefusedError when the token endpoint refuses the
   *  grant; any other throw is transient. */
  refresh: (path: RefreshPath, refreshToken: string) => Promise<FreshTokens>;
  /** Asked only after OUR account server refused a refresh: is this row's device gone there? */
  deviceStatus: (row: SessionRow) => Promise<DeviceStatus>;
  /** The operator alarm (rate-limited by the notifier). */
  alarm: (message: string) => void;
  log: (line: string) => void;
  /** Told of every refused refresh, either verdict, with the side the account lives on — this
   *  install's server or an outside one, counted apart (the rate alarms, matrixSessionWatch.ts). */
  onRefusal?: (matrixId: string, side: AlarmSide) => void;
};

export type ResolvedTokens = { row: SessionRow; accessToken: string; expiresAt: number };

/**
 * A token endpoint's answer to a refresh grant. A refusal the endpoint states itself
 * (`invalid_grant`; `invalid_token`, which some servers send though RFC 6749 §5.2 does not list
 * it) is RefreshRefusedError; any other non-2xx or an unreadable body is a plain (transient) Error.
 */
export async function readRefreshAnswer(res: Response, maxBytes: number): Promise<FreshTokens> {
  if (!res.ok) {
    const body = ((await readJsonCapped(res, maxBytes)) ?? {}) as { error?: unknown; error_description?: unknown };
    if (body.error === "invalid_grant" || body.error === "invalid_token") {
      throw new RefreshRefusedError(body.error, typeof body.error_description === "string" ? body.error_description : "");
    }
    throw new Error(`refresh failed: ${res.status}`);
  }
  const fresh = (await readJsonCapped(res, maxBytes)) as FreshTokens | null;
  if (typeof fresh?.access_token !== "string") throw new Error("refresh failed: unreadable token response");
  return fresh;
}

/** A stored access token with at least 30 s left, or null. */
function liveAccess(deps: Pick<ResolveDeps, "dec" | "now">, row: SessionRow): { accessToken: string; expiresAt: number } | null {
  const accessToken = deps.dec(row.mx_access_token);
  const expiresAt = Number(row.mx_token_expires ?? 0);
  return accessToken && expiresAt && deps.now() < expiresAt - 30_000 ? { accessToken, expiresAt } : null;
}

const oneLine = (s: string) => s.replace(/[\r\n"]+/g, " ").slice(0, 200);

/** A transient failure's cause for the journal: the network error code when there is one
 *  (`fetch failed` alone cannot tell an expired certificate from a timeout), else the message. */
function causeOf(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return `"${oneLine(e instanceof Error ? e.message : String(e))}"`;
}

/**
 * This session's access token, refreshed when it is near expiry. Throws RevokedSessionError only
 * on a confirmed revoke, SignedOutSessionError for every other way the session has ended, and a
 * plain Error for anything transient (nothing is deleted then).
 */
export async function resolveTokens(deps: ResolveDeps, matrixId: string, sessionId: string): Promise<ResolvedTokens> {
  const row = await loadSessionRow(deps.query, matrixId, sessionId);
  // Gone already: signed out in another tab, a re-sign-in rotated it, or a refusal handled before.
  // Whatever removed it decided about the device then; this request only learns it is signed out.
  if (!row) throw new SignedOutSessionError("no_row");

  const live = liveAccess(deps, row);
  if (live) {
    deps.query(`UPDATE site.user_sessions SET last_seen = now() WHERE session_id = $1`, [row.session_id]).catch(() => {});
    return { row, ...live };
  }

  const server = serverNameOf(row.matrix_id) ?? "?";
  if (row.mx_refresh_token == null) {
    await deleteSessionRow(deps.query, row.session_id).catch(() => {});
    deps.log(`[matrix-session] no refresh token server=${server} device=${row.mx_device_id} → signed_out`);
    throw new SignedOutSessionError("no_refresh_token");
  }
  const storedRefresh = deps.dec(row.mx_refresh_token);
  if (!storedRefresh) {
    // The key, not the session, is wrong: keep the row (it works again once the key is fixed).
    deps.alarm("A stored Matrix refresh token will not decrypt: TOKEN_ENC_KEY is missing, wrong or was rotated. Sessions are kept and resume once the key is right.");
    throw new Error("stored refresh token unreadable (TOKEN_ENC_KEY)");
  }

  const path = refreshPathFor(row, deps.ownServer);
  try {
    const fresh = await deps.refresh(path, storedRefresh);
    const expiresAt = deps.now() + (fresh.expires_in ?? 3600) * 1000;
    await deps.query(
      `UPDATE site.user_sessions
       SET mx_access_token = $1, mx_refresh_token = $2, mx_token_expires = $3, last_seen = now()
       WHERE session_id = $4`,
      [deps.enc(fresh.access_token), deps.enc(fresh.refresh_token ?? storedRefresh), expiresAt, row.session_id],
    );
    return { row, accessToken: fresh.access_token, expiresAt };
  } catch (e) {
    // Another server process may have rotated the pair while this request was out: its tokens win.
    const again = await loadSessionRow(deps.query, matrixId, sessionId).catch(() => null);
    const theirs = again ? liveAccess(deps, again) : null;
    if (again && theirs) return { row: again, ...theirs };
    if (!(e instanceof RefreshRefusedError)) {
      deps.log(`[matrix-session] refresh failed path=${path.kind} server=${server} device=${row.mx_device_id} cause=${causeOf(e)} → kept`);
      throw e;
    }

    // A refusal. Only our own account server can be asked whether the device is gone, and only
    // about an account whose id names OUR server — not by the refresh path, which also sends a
    // foreign row missing a column down the local path; its localpart is someone else here.
    const ours = serverNameOf(row.matrix_id) !== null && serverNameOf(row.matrix_id) === normalizeServerName(deps.ownServer);
    const status: DeviceStatus = ours ? await deps.deviceStatus(row).catch(() => "unknown" as const) : "unknown";
    const verdict = status === "gone" ? "revoked" : "signed_out";
    await deleteSessionRow(deps.query, row.session_id).catch(() => {});
    deps.log(`[matrix-session] refresh refused path=${path.kind} device=${row.mx_device_id} oauth_error=${oneLine(e.oauthError)} desc="${oneLine(e.description)}" device=${status} → ${verdict}`);
    deps.onRefusal?.(row.matrix_id, sideOf(row.matrix_id, deps.ownServer));
    if (status === "gone") throw new RevokedSessionError(row.matrix_id, row.mx_device_id);
    throw new SignedOutSessionError("refused");
  }
}

// ─── The session getter ───────────────────────────────────────────────────────

/** What the site-session check (`auth()`, siteSession.ts) says about this request. */
export type SiteSessionView = { user?: { id?: string | null } | null; sessionId?: string | null; authState?: string | null } | null;

export type GetterDeps<T> = {
  auth: () => Promise<SiteSessionView>;
  resolve: (matrixId: string, sessionId: string) => Promise<T>;
  /** The federated sign-in policy around the load (federatedSignInSwitch.ts policyGatedSession). */
  gate: (matrixId: string, load: () => Promise<T>) => Promise<T | null>;
  log: (line: string) => void;
};

/**
 * The caller's Matrix session: null when there is no site session; RevokedSessionError for a
 * deleted account's cookie, SignedOutSessionError for a cookie whose row is gone (whatever removed
 * it decided about the device), a plain Error while the check is unavailable. Concurrent calls for
 * one session share one resolve — MAS rotates the refresh token on every use, so a parallel second
 * refresh would be refused and look like a revocation. The entry is dropped once settled.
 */
export function createSessionGetter<T>(deps: GetterDeps<T>): () => Promise<T | null> {
  const inFlight = new Map<string, Promise<T>>();
  return async () => {
    const session = await deps.auth();
    const matrixId = session?.user?.id;
    const sessionId = session?.sessionId;
    if (!matrixId || !sessionId) {
      if (session?.authState === "deleted") {
        deps.log("[matrix-session] account deleted → revoked");
        throw new RevokedSessionError();
      }
      if (session?.authState === "revoked") throw new SignedOutSessionError("no_row");
      if (session?.authState === "unavailable") throw new Error("site session check unavailable");
      return null;
    }
    return deps.gate(matrixId, () => {
      const existing = inFlight.get(sessionId);
      if (existing) return existing;
      const p = deps.resolve(matrixId, sessionId).finally(() => { inFlight.delete(sessionId); });
      inFlight.set(sessionId, p);
      return p;
    });
  };
}
