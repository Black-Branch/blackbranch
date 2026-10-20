// One web image for every install. Nothing install-specific may be fixed when the
// site is built — the values are read from env when the server starts (installValues.ts). These
// pins hold the four ways a value could be fixed at build again: an `env` block or a schema read in
// next.config.ts, a page or route prerendered with the values, and the browser reading something
// other than the page's own attribute.
// Run: node --test app/lib/installValues.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const WEB = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(WEB, dir))) {
    const rel = join(dir, name);
    if (statSync(join(WEB, rel)).isDirectory()) filesUnder(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

test("next.config.ts reads no install value and inlines nothing", () => {
  const raw = read("next.config.ts");
  assert.ok(raw.trimEnd().endsWith("export default nextConfig;"), "next.config.ts read whole (anchor)");
  const cfg = stripComments(raw);
  assert.doesNotMatch(cfg, /\benv\s*:/, "an `env` block inlines its values into every bundle at build");
  assert.doesNotMatch(cfg, /instanceSchema|installValues|INSTALL_VALUES|process\.env\.(SITE|MATRIX|LEGAL|CURRENCY)_/, "next.config.ts must not read an install value");
  assert.match(cfg, /contentSecurityPolicy\(\)/, "the files' CSP is the shared policy WITHOUT install origins");
});

test("no page or route is prerendered: nothing is force-static, the root layout waits for a request", () => {
  const files = filesUnder("app");
  assert.ok(files.length > 300, `the scan saw ${files.length} files — too few, it is looking in the wrong place`);
  const fixed = files.filter((f) => /export const dynamic = ["']force-static["']/.test(stripComments(read(f))));
  assert.deepEqual(fixed, [], "a force-static route is built once with whatever env the build had");
  const layout = stripComments(read("app/layout.tsx"));
  assert.match(layout, /export default async function RootLayout[\s\S]*?await connection\(\);/, "the root layout opts every page out of prerendering");
  assert.match(layout, /export function generateMetadata\(\)/, "the root metadata is made per request");
  assert.doesNotMatch(layout, /export const metadata\b/, "a metadata object is evaluated during the build too");
  // The routes with no layout of their own say so themselves.
  for (const f of ["app/robots.ts", "app/sitemap.ts", "app/manifest.ts", "app/opengraph-image.tsx",
    "app/offline.html/route.ts", "app/oauth/client-metadata.json/route.ts", "app/.well-known/matrix/server/route.ts"]) {
    assert.match(stripComments(read(f)), /export const dynamic = "force-dynamic";/, `${f} must be rendered per request`);
  }
});

test("the browser reads the page's own attribute, written on <html> before any script", () => {
  const layout = stripComments(read("app/layout.tsx"));
  assert.match(layout, /<html lang="en" suppressHydrationWarning \{\.\.\.\{ \[INSTALL_ATTRIBUTE\]: installValuesAttribute\(\) \}\}/);
  const reader = stripComments(read("app/lib/installValues.ts"));
  assert.match(reader, /document\.documentElement\?\.getAttribute\(INSTALL_ATTRIBUTE\)/);
  assert.match(reader, /process\.env\.INSTALL_VALUES/, "the server's copy is the env instrumentation published");
  const boot = stripComments(read("instrumentation.ts"));
  const publish = boot.indexOf("publishInstallValues()");
  assert.ok(publish > 0 && publish < boot.indexOf("streamApiBase()") && publish < boot.indexOf("startInstanceConfig()"),
    "the values are published before anything else at boot reads one");
});

test("the proxy sends the CSP with this install's origins, on what next.config's file rule leaves out", () => {
  const proxy = stripComments(read("proxy.ts"));
  // The Matrix media proxy gets its own sandbox instead (mediaProxyCsp.test.ts); every other path the install's policy.
  assert.match(proxy, /withHeader\(await route\(req, ev, path\), "Content-Security-Policy", responseCsp\(path\)\)/);
  assert.match(proxy, /return path\.startsWith\(MEDIA_PROXY_PREFIX\) \? MEDIA_CSP : installCsp\(\);/);
  assert.match(proxy, /api: installValue\("site\.apiOrigin"\), ws: installValue\("site\.apiWsOrigin"\), matrix: installValue\("matrix\.baseUrl"\)/);
  const cfg = stripComments(read("next.config.ts"));
  assert.match(cfg, /source: "\/:file\(\(\?!api\/matrix\/media\/\)\.\*\\\\\.\[A-Za-z0-9\]\+\)",\s*headers: \[\{ key: "Content-Security-Policy", value: CSP \}\]/,
    "next.config sends the CSP only on files (the proxy's matcher leaves them out)");
  assert.match(proxy, /"\/\(\(\?!_next\/static\|_next\/image\|\.\*\\\\\.\[A-Za-z0-9\]\+\$\)\.\*\)"/, "the proxy's matcher: every path but a file");
});

test("the policy carries the install's origins only when given them", async () => {
  const { contentSecurityPolicy } = await import("./csp.ts");
  const files = contentSecurityPolicy();
  const site = contentSecurityPolicy({ api: "https://api.example.tv", ws: "wss://api.example.tv", matrix: "https://matrix.example.tv" });
  const dir = (p: string, n: string) => p.split("; ").find((d) => d.startsWith(`${n} `))!;
  assert.equal(dir(files, "media-src"), "media-src 'self' blob: https://stream.place https://*.stream.place");
  assert.equal(dir(site, "media-src"), "media-src 'self' blob: https://api.example.tv https://stream.place https://*.stream.place");
  assert.equal(dir(site, "connect-src"), "connect-src 'self' https: wss: https://api.example.tv wss://api.example.tv https://matrix.example.tv");
  assert.equal(files.replace(/ https:\/\/api\.example\.tv| wss:\/\/api\.example\.tv| https:\/\/matrix\.example\.tv/g, ""), files);
  assert.equal(site.replace(/ https:\/\/api\.example\.tv| wss:\/\/api\.example\.tv| https:\/\/matrix\.example\.tv/g, ""), files, "the two differ by the origins alone");
});
