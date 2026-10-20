import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// TipForm unmounts on BOTH surfaces once the checkout view opens —
// DonateClient's ternary and SupportContent's early `return` are the same
// shape (tipFormDraft.render.test.ts pins that TipForm itself restores a draft
// correctly via `initialDraft`; this pins that BOTH parents actually save
// what they receive from `onSubmit` and hand it back, not just one of them).

test("DonateClient remembers the submitted draft and hands it back to TipForm", () => {
  const src = read("../../donate/DonateClient.tsx");
  assert.ok(
    /const \[draft, setDraft\] = useState<TipDraft \| null>\(null\)/.test(src),
    "DonateClient no longer keeps a remembered TipDraft — a decline-and-retry will lose it again",
  );
  assert.ok(
    /setDraft\(next\)/.test(src),
    "DonateClient declares draft state but startCheckout never saves into it — dead state saves nothing",
  );
  assert.ok(
    /initialDraft=\{draft \?\? undefined\}/.test(src),
    "DonateClient does not hand the remembered draft back to TipForm on remount",
  );
});

test("SupportContent remembers the submitted draft and hands it back to TipForm", () => {
  const src = read("../../components/SupportContent.tsx");
  assert.ok(
    /const \[donationDraft, setDonationDraft\] = useState<TipDraft \| null>\(null\)/.test(src),
    "SupportContent no longer keeps a remembered TipDraft — its checkout view is ALSO an early return that unmounts TipForm, so it regresses the same way DonateClient did",
  );
  assert.ok(
    /setDonationDraft\(d\)/.test(src),
    "SupportContent declares donationDraft state but its TipForm onSubmit never saves into it",
  );
  assert.ok(
    /initialDraft=\{donationDraft \?\? undefined\}/.test(src),
    "SupportContent does not hand the remembered draft back to TipForm on remount",
  );
});

// Vacuity anchor at the END: a renamed/emptied file would make the negative
// shape of the assertions above ("no longer") pass over a hole rather than a
// real absence.
test("vacuity anchor: both files are read whole", () => {
  assert.ok(read("../../donate/DonateClient.tsx").trimEnd().endsWith("}"), "DonateClient.tsx truncated");
  assert.ok(read("../../components/SupportContent.tsx").trimEnd().endsWith("}"), "SupportContent.tsx truncated");
});
