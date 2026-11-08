// @test-only test infrastructure — a real OAuth 2.0 sign-in on the THROWAWAY account server, for the
// homeserver suites (*.hs.test.ts). Never point it at a real one.
//
// The site's sign-in is an authorization-code grant for its own confidential client (mas-initiate →
// MAS's sign-in and consent pages → mas-callback). A password `/login` makes a compat session, which
// has no refresh token and is ended differently, so the session tests drive the same grant the site
// does: the authorize URL, MAS's two HTML forms (each carries a csrf field), then the code exchange.
// Cookies are kept per sign-in; nothing is followed past the redirect back to the site.
import { createHash, randomBytes } from "node:crypto";

export type HsEnv = {
  base: string;          // HS_TEST_BASE — the homeserver (auth_metadata is read from it)
  login: string;         // HS_TEST_LOGIN_BASE — MAS, as this machine reaches it
  adminUrl: string;      // HS_TEST_MAS_ADMIN_URL — MAS's internal admin listener
  clientId: string;
  clientSecret: string;
};

export function hsEnv(e: Record<string, string | undefined> = process.env): HsEnv | null {
  const login = (e.HS_TEST_LOGIN_BASE ?? "").replace(/\/+$/, "");
  if (!login || !e.HS_TEST_CLIENT_ID || !e.HS_TEST_CLIENT_SECRET || !e.HS_TEST_BASE) return null;
  return {
    base: e.HS_TEST_BASE.replace(/\/+$/, ""), login,
    adminUrl: (e.HS_TEST_MAS_ADMIN_URL || `${login}/api/admin/v1`).replace(/\/+$/, ""),
    clientId: e.HS_TEST_CLIENT_ID, clientSecret: e.HS_TEST_CLIENT_SECRET,
  };
}

export const basic = (env: HsEnv) => `Basic ${Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64")}`;

export type Endpoints = { authorization: string; token: string; revocation: string };

/** `url` on the login base's origin: the issuer's own hostname need not resolve on this machine
 *  (a CI runner), and MAS answers the same paths on the address the tests reach it by. */
export function viaLogin(env: HsEnv, url: string): string {
  const u = new URL(url, env.login);
  const l = new URL(env.login);
  u.protocol = l.protocol; u.host = l.host;
  return u.toString();
}

export async function endpoints(env: HsEnv): Promise<Endpoints> {
  const md = await (await fetch(`${env.base}/_matrix/client/v1/auth_metadata`)).json() as Record<string, string>;
  return {
    authorization: viaLogin(env, md.authorization_endpoint!),
    token: viaLogin(env, md.token_endpoint!),
    revocation: viaLogin(env, md.revocation_endpoint!),
  };
}

/** An admin API token, the way production gets one (client_credentials, `urn:mas:admin`). */
export async function adminToken(env: HsEnv): Promise<string> {
  const r = await fetch(`${env.login}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(env) },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "urn:mas:admin" }),
  });
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error(`no admin token (${r.status})`);
  return j.access_token;
}

/** A fresh password account on the throwaway, so no shared account collects sessions. */
export async function makeAccount(env: HsEnv, admin: string, prefix: string): Promise<{ id: string; username: string; password: string }> {
  const username = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const password = `correct horse battery staple ${username}!`;
  const H = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };
  const c = await fetch(`${env.adminUrl}/users`, { method: "POST", headers: H, body: JSON.stringify({ username }) });
  const id = ((await c.json()) as { data?: { id?: string } }).data?.id;
  if (!id) throw new Error(`account not made (${c.status})`);
  const p = await fetch(`${env.adminUrl}/users/${id}/set-password`, { method: "POST", headers: H, body: JSON.stringify({ password }) });
  if (!p.ok) throw new Error(`password not set (${p.status})`);
  return { id, username, password };
}

const DEVICE_SCOPE = "urn:matrix:org.matrix.msc2967.client:device:";

/** The MAS sessions of one user that are still active, optionally for one device. */
export async function activeSessions(env: HsEnv, admin: string, userId: string, deviceId?: string): Promise<number> {
  const q = new URLSearchParams({ "filter[user]": userId, "filter[status]": "active", "page[first]": "50" });
  if (deviceId) q.set("filter[scope]", `${DEVICE_SCOPE}${deviceId}`);
  const r = await fetch(`${env.adminUrl}/oauth2-sessions?${q}`, { headers: { Authorization: `Bearer ${admin}` } });
  if (!r.ok) throw new Error(`sessions not listed (${r.status})`);
  return ((await r.json()) as { data: unknown[] }).data.length;
}

/** One MAS browser session per account for the whole file: the second authorization of the same
 *  account rides on it (the consent step only), so a suite spends ONE password sign-in of the
 *  address's shared budget, not one per test. */
const jars = new Map<string, Map<string, string>>();

/** Sign `user` in on `deviceId` exactly as the site's own sign-in does; returns the token pair. */
export async function signInByCode(env: HsEnv, user: { username: string; password: string }, deviceId: string, redirectUri: string): Promise<{ access_token: string; refresh_token: string }> {
  const ep = await endpoints(env);
  const jar = jars.get(user.username) ?? new Map<string, string>();
  jars.set(user.username, jar);
  const go = async (url: string, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string> | undefined), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    const r = await fetch(viaLogin(env, url), { ...init, headers, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(";")[0] ?? "";
      const i = kv.indexOf("=");
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return r;
  };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(ep.authorization);
  for (const [k, v] of Object.entries({
    client_id: env.clientId, redirect_uri: redirectUri, response_type: "code", state: "hs-test",
    scope: `openid urn:matrix:org.matrix.msc2967.client:api:* ${DEVICE_SCOPE}${deviceId}`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  })) authorize.searchParams.set(k, v);

  let at = authorize.toString();
  let r = await go(at);
  let code: string | null = null;
  // MAS limits password sign-ins per ADDRESS, shared by every suite in the run (testHsLogin.ts): a
  // sign-in it refuses for that comes back as the sign-in page again. That is waited out — 10 s,
  // at most six times — never treated as the answer.
  let waits = 0;
  for (let step = 0; step < 12 && !code; step++) {
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location") ?? "";
      if (loc.startsWith(redirectUri)) { code = new URL(loc).searchParams.get("code"); break; }
      at = new URL(loc, at).toString();
      r = await go(at);
      continue;
    }
    const html = await r.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new Error(`MAS page ${r.status} without a form`);
    const form = new URLSearchParams({ csrf });
    const signIn = /name="username"/.test(html);
    if (signIn) { form.set("username", user.username); form.set("password", user.password); }
    r = await go(at, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (signIn && (r.status === 429 || r.status === 200) && waits < 6) {
      // Refused sign-in (the limiter; this account's password is known good): wait, then a fresh page.
      const again = r.status === 429 ? "" : await r.clone().text();
      if (r.status === 429 || /name="username"/.test(again)) {
        waits++;
        await r.body?.cancel().catch(() => {});
        await new Promise((res) => setTimeout(res, 10_000));
        r = await go(at);
        step--;
      }
    }
  }
  if (!code) throw new Error("no authorization code came back");
  const t = await fetch(ep.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(env) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  const j = (await t.json()) as { access_token?: string; refresh_token?: string };
  if (!j.access_token || !j.refresh_token) throw new Error(`code exchange failed (${t.status})`);
  return { access_token: j.access_token, refresh_token: j.refresh_token };
}

/** The redirect URI the throwaway's static client has registered (MAS refuses any other). */
export async function registeredRedirect(env: HsEnv, admin: string): Promise<string> {
  const r = await fetch(`${env.adminUrl}/oauth2-clients/${encodeURIComponent(env.clientId)}`, { headers: { Authorization: `Bearer ${admin}` } });
  const uris = ((await r.json()) as { data?: { attributes?: { redirect_uris?: string[] } } }).data?.attributes?.redirect_uris ?? [];
  const uri = uris.find((u) => u.endsWith("/api/auth/mas-callback"));
  if (!uri) throw new Error("the throwaway client has no mas-callback redirect registered");
  return uri;
}
