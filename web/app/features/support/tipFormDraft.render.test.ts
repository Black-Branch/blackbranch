// A REAL mount, not a source scan. TipForm unmounts on both surfaces whenever
// the checkout box opens (it must — tipFormCheckoutGuard.scan.test.ts pins
// that), so without `initialDraft` a decline-and-retry would silently reset
// the whole draft: pick $25, write a long message, the card declines, tap back
// to retry at $10 → amount resets, message and name are gone. This mounts
// TipForm the way DonateClient/SupportContent do around a checkout round trip
// — submit, unmount, remount with the remembered TipDraft as `initialDraft` —
// and checks the actual DOM, not the source text. tipFormDraft.scan.test.ts
// separately pins that both parent components really do the remembering.
//
// Run: node --test app/features/support/tipFormDraft.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, serveJson } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

// TipForm pulls in useEmotes(), which fetches /api/emotes in an effect. An
// empty manifest is a normal, handled state (the site works without emotes)
// — this just keeps that fetch from hitting the network during the test.
serveJson({});

const { TipForm } = await import("./TipForm.tsx");
type TipDraft = { amount: number; message: string; displayName: string; anonymous: boolean; announce: boolean };
const { createRoot } = await import("react-dom/client");

function mount(props: Parameters<typeof TipForm>[0]) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(TipForm, props)));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

function preset(host: HTMLElement, label: string) {
  return [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
}

function submitButton(host: HTMLElement) {
  return [...host.querySelectorAll("button")].find((b) => /^(Tip \$|Starting)/.test(b.textContent ?? "")) as HTMLButtonElement;
}

test("vacuity anchor: the form actually mounts its controls", () => {
  const m = mount({ busy: false, signedIn: true, initialName: "", onSubmit: () => {} });
  // Filtered to preset-shaped labels, not positional — a signed-in mount
  // also renders the Announce switch (Qorm-for-all-income piece 3, task 2)
  // as the FIRST button, ahead of the presets, so a plain `.slice(0, 4)`
  // would start one button early and cut off $25 (re-pinned, same task).
  const labels = [...m.host.querySelectorAll("button")].map((b) => b.textContent).filter((t) => /^\$\d+$/.test(t ?? ""));
  assert.deepEqual(labels, ["$3", "$5", "$10", "$25"], "preset buttons did not render — every assertion below would check an empty tree");
  assert.ok(m.host.querySelector("textarea"), "the message textarea did not render");
  assert.ok(m.host.querySelector('input[type="checkbox"]'), "the anonymous checkbox did not render");
  m.unmount();
});

test("a submitted draft, remembered and handed back as initialDraft, restores the amount and name exactly", () => {
  let captured: TipDraft | null = null;
  const a = mount({
    busy: false,
    signedIn: true,
    initialName: "Ada",
    initialAmount: 25,
    onSubmit: (d) => { captured = d; },
  });
  assert.ok(preset(a.host, "$25").className.includes("bg-emerald-500"), "the $25 preset did not seed from initialAmount");
  const nameA = a.host.querySelector('input[aria-label="Your name"]') as HTMLInputElement;
  assert.equal(nameA.value, "Ada", "the name did not seed from initialName");

  act(() => { submitButton(a.host).click(); });
  assert.ok(captured, "onSubmit never fired — there is nothing to remember");
  assert.deepEqual(captured, { amount: 25, message: "", displayName: "Ada", anonymous: false, announce: true });
  a.unmount(); // simulates the checkout view swap — TipForm unmounts here on both real surfaces

  // The parent's job (pinned separately by tipFormDraft.scan.test.ts): hand
  // the captured draft back in as initialDraft when the form remounts.
  // initialName/initialAmount are DELIBERATELY different from the captured
  // draft here — a page reload could legitimately re-derive a different
  // initialName, and the point of this assertion is that initialDraft wins
  // over both, not that it happens to agree with them.
  const b = mount({
    busy: false,
    signedIn: true,
    initialName: "Zoe",
    initialAmount: 5,
    initialDraft: captured!,
    onSubmit: () => {},
  });
  assert.ok(preset(b.host, "$25").className.includes("bg-emerald-500"), "the amount was lost on the round trip — it fell back to initialAmount instead of the remembered draft");
  const nameB = b.host.querySelector('input[aria-label="Your name"]') as HTMLInputElement;
  assert.equal(nameB.value, "Ada", "the name was lost on the round trip — it fell back to initialName instead of the remembered draft");
  b.unmount();
});

test("a rich remembered draft — custom amount, a long message, anonymous — survives the round trip", () => {
  const longMessage = "x".repeat(200);
  const draft: TipDraft = { amount: 17, message: longMessage, displayName: "", anonymous: true, announce: true };
  const m = mount({ busy: false, signedIn: true, initialName: "Ada", initialAmount: 5, initialDraft: draft, onSubmit: () => {} });

  // FIX 4 holds for a remembered draft too, not only a `?amount=` link: a
  // non-preset amount must show in the editable box, not just the button.
  for (const label of ["$3", "$5", "$10", "$25"]) {
    assert.ok(!preset(m.host, label).className.includes("bg-emerald-500"), `${label} should not read as selected for a $17 draft`);
  }
  const custom = m.host.querySelector('input[placeholder="Other"]') as HTMLInputElement;
  assert.equal(custom.value, "17", "the $17 draft amount did not seed the custom box");

  const textarea = m.host.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(textarea.value, longMessage, "the message was not restored — this is the decline-path data loss (finding 1)");

  const checkbox = m.host.querySelector('input[type="checkbox"]') as HTMLInputElement;
  assert.equal(checkbox.checked, true, "anonymous was not restored");

  const name = m.host.querySelector('input[aria-label="Your name"]') as HTMLInputElement;
  assert.equal(name.value, "", "the draft's blank displayName was not restored");
  assert.equal(name.disabled, true, "the name box should stay disabled while a restored draft is anonymous");

  m.unmount();
});

test("the name box caps at 32 characters — sanitizeDisplayName's own limit (FIX 2)", () => {
  const m = mount({ busy: false, signedIn: true, initialName: "", onSubmit: () => {} });
  const name = m.host.querySelector('input[aria-label="Your name"]') as HTMLInputElement;
  assert.equal(name.getAttribute("maxlength"), "32", "the box can promise more characters than the server keeps (sanitize.ts slices at 32)");
  m.unmount();
});

test("the account-name hint shows only for a signed-in person whose name box is empty (FIX 3)", () => {
  const signedOut = mount({ busy: false, signedIn: true, initialName: "", onSubmit: () => {} });
  assert.ok(
    !signedOut.host.textContent?.includes("Leave blank to use your account name"),
    "a signed-out person must never see this — for them a blank box really does mean Anonymous",
  );
  signedOut.unmount();

  const signedInFilled = mount({ busy: false, signedIn: true, initialName: "Ada", onSubmit: () => {} });
  assert.ok(
    !signedInFilled.host.textContent?.includes("Leave blank to use your account name"),
    "the hint should not show while the box is prefilled and non-empty",
  );
  signedInFilled.unmount();

  // The case the hint exists for: a signed-in person's box is empty
  // because a remembered draft restored a DELIBERATELY blank, non-anonymous
  // name — donate/route.ts re-fills that from their account, so an
  // empty box here is misleading without the hint.
  const draft: TipDraft = { amount: 5, message: "", displayName: "", anonymous: false, announce: true };
  const signedInEmpty = mount({ busy: false, signedIn: true, initialName: "Ada", initialDraft: draft, onSubmit: () => {} });
  const nameField = signedInEmpty.host.querySelector('input[aria-label="Your name"]') as HTMLInputElement;
  assert.equal(nameField.value, "");
  assert.equal(nameField.disabled, false, "not anonymous — the box should stay editable");
  assert.ok(
    signedInEmpty.host.textContent?.includes('Leave blank to use your account name, or tick "Tip anonymously".'),
    "a signed-in person with an empty, non-anonymous name box should see the hint",
  );
  signedInEmpty.unmount();
});
