// Who may sign in with an account on ANOTHER Matrix server — the install keys auth.federatedSignin
// (off | on | allowlist), auth.federatedAllow and auth.federatedDeny. SERVER ONLY.
//
// The decision is keyed on the SERVER NAME of a Matrix id (the part after the first colon), never
// on a URL a browser sent: a homeserver URL is chosen by whoever asks, a server name is what the
// account is. Matching is exact after lower-casing — "evil-example.org" and "chat.example.org" are
// not "example.org". This install's own server always passes, so turning federated sign-in off
// leaves the site's own sign-in (its own server, through its own MAS) exactly as it was.
//
// Asked at every step: discover and initiate check the server the visitor asked for
// (provisionally — nothing is authenticated yet); the callback checks the AUTHENTICATED account's
// server against the policy as it is then (a login that started before the policy tightened is
// refused there) and against the server the login started with (the signed state cookie carries
// it); and every request's session check (siteSession.ts) and Matrix session (matrixSession.ts) ask
// again, so a server refused now loses access at its next request. The values are read from the
// settings layer's memory on each call — a change made in the Admin Panel reloads it at once.
import { instanceList, instanceResolve, instanceString } from "./instanceConfigServer.ts";
import { matrixServerName } from "./matrixConfig.ts";
import { instanceEntry, parseInstanceValue } from "./instanceSchema.generated.mjs";

export type FederatedMode = "off" | "on" | "allowlist";
export type FederatedPolicy = { mode: FederatedMode; allow: readonly string[]; deny: readonly string[]; own: string };

// The rule for a server name is the settings schema's own (config/instance-schema.mjs, a list with
// `items: 'serverName'`): what the two lists store and what a sign-in is compared with are one
// rule, so a stored entry always matches the accounts it names.
const SERVER_LIST = instanceEntry("auth.federatedDeny");

/** A server name in the one form the policy compares (lower-cased, trimmed); null when it is not one. */
export function normalizeServerName(raw: unknown): string | null {
  if (typeof raw !== "string" || !SERVER_LIST) return null;
  const r = parseInstanceValue(SERVER_LIST, [raw]);
  return r.ok && Array.isArray(r.value) && typeof r.value[0] === "string" ? r.value[0] : null;
}

/** The server name of a Matrix id (`@local:server`), normalised; null when it has none.
 *  @test-only exported so the tests can pin how a name is read from an id; the product reads it
 *  through federatedSessionAllowed. */
export function serverNameOf(matrixId: unknown): string | null {
  if (typeof matrixId !== "string" || !matrixId.startsWith("@")) return null;
  const at = matrixId.indexOf(":");
  return at > 1 ? normalizeServerName(matrixId.slice(at + 1)) : null;
}

/** May an account on `serverName` sign in (or stay signed in) under `policy`? */
export function serverAllowed(policy: FederatedPolicy, serverName: unknown): boolean {
  const s = normalizeServerName(serverName);
  if (!s) return false;
  if (s === normalizeServerName(policy.own)) return true;
  const listed = (list: readonly string[]) => list.some((x) => normalizeServerName(x) === s);
  if (listed(policy.deny)) return false;
  if (policy.mode === "on") return true;
  if (policy.mode === "allowlist") return listed(policy.allow);
  return false;
}

function asMode(v: string | null): FederatedMode {
  return v === "on" || v === "allowlist" ? v : "off";
}

/** The policy as the settings layer holds it now. A deny list that does not parse (a value stored
 *  before the schema checked its entries, or a bad env value) reads as off: only this install's own
 *  server signs in until it is fixed, never everyone. */
function currentFederatedPolicy(): FederatedPolicy {
  const denyUnreadable = instanceResolve("auth.federatedDeny").error !== null;
  return {
    mode: denyUnreadable ? "off" : asMode(instanceString("auth.federatedSignin")),
    allow: instanceList("auth.federatedAllow"),
    deny: instanceList("auth.federatedDeny"),
    own: matrixServerName(),
  };
}

/** The mode the sign-in page shows its "another server" box for (hidden when off). */
export function federatedSignInMode(): FederatedMode {
  return currentFederatedPolicy().mode;
}

/** discover / initiate / callback: may this server name sign in now? */
export function federatedServerAllowed(serverName: unknown): boolean {
  return serverAllowed(currentFederatedPolicy(), serverName);
}

/** Every request with a session: may this account stay signed in now? */
export function federatedSessionAllowed(matrixId: unknown): boolean {
  return serverAllowed(currentFederatedPolicy(), serverNameOf(matrixId));
}

/** A value that changes whenever the policy does — what an in-memory session cache stores with an
 *  entry and compares on a hit, so a tightened policy is never answered from a cache. */
export function federatedPolicyVersion(p: FederatedPolicy = currentFederatedPolicy()): string {
  return JSON.stringify([p.mode, [...p.allow].map(String).sort(), [...p.deny].map(String).sort(), p.own]);
}

/** A Matrix session load held to the policy on both sides of its wait: refused before it starts,
 *  and refused after it settles when the policy changed meanwhile — a token refresh in flight
 *  (shared through matrixSession.ts's in-flight map) never hands a token to a server refused
 *  while it ran. null = treat as signed out. */
export async function policyGatedSession<T>(
  matrixId: string,
  load: () => Promise<T>,
  allowed: (matrixId: string) => boolean = federatedSessionAllowed,
): Promise<T | null> {
  if (!allowed(matrixId)) return null;
  const s = await load();
  return allowed(matrixId) ? s : null;
}

/** The error code the sign-in page shows as "sign-in from this server isn't enabled". */
export const FEDERATED_SIGNIN_REFUSED = "federated_signin_disabled";
