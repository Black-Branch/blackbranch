import { test } from "node:test";
import assert from "node:assert";
import {
  LEDGER_KINDS, SPEND_SINKS, ledgerKindLabel, EARN_KINDS, earnedParenthetical,
} from "./coins.ts";
import * as coins from "./coins.ts";

// The point of this file: the ledger vocabulary is ONE list, and every member of
// it has a label. StoreContent used to carry its own copy of the union with a
// default-less switch, so a kind added to coinsServer rendered `undefined` in the
// Qorm history tab with a green build. Enumerating the array is what stops that.
test("every ledger kind has a non-empty label", () => {
  for (const kind of LEDGER_KINDS) {
    const label = ledgerKindLabel(kind, null);
    assert.ok(typeof label === "string" && label.length > 0, `${kind} has no label`);
  }
});

test("every spend sink has a non-empty label under the 'spend' kind", () => {
  for (const sink of SPEND_SINKS) {
    const label = ledgerKindLabel("spend", sink);
    assert.ok(typeof label === "string" && label.length > 0, `sink ${sink} has no label`);
  }
});

test("the four LEGACY market kinds are still present and distinctly labelled — history rows render by kind", () => {
  const market = ["market_buy", "market_sell", "market_payout", "market_void"] as const;
  for (const k of market) assert.ok(LEDGER_KINDS.includes(k), `${k} missing from LEDGER_KINDS`);
  const labels = market.map((k) => ledgerKindLabel(k, null));
  assert.equal(new Set(labels).size, market.length, "market kinds must not share a label");
});

test("nothing re-declares the ledger unions outside coins.ts", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../features/store/StoreContent.tsx", import.meta.url), "utf8"
  );
  assert.ok(
    !/^type LedgerKind\s*=/m.test(src),
    "StoreContent re-declares LedgerKind — import it from app/lib/coins.ts instead"
  );
  assert.ok(
    !/^type SpendSink\s*=/m.test(src),
    "StoreContent re-declares SpendSink — import it from app/lib/coins.ts instead"
  );
});

// ── fixed-price spend wiring (highlight + TTS) ───────────────────────────────
//
// Highlight/TTS are fixed prices, not a derived amount ladder. A fixed price
// still has a live number (site.store_prices, moved by E) and a
// SSR/first-paint constant, and `expectedPrice` must come from the live one —
// see storePricing.ts's priceGuard, whose entire job is that a viewer is
// never charged a price they were not shown. Sending the constant would defeat
// it. This pins that wiring, which is the part a unit test on priceGuard alone
// cannot see.
test("the chip and the composer both read the LIVE price, not just the constant", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("./testSource.ts");
  const read = (r: string) => stripComments(readFileSync(new URL(r, import.meta.url), "utf8"));

  const chip = read("../features/chat/SpendChip.tsx");
  assert.match(
    chip, /useItemPrice\(mode\)/,
    "SpendChip no longer reads the live price for the armed product"
  );
  assert.match(
    chip, /HIGHLIGHT_PRICE|TTS_PRICE/,
    "SpendChip lost its SSR first-paint fallback entirely"
  );

  const input = read("../features/chat/ChatInput.tsx");
  assert.match(
    input, /useItemPrice\("highlight"\) \?\? HIGHLIGHT_PRICE/,
    "ChatInput's highlight price is no longer the live price with a constant fallback"
  );
  assert.match(
    input, /useItemPrice\("tts"\) \?\? TTS_PRICE/,
    "ChatInput's TTS price is no longer the live price with a constant fallback"
  );
});

// ── the wallet parenthetical ─────────────────────────────────────────────────

test("the earned parenthetical is ALWAYS rendered, even when it equals the total", () => {
  // The bug it fixes: omit-when-equal hid it from everyone who has never bought
  // Qorm — almost everyone — so it appeared and vanished based on purchase
  // history and could not be learned — people did not see it.
  // No build here, so the product's mark ("pts", spaced); an install's one-letter mark sits flush
  // (currencyBuilt.test.ts).
  assert.equal(earnedParenthetical(200), " (200\u00a0pts)");
  assert.equal(earnedParenthetical(475), " (475\u00a0pts)");
  assert.equal(earnedParenthetical(0), " (0\u00a0pts)");
});

test("an UNKNOWN split shows a placeholder, never a guessed number", () => {
  // useCoinBalance blanks the split whenever the balance moves through a path
  // that cannot know the new one (a spend, an earn). Rendering the old value
  // there would put a quietly wrong number inside the total it sits in;
  // rendering nothing would collapse the slot and jump the layout.
  assert.equal(earnedParenthetical(null), " (…)");
  assert.doesNotMatch(earnedParenthetical(null), /\d/, "a placeholder must not look like an amount");
});

test("both wallet surfaces render the parenthetical through the shared rule", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("./testSource.ts");
  const read = (r: string) => stripComments(readFileSync(new URL(r, import.meta.url), "utf8"));
  for (const [file, what] of [
    ["../features/store/StoreContent.tsx", "the store header"],
    ["../components/ProfileCardBody.tsx", "the profile card row"],
  ] as const) {
    const src = read(file);
    assert.match(src, /earnedParenthetical\(/, `${what} does not use the shared parenthetical rule`);
    assert.doesNotMatch(
      src, /!==\s*coinBalance/,
      `${what} still has an omit-when-equal condition — every line shows`
    );
  }
});

test("the store is ONE page: top up and spend are not exclusive tabs", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(
    readFileSync(new URL("../features/store/StoreContent.tsx", import.meta.url), "utf8")
  );
  assert.doesNotMatch(
    src, /\["topup", "spend", "history"\]/,
    "the three-tab strip is back — buying and spending live on one page"
  );
  // Both must render under the SAME tab value, or they are still exclusive.
  assert.match(src, /tab === "store" && <StoreSpend \/>/, "the spend catalog is not on the store page");
  // (The buy box also waits on the buy switch — still the same tab value.)
  assert.match(src, /tab === "store" && purchasable !== false && \(/, "the buy box is not on the store page");
  // Old callers must keep working — the event contract is the compatibility surface.
  assert.match(src, /initialTab === "history"/, "an entry of \"history\" no longer opens history");
  assert.match(src, /initialTab !== "topup"/, "an entry of \"topup\" no longer surfaces the buy box");
});

test("removing the store sections did not remove the sinks themselves", async () => {
  // A removed section is a layout decision; a deleted sink is a product one, and
  // stream-api refuses to boot if COIN_KINDS and KIND_POLICY disagree.
  for (const sink of ["tts", "sound"] as const) {
    assert.ok(SPEND_SINKS.includes(sink), `${sink} was dropped from SPEND_SINKS`);
  }
});

test("earn_bonus is a ledger kind, an EARN kind by prefix, and labelled", () => {
  assert.ok(LEDGER_KINDS.includes("earn_bonus"));
  assert.ok(EARN_KINDS.includes("earn_bonus"), "the chip and the chip query derive from EARN_KINDS — the bonus must ride them");
  assert.equal(ledgerKindLabel("earn_bonus", null), "Clock bonus");
});

test("ledgerKindLabel names the two live products and the retired one", () => {
  assert.equal(ledgerKindLabel("spend", "highlight"), "Highlight");
  assert.equal(ledgerKindLabel("spend", "tts"), "Read aloud");
  // 247 historical rows carry sink 'cheer'. They must keep reading as what
  // they were, not as whatever replaced them.
  assert.equal(ledgerKindLabel("spend", "cheer"), "Cheer");
});

test("highlight is a spend sink", () => {
  assert.ok((SPEND_SINKS as readonly string[]).includes("highlight"));
});

test("money kinds are ledger kinds with plain labels", () => {
  for (const k of ["tip", "clawback", "clawback_reversed"] as const) {
    assert.ok(LEDGER_KINDS.includes(k), `${k} missing from LEDGER_KINDS`);
  }
  assert.equal(ledgerKindLabel("tip", null), "Tip");
  assert.equal(ledgerKindLabel("clawback", null), "Refunded");
  // "Returned", not "Dispute won" — restoreClawback also fires for a failed
  // or canceled Stripe refund, which is not a dispute
  // (paymentEventHandlers.ts's refund.updated branch).
  assert.equal(ledgerKindLabel("clawback_reversed", null), "Returned");
});

test("one payment range for tips AND Qorm purchases: $1–$1,000", () => {
  assert.equal(coins.PAY_MIN_CENTS, 100);
  assert.equal(coins.PAY_MAX_CENTS, 100_000);
  assert.equal("COIN_MIN_PURCHASE" in coins, false, "the old purchase-only floor must be gone, not kept as a second copy");
  assert.equal("COIN_MAX_PURCHASE" in coins, false, "the old purchase-only ceiling must be gone, not kept as a second copy");
});
