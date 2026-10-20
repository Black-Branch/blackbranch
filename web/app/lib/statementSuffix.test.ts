import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { statementSuffixFor } from "./statementSuffix.ts";

test("statementSuffixFor: returns the suffix when prefix + '* ' + suffix fits in 22 chars", () => {
  assert.equal(statementSuffixFor("donation", 10), "TIP");       // 10 + 2 + 3 = 15
  assert.equal(statementSuffixFor("gift", 10), "GIFT");          // 10 + 2 + 4 = 16
  // A points purchase says the currency's own name — this process has no build, so the
  // product's: POINTS. An install's own word is pinned in currencyBuilt.test.ts.
  assert.equal(statementSuffixFor("coin_purchase", 10), "POINTS"); // 10 + 2 + 6 = 18
  assert.equal(statementSuffixFor("coin_purchase", 14), "POINTS"); // 14 + 2 + 6 = 22
  assert.equal(statementSuffixFor("coin_purchase", 15), undefined);
});

test("statementSuffixFor: fits exactly at 22, omitted (undefined) one character over", () => {
  assert.equal(statementSuffixFor("donation", 17), "TIP");       // 17 + 2 + 3 = 22
  assert.equal(statementSuffixFor("donation", 18), undefined);   // 18 + 2 + 3 = 23
  assert.equal(statementSuffixFor("gift", 16), "GIFT");          // 16 + 2 + 4 = 22
  assert.equal(statementSuffixFor("gift", 17), undefined);       // 17 + 2 + 4 = 23
});

test("statementSuffixFor: no prefix at all means no suffix — never fail open", () => {
  assert.equal(statementSuffixFor("donation", 0), undefined);
  assert.equal(statementSuffixFor("gift", -1), undefined);
});

test("getStatementPrefixLength: reads card_payments.statement_descriptor_prefix, cached at most one API call per process", async () => {
  // @ts-expect-error — the query string gives this test its own module instance (a fresh cache); tsc cannot resolve a query-string specifier
  const { getStatementPrefixLength } = await import("./statementSuffix.ts?case=success");
  let calls = 0;
  const stripe = {
    accounts: {
      retrieve: async () => {
        calls += 1;
        return { settings: { card_payments: { statement_descriptor_prefix: "EXAMPLE" }, payments: { statement_descriptor: "IGNORED" } } };
      },
    },
  } as unknown as Stripe;
  assert.equal(await getStatementPrefixLength(stripe), "EXAMPLE".length);
  await getStatementPrefixLength(stripe); // second call — must not hit the API again
  assert.equal(calls, 1, "stripe.accounts.retrieve() must be called at most once per process");
});

test("getStatementPrefixLength: falls back to settings.payments.statement_descriptor when card_payments has none", async () => {
  // @ts-expect-error — the query string gives this test its own module instance (a fresh cache); tsc cannot resolve a query-string specifier
  const { getStatementPrefixLength } = await import("./statementSuffix.ts?case=fallback");
  const stripe = {
    accounts: { retrieve: async () => ({ settings: { card_payments: {}, payments: { statement_descriptor: "EXAMPLETV" } } }) },
  } as unknown as Stripe;
  assert.equal(await getStatementPrefixLength(stripe), "EXAMPLETV".length);
});

test("getStatementPrefixLength: any error resolves to 22 (fail-closed to 'omit the suffix')", async () => {
  // @ts-expect-error — the query string gives this test its own module instance (a fresh cache); tsc cannot resolve a query-string specifier
  const { getStatementPrefixLength } = await import("./statementSuffix.ts?case=error");
  const stripe = { accounts: { retrieve: async () => { throw new Error("stripe down"); } } } as unknown as Stripe;
  assert.equal(await getStatementPrefixLength(stripe), 22);
});

test("getStatementPrefixLength: an error is not cached — the next call retries", async () => {
  // @ts-expect-error — the query string gives this test its own module instance (a fresh cache); tsc cannot resolve a query-string specifier
  const { getStatementPrefixLength } = await import("./statementSuffix.ts?case=retry");
  let calls = 0;
  const stripe = {
    accounts: {
      retrieve: async () => {
        calls += 1;
        if (calls === 1) throw new Error("blip");
        return { settings: { card_payments: { statement_descriptor_prefix: "EXAMPLE" }, payments: { statement_descriptor: "X" } } };
      },
    },
  } as unknown as Stripe;
  assert.equal(await getStatementPrefixLength(stripe), 22);
  assert.equal(await getStatementPrefixLength(stripe), "EXAMPLE".length);
  assert.equal(calls, 2);
});
