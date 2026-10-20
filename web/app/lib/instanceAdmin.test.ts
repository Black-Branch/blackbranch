// The Admin Panel's key cards — server side: the view carries status and never
// a value, a mutation must be same-origin, and EVERY admin route authorizes on the server.
// Run: node --test app/lib/instanceAdmin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./testInstallValues.ts";
import { buildInstanceView, sameOriginRequest, type StreamApiSnapshot } from "./instanceAdminView.ts";
import { stripComments } from "./testSource.ts";

const PLANTED = "sk_live_PLANTED-SECRET-MUST-NOT-APPEAR-zz99";

test("the view is status only: a planted secret in the process env appears nowhere in it", () => {
  const prior = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = PLANTED;
  try {
    const snap: StreamApiSnapshot = {
      state: { loaded: true, loadedAt: "2026-10-06T12:00:00.000Z", failingSince: null, masterKey: "ok" },
      values: { "bot.matrixId": "@bot:example.tv" },
      meta: { "bot.matrixId": { updatedBy: "@admin:example.tv", updatedAt: "2026-10-06T11:00:00.000Z" } },
      secrets: { "anthropic.apiKey": { last4: "abcd", updatedBy: "@admin:example.tv", updatedAt: "2026-10-06T11:00:00.000Z", readable: true, error: null } },
      self: {
        "anthropic.apiKey": { source: "database", envName: null, display: "…abcd", error: null },
        "bot.matrixId": { source: "database", envName: null, display: "@bot:example.tv", error: null },
      },
      reports: {
        "stream-ingest": {
          at: "2026-10-06T12:00:00.000Z",
          state: { loaded: true, loadedAt: "2026-10-06T12:00:00.000Z", failingSince: null },
          keys: { "anthropic.apiKey": { source: "env", envName: "ANTHROPIC_API_KEY", display: "…wxyz", error: null } },
        },
      },
      tests: [{ key: "anthropic.apiKey", package: "stream-api", testedAt: "2026-10-06T12:00:00.000Z", ok: true, detail: "accepted — 3 listed", source: "database", last4: "abcd" }],
    };
    const view = buildInstanceView(snap);
    const text = JSON.stringify(view);
    assert.ok(!text.includes("PLANTED"), "a secret value reached the admin view");
    const stripe = view.keys.find((k) => k.key === "stripe.secretKey")!;
    assert.deepEqual(stripe.packages, [{ package: "web", known: true, source: "env", envName: "STRIPE_SECRET_KEY", display: "…zz99", error: null, envOverrides: true }]);
    const ant = view.keys.find((k) => k.key === "anthropic.apiKey")!;
    assert.deepEqual(ant.packages.map((p) => [p.package, p.source, p.display]), [["stream-api", "database", "…abcd"], ["stream-ingest", "env", "…wxyz"]]);
    assert.equal(ant.disagree, true, "two processes holding different credentials must be flagged");
    assert.deepEqual(ant.stored, { display: "…abcd", updatedBy: "@admin:example.tv", updatedAt: "2026-10-06T11:00:00.000Z", readable: true, error: null });
    assert.equal(ant.tests[0]!.detail, "accepted — 3 listed");
    const origin = view.keys.find((k) => k.key === "site.origin")!;
    assert.equal(origin.packages[0]!.source, "env", "an install key is read from env at boot — nothing is built in");
    assert.equal(view.processes.find((p) => p.package === "stream-ingest")!.reachable, true);
  } finally {
    if (prior === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prior;
  }
});

test("stream-api unreachable: its half and stream-ingest's are shown as NOT reporting, not as unset", () => {
  const view = buildInstanceView(null);
  const p = view.processes.find((x) => x.package === "stream-api")!;
  assert.equal(p.reachable, false);
  const ant = view.keys.find((k) => k.key === "anthropic.apiKey")!;
  assert.ok(ant.packages.every((x) => x.known === false));
});

test("same-origin: Sec-Fetch-Site decides when present; else Origin must be the site's; else refused", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(sameOriginRequest(h({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOriginRequest(h({ "sec-fetch-site": "same-site" })), false);
  assert.equal(sameOriginRequest(h({ "sec-fetch-site": "cross-site", origin: "https://example.tv" })), false);
  assert.equal(sameOriginRequest(h({ origin: "https://example.tv" })), true);
  assert.equal(sameOriginRequest(h({ origin: "https://evil.example" })), false);
  assert.equal(sameOriginRequest(h({})), false, "no header at all is refused");
});

// ── every route authorizes on the SERVER ─────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = join(here, "../api/admin/instance");
const routes = readdirSync(ADMIN_DIR, { recursive: true, encoding: "utf8" })
  .filter((p) => p.endsWith("route.ts"))
  .map((p) => ({ path: p, src: stripComments(readFileSync(join(ADMIN_DIR, p), "utf8")) }));

test("every /api/admin/instance handler checks admin first; every MUTATION checks same-origin too", () => {
  assert.equal(routes.length, 3, `expected the three admin routes, found ${routes.length}`);
  let handlers = 0;
  for (const { path, src } of routes) {
    for (const m of src.matchAll(/export async function (GET|PUT|DELETE|POST)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
      handlers++;
      const [, method, body] = m;
      const firstLine = body!.trim().split("\n")[0]!;
      if (method === "GET") assert.match(firstLine, /await requireAdminResponse\(\)/, `${path} GET does not start with the admin check`);
      else assert.match(firstLine, /await requireAdminMutation\(req\)/, `${path} ${method} does not start with the admin + same-origin check`);
      assert.match(body!, /if \(admin instanceof Response\) return admin;/, `${path} ${method} ignores the refusal`);
    }
  }
  assert.equal(handlers, 4, "GET + PUT + DELETE + POST");
});

test("the Admin Panel page is admin-gated on the server, and its key cards import no server module", () => {
  const page = stripComments(readFileSync(join(here, "../(main)/admin/[section]/page.tsx"), "utf8"));
  assert.match(page, /if \(!\(await requireAdmin\(\)\)\) redirect\("\/"\);/);
  for (const file of ["KeyCards.tsx", "AdminPanel.tsx", "PointsPanel.tsx"]) {
    const panel = readFileSync(join(here, `../features/instance/${file}`), "utf8");
    assert.match(panel, /^"use client";/, `${file} is not a client module`);
    for (const m of panel.matchAll(/^import (type )?[^;]*from "([^"]+)";/gm)) {
      if (m[1]) continue; // type-only: erased
      assert.ok(!/Server|instanceAdminView|lib\/db/.test(m[2]!), `${file} imports ${m[2]} at runtime`);
    }
    assert.match(panel, /^export default function (KeyCards|AdminPanel|PointsPanel)/m, `vacuity: ${file} was read to its end`);
  }
});
