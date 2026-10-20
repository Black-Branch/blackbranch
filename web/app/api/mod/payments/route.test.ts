import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const src = stripComments(raw);

test("route.ts is whole", () => { assert.ok(raw.trimEnd().endsWith("}")); });

test("gated by requireAdmin(), the mod/setmod/route.ts idiom", () => {
  assert.match(src, /import \{ requireAdmin \} from "@\/app\/lib\/admin"/);
  const gateAt = src.indexOf("const admin = await requireAdmin();");
  assert.ok(gateAt >= 0);
  assert.match(src.slice(gateAt, gateAt + 200), /if \(!admin\) return new Response\([\s\S]*403/);
});

test("must NOT use instanceof Response — requireAdmin() never returns a Response", () => {
  assert.ok(!src.includes("admin instanceof Response"),
    "requireAdmin() returns string | null, not string | Response — this check never fires and the route runs unauthenticated");
});

test("no payer name — the WHO column is site.users.display_name, joined", () => {
  assert.match(src, /SELECT pe\.\*, u\.display_name/);
});

test("received payments come from the support ledger, problems from payment_events", () => {
  assert.match(src, /FROM stream\.support_events se/);
  assert.match(src, /FROM site\.payment_events pe/);
  assert.match(src, /mergePayments\(/);
  assert.match(src, /last30: t \? \{ count: Number\(t\.n\), cents: Math\.round\(Number\(t\.usd \?\? 0\) \* 100\) \} : null,\s*\}\);\s*\}\s*$/, "read to its end");
});
