// The Points screen's routes authorize on the server, and the buy switch guards the two quiet-
// purchase paths at their choke point — never a tip.
// Run: node --test app/lib/pointsAdmin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./sourceText.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

test("every /api/admin/points handler checks admin first; the mutation checks same-origin too", () => {
  const dir = join(here, "../api/admin/points");
  const routes = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith("route.ts"))
    .map((p) => ({ path: p, src: stripComments(readFileSync(join(dir, p), "utf8")) }));
  assert.equal(routes.length, 2, `expected the two Points routes, found ${routes.length}`);
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
  assert.equal(handlers, 2, "GET + PUT");
});

const GATE = 'instanceBool("currency.purchasable")';

test("the card top-up refuses when buying is off — BEFORE it signs anyone in or talks to Stripe", () => {
  const src = read("api/billing/points/route.ts");
  const gate = src.indexOf(GATE);
  assert.ok(gate > 0, "no buy-switch check in /api/billing/points");
  assert.ok(gate < src.indexOf("requireUser()"), "the switch is read after the sign-in check");
  assert.ok(gate < src.indexOf("getStripe()"), "the switch is read after Stripe is reached");
  assert.match(src.slice(gate, gate + 200), /status: 403/);
  assert.match(src, /metadata: \{[\s\S]*kind: "coin_purchase"/, "vacuity: the route was read through its checkout params");
});

test("a PayPal points order refuses when buying is off; a PayPal TIP never reads the switch", () => {
  const src = read("api/billing/paypal/order/route.ts");
  const points = src.indexOf('if (purpose === "points") {');
  const gate = src.indexOf(GATE);
  assert.ok(points > 0 && gate > points, "the switch is not inside the points branch");
  assert.ok(gate < src.indexOf("pointsOrders.open("), "the order row is opened before the switch is read");
  assert.equal(src.split(GATE).length - 1, 1, "read once — only for points");
  assert.doesNotMatch(read("api/billing/donate/route.ts"), /currency\.purchasable/, "a tip is not a purchase");
  assert.match(src, /pointsOrders\.open\(\{ matrixId: buyer, cents, fundingSource \}\)/, "vacuity: the points branch was read to its order");
});

test("the public price list carries the buy switch and the clock multiplier the UI shows", () => {
  const src = read("api/store/prices/route.ts");
  assert.match(src, /const purchasable = instanceBool\("currency\.purchasable"\);/);
  assert.match(src, /const \{ clockMultiplier \} = earnRulesFrom\(/);
  assert.match(src, /return Response\.json\(\{ prices, e, purchasable, clockMultiplier \}\);/);
});
