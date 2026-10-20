// The homeserver account server's (MAS) admin API, as this site's own confidential client with the
// `urn:mas:admin` scope (client_credentials). SERVER ONLY. Two callers: "Delete my account"
// (matrixAccountErase.ts) and the setup pages' first step, which creates the first admin.
//
// The operator has to allow the scope: the client listed in MAS's `policy.data.admin_clients` and
// the `adminapi` resource on a listener (the bundle renders both — the resource on an internal
// listener only, reached through MAS_ADMIN_URL). The token itself still comes from the issuer's
// public token endpoint. Codes only leave this module,
// never the server's own text — except a password refusal's reason, which the person needs.

import { oauthTokenRequest } from "./matrixOAuthClient.ts";
import { matrixOAuthIssuer } from "./matrixConfig.ts";

const ADMIN_SCOPE = "urn:mas:admin";

export type MasAdminToken = { ok: true; token: string } | { ok: false; code: string };
export type MasAdmin = {
  /** `<issuer>/api/admin/v1`, no trailing slash. */
  base: string;
  token: (signal?: AbortSignal) => Promise<MasAdminToken>;
  fetch: typeof fetch;
};

export async function masAdminToken(signal?: AbortSignal): Promise<MasAdminToken> {
  let res: Response;
  try {
    res = await oauthTokenRequest(new URLSearchParams({ grant_type: "client_credentials", scope: ADMIN_SCOPE }), signal);
  } catch { return { ok: false, code: "unreachable" }; }
  if (!res.ok) return { ok: false, code: res.status === 400 || res.status === 401 || res.status === 403 ? "not_allowed" : `http_${res.status}` };
  const j = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  return typeof j?.access_token === "string" ? { ok: true, token: j.access_token } : { ok: false, code: "bad_response" };
}

/** This install's admin API, as production reaches it. MAS_ADMIN_URL names it when the admin API
 *  is NOT under the issuer: the bundle serves it only on MAS's internal listener, which the router
 *  never routes, so that the site client's secret alone cannot reach it from the internet (anyone
 *  holding a token from it could set any account's password). Unset = the issuer's own path — a
 *  homeserver the bundle did not render, served the old way. */
export function masAdmin(env: Record<string, string | undefined> = process.env): MasAdmin {
  const explicit = (env.MAS_ADMIN_URL ?? "").trim();
  const base = explicit || `${matrixOAuthIssuer().replace(/\/+$/, "")}/api/admin/v1`;
  return { base: base.replace(/\/+$/, ""), token: masAdminToken, fetch };
}

type MasUser = { id: string; deactivated: boolean };

/** The account with this username, null when the name is free, or a code. */
export async function masUserByName(admin: MasAdmin, token: string, username: string): Promise<{ ok: true; user: MasUser | null } | { ok: false; code: string }> {
  try {
    const r = await admin.fetch(`${admin.base}/users/by-username/${encodeURIComponent(username)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000),
    });
    if (r.status === 404) return { ok: true, user: null };
    if (!r.ok) return { ok: false, code: `lookup_http_${r.status}` };
    const j = (await r.json().catch(() => null)) as { data?: { id?: unknown; attributes?: { deactivated_at?: unknown } } } | null;
    const id = j?.data?.id;
    return typeof id === "string" ? { ok: true, user: { id, deactivated: !!j?.data?.attributes?.deactivated_at } } : { ok: false, code: "bad_response" };
  } catch { return { ok: false, code: "unreachable" }; }
}

/** MAS's own words for a refusal (its JSON:API `errors`), one line, bounded. */
async function reasonOf(r: Response): Promise<string> {
  const j = (await r.json().catch(() => null)) as { errors?: { title?: unknown }[] } | null;
  const t = j?.errors?.map((e) => (typeof e.title === "string" ? e.title : "")).filter(Boolean).join("; ") ?? "";
  return t.replace(/[\r\n]+/g, " ").slice(0, 300);
}

export type CreateAccountResult =
  | { ok: true; id: string }
  | { ok: false; code: "taken" | "name_refused" | "weak_password" | string; reason?: string; id?: string };

/**
 * Create a password account, or — when `resumeId` names an account this caller made earlier and
 * whose password was refused — set the password on that one. Any other existing name is "taken":
 * this never takes over an account someone else registered.
 * A refused password leaves the account made and returns its `id`, so the caller can record it
 * and resume with a better password.
 */
export async function createPasswordAccount(admin: MasAdmin, username: string, password: string, resumeId: string | null): Promise<CreateAccountResult> {
  const t = await admin.token(AbortSignal.timeout(8_000));
  if (!t.ok) return t;
  const headers = { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" };
  const found = await masUserByName(admin, t.token, username);
  if (!found.ok) return found;
  let id: string;
  if (found.user) {
    if (found.user.id !== resumeId || found.user.deactivated) return { ok: false, code: "taken" };
    id = found.user.id;
  } else {
    try {
      const c = await admin.fetch(`${admin.base}/users`, {
        method: "POST", headers, body: JSON.stringify({ username }), signal: AbortSignal.timeout(15_000),
      });
      if (c.status === 400 || c.status === 409 || c.status === 422) return { ok: false, code: "name_refused", reason: await reasonOf(c) };
      if (!c.ok) return { ok: false, code: `create_http_${c.status}` };
      const j = (await c.json().catch(() => null)) as { data?: { id?: unknown } } | null;
      if (typeof j?.data?.id !== "string") return { ok: false, code: "bad_response" };
      id = j.data.id;
    } catch { return { ok: false, code: "unreachable" }; }
  }
  try {
    const p = await admin.fetch(`${admin.base}/users/${encodeURIComponent(id)}/set-password`, {
      method: "POST", headers, body: JSON.stringify({ password, skip_password_check: false }), signal: AbortSignal.timeout(15_000),
    });
    if (p.status === 400 || p.status === 422) return { ok: false, code: "weak_password", reason: await reasonOf(p), id };
    if (!p.ok) return { ok: false, code: `password_http_${p.status}`, id };
  } catch { return { ok: false, code: "unreachable", id }; }
  return { ok: true, id };
}
