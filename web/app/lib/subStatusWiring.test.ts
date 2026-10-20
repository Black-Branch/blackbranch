// Wiring for the subscription-status card + gifter ledger.
//
// The copy is unit-tested in supportStatus.test.ts and the grouping in
// giftLedger.test.ts; this file pins the plumbing that feeds them:
//
//   1. migrate-v119 adds site.subscriptions.cancel_at_period_end (default
//      false) and registers itself in public.schema_migrations.
//   2. The billing webhook — the ONLY writer of subscription state — stores
//      Stripe's cancel_at_period_end on every sync. Without it, a viewer who
//      switched renewal off in the portal reads "Renews <date>" until the day
//      access ends, and the panel's "Access ends" branch can never render
//      (status only becomes "canceled" once tier is already null).
//   3. /api/me carries the flag and who the current gift came from.
//   4. GET /api/billing/gifts is auth-gated and read-only.
//   5. SupportContent renders the status line and the ledger, and refreshes
//      the ledger when a gift checkout finishes.
//
// Run: node --test app/lib/subStatusWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

// The migration history (migrations/schema.sql + migrate-vN.sql) is the private repo's; a public
// tree starts from migrations/baseline/. A test of what one migration wrote runs where the history is.
const CHAIN = existsSync(join(process.cwd(), "..", "migrations", "schema.sql"));
const HISTORY = CHAIN ? false : "reads the migration history, which this tree does not carry";

const web = process.cwd();
const read = (p: string) => readFileSync(join(web, p), "utf8");

test("1: migrate-v119 adds the renewal-off flag, additively, and tracks itself", { skip: HISTORY }, () => {
  const sql = read("../migrations/migrate-v119.sql");
  assert.match(sql, /ON CONFLICT DO NOTHING;\s*$/, "END of migrate-v119.sql not read / tracking insert missing");
  const s = sql.replace(/^\s*--.*$/gm, "");
  assert.match(s, /ALTER TABLE site\.subscriptions\s+ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;/,
    "the column must be additive with a default so the deploy order (migration → web) never breaks a running webhook");
  assert.match(s, /INSERT INTO public\.schema_migrations \(version, note\)\s*VALUES \(119,/, "v119 must register itself");
  assert.doesNotMatch(s, /DROP |kick/i, "v119 must not fold in the parked v118 Kick-column drop");
});

test("2: the webhook's subscription writer stores Stripe's cancel_at_period_end in the same upsert as status", () => {
  // The upsert lives in subscriptionSync.ts (external review S3), imported by the
  // webhook route and nothing else — pinned in "2b" below.
  const src = read("app/lib/subscriptionSync.ts");
  assert.match(src, /export const syncSubscriptionState = bound\.syncSubscription;\s*$/, "END of subscriptionSync.ts not read");
  const s = stripComments(src);
  const start = s.indexOf("async function writeState(");
  assert.ok(start > 0, "writeState not found");
  const fn = s.slice(start, s.indexOf("\n  }\n", start));
  const insert = fn.indexOf("INSERT INTO site.subscriptions");
  assert.ok(insert > 0, "the upsert is gone");
  const upsert = fn.slice(insert, fn.indexOf("RETURNING matrix_id", insert));
  assert.match(upsert, /\(matrix_id, stripe_customer_id, stripe_sub_id, tier, status, current_period_end, cancel_at_period_end, updated_at, stripe_event_at\)/,
    "the column list must name cancel_at_period_end");
  assert.match(upsert, /cancel_at_period_end = EXCLUDED\.cancel_at_period_end,/, "…and the ON CONFLICT branch must update it");
  assert.match(fn, /sub\.cancel_at_period_end/, "the value is Stripe's own flag, not a guess from status");
  // Still ONE writer: nothing else in web touches the column.
  const others = ["app/lib/billingServer.ts", "app/lib/giftServer.ts", "app/api/billing/portal/route.ts", "app/api/billing/checkout/route.ts"];
  for (const f of others) {
    const o = stripComments(read(f));
    assert.match(o, /\}\s*$/, `END of ${f} not read`);
    assert.doesNotMatch(o, /cancel_at_period_end/, `${f} must not write the flag — the webhook is the only writer`);
  }
});

test("2b: the subscription writer has ONE importer, the billing webhook route", () => {
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(web, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(e.name) || /\.test\.(ts|tsx|mjs)$/.test(e.name)) continue;
      if (rel === "app/lib/subscriptionSync.ts") continue;
      if (/["'][^"']*\/subscriptionSync(\.ts)?["']/.test(stripComments(read(rel)))) importers.push(rel);
    }
  };
  walk("app");
  walk("lib");
  assert.ok(importers.length > 0, "found no importer at all — this scan is measuring nothing");
  assert.deepEqual(importers, ["app/api/billing/webhook/route.ts"],
    "only the billing webhook may write subscription tier/status");
});

test("3: /api/me returns the flag and who the current gift came from", () => {
  const src = read("app/api/me/route.ts");
  assert.match(src, /return raw\.startsWith\("@"\) \? matrixLocalpart\(raw\) : raw;\s*\}\s*$/, "END of /api/me not read (giftFromDisplay is the last construct)");
  const s = stripComments(src);
  assert.match(s, /s\.cancel_at_period_end/, "the SELECT must read the column");
  assert.match(s, /subCancelAtPeriodEnd: subActive && Boolean\(rows\[0\]\?\.cancel_at_period_end\),/,
    "the flag is only meaningful while the sub is active — a stale true on a lapsed row must not say 'renewal is off'");
  // The gift's giver: the latest active gift, anonymous → null, decided in SQL.
  assert.match(s, /CASE WHEN g\.anonymous THEN NULL ELSE COALESCE\(gu\.display_name, g\.gifter_matrix_id\) END/,
    "the giver's name is withheld in SQL when the gift was anonymous");
  assert.match(s, /ORDER BY g\.expires_at DESC LIMIT 1\) AS gift_from/, "…for the gift that ends last, i.e. the one the status line is about");
  assert.match(s, /giftFrom: giftFromDisplay\(rows\[0\]\?\.gift_from\),/, "and returned as giftFrom");
  assert.match(s, /function giftFromDisplay\([\s\S]*?matrixLocalpart\(/, "a raw @id (no display name) is shortened to the local part");
});

test("4: GET /api/billing/gifts is auth-gated, read-only, and answers from loadGiftLedger", () => {
  const src = read("app/api/billing/gifts/route.ts");
  assert.match(src, /\}\s*$/, "END of the gifts route not read");
  const s = stripComments(src);
  assert.match(s, /export async function GET\(/);
  assert.match(s, /const matrixId = await requireUser\(\);\s*if \(typeof matrixId !== "string"\) return matrixId;/, "auth-gated like every billing route");
  assert.match(s, /return Response\.json\(await loadGiftLedger\(matrixId\)\);/, "the route is a thin read");
  assert.doesNotMatch(s, /INSERT|UPDATE|DELETE|pool\./, "read-only: no SQL of its own");
});

test("5: SupportContent shows the status line, the ledger, and refreshes the ledger after a gift checkout", () => {
  const src = read("app/components/SupportContent.tsx");
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "END of SupportContent.tsx not read");
  const s = stripComments(src);
  assert.match(s, /import \{ subscriptionStatusLine, giftPurchaseLine, giftReceivedLine, type GiftPurchaseView, type GiftReceivedView \} from "@\/app\/lib\/supportStatus";/);
  assert.doesNotMatch(s, /giftLedgerServer/, "the client must never import the pool-backed module, not even for a type");
  // The old two lines are gone — one status line replaces both.
  assert.doesNotMatch(s, /"Access ends" : "Renews"/, "the unreachable 'Access ends' branch is replaced");
  assert.doesNotMatch(s, /Supporter via gift\s*\{/, "the old gift line is replaced by the status line");
  assert.match(s, /const status = me \? subscriptionStatusLine\(me\) : null;/);
  // Both boolean/flag fields ride on the Me type so a stale client can't crash.
  assert.match(s, /subCancelAtPeriodEnd: d\.subCancelAtPeriodEnd \?\? false,/);
  assert.match(s, /giftFrom: d\.giftFrom \?\? null,/);
  // Ledger: fetched on mount of the gift section, listed newest first (server order), only when non-empty.
  assert.match(s, /getJson<\{ given\?: GiftPurchaseView\[\]; received\?: GiftReceivedView\[\] \}>\("\/api\/billing\/gifts", \{ cache: "no-store" \}\)/);
  assert.match(s, /\{ledger && ledger\.given\.length > 0 && \(/, "the given list renders only when there is something to show");
  assert.match(s, /Gifts you.ve given/);
  assert.match(s, /giftPurchaseLine\(p\)/);
  assert.match(s, /\{ledger && ledger\.received\.length > 0 && \(/, "the received list renders only when there is something to show");
  assert.match(s, /Gifts you.ve received/);
  // A finished gift checkout refreshes the ledger, so "Back" shows the new gift.
  assert.match(s, /onComplete: \(\) => \{\s*setView\("done"\);\s*if \(mode === "subscription"\) refreshMe\(\);\s*if \(mode === "gift"\) refreshLedger\(\);/,
    "a gift checkout must refresh the ledger on completion");
});
