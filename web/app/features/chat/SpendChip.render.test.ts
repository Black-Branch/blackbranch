// SpendChip with a NEGATIVE wallet balance — a real mount, not a source scan.
// A wallet can go below zero via clawback. SpendChip is the render-tested
// balance surface because it is the cheapest to actually mount:
// StoreContent/StoreSpend need BadgesContext + Stripe scaffolding,
// ProfileCardBody needs the same, and ChatInput (the one place a real
// `coinBalance >= price` spend gate lives — its own
// `spendAffordable`/`spendBlocked`, ChatInput.tsx) needs the Matrix client
// context and a dozen other hooks on top. SpendChip is a plain, prop-driven
// component with no context dependency at all.
//
// Run: node --test app/features/chat/SpendChip.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, serveJson } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

// SpendChip reads useItemPrice(), which pulls useStorePrices() — that fetches
// GET /api/store/prices in an effect. `{}` has neither `prices` nor `e`, so
// useStorePrices treats it as a failed/empty read and keeps its null
// snapshot — SpendChip then falls back to the HIGHLIGHT_PRICE/TTS_PRICE
// constant it already carries for exactly this case, same as production
// while the table hasn't loaded yet.
serveJson({});

const { SpendChip } = await import("./SpendChip.tsx");
const { createRoot } = await import("react-dom/client");

function mount(props: Parameters<typeof SpendChip>[0]) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(SpendChip, props)));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

test("a negative balance (-200) displays as-is, with no NaN, and reads as unaffordable", () => {
  const m = mount({ mode: "highlight", coinBalance: -200, onCancel: () => {} });
  const text = m.host.textContent ?? "";
  assert.ok(!text.includes("NaN"), `must never render NaN for a negative balance, got: ${text}`);
  assert.ok(
    text.includes("-200") || text.includes("−200"),
    `expected the balance to display as -200 (hyphen or unicode minus), got: ${text}`,
  );
  // SpendChip owns no submit control of its own — the actual send button
  // lives in ChatInput, gated by `coinBalance >= spendPrice`
  // (spendAffordable/spendBlocked, ChatInput.tsx), which a negative balance
  // can never satisfy against any positive price. SpendChip's own equivalent
  // of "spend disabled" is never presenting an affordable state: it offers
  // "Top up" instead of a plain balance line, and prices the shortfall
  // correctly rather than going negative or NaN.
  assert.ok(text.includes("Top up"), "an unaffordable balance must offer Top up, not a plain balance line");
  // The price span and the "N short" span sit adjacent with no separator, so
  // a whole-text regex over-matches their concatenated digits (found: this
  // assertion first read "50250" as one run) — the "short" span is queried
  // on its own to avoid that.
  const shortSpan = [...m.host.querySelectorAll("span")].find((s) => s.textContent?.includes("short"));
  assert.ok(shortSpan, `vacuity anchor: no "short" span rendered, got: ${text}`);
  // price(50, the highlight fallback) - (-200) = 250.
  assert.ok(
    shortSpan!.textContent?.startsWith("250 short"),
    `expected 250 short (50 - (-200)), got: ${shortSpan!.textContent}`,
  );
  m.unmount();
});

test("vacuity anchor: a healthy balance shows neither NaN nor \"short\"", () => {
  const m = mount({ mode: "highlight", coinBalance: 500, onCancel: () => {} });
  const text = m.host.textContent ?? "";
  assert.ok(!text.includes("NaN"), "sanity: a healthy balance must not show NaN either");
  assert.ok(!text.includes("short"), "an affordable balance should not read as short — otherwise this test proves nothing about the negative case above");
  assert.ok(text.includes("500"), `expected the balance itself to show, got: ${text}`);
  m.unmount();
});
