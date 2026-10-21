// The web-side halves the admin, home and moderation work reads: the reader-state
// route (contract 1), the lockdown's checkable platforms (contract 3), the Admin Panel opening on
// Site, the add-space button hidden, the News tab hidden until a feed has items, and the
// help desk's avatar falling back to the site icon.
//
// Run: node --test app/lib/b3Wiring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readIngestHealth } from "./ingestHealth.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("ingest health: the body is read whether ok is true or false (a 503 with a failed reader is the answer)", async () => {
  const failed = { ok: false, readers: { youtube: { state: "failed", since: "2026-10-20T00:00:00Z", error: "browser missing" } }, bot: "off" };
  assert.deepEqual(await readIngestHealth(answer(503, failed), {}), { reachable: true, health: failed });
  const fine = { ok: true, readers: {}, bot: "running" };
  assert.deepEqual(await readIngestHealth(answer(200, fine), {}), { reachable: true, health: fine });
});

test("ingest health: unreachable, or not JSON, reads as { reachable: false } — never throws", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.deepEqual(await readIngestHealth(down, {}), { reachable: false });
  const html = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
  assert.deepEqual(await readIngestHealth(html, {}), { reachable: false });
});

test("ingest health: STREAM_INGEST_URL decides where, else the same box on 3010", async () => {
  const seen: string[] = [];
  const spy = (async (u: string) => { seen.push(u); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  await readIngestHealth(spy, { STREAM_INGEST_URL: "http://stream-ingest:3010/" });
  await readIngestHealth(spy, {});
  assert.deepEqual(seen, ["http://stream-ingest:3010/health", "http://127.0.0.1:3010/health"]);
});

test("the readers route is admin-only and never cached", () => {
  const src = read("app/api/admin/stream/readers/route.ts");
  assert.match(src, /const admin = await requireAdminResponse\(\);\n\s+if \(admin instanceof Response\) return admin;/);
  assert.match(src, /Response\.json\(await readIngestHealth\(\), \{ headers: NO_STORE \}\)/);
});

test("the lockdown GET carries stream-api's checkable platforms (contract 3), null when it does not answer", () => {
  const src = read("app/api/mod/lockdown/route.ts");
  assert.match(src, /streamApiFetch\("\/lockdown\/checkable", undefined, 3000\)/);
  assert.match(src, /\.catch\(\(\) => null\)/);
  assert.match(src, /^\s+checkable,$/m);
});

test("the Admin Panel opens on Site; the add-space button is hidden (W18)", () => {
  assert.match(read("app/(main)/admin/page.tsx"), /redirect\("\/admin\/site"\);/);
  assert.match(read("app/features/community/MatrixView.tsx"), /canAddSpace=\{false\}/);
});

test("the News tab shows only once the remembered Home body has news, in the dock and the chat panel", () => {
  for (const p of ["app/components/BottomDock/index.tsx", "app/features/chat/ChatSidebar.tsx"]) {
    const src = read(p);
    assert.match(src, /const newsHasItems = \(useSyncExternalStore\(subscribeHomeStore, readHomeStore, \(\) => null\)\?\.news\?\.length \?\? 0\) > 0;/, p);
    assert.match(src, /news: newsHasItems,/, p);
  }
});

test("the help desk's avatar falls back to the site icon on both images (W2b)", () => {
  const src = read("app/features/chat/support/SupportPanel.tsx");
  assert.equal(src.match(/<img src=\{BOT_PFP\} onError=\{botPfpFallback\}/g)?.length, 2);
  assert.match(src, /siteIcon\("icon-192\.png"\)/);
  // Vacuity anchor at the END of the file.
  assert.match(src.trimEnd(), /\}$/);
});
