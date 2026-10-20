// PWA installability guards.
//
// The bug these pin: the Vanadium (Chromium) install silently reverted while the
// Firefox install survived. Three causes, all structural rather than behavioural,
// so they are guarded by reading the real files rather than by unit tests:
//
//   1. The manifest had NO `id`. Chromium keys an installed app by `id`
//      (defaulting to `start_url` when absent) — so anything that perturbs the
//      resolved start URL can orphan the install. Firefox does not implement
//      `id` at all, which is exactly why one browser broke and the other didn't.
//   2. `navigator.serviceWorker.register` lived inside `usePwaInstall()`, which
//      mounts on only two routes. `/chat`, `/popout`, `/about`, `/legal`
//      and `/billing` therefore had no worker — and no worker means
//      no `navigate` fetch handler, which is Chromium's installability
//      precondition.
//   3. `sw.js` inherited Next's 4h static Cache-Control.
//
// Run: node --test app/lib/pwa.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "./testTsx.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

// The site manifest is GENERATED: app/manifest.ts. These checks read what it produces for an
// install. (The terminal's own manifest and the shortcut to it are this install's plugin:
// app/(owner)/_terminal/pwa.test.ts.)
process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream" });
const siteManifest = (await import("../manifest.ts")).default() as unknown as Record<string, unknown>;

test("manifest declares an explicit id", () => {
  const m = siteManifest;

  assert.ok(
    typeof m.id === "string" && m.id.length > 0,
    "the manifest must declare `id` — without it Chromium derives the app key " +
      "from start_url, and the install can be orphaned by a start_url change"
  );

  // `id` and `start_url` are both resolved against the manifest's own URL. Keeping
  // them equal is what makes the key stable if start_url is ever moved.
  const base = "https://example.tv/";
  assert.equal(
    new URL(m.id as string, base).href,
    new URL(m.start_url as string, base).href,
    "id and start_url should resolve to the same URL"
  );
});

test("manifest still carries the fields Chromium requires to offer an install", () => {
  const m = siteManifest;
  assert.equal(m.display, "standalone");
  for (const key of ["name", "short_name", "start_url", "icons"]) {
    assert.ok(m[key], `manifest lost its \`${key}\``);
  }
  const icons = m.icons as { sizes?: string; purpose?: string }[];
  assert.ok(icons.some((i) => i.sizes === "192x192"), "missing the 192px icon");
  assert.ok(icons.some((i) => i.sizes === "512x512"), "missing the 512px icon");
  assert.ok(icons.some((i) => i.purpose === "maskable"), "missing a maskable icon");
});

test("the service worker is registered from the ROOT layout, on every route", () => {
  const layout = read("app/layout.tsx");
  assert.match(
    layout,
    /import\s+ServiceWorkerRegistrar\s+from\s+["']\.\/components\/ServiceWorkerRegistrar["']/,
    "root layout must import ServiceWorkerRegistrar"
  );
  assert.match(layout, /<ServiceWorkerRegistrar\s*\/>/, "root layout must render ServiceWorkerRegistrar");

  const reg = read("app/components/ServiceWorkerRegistrar.tsx");
  assert.match(
    reg,
    /navigator\.serviceWorker\.register\(\s*["']\/sw\.js["']/,
    "ServiceWorkerRegistrar must actually register /sw.js"
  );
  // The origin's max-age=0 does NOT reach the browser — Cloudflare rewrites it
  // to max-age=14400 at the edge. This flag is the only part of the freshness
  // story we actually control.
  assert.match(
    reg,
    /updateViaCache:\s*["']none["']/,
    "register() must pass updateViaCache:'none' — the CDN overrides the origin's Cache-Control"
  );
});

test("registration has not crept back into a route-scoped hook", () => {
  // The regression this guards is subtle: putting the call back in usePwaInstall
  // still "works" on the home page, so it looks fine in testing and silently
  // drops every other route.
  for (const file of ["app/lib/usePwaInstall.ts", "app/components/PwaInstallNudge.tsx"]) {
    assert.doesNotMatch(
      read(file),
      /serviceWorker\.register\s*\(/,
      `${file} must not register the service worker — the root layout owns that`
    );
  }
});

test("sw.js is served no-cache", () => {
  const cfg = read("next.config.ts");
  // Find the header block whose source is exactly "/sw.js" and check its value.
  const block = cfg.match(/source:\s*["']\/sw\.js["'][\s\S]{0,300}?\]/);
  assert.ok(block, "next.config.ts has no headers() rule for /sw.js");
  assert.match(
    block[0],
    /max-age=0|no-store|no-cache/,
    "the /sw.js rule must defeat the 4h static default"
  );
});
