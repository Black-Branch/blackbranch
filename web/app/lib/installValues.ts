// The instance's INSTALL-tier values — the site's name, origins, legal details, Matrix sign-in
// client, currency words. Universal: server and client read the same values through installValue().
//
// READ AT START, NOT BUILT IN. Nothing install-specific is in the build, so one web image serves
// every install:
//   • the SERVER resolves them from its environment once, at boot — instrumentation.ts calls
//     publishInstallValues() (installValuesServer.ts) before the first request, which puts the
//     resolved values in process.env.INSTALL_VALUES (one JSON string: every module copy and the
//     proxy read the same process environment);
//   • the BROWSER gets the public ones in the page itself: the root layout writes them as JSON
//     into the <html> element's `data-bb-install` attribute (installValuesAttribute()). The <html>
//     start tag is parsed before anything in <head>, so the values are there before ANY script —
//     an inline <script> would not do: Next puts its async chunk scripts first in <head>, and a
//     cached chunk may run before the parser reaches a script after it;
//   • every page is rendered at request time (the root layout opts out of prerendering), so no
//     page holds the values of the environment it happened to be built in.
// A changed value applies when web restarts.
//
// "" for a key that is unset (or outside a running server — a build, a test that sets none).

export type InstallKey =
  | "site.name" | "site.description" | "site.origin" | "site.apiOrigin" | "site.apiWsOrigin"
  | "site.homeHeading" | "site.homeIntro" | "platform.youtube.vodPlaylist"
  | "site.shortName" | "site.tagline" | "site.iconSet" | "site.legacyId"
  | "legal.operator" | "legal.contactEmail" | "legal.governingLaw" | "legal.effectiveDate"
  | "matrix.serverName" | "matrix.baseUrl" | "matrix.federationServer" | "matrix.legacyNamespace"
  | "matrix.oauth.issuer" | "matrix.oauth.clientId"
  | "discordBridge.usernameTemplate" | "discordBridge.displaynameTemplate"
  | "currency.name" | "currency.namePlural" | "currency.symbol" | "currency.icon" | "community.scoreName";

export type InstallValues = Partial<Record<InstallKey, string>>;

/** The attribute on <html> that carries the public values to the browser. */
export const INSTALL_ATTRIBUTE = "data-bb-install";

function parse(raw: string | null | undefined): InstallValues {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as InstallValues) : {};
  } catch {
    return {};
  }
}

/** The process-wide holder the boot fills alongside process.env.INSTALL_VALUES (server only).
 *  WHY a second place: `next dev` puts process.env back to the environment it started with
 *  (@next/env loadEnvConfig → replaceProcessEnv), which deletes a key added after start — the
 *  published INSTALL_VALUES with it — and every reader then answered "". globalThis is shared by
 *  every module copy in the process and no env reset touches it. `resolve` re-resolves from the
 *  current environment, for when both the holder's copy and the env key are gone.
 *  `next start` never reloads its env, so in production the two always agree. */
export const INSTALL_HOLDER = Symbol.for("blackbranch.installValues");
export type InstallHolder = { raw?: string; resolve?: () => string };
const holder = (): InstallHolder | undefined => (globalThis as Record<symbol, InstallHolder | undefined>)[INSTALL_HOLDER];

// Parsed once per distinct string (a test may set a new one between imports). In the browser the
// page's attribute; on the server the boot's holder, then the published env (a test sets only that),
// then — both gone — a fresh resolve from the environment, kept in the holder.
let seenRaw: string | null | undefined;
let seen: InstallValues = {};
function serverRaw(): string | undefined {
  const h = holder();
  const raw = h?.raw || process.env.INSTALL_VALUES;
  if (raw || !h?.resolve) return raw;
  h.raw = h.resolve();
  return h.raw;
}
function current(): InstallValues {
  const attr = typeof document !== "undefined" ? document.documentElement?.getAttribute(INSTALL_ATTRIBUTE) ?? null : null;
  const raw = attr ?? serverRaw();
  if (raw !== seenRaw) { seenRaw = raw; seen = parse(raw); }
  return seen;
}

/** One install value, or "" when this install has none (a REQUIRED key is never "" in a running
 *  server — web refuses to boot without it; an optional key such as a module's template is ""
 *  whenever its module is off). */
export function installValue(key: InstallKey): string {
  return current()[key] ?? "";
}

/** Every install value this process holds. */
export function installValues(): InstallValues {
  return { ...current() };
}
