// The sentences the Support panel shows a subscriber, a gift recipient and a
// gifter — built from dates and a clock, so the wording is pinned against
// fixed times rather than eyeballed in a browser: how long a sub has before it
// expires, whether renewal is on or off, and a way to verify a gift went
// through — its length, whether it was claimed, whether it is active now.
//
// Run: node --test app/lib/supportStatus.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionStatusLine, giftPurchaseLine, giftReceivedLine } from "./supportStatus.ts";

const NOW = new Date("2026-09-14T12:00:00Z");
// A fixed formatter so the assertions don't depend on the machine's locale.
const fmt = (d: Date) => d.toISOString().slice(0, 10);

const base = {
  tier: null as string | null,
  subStatus: null as string | null,
  subRenewsAt: null as string | null,
  subCancelAtPeriodEnd: false,
  giftActive: false,
  giftExpiresAt: null as string | null,
  giftFrom: null as string | null,
};

test("the day count rounds UP to whole days and never goes negative", () => {
  const at = (subRenewsAt: string) => subscriptionStatusLine({ ...base, tier: "supporter", subStatus: "active", subRenewsAt }, NOW, fmt)?.text;
  assert.equal(at("2026-09-15T11:00:00Z"), "Renews on 2026-09-15 (1 day)", "23 hours left reads as 1 day, not 0");
  assert.equal(at("2026-09-14T12:00:00Z"), "Renews on 2026-09-14 (0 days)");
  assert.equal(at("2026-09-01T00:00:00Z"), "Renews on 2026-09-01 (0 days)", "a date already passed (a webhook not yet landed) never shows a negative count");
});

test("a renewing subscription says when it renews and how many days that is", () => {
  const line = subscriptionStatusLine({ ...base, tier: "supporter", subStatus: "active", subRenewsAt: "2026-10-13T12:00:00Z" }, NOW, fmt);
  assert.deepEqual(line, { tone: "renews", text: "Renews on 2026-10-13 (29 days)" });
});

test("renewal switched off in the portal reads as ENDING, not renewing — the flag the webhook never stored", () => {
  const line = subscriptionStatusLine(
    { ...base, tier: "supporter", subStatus: "active", subRenewsAt: "2026-10-13T12:00:00Z", subCancelAtPeriodEnd: true },
    NOW, fmt
  );
  assert.deepEqual(line, { tone: "ending", text: "Renewal is off — access ends 2026-10-13 (29 days left)" });
});

test("past_due keeps the date but says payment is due", () => {
  const line = subscriptionStatusLine({ ...base, tier: "supporter", subStatus: "past_due", subRenewsAt: "2026-09-20T12:00:00Z" }, NOW, fmt);
  assert.deepEqual(line, { tone: "ending", text: "Payment due — access ends 2026-09-20 (6 days left) unless the card goes through" });
});

test("a gift recipient sees who it came from and until when", () => {
  const named = subscriptionStatusLine({ ...base, giftActive: true, giftExpiresAt: "2026-10-13T12:00:00Z", giftFrom: "cleo" }, NOW, fmt);
  assert.deepEqual(named, { tone: "gift", text: "Supporter via a gift from cleo — until 2026-10-13 (29 days left)" });
  const anon = subscriptionStatusLine({ ...base, giftActive: true, giftExpiresAt: "2026-10-13T12:00:00Z", giftFrom: null }, NOW, fmt);
  assert.deepEqual(anon, { tone: "gift", text: "Supporter via a gift — until 2026-10-13 (29 days left)" });
});

test("an own subscription outranks a stacked gift in the status line", () => {
  const line = subscriptionStatusLine(
    { ...base, tier: "supporter", subStatus: "active", subRenewsAt: "2026-10-13T12:00:00Z", giftActive: true, giftExpiresAt: "2026-12-13T12:00:00Z", giftFrom: "cleo" },
    NOW, fmt
  );
  assert.equal(line?.tone, "renews");
});

test("a subscription that already ended says so, with the date", () => {
  const line = subscriptionStatusLine({ ...base, subStatus: "canceled", subRenewsAt: "2026-09-01T12:00:00Z" }, NOW, fmt);
  assert.deepEqual(line, { tone: "ended", text: "Your subscription ended on 2026-09-01" });
});

test("nothing to say for someone who never subscribed", () => {
  assert.equal(subscriptionStatusLine(base, NOW, fmt), null);
  // A canceled row with no date is also silence — no "ended on undefined".
  assert.equal(subscriptionStatusLine({ ...base, subStatus: "canceled" }, NOW, fmt), null);
});

// ── The gifter's ledger rows ─────────────────────────────────────────────────

const direct = {
  sessionId: "cs_1",
  kind: "direct" as const,
  months: 3,
  anonymous: false,
  createdAt: "2026-09-13T20:00:00Z",
  recipients: [{ name: "cleo", expiresAt: "2026-12-13T20:00:00Z", active: true }],
  waiting: 0,
  waitingUntil: null,
};

test("a direct gift names the recipient, the length, and that it is active until a date", () => {
  assert.equal(giftPurchaseLine(direct, fmt), "3 months to cleo · active until 2026-12-13");
  assert.equal(giftPurchaseLine({ ...direct, months: 1 }, fmt), "1 month to cleo · active until 2026-12-13", "singular month");
});

test("a direct gift that ran out says ended, with the date", () => {
  const ended = { ...direct, recipients: [{ name: "cleo", expiresAt: "2026-09-01T20:00:00Z", active: false }] };
  assert.equal(giftPurchaseLine(ended, fmt), "3 months to cleo · ended 2026-09-01");
});

test("a community gift counts claimed and waiting slots, and says how long the waiting ones stay claimable", () => {
  const community = {
    sessionId: "cs_2",
    kind: "community" as const,
    months: 1,
    anonymous: true,
    createdAt: "2026-09-11T20:00:00Z",
    recipients: [
      { name: "a", expiresAt: "2026-10-11T20:00:00Z", active: true },
      { name: "b", expiresAt: "2026-10-11T20:00:00Z", active: true },
      { name: "c", expiresAt: "2026-10-12T20:00:00Z", active: true },
      { name: "d", expiresAt: "2026-10-11T20:00:00Z", active: true },
    ],
    waiting: 1,
    waitingUntil: "2026-12-10T20:00:00Z",
  };
  assert.equal(
    giftPurchaseLine(community, fmt),
    "5 × 1 month to the community · 4 claimed, 1 waiting for a new member (claimable until 2026-12-10) · active until 2026-10-12"
  );
});

test("a community gift with everyone claimed and everything expired reads as ended on the latest date", () => {
  const done = {
    sessionId: "cs_3",
    kind: "community" as const,
    months: 1,
    anonymous: false,
    createdAt: "2026-06-01T20:00:00Z",
    recipients: [
      { name: "a", expiresAt: "2026-07-01T20:00:00Z", active: false },
      { name: "b", expiresAt: "2026-07-03T20:00:00Z", active: false },
    ],
    waiting: 0,
    waitingUntil: null,
  };
  assert.equal(giftPurchaseLine(done, fmt), "2 × 1 month to the community · 2 claimed · ended 2026-07-03");
});

test("a community gift nobody has claimed yet is honest about it", () => {
  const fresh = {
    sessionId: "cs_4",
    kind: "community" as const,
    months: 2,
    anonymous: false,
    createdAt: "2026-09-14T11:00:00Z",
    recipients: [],
    waiting: 3,
    waitingUntil: "2026-12-13T11:00:00Z",
  };
  assert.equal(
    giftPurchaseLine(fresh, fmt),
    "3 × 2 months to the community · 0 claimed, 3 waiting for a new member (claimable until 2026-12-13)"
  );
});

// ── Gifts received ───────────────────────────────────────────────────────────

test("a received gift names the giver (or Anonymous), the length, and until when", () => {
  assert.equal(
    giftReceivedLine({ from: "cleo", months: 3, expiresAt: "2026-12-13T20:00:00Z", active: true }, fmt),
    "3 months from cleo · active until 2026-12-13"
  );
  assert.equal(
    giftReceivedLine({ from: null, months: 1, expiresAt: "2026-07-01T20:00:00Z", active: false }, fmt),
    "1 month from Anonymous · ended 2026-07-01"
  );
});
