// The Matrix media proxy's sandbox CSP must be the one a browser receives. Next keeps the FIRST
// Content-Security-Policy set on a response (send-response.js appends a handler's header only when
// none is present), so if proxy.ts or next.config.ts's file rule gives the media path the site's
// policy — which allows inline script — the route's sandbox never arrives. Both did.
//
// proxy.ts and next.config.ts import modules node --test cannot resolve (@/auth, extensionless
// paths), so: proxy.ts is scanned, and next.config.ts's file-rule pattern is run through Next's own
// path matcher — the same getPathMatch(…, { strict, removeUnnamedParams }) Next builds header
// routes with — so the test asks Next, not a regex of ours, which paths the rule covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stripComments } from "./testSource.ts";
import { MEDIA_CSP, MEDIA_PROXY_PREFIX } from "./mediaHeaders.ts";

const root = join(import.meta.dirname, "..", "..");
const proxyRaw = readFileSync(join(root, "proxy.ts"), "utf8");
const proxySrc = stripComments(proxyRaw);
const configRaw = readFileSync(join(root, "next.config.ts"), "utf8");
const configSrc = stripComments(configRaw);

const require = createRequire(import.meta.url);
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match.js") as {
  getPathMatch: (source: string, o: { strict: boolean; removeUnnamedParams: boolean }) => (p: string) => unknown;
};

test("END anchors: both files were read whole", () => {
  assert.match(proxyRaw, /matcher: \[[\s\S]*\],\n\};\n$/, "proxy.ts truncated");
  assert.match(configRaw, /export default nextConfig;\n$/, "next.config.ts truncated");
});

test("proxy.ts sends the media sandbox, not the site policy, on the media proxy's path", () => {
  assert.match(proxySrc, /return withHeader\(await route\(req, ev, path\), "Content-Security-Policy", responseCsp\(path\)\);/);
  assert.match(proxySrc, /function responseCsp\(path: string\): string \{\s*return path\.startsWith\(MEDIA_PROXY_PREFIX\) \? MEDIA_CSP : installCsp\(\);\s*\}/);
  assert.match(proxySrc, /import \{ MEDIA_CSP, MEDIA_PROXY_PREFIX \} from "@\/app\/lib\/mediaHeaders";/);
  // The site policy is sent nowhere else.
  assert.equal(proxySrc.match(/installCsp\(\)(?!:)/g)?.length, 1);
  assert.equal(MEDIA_CSP, "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
});

/** next.config.ts's file rule: the `source` of the entry that sets the site CSP. */
function fileRuleSource(): string {
  const m = /source: ("[^"\n]+"),\s*headers: \[\{ key: "Content-Security-Policy", value: CSP \}\]/.exec(configSrc);
  assert.ok(m, "next.config.ts has no file rule setting the CSP — the scan is reading the wrong text");
  return JSON.parse(m[1]!) as string;
}

test("next.config.ts's file rule never covers the media proxy, and still covers every other file", () => {
  const match = getPathMatch(fileRuleSource(), { strict: true, removeUnnamedParams: true });
  for (const p of [
    `${MEDIA_PROXY_PREFIX}download/hs.test/abc123/evil.html`,
    `${MEDIA_PROXY_PREFIX}download/hs.test/abc123/a.png`,
    `${MEDIA_PROXY_PREFIX}download/hs.test/abc123/feed.rss`,
  ]) assert.equal(match(p), false, `${p} gets the site CSP — the route's sandbox would be dropped`);
  for (const p of ["/sw.js", "/brand/favicon.ico", "/_next/static/chunks/main.js", "/manifest.webmanifest", "/api/matrix/mediax/a.js"]) {
    assert.notEqual(match(p), false, `${p} lost the site CSP`);
  }
});

test("no other next.config.ts rule sets a CSP", () => {
  assert.equal(configSrc.match(/"Content-Security-Policy"/g)?.length, 1);
});
