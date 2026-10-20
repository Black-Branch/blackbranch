import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// The whole point of extracting this form is that a fix lands on every surface
// at once. A second copy would silently re-open the gap this page exists to
// close (a guest could name themselves on one surface and not the other).
const SURFACES = ["../../components/SupportContent.tsx", "../../donate/DonateClient.tsx"];

test("every tip surface renders the shared TipForm", () => {
  // Vacuity anchor: a negative-ish assertion over an empty list is green.
  assert.ok(SURFACES.length >= 2, "no surfaces listed — this test would assert nothing");
  for (const path of SURFACES) {
    const src = read(path);
    assert.ok(/<TipForm\b/.test(src), `${path} must render <TipForm>, not its own copy`);
    assert.ok(
      !/donationTtsLine\(/.test(src),
      `${path} still computes the reading-tier line itself — that belongs to TipForm now`,
    );
  }
});

// A retry at a different amount must not still show a message about the failed
// attempt, so a stale error is cleared from BOTH the preset-amount onClick and
// the custom-amount onChange. TipForm can't reach the caller's error state
// directly, so that clearing travels through an onAmountChange callback. This
// pins that it actually does, on both amount inputs, and that it stays scoped
// to the amount (not the message or the anonymous checkbox).
test("TipForm clears the caller's stale error on an amount change — preset AND custom", () => {
  const src = read("./TipForm.tsx");
  const presetAt = src.indexOf("setAmount(p)");
  assert.ok(presetAt !== -1, "vacuity anchor: the preset-amount setter is gone from TipForm");
  const presetHandler = src.slice(presetAt, src.indexOf("}}", presetAt));
  assert.ok(
    /onAmountChange\?\.\(\)/.test(presetHandler),
    "TipForm's preset-amount handler no longer calls onAmountChange — a stale error survives picking a new preset",
  );

  const customAt = src.indexOf("setCustom(e.target.value)");
  assert.ok(customAt !== -1, "vacuity anchor: the custom-amount setter is gone from TipForm");
  const customHandler = src.slice(customAt, src.indexOf("}}", customAt));
  assert.ok(
    /onAmountChange\?\.\(\)/.test(customHandler),
    "TipForm's custom-amount handler no longer calls onAmountChange — a stale error survives typing a new amount",
  );

  // Scoped to amount only — the old code never cleared the error on the
  // message or the anonymous checkbox, and matching that exactly is the
  // point of a no-behaviour-change task.
  const messageHandler = "onChange={(e) => setMessage(e.target.value)}";
  assert.ok(src.includes(messageHandler), "vacuity anchor: the message onChange handler's shape changed — update this scan");
  const anonHandler = "onChange={(e) => setDonateAnon(e.target.checked)}";
  assert.ok(src.includes(anonHandler), "vacuity anchor: the anonymous-checkbox onChange handler's shape changed — update this scan");
});

test("SupportContent wires TipForm's onAmountChange to clear its own error", () => {
  const src = read("../../components/SupportContent.tsx");
  assert.ok(
    /onAmountChange=\{\(\) => setErr\(null\)\}/.test(src),
    "SupportContent no longer clears its stale error when the tip amount changes",
  );
});

test("TipForm's amount bounds are the shared range, not literals", () => {
  const src = read("./TipForm.tsx");
  assert.ok(src.trimEnd().endsWith("}"), "vacuity anchor: TipForm.tsx truncated");
  assert.match(src, /import\s*\{[^}]*PAY_MIN_CENTS[^}]*\}\s*from\s*"@\/app\/lib\/coins"/);
  assert.doesNotMatch(src, /<=\s*1000\b|>=\s*1\s*&&/, "a literal $1/$1,000 bound is a second copy of the range");
  assert.match(src, /min=\{PAY_MIN_CENTS \/ 100\}/);
  assert.match(src, /max=\{PAY_MAX_CENTS \/ 100\}/);
});
