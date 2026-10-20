import type { NextConfig } from "next";
import { existsSync, readdirSync } from "node:fs";
import { contentSecurityPolicy } from "./app/lib/csp";

// Nothing install-specific is read here: the site's name, origins and the rest are read from the
// environment when the server starts (app/lib/installValues.ts), so one build — one image —
// serves every install. A value that changes per install belongs in the proxy (proxy.ts: the
// CSP's origins, the points icon's cache line) or in a request-time page.

// The owner seam: `@owner/<area>` is the install's app/(owner)/<area>.ts when it exists, else the
// empty app/lib/plugins/absent/<area>.ts. One entry per area keeps each page's bundle to the areas
// it reads. tsconfig.json's `@owner/*` paths list the same two folders in the same order (a
// wildcard: Next refuses a fallback list on an exact path), so the type check and the bundler
// resolve alike.
const OWNER_ALIASES = Object.fromEntries(
  readdirSync("./app/lib/plugins/absent").filter((f) => f.endsWith(".ts")).map((f) => [
    `@owner/${f.slice(0, -3)}`,
    existsSync(`./app/(owner)/${f}`) ? `./app/(owner)/${f}` : `./app/lib/plugins/absent/${f}`,
  ]),
);
// The policy for what the proxy never sees (static and public files): no install origins —
// proxy.ts sends the full one, with them, on every page and API response (app/lib/csp.ts).
const CSP = contentSecurityPolicy();

const nextConfig: NextConfig = {
  output: "standalone",
  // Don't advertise the framework/version in a response header (info leak).
  poweredByHeader: false,
  // Turbopack (Next.js 16 default). matrix-js-sdk loads WASM at runtime via fetch, so it needs
  // nothing here. `@owner/*` is the owner seam (app/lib/plugins/): the install's owner folder when
  // it exists, else the empty plugin — the public export has no owner folder.
  turbopack: { resolveAlias: OWNER_ALIASES },
  async redirects() {
    return [
      // /donate and /tip only. /support is deliberately NOT here — that word
      // belongs to the help-desk chat command.
      { source: "/tip", destination: "/donate", permanent: false },
      // The admin pages are sections of the Admin Panel.
      { source: "/mod/ai", destination: "/admin/ai", permanent: true },
      { source: "/mod/credentials", destination: "/admin/site", permanent: true },
    ];
  },
  async rewrites() {
    return {
      // /favicon.ico for a site that has none of its own (a fresh install) is the product's. An
      // afterFiles rewrite runs only when no public/ file answers, so a site that ships its own
      // public/favicon.ico keeps serving exactly that file.
      afterFiles: [{ source: "/favicon.ico", destination: "/brand/favicon.ico" }],
    };
  },
  async headers() {
    return [
      // /.well-known/matrix/* sets its own JSON + CORS headers (app/.well-known/matrix/, built
      // from the matrix.* install config — no static files).
      // The points icon's 30-day cache line (install key currency.icon) is the proxy's: the
      // icon's path is this install's, read at start (proxy.ts).
      {
        // The service worker must never be served stale. Next's static default
        // gives public/ files `public, max-age=14400`, so a fixed sw.js could
        // take up to 4h to reach a browser that already had one — and the SW is
        // what governs the emote cache and PWA installability. Browsers also
        // bypass the HTTP cache for the SW script only when it is <24h old, so
        // relying on that is fragile; say no-store explicitly.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      {
        // A file (anything whose path ends in an extension: the build's static files, public/, the
        // service worker) — exactly what proxy.ts's matcher leaves out. The proxy sends the policy,
        // with this install's origins, on everything else; the two never overlap.
        // Never the Matrix media proxy (MEDIA_PROXY_PREFIX in app/lib/mediaHeaders.ts), even when a
        // download ends in a file name: Next keeps the first CSP set, and that route's sandbox must
        // be the one that arrives.
        source: "/:file((?!api/matrix/media/).*\\.[A-Za-z0-9]+)",
        headers: [{ key: "Content-Security-Policy", value: CSP }],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
