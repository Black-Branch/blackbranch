// The writer invariant of subscription sources (decision D2, spec §4.2, §6, §13.1), held over the
// whole web tree:
//   1. the transition function (state.ts) is imported by exactly an allowlist of files, each a
//      provider-verified path — the Stripe reconciler (S1) and the PayPal adapter (S3), whose
//      writing entry points are reached only from the PayPal webhook after its signature check
//      and from its own re-check; the viewer's PayPal routes reach only the functions that write
//      an intent or nothing;
//   2. no other file writes site.subscription_records — except account deletion's DELETE of the
//      records of services the site does not bill (the person's data going, not a transition);
//   3. every SQL reader of the table outside the writer, the viewer's own listing and deletion's
//      "still bills" goes through the one fragment, entitledRecordsSql — and the readers S1 moved
//      no longer read entitlement from the legacy row.
// The subscriptionSync.ts "2b" pin (subStatusWiring.test.ts) still holds that the Stripe
// reconciler's only importer is the webhook route.
//
// Each tree scan ends in a deepEqual against the exact expected set (a positive assertion: a short
// read or a missed file changes the set and fails). The two negative scans of single files are
// anchored on the END of the file they read.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../testSource.ts";

const web = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");

/** Every non-test source file under app/ and lib/, as web-relative paths. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(web, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(e.name) || /\.test\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
      out.push(rel);
    }
  };
  walk("app");
  walk("lib");
  return out;
}

const ALL = sources();

test("the scan read the tree (vacuity)", () => {
  assert.ok(ALL.length > 300, `only ${ALL.length} source files found`);
  assert.ok(ALL.includes("app/lib/subscriptions/state.ts") && ALL.includes("app/api/billing/webhook/route.ts"));
});

test("1: the transition function is imported only by provider-verified paths (the allowlist)", () => {
  const importers = ALL.filter((f) => f !== "app/lib/subscriptions/state.ts"
    && /["'][^"']*subscriptions\/state(\.ts)?["']|["']\.\/state(\.ts)?["']/.test(stripComments(read(f)))
    && (f.startsWith("app/lib/subscriptions/") || /subscriptions\/state/.test(stripComments(read(f)))));
  // S2 adds its drain and link callback here, each with the provider check that guards it.
  assert.deepEqual(importers.sort(), ["app/lib/subscriptionSync.ts", "app/lib/subscriptions/paypal.ts"]);
  // …and that importer runs only behind Stripe's signature check: the route verifies before its switch.
  const route = stripComments(read("app/api/billing/webhook/route.ts"));
  assert.ok(route.indexOf("stripe.webhooks.constructEvent(raw, sig, secret)") > 0);
  assert.ok(route.indexOf("stripe.webhooks.constructEvent(raw, sig, secret)") < route.indexOf("switch (event.type)"), "the reconciler runs only after verification");
});

test("1 (S3): the PayPal adapter writes only from the verified webhook and its re-check; the viewer's routes cannot reach a write", () => {
  const raw = read("app/lib/subscriptions/paypal.ts");
  assert.match(raw, /setInterval\(run, RECHECK_EVERY_MS\);\s*\}\s*$/, "END of paypal.ts not read");
  const s = stripComments(raw);
  // writeTransition is called in ONE place, observe(); observe is reached from the webhook
  // handlers and the re-check only — never from offer, startSubscribe or cancel.
  assert.equal([...s.matchAll(/\bwriteTransition\(/g)].length, 1);
  const at = (name: string) => s.search(new RegExp(`async function ${name}[(<]`));
  const body = (name: string, next: string) => s.slice(at(name), at(next));
  assert.match(body("observe", "onSubscriptionEvent"), /await writeTransition\(client, \{/);
  for (const [fn, next] of [["offer", "startSubscribe"], ["startSubscribe", "cancel"], ["cancel", "recheck"]] as const) {
    const b = body(fn, next);
    assert.ok(b.length > 200, `${fn} not found`);
    assert.doesNotMatch(b, /observe\(|writeTransition|recordSale|site\.subscription_records\s+SET|INSERT INTO site\.subscription_records/, `${fn} must never write a record`);
  }
  // The viewer's routes import only the viewer's functions.
  for (const f of ["app/api/billing/paypal/subscription/route.ts", "app/api/billing/paypal/subscription/cancel/route.ts"]) {
    const r = stripComments(read(f));
    const names = [...r.matchAll(/import \{([^}]*)\} from "@\/app\/lib\/subscriptions\/paypal"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()).filter(Boolean));
    assert.ok(names.length > 0, `${f} imports nothing from the adapter`);
    for (const n of names) assert.ok(["paypalSubscriptionOffer", "startPaypalSubscription", "cancelPaypalSubscriptions"].includes(n), `${f} imports ${n}`);
  }
  // The webhook route dispatches to the adapter only after verify-webhook-signature said SUCCESS.
  const hook = stripComments(read("app/api/billing/paypal/webhook/route.ts"));
  const verified = hook.indexOf("if (!verified)");
  assert.ok(verified > 0 && verified < hook.indexOf("switch (event.event_type)"));
  for (const h of ["onPaypalSubscriptionEvent(event)", "onPaypalSaleCompleted(event)", "onPaypalSaleRefunded(event)", "onPaypalSaleReversed(event)", "onPaypalSaleDisputeResolved(event)"]) {
    assert.ok(hook.indexOf(h) > hook.indexOf("switch (event.event_type)"), `${h} must be inside the verified switch`);
  }
});

test("2: nothing but the transition function writes site.subscription_records (deletion's DELETE excepted)", () => {
  const writers: Record<string, string[]> = {};
  for (const f of ALL) {
    const s = stripComments(read(f));
    const kinds = [...s.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+site\.subscription_records\b/g)].map((m) => m[1]!);
    if (kinds.length) writers[f] = kinds;
  }
  assert.deepEqual(writers, {
    "app/lib/subscriptions/state.ts": ["INSERT INTO"],
    "app/lib/accountDeletion.ts": ["DELETE FROM"],
  });
  // The INSERT is inside writeTransition, the one writer.
  const state = read("app/lib/subscriptions/state.ts");
  assert.match(state, /export const applyTransition = bound\.applyTransition;\s*$/, "END of state.ts not read");
  const s = stripComments(state);
  const fn = s.slice(s.indexOf("export async function writeTransition("), s.indexOf("export function createSubscriptionState("));
  assert.match(fn, /INSERT INTO site\.subscription_records/, "the INSERT moved out of writeTransition");
  // Deletion removes only the records of services the site does not bill.
  const del = stripComments(read("app/lib/accountDeletion.ts"));
  assert.match(del, /DELETE FROM site\.subscription_records WHERE matrix_id = \$1 AND provider <> ALL\(\$2::text\[\]\)`, \[matrixId, BILLED_PROVIDERS\]/);
});

test("3: every SQL reader of the records uses the one fragment; the moved readers left the legacy row", () => {
  const readers = ALL.filter((f) => /\bsubscription_records\b/.test(stripComments(read(f)))).sort();
  assert.deepEqual(readers, [
    "app/lib/accountDeletion.ts",              // the erase (writer test above)
    "app/lib/billingServer.ts",                // the badge re-point — through entitledRecordsSql
    "app/lib/subscriptions/entitlement.ts",    // the fragment's home, the viewer's own listing, still-bills
    "app/lib/subscriptions/paypal.ts",         // the PayPal adapter: records by key, same-service, re-check pick — never entitlement
    "app/lib/subscriptions/state.ts",          // the writer
  ]);
  // "Already a Supporter elsewhere" is entitlement, so it is the fragment's.
  const elsewhere = stripComments(read("app/lib/subscriptions/entitlement.ts"));
  assert.match(elsewhere.slice(elsewhere.indexOf("export async function entitledElsewhere(")), /^[\s\S]*?\$\{entitledRecordsSql\("r", "\$2"\)\}/);
  const ent = stripComments(read("app/lib/subscriptions/entitlement.ts"));
  for (const name of ["ENTITLED_VIEWERS_SQL", "VIEWER_TIERS_SQL"]) {
    const at = ent.indexOf(`export const ${name} =`);
    assert.ok(at > 0, `${name} is gone`);
    assert.match(ent.slice(at, ent.indexOf(";", at)), /entitledRecordsSql\("r", "\$\d"\)/, `${name} must be built from the fragment`);
  }
  assert.match(ent.slice(ent.indexOf("export function viewerEntitledSql(")), /^[\s\S]*?entitledRecordsSql\("r", sourcesParam\)/);
  assert.match(stripComments(read("app/lib/billingServer.ts")), /FROM site\.subscription_records r\s+WHERE \$\{entitledRecordsSql\("r", "\$2"\)\}/);

  // Each moved reader imports the fragment's module and reads entitlement from it.
  const moved: [string, RegExp][] = [
    ["app/lib/entitlements.ts", /ARRAY\(\$\{VIEWER_TIERS_SQL\}\)/],
    ["app/lib/badgeCache.ts", /pool\.query<IdRow>\(ENTITLED_VIEWERS_SQL, \[subscriptionSources\(\)\]\)/],
    ["app/lib/billingServer.ts", /\[newBadgeId, subscriptionSources\(\)\]/],
    ["app/api/badges/equip/route.ts", /\$\{viewerEntitledSql\("\$1", "\$3"\)\}[\s\S]*\[matrixId, badgeId \?\? 0, subscriptionSources\(\)\]/],
    ["app/api/me/route.ts", /listViewerSubscriptions\(pool, session\.user\.id\)/],
    ["app/lib/accountDeletion.ts", /stillBills\(pool, matrixId\)/],
    // Moved in S3 (owner review D): community recipients and the gift clock.
    ["app/lib/giftServer.ts", /columnEntitledSql\("u\.matrix_id", "\$5"\)[\s\S]*paidThroughSql\("\$3", "\$7"\)/],
  ];
  for (const [f, re] of moved) {
    const s = stripComments(read(f));
    assert.match(s, /from "(?:\.\/|@\/app\/lib\/)subscriptions\/entitlement(?:\.ts)?"/, `${f} must import the fragment's module`);
    assert.match(s, re, `${f} no longer reads through the fragment`);
  }
  // Negative: the entitlement readers no longer read the legacy row (anchored on each file's end).
  for (const [f, tail] of [
    ["app/lib/entitlements.ts", /return tier \? CHAT_RATE_SUB : CHAT_RATE_BASE;\s*\}\s*$/],
    ["app/lib/badgeCache.ts", /cache\.invalidate\(\);\s*\}\s*$/],
    ["app/api/badges/equip/route.ts", /return Response\.json\(\{ ok: true \}\);\s*\}\s*$/],
    ["app/lib/giftServer.ts", /setInterval\(\(\) => void run\(\), 60 \* 60 \* 1000\); \/\/ hourly\s*\}\s*$/],
  ] as const) {
    const raw = read(f);
    assert.match(raw, tail, `END of ${f} not read`);
    assert.doesNotMatch(stripComments(raw), /site\.subscriptions\b/, `${f} reads entitlement from the legacy row again`);
  }
  const del = read("app/lib/accountDeletion.ts");
  assert.match(del, /return \{ ok: true, matrix: "operator", counts \};\s*\}\s*$/, "END of accountDeletion.ts not read");
  assert.doesNotMatch(stripComments(del), /site\.subscriptions\b/, "deletion's block reads the legacy row again");
});
