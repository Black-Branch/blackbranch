import { authOrigin } from "./authOrigin.ts";

// next-auth decides its own URL from AUTH_URL (or NEXTAUTH_URL), read per request, and without
// one it trusts the request's Host. An install that set only SITE_ORIGIN would finish sign-in on
// the bind host (localhost) with the session cookie on the other name — signed out. So the site's
// one origin (install key site.origin) is handed to next-auth at boot when the env names none. An
// env that DOES name one keeps it (AUTH_URL is also site.origin's second env name, so with
// SITE_ORIGIN unset the two are the same value).

/** Give next-auth the site's origin when the env names none. Returns which source won, for the
 *  boot line. `env` is injectable for tests; production passes process.env. */
export function applyAuthUrl(
  env: Record<string, string | undefined>,
  origin: string = authOrigin(),
): "env" | "site.origin" | "none" {
  if ((env.AUTH_URL ?? "").trim() || (env.NEXTAUTH_URL ?? "").trim()) return "env";
  if (!origin) return "none";
  env.AUTH_URL = origin;
  return "site.origin";
}
