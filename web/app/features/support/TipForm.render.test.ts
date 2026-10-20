// TipForm's points copy — the "what people see" half of paying points on tips. A real mount, not
// a source scan: the point is what the tipper actually reads under the amount, signed in and
// signed out, and that it tracks the amount they typed.
//
// `signedIn` is a REQUIRED TipForm prop — every mount() call below supplies it explicitly, as do
// TipPayButton.render.test.ts, tipFormDraft.render.test.ts and tipFormEmoteLock.render.test.ts.
//
// Run: node --test app/features/support/TipForm.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, serveJson } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

// TipForm pulls in useEmotes(), which fetches /api/emotes in an effect. An
// empty manifest is a normal, handled state — this just keeps that fetch from
// hitting the network during the test (same idiom as tipFormDraft.render.test.ts).
serveJson({});

const { TipForm } = await import("./TipForm.tsx");
const { createRoot } = await import("react-dom/client");

function mount(props: Partial<Parameters<typeof TipForm>[0]> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const defaults: Parameters<typeof TipForm>[0] = { busy: false, signedIn: true, initialName: "", onSubmit: () => {} };
  act(() => root.render(React.createElement(TipForm, { ...defaults, ...props })));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

function customAmountInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector('input[placeholder="Other"]') as HTMLInputElement;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("signed in at the $5 default: \"You'll also get\" and \"500 points\" both show", () => {
  const m = mount({ signedIn: true });
  assert.ok(
    m.host.textContent?.includes("You'll also get"),
    `expected the signed-in points line, got: ${m.host.textContent}`,
  );
  assert.ok(
    m.host.textContent?.includes("500 points"),
    `expected 500 points at the $5 default, got: ${m.host.textContent}`,
  );
  m.unmount();
});

test("signed out: \"Sign in to also get 500 points\", with a Sign in link into /auth/signin", () => {
  const m = mount({ signedIn: false });
  assert.ok(
    m.host.textContent?.includes("Sign in to also get 500 points"),
    `expected the signed-out points nudge, got: ${m.host.textContent}`,
  );
  const link = [...m.host.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Sign in");
  assert.ok(link, "vacuity anchor: no \"Sign in\" link rendered");
  assert.ok(
    link!.getAttribute("href")?.startsWith("/auth/signin"),
    `expected the Sign in link to point at /auth/signin, got: ${link!.getAttribute("href")}`,
  );
  m.unmount();
});

test("a signed-in tipper never sees the sign-in nudge", () => {
  const m = mount({ signedIn: true });
  assert.ok(!m.host.textContent?.includes("Sign in to also get"), "a signed-in tipper should not see the signed-out copy");
  assert.ok(![...m.host.querySelectorAll("a")].some((a) => a.textContent?.trim() === "Sign in"), "no Sign in link for a signed-in tipper");
  m.unmount();
});

test("changing the amount to 12.34 shows 1,234 points (1 point per cent, rounded)", () => {
  const m = mount({ signedIn: true });
  setValue(customAmountInput(m.host), "12.34");
  assert.ok(
    m.host.textContent?.includes("1,234 points"),
    `expected 1,234 points for a $12.34 tip, got: ${m.host.textContent}`,
  );
  m.unmount();
});

test("picking the $25 preset shows 2,500 points", () => {
  const m = mount({ signedIn: true });
  const preset25 = [...m.host.querySelectorAll("button")].find((b) => b.textContent === "$25") as HTMLButtonElement;
  assert.ok(preset25, "vacuity anchor: no $25 preset button rendered");
  act(() => { preset25.click(); });
  assert.ok(
    m.host.textContent?.includes("2,500 points"),
    `expected 2,500 points for the $25 preset, got: ${m.host.textContent}`,
  );
  m.unmount();
});

// The Announce switch (Qorm-for-all-income piece 3, task 2): off turns this
// form into a quiet points purchase — no name, message or anonymous option,
// and the submit button becomes TipPayButton's gold "Buy N points" half.
function announceSwitch(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector('button[role="switch"][aria-label="Announce on stream"]');
}
function mainButtonText(host: HTMLElement): string {
  return [...host.querySelectorAll("button")].map((b) => b.textContent ?? "").join(" | ");
}

test("signed in: the switch shows, starts ON, and the form is today's tip form", () => {
  const m = mount({ signedIn: true });
  const sw = announceSwitch(m.host);
  assert.ok(sw, "the Announce switch must render for a signed-in person");
  assert.equal(sw!.getAttribute("aria-checked"), "true");
  assert.ok(m.host.querySelector("textarea"), "message box shows while announcing");
  assert.ok(m.host.textContent?.includes("Tip anonymously"));
  assert.match(mainButtonText(m.host), /Tip \$5/);
  m.unmount();
});

test("switch off: no name, message or anonymous; gold 'Buy 500 points'; 'You'll get' without 'also'", () => {
  const m = mount({ signedIn: true });
  act(() => { announceSwitch(m.host)!.click(); });
  assert.equal(announceSwitch(m.host)!.getAttribute("aria-checked"), "false");
  assert.equal(m.host.querySelector("textarea"), null, "no message box when quiet");
  assert.equal(m.host.querySelector('input[aria-label="Your name"]'), null, "no name box when quiet");
  assert.ok(!m.host.textContent?.includes("Tip anonymously"), "no anonymous option when quiet");
  assert.match(mainButtonText(m.host), /Buy 500 points/);
  assert.ok(m.host.textContent?.includes("You'll get"), `got: ${m.host.textContent}`);
  assert.ok(!m.host.textContent?.includes("also get"), "a quiet buy is not 'also' getting points");
  m.unmount();
});

test("initialAnnounce={false} starts quiet (the Store)", () => {
  const m = mount({ signedIn: true, initialAnnounce: false });
  assert.equal(announceSwitch(m.host)!.getAttribute("aria-checked"), "false");
  assert.match(mainButtonText(m.host), /Buy 500 points/);
  m.unmount();
});

test("a remembered quiet draft reopens quiet, at its amount", () => {
  const m = mount({
    signedIn: true,
    initialDraft: { amount: 25, message: "", displayName: "", anonymous: false, announce: false },
  });
  assert.equal(announceSwitch(m.host)!.getAttribute("aria-checked"), "false");
  assert.match(mainButtonText(m.host), /Buy 2,500 points/);
  m.unmount();
});

test("signed out: no switch and always a tip, even from a quiet draft", () => {
  const m = mount({
    signedIn: false,
    initialDraft: { amount: 5, message: "", displayName: "", anonymous: false, announce: false },
  });
  assert.equal(announceSwitch(m.host), null, "a guest has no wallet — no switch");
  assert.ok(m.host.querySelector("textarea"), "a guest always gets the tip form");
  assert.match(mainButtonText(m.host), /Tip \$5/);
  m.unmount();
});

test("the card submit carries announce, and a quiet draft carries no message or name", () => {
  const seen: unknown[] = [];
  const m = mount({ signedIn: true, initialName: "Real Person", onSubmit: (d) => seen.push(d) });
  const textarea = m.host.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(textarea, "hello"); textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  act(() => { announceSwitch(m.host)!.click(); });
  const buy = [...m.host.querySelectorAll("button")].find((b) => /Buy 500 points/.test(b.textContent ?? ""))!;
  act(() => { buy.click(); });
  assert.deepEqual(seen.at(-1), { amount: 5, message: "", displayName: "", anonymous: false, announce: false });
  m.unmount();
});

test("switch off ignores an over-long hidden message", () => {
  const m = mount({ signedIn: true });
  const textarea = m.host.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(textarea, "x".repeat(600)); textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  // Vacuity anchor: before flipping the switch, confirm the over-long
  // message actually disabled the card button — otherwise the assertion
  // below would pass even if messageTooLong never took hold.
  const tipButton = [...m.host.querySelectorAll("button")].find((b) => /Tip \$5/.test(b.textContent ?? "")) as HTMLButtonElement;
  assert.equal(tipButton.disabled, true, "the over-long message must disable the Tip button while announcing, or this test proves nothing");
  act(() => { announceSwitch(m.host)!.click(); });
  const buy = [...m.host.querySelectorAll("button")].find((b) => /Buy 500 points/.test(b.textContent ?? ""))!;
  assert.equal(buy.disabled, false, "a message nobody will hear must not block a quiet buy");
  m.unmount();
});

test("flipping the switch off and back on does not reset a typed message", () => {
  const m = mount({ signedIn: true });
  const textarea = m.host.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(textarea, "hello"); textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  act(() => { announceSwitch(m.host)!.click(); }); // off
  act(() => { announceSwitch(m.host)!.click(); }); // on again
  const textareaAgain = m.host.querySelector("textarea") as HTMLTextAreaElement;
  assert.ok(textareaAgain, "vacuity anchor: message box must be back once announcing again");
  assert.equal(textareaAgain.value, "hello", "flipping the switch must not reset what was typed");
  m.unmount();
});

// The anonymous checkbox's helper line (k, 2026-10-19): what "anonymous" does and does not hide.
// Exact wording from k. It is always rendered while the checkbox is — never toggled with it — so
// ticking the box cannot move anything below it (the phone-width layout-shift concern): the same
// node, same text, checked or not. jsdom has no layout, so "nothing moves" is asserted as "the
// same node stays", which is what a shift would need to break.
const ANON_HELP = "Hides your name from public alerts and chat. The payment provider and site operator still have payment records.";

function anonCheckbox(host: HTMLElement): HTMLInputElement {
  const box = [...host.querySelectorAll('input[type="checkbox"]')].find((el) => el.closest("label")?.textContent?.includes("Tip anonymously"));
  assert.ok(box, "vacuity anchor: the anonymous checkbox is gone");
  return box as HTMLInputElement;
}
function describedBy(box: HTMLInputElement): Element | null {
  const id = box.getAttribute("aria-describedby");
  assert.ok(id, "the checkbox must be described by its helper line");
  return dom.window.document.getElementById(id!);
}

test("anonymous: the helper line under the checkbox says exactly k's words, and the checkbox points at it", () => {
  const m = mount({ signedIn: true });
  const box = anonCheckbox(m.host);
  const help = describedBy(box);
  assert.ok(help, "aria-describedby must name a node on the page");
  assert.equal(help!.textContent, ANON_HELP);
  assert.equal(help!.className, "mt-1 text-xs text-body-dim", "the form's own helper-line style, no new class or colour");
  assert.equal(box.closest("label")!.nextElementSibling, help, "the helper sits directly under the checkbox");
  m.unmount();
});

test("anonymous: ticking the box keeps the same helper node and text — nothing below moves", () => {
  const m = mount({ signedIn: true });
  const before = describedBy(anonCheckbox(m.host));
  act(() => { anonCheckbox(m.host).click(); });
  assert.equal(anonCheckbox(m.host).checked, true);
  const after = describedBy(anonCheckbox(m.host));
  assert.equal(after, before, "the helper must be the same node checked or not");
  assert.equal(after!.textContent, ANON_HELP);
  m.unmount();
});

test("anonymous: a quiet points purchase has no anonymous option, so no helper line either", () => {
  const m = mount({ signedIn: true, initialAnnounce: false });
  assert.match(mainButtonText(m.host), /Buy 500 points/, "vacuity anchor: the quiet form rendered");
  assert.ok(!m.host.textContent?.includes(ANON_HELP));
  m.unmount();
});
