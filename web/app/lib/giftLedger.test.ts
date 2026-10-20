// The gifter's ledger: site.gift_subscriptions + site.gift_pending rows,
// grouped per Stripe checkout session (= one purchase), newest first.
//
// Shape of the data: a community gift of N months to
// M people is ONE session with up to M gift_subscriptions rows (one per
// recipient granted, at purchase time or later when a pending slot is
// claimed) plus one gift_pending row per slot that could not be handed out
// yet. A claimed slot keeps its gift_pending row (claimed_by set) AND gains a
// gift_subscriptions row — so recipients come from gift_subscriptions alone,
// and only UNCLAIMED pending rows count as waiting.
//
// Run: node --test app/lib/giftLedger.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { groupGiftPurchases, type GiftGivenRow, type GiftPendingRow } from "./giftLedger.ts";

const NOW = new Date("2026-09-14T12:00:00Z");

const given: GiftGivenRow[] = [
  // Older direct gift, expired.
  { stripe_session_id: "cs_old", kind: "direct", months: 1, anonymous: false, created_at: "2026-06-01T00:00:00.000Z",
    recipient_name: "zed", expires_at: "2026-07-01T00:00:00.000Z" },
  // Community gift of 5: two granted now, one claimed later, two still waiting.
  { stripe_session_id: "cs_comm", kind: "community", months: 1, anonymous: true, created_at: "2026-09-11T00:00:00.000Z",
    recipient_name: "A", expires_at: "2026-10-11T00:00:00.000Z" },
  { stripe_session_id: "cs_comm", kind: "community", months: 1, anonymous: true, created_at: "2026-09-11T00:00:00.000Z",
    recipient_name: "B", expires_at: "2026-10-11T00:00:00.000Z" },
  { stripe_session_id: "cs_comm", kind: "community", months: 1, anonymous: true, created_at: "2026-09-12T00:00:00.000Z",
    recipient_name: "C", expires_at: "2026-10-12T00:00:00.000Z" },
  // Newest: a direct gift to one person, active.
  { stripe_session_id: "cs_cho", kind: "direct", months: 3, anonymous: false, created_at: "2026-09-13T20:00:00.000Z",
    recipient_name: "cleo", expires_at: "2026-12-13T20:00:00.000Z" },
];

const pending: GiftPendingRow[] = [
  { stripe_session_id: "cs_comm", months: 1, anonymous: true, created_at: "2026-09-11T00:00:00.000Z", claimed_by: "@c:site.test", claimed_at: "2026-09-12T00:00:00.000Z", claim_expires_at: "2026-12-10T00:00:00.000Z" },
  { stripe_session_id: "cs_comm", months: 1, anonymous: true, created_at: "2026-09-11T00:00:00.000Z", claimed_by: null, claimed_at: null, claim_expires_at: "2026-12-10T00:00:00.000Z" },
  { stripe_session_id: "cs_comm", months: 1, anonymous: true, created_at: "2026-09-11T00:00:00.000Z", claimed_by: null, claimed_at: null, claim_expires_at: "2026-12-10T00:00:00.000Z" },
];

test("one purchase per checkout session, newest first", () => {
  const out = groupGiftPurchases(given, pending, NOW);
  assert.deepEqual(out.map((p) => p.sessionId), ["cs_cho", "cs_comm", "cs_old"]);
});

test("a direct gift carries its recipient's name, end date and whether it is active now", () => {
  const [cleo, , old] = groupGiftPurchases(given, pending, NOW);
  assert.deepEqual(cleo, {
    sessionId: "cs_cho", kind: "direct", months: 3, anonymous: false, createdAt: "2026-09-13T20:00:00.000Z",
    recipients: [{ name: "cleo", expiresAt: "2026-12-13T20:00:00.000Z", active: true }],
    waiting: 0, waitingUntil: null,
  });
  assert.equal(old?.recipients[0]?.active, false, "expired reads as inactive");
});

test("a claimed pending slot is NOT double-counted: recipients come from gift_subscriptions, waiting = unclaimed only", () => {
  const comm = groupGiftPurchases(given, pending, NOW).find((p) => p.sessionId === "cs_comm");
  assert.ok(comm);
  assert.deepEqual(comm.recipients.map((r) => r.name), ["A", "B", "C"]);
  assert.equal(comm.waiting, 2);
  assert.equal(comm.waitingUntil, "2026-12-10T00:00:00.000Z");
  assert.equal(comm.anonymous, true);
});

test("a pending slot whose claim window has lapsed no longer counts as waiting", () => {
  const lapsed: GiftPendingRow[] = [
    { stripe_session_id: "cs_x", months: 1, anonymous: false, created_at: "2026-05-01T00:00:00.000Z", claimed_by: null, claimed_at: null, claim_expires_at: "2026-07-30T00:00:00.000Z" },
  ];
  const out = groupGiftPurchases([], lapsed, NOW);
  assert.equal(out.length, 1, "the purchase still shows — the money was real");
  assert.equal(out[0]?.waiting, 0);
  assert.equal(out[0]?.waitingUntil, null);
});

test("a purchase with only pending rows (nothing granted yet) still appears, with kind community", () => {
  const onlyPending: GiftPendingRow[] = [
    { stripe_session_id: "cs_fresh", months: 2, anonymous: false, created_at: "2026-09-14T11:00:00.000Z", claimed_by: null, claimed_at: null, claim_expires_at: "2026-12-13T11:00:00.000Z" },
  ];
  const [p] = groupGiftPurchases([], onlyPending, NOW);
  assert.deepEqual(p, {
    sessionId: "cs_fresh", kind: "community", months: 2, anonymous: false, createdAt: "2026-09-14T11:00:00.000Z",
    recipients: [], waiting: 1, waitingUntil: "2026-12-13T11:00:00.000Z",
  });
});

// ── The queries behind it (source scan of the server half) ───────────────────

test("the ledger queries scope BOTH tables to the caller as gifter, and resolve names by chatIdentity's one rule", () => {
  const src = readFileSync(join(process.cwd(), "app/lib/giftLedgerServer.ts"), "utf8");
  assert.match(src, /\}\s*$/, "END of giftLedgerServer.ts not read");
  const s = stripComments(src);
  const fn = s.slice(s.indexOf("export async function loadGiftLedger("));
  assert.ok(fn.length > 0, "loadGiftLedger not found");
  assert.match(fn, /FROM site\.gift_subscriptions g[\s\S]*?WHERE g\.gifter_matrix_id = \$1/, "gifts given: scoped by gifter");
  assert.match(fn, /LEFT JOIN site\.users ru ON ru\.matrix_id = g\.recipient_matrix_id/, "the recipient's display name is joined, not a second query per row");
  assert.match(fn, /FROM site\.gift_pending p[\s\S]*?WHERE p\.gifter_matrix_id = \$1/, "pending slots: scoped by gifter");
  assert.match(fn, /recipient_name: r\.recipient_name \|\| matrixLocalpart\(r\.recipient_matrix_id\)/, "no display name → the Matrix local part, never the raw @id");
  // Received: an anonymous gifter's id AND name are nulled in SQL.
  assert.match(fn, /WHERE g\.recipient_matrix_id = \$1/, "gifts received: scoped by recipient");
  assert.match(fn, /CASE WHEN g\.anonymous THEN NULL ELSE g\.gifter_matrix_id END AS from_id/, "an anonymous gifter's id never leaves the server");
  assert.match(fn, /CASE WHEN g\.anonymous THEN NULL ELSE gu\.display_name END AS from_name/, "…nor their name");
  assert.match(fn, /from: r\.from_id == null \? null : r\.from_name \|\| matrixLocalpart\(r\.from_id\)/, "a known gifter falls back to the local part");
});
