import { installValue } from "./installValues.ts";
// The canonical origin this instance answers on — the ONE place that decides
// "which site am I" for every redirect the auth flows emit.
//
// Every flow's `redirect_uri` AND its final hand-off
// (`/auth/federated-complete?token=…`) must read the same value. If the
// redirect_uri came back to one origin (say localhost in dev) while the
// hand-off went to another, the one-time token would be looked up in the
// other site's database, miss, and show "Sign-in link expired or already
// used." So both halves read it from here.
//
// The value is the install key site.origin (env SITE_ORIGIN, alias
// AUTH_URL), read from the environment when web starts (installValues.ts). There is no fallback
// origin: web refuses to boot without one. Normalised to a bare origin (no slash): callers append
// absolute paths.
export function authOrigin(): string {
  return installValue("site.origin");
}
