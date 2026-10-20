// Positive scan: each payment-mode route computes its kind's suffix via
// statementSuffixFor/getStatementPrefixLength and spreads it into
// payment_intent_data — never a hardcoded literal, since Stripe rejects a
// session create whose prefix + suffix exceeds 22 chars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const webRoot = join(import.meta.dirname, "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));
const CASES: Array<[string, string]> = [
  ["api/billing/donate/route.ts", "donation"], ["api/billing/gift/route.ts", "gift"],
  ["api/billing/points/route.ts", "coin_purchase"],
];

test("each payment-mode route computes its suffix via statementSuffixFor and spreads it into payment_intent_data", () => {
  for (const [path, kind] of CASES) {
    const src = read(path);
    assert.match(
      src,
      /import \{ statementSuffixFor, getStatementPrefixLength \} from "@\/app\/lib\/statementSuffix"/,
      `${path}: missing the import`
    );
    assert.match(src, new RegExp(`statementSuffixFor\\("${kind}",`), `${path}: must call statementSuffixFor("${kind}", ...)`);
    const piAt = src.indexOf("payment_intent_data: {");
    assert.ok(piAt >= 0, `${path}: no payment_intent_data block`);
    const closeAt = src.indexOf("branding_settings:", piAt);
    assert.ok(closeAt > piAt, `${path}: no branding_settings after payment_intent_data`);
    const block = src.slice(piAt, closeAt);
    assert.match(
      block,
      /\.\.\.\(suffix \? \{ statement_descriptor_suffix: suffix \} : \{\}\)/,
      `${path}: missing the conditional spread — a bare literal can never omit itself`
    );
  }
});
