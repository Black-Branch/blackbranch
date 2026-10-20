import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the tip form collects a name and the caller forwards it", () => {
  const form = read("./TipForm.tsx");
  assert.ok(/displayName/.test(form), "TipForm must have a name input bound to displayName");
  // Matches `displayName: anonymous ? "" : name.trim()` as well as a bare
  // `displayName: name` — what must be true is that the submitted value is
  // DERIVED FROM the name state, not a constant.
  assert.ok(
    /displayName:\s*[^,\n]*\bname\b/.test(form),
    "the submitted draft must carry the typed name, not a hardcoded empty string",
  );
  // Scoped to the ANNOUNCING draft literal specifically (matched by its
  // neighbouring `anonymous: donateAnon`), not the whole file — since Qorm-
  // for-all-income piece 3 task 2, TipForm also has a second, QUIET draft
  // literal (`announce: false`) that legitimately hardcodes `displayName: ""`
  // by spec (a quiet Qorm purchase never carries a name). A file-wide
  // negative match would be defeated by that unrelated, correct literal, so
  // this re-pins to just the branch this assertion is actually about
  // (re-pinned, same task, equal strictness).
  const announcingDraft = form.match(/\?\s*\{[^}]*anonymous: donateAnon[^}]*\}/)?.[0] ?? "";
  assert.ok(announcingDraft.length > 0, "vacuity anchor: the announcing draft literal is gone from TipForm.tsx");
  assert.ok(!/displayName:\s*""\s*[,}]/.test(announcingDraft), "displayName is no longer hardcoded empty in the announcing draft");

  // The donate-body literal lives in checkoutRequestFor (tipCheckout.ts) —
  // every host hands its WHOLE draft to that one function rather than
  // building the request body itself. So "does the typed name reach
  // /api/billing/donate" is two checks that together say it: (1) the panel
  // forwards the full draft `d` (not a stripped-down object) to
  // checkoutRequestFor, so nothing here can drop the name before it gets
  // there, and (2) checkoutRequestFor's tip branch actually carries the name
  // through rather than hardcoding it away.
  const panel = read("../../components/SupportContent.tsx");
  assert.ok(
    /checkoutRequestFor\(d\)/.test(panel),
    "the support panel no longer forwards the whole draft to checkoutRequestFor — the typed name could be dropped before it reaches /api/billing/donate",
  );

  const checkout = read("./tipCheckout.ts");
  assert.ok(checkout.trimEnd().endsWith("}"), "vacuity anchor: tipCheckout.ts truncated");
  const tipBranch = checkout.match(/endpoint:\s*"\/api\/billing\/donate"[^}]*body:\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(tipBranch.length > 0, "vacuity anchor: the /api/billing/donate branch is gone from checkoutRequestFor");
  assert.ok(
    /displayName:\s*draft\.displayName/.test(tipBranch),
    "checkoutRequestFor's tip branch no longer forwards the typed name to /api/billing/donate",
  );
});
