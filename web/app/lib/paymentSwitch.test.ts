// Switching a payment provider off asks first, with the count (A1-06, KG-03; k-questions Q1 default:
// no change to entitlement).
//
// The Stripe / PayPal module switch saved at one tap. Switching it off ends every one of that
// provider's subscribers' Supporter perks at once (subscriptions/entitlement.ts drops a provider
// whose module is off) while the provider keeps charging them, and the only line saying so sat
// behind a closed Details fold. Now the save refuses a switch-off while that provider entitles
// anyone, unless the request confirms the count it was shown; the panel asks with the count and
// says what to cancel at the provider first. Entitlement itself is unchanged.
//
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/paymentSwitch.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { paymentConfirmParam, paymentSwitchClear, paymentSwitchOff, paymentSwitchRefusal, paymentSwitchWarning } from "./paymentSwitch.ts";
import { entitledCountFor } from "./subscriptions/entitlement.ts";
import { writeTransition } from "./subscriptions/state.ts";
import type { Observation } from "./subscriptions/types.ts";
import { stripComments } from "./testSource.ts";

test("only switching a payment provider OFF is a switch-off", () => {
  assert.equal(paymentSwitchOff("modules.stripe", false), "stripe");
  assert.equal(paymentSwitchOff("modules.paypal", false), "paypal");
  assert.equal(paymentSwitchOff("modules.stripe", true), null, "switching on asks nothing");
  assert.equal(paymentSwitchOff("modules.radio", false), null, "not a payment provider");
  assert.equal(paymentSwitchOff("modules.stripe", "false"), null, "the value is a boolean; anything else is refused by the writer");
});

test("a switch-off with running subscribers is refused unless the request confirms that count", () => {
  assert.deepEqual(paymentSwitchRefusal("stripe", 33, undefined), { error: "confirm_payment_switch", needConfirm: true, provider: "stripe", count: 33 });
  assert.deepEqual(paymentSwitchRefusal("stripe", 33, 32), { error: "confirm_payment_switch", needConfirm: true, provider: "stripe", count: 33 },
    "a count that moved since the panel asked is asked again");
  assert.equal(paymentSwitchRefusal("stripe", 33, 33), null);
  assert.equal(paymentSwitchRefusal("paypal", 0, undefined), null, "nobody to warn about: the switch saves at once");
});

test("the warning names the count, that perks end now, that billing continues, and where to cancel", () => {
  const s = paymentSwitchWarning("stripe", 33);
  assert.match(s, /33 subscribers/);
  assert.match(s, /perks end now/);
  assert.match(s, /Stripe keeps charging them/);
  assert.match(s, /Stripe Dashboard → Billing → Subscriptions/);
  assert.match(paymentSwitchWarning("paypal", 1), /^1 subscriber /);
  assert.match(paymentSwitchWarning("paypal", 1), /PayPal keeps charging them/);
});

// W4 R2: "Clear saved" beside the switch removes the stored value, and on a fresh install the switch
// then falls back to its default, OFF — the same perks-end-while-billed outcome by a second button.
// A clear of a payment switch that is ON now takes the same confirm.
test("clearing a payment switch that is on is a switch-off; anything else is not", () => {
  assert.equal(paymentSwitchClear("modules.stripe", true), "stripe");
  assert.equal(paymentSwitchClear("modules.paypal", true), "paypal");
  assert.equal(paymentSwitchClear("modules.stripe", false), null, "already off: a clear cannot end anyone's perks");
  assert.equal(paymentSwitchClear("modules.radio", true), null);
  assert.equal(paymentConfirmParam(new URL("https://site.test/api/admin/instance/modules.stripe?confirm=33")), 33);
  assert.equal(paymentConfirmParam(new URL("https://site.test/api/admin/instance/modules.stripe")), undefined);
  assert.equal(paymentConfirmParam(new URL("https://site.test/x?confirm=abc")), undefined);
});

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");

test("wiring: Clear saved goes through the same check before the value is removed, and asks with the count", () => {
  const route = stripComments(read("app/api/admin/instance/[key]/route.ts"));
  const del = route.slice(route.indexOf("export async function DELETE("));
  const check = del.indexOf("paymentSwitchClear(name, instanceBool(name))");
  const clear = del.indexOf("clearInstanceValue(name, admin)");
  assert.ok(check > 0 && clear > 0 && check < clear, "the check runs before the saved value is removed");
  assert.match(del, /paymentSwitchRefusal\(off, await entitledCountFor\(pool, off\), paymentConfirmParam\(req\.nextUrl\)\)/);
  const cards = stripComments(read("app/features/instance/KeyCards.tsx"));
  const fn = cards.slice(cards.indexOf("async function clear("), cards.indexOf("async function find("));
  assert.match(fn, /window\.confirm\(paymentSwitchWarning\(j\.provider, j\.count\)\)/);
  assert.match(fn, /return clear\(j\.count\);/, "the confirmed retry sends the count it showed");
  assert.doesNotMatch(cards, /onClick=\{clear\}/, "a bare onClick would hand the click event in as the confirmed count");
  assert.match(cards.trimEnd(), /\}$/, "vacuity anchor: the panel file was read to its end");
});

test("wiring: the save route refuses before writing, and the panel asks with the count", () => {
  const route = stripComments(read("app/api/admin/instance/[key]/route.ts"));
  const off = route.indexOf("paymentSwitchOff(name, body.value)");
  const write = route.indexOf("writeInstanceValue(name, body.value, admin)");
  assert.ok(off > 0 && write > 0 && off < write, "the switch-off check runs before the value is written");
  assert.match(route, /paymentSwitchRefusal\(off, await entitledCountFor\(pool, off\), body\.confirm\)/);
  const cards = stripComments(read("app/features/instance/KeyCards.tsx"));
  assert.match(cards, /j\.needConfirm && j\.provider && typeof j\.count === "number"/);
  assert.match(cards, /window\.confirm\(paymentSwitchWarning\(j\.provider, j\.count\)\)/);
  assert.match(cards, /return put\(value, done, j\.count\);/, "the confirmed retry sends the count it showed");
  // Vacuity anchor at the END of the panel file.
  assert.match(cards.trimEnd(), /\}$/);
});

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

test("the count is the provider's entitling records, through the one fragment", { skip }, async () => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const RUN = `pswitch${process.pid}x${Date.now().toString(36)}`;
  const end = new Date(Date.now() + 20 * 86_400_000);
  const who = [`@${RUN}-a:site.test`, `@${RUN}-b:site.test`, `@${RUN}-c:site.test`];
  const obs = (provider: "stripe" | "paypal", id: string, status: Observation["status"]): Observation => ({
    provider, externalId: id, tier: "supporter", status, providerStatus: status === "active" ? "active" : "canceled",
    renews: status === "active", periodEnd: end, accessUntil: end, observedAt: new Date(),
  });
  try {
    const before = { stripe: await entitledCountFor(pool, "stripe"), paypal: await entitledCountFor(pool, "paypal") };
    await pool.query(`INSERT INTO site.users (matrix_id) SELECT unnest($1::text[])`, [who]);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await writeTransition(c, { via: "webhook", viewer: who[0]!, observations: [obs("stripe", `sub_${RUN}_a`, "active")], sources: ["stripe", "paypal"] });
      await writeTransition(c, { via: "webhook", viewer: who[1]!, observations: [obs("stripe", `sub_${RUN}_b`, "ended")], sources: ["stripe", "paypal"] });
      await writeTransition(c, { via: "webhook", viewer: who[2]!, observations: [obs("paypal", `I-${RUN}_c`, "active")], sources: ["stripe", "paypal"] });
      await c.query("COMMIT");
    } finally { c.release(); }
    assert.equal(await entitledCountFor(pool, "stripe") - before.stripe, 1, "an ended record is not a running subscriber");
    assert.equal(await entitledCountFor(pool, "paypal") - before.paypal, 1);
  } finally {
    await pool.query(`DELETE FROM site.subscription_records WHERE matrix_id = ANY($1::text[])`, [who]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1::text[])`, [who]);
    await pool.end();
  }
});
