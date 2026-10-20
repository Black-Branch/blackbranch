// The setup wizard's payment pages warn about the operator's legal name and home address BEFORE
// the keys that take live money are pasted (k, 2026-10-19; product wording from the docs page
// "Protect your personal name and home address"). A warning, not a gate: no checkbox, no "I
// checked" value, nothing new saved. A real mount of the wizard on each module page.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/features/setup/SetupWizard.paymentWarning.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

// Every request the page makes, with its body: rendering must make none, and saving must send
// only what the page already sent before the warning existed.
const posts: { url: string; body: unknown }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : null });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
const { SetupWizard } = await import("./SetupWizard.tsx");
const { moduleSetupPage } = await import("../../lib/setup/setupPages.ts");
const { createRoot } = await import("react-dom/client");

const ADDRESSES = { origin: "https://site.test", apiOrigin: "https://api.site.test", matrixOrigin: "https://matrix.site.test", serverName: "site.test" };
const ORDER = ["recovery", "site", "points", "modules", "module:youtube", "module:stripe", "module:paypal", "community", "finish"];

function mountModule(id: string) {
  const page = moduleSetupPage(id, ADDRESSES);
  assert.ok(page, `vacuity anchor: module ${id} has no setup page`);
  const view = { phase: "wizard" as const, me: "@casey:site.test", step: `module:${id}`, order: ORDER, data: { page, values: {}, isSet: {}, skipped: [] } };
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
    React.createElement(SetupWizard, { view, siteName: "Gadget", serverName: "site.test", domain: "site.test", token: null }))));
  return { host, page: page!, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const warning = (host: HTMLElement) => host.querySelector('[data-setup-warning="payment-identity"]');

for (const [id, provider, keyStep] of [["stripe", "Stripe", "A restricted key and the publishable key"], ["paypal", "PayPal", "Your PayPal app"]] as const) {
  test(`${id}: the name-and-address warning is on the page, in plain words, before the step that takes the live keys`, () => {
    posts.length = 0;
    const m = mountModule(id);
    const w = warning(m.host);
    assert.ok(w, "the warning must be on the payment page");
    const text = w!.textContent ?? "";
    for (const must of [
      provider,
      "legal name",
      "home address",
      "public business name",
      "support address",
      "statement",
      "cannot change",
      "receipt",
      "invoice",
      "test mode",
      "live keys",
    ]) assert.ok(text.includes(must), `the warning must say "${must}" — got: ${text}`);
    assert.doesNotMatch(text, /\bwe\b|\bour\b/i, "plain language, \"you\" — never \"we\"");
    // Before the step whose fields hold the keys that take live money.
    const steps = [...m.host.querySelectorAll("h3")];
    const keys = steps.find((h) => h.textContent === keyStep);
    assert.ok(keys, `vacuity anchor: the "${keyStep}" step is gone`);
    assert.ok(w!.compareDocumentPosition(keys!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "the warning must come before the keys step");
    // A warning, not a gate: nothing to tick, nothing to fill, no link out.
    assert.equal(w!.querySelector("input, select, textarea, button"), null, "no control inside the warning — it records nothing");
    assert.equal(w!.querySelector("a"), null, "the wizard links no docs pages, so neither does this");
    assert.equal(posts.length, 0, "rendering the page must not write anything");
    m.unmount();
  });

  test(`${id}: saving the page sends exactly what it sent before — the warning adds no setting`, async () => {
    posts.length = 0;
    const m = mountModule(id);
    // Skip every required step so the page submits without values.
    const skips = [...m.host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    assert.equal(skips.length, m.page.steps.length, "only the per-step skip boxes are checkboxes — the warning added none");
    for (const s of skips) act(() => { s.click(); });
    const form = m.host.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    const saves = posts.filter((p) => p.url === "/api/setup/step");
    assert.equal(saves.length, 1, "one save");
    assert.deepEqual(saves[0]!.body, { step: `module:${id}`, data: { values: {}, skipped: m.page.steps.map((s) => s.id) } });
    m.unmount();
  });
}

test("restart: the page re-drawn from what was saved (keys set, a step skipped) shows the warning again — it remembers nothing", () => {
  const page = moduleSetupPage("stripe", ADDRESSES)!;
  const data = { page, values: { "stripe.publishableKey": "pk_test_x" }, isSet: { "stripe.secretKey": true, "stripe.publishableKey": true }, skipped: ["stripe:cloudflare"] };
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
    React.createElement(SetupWizard, { view: { phase: "wizard", me: "@casey:site.test", step: "module:stripe", order: ORDER, data }, siteName: "Gadget", serverName: "site.test", domain: "site.test", token: null }))));
  assert.ok(warning(host), "a warning has no 'seen' state to hide it after a restart");
  act(() => root.unmount()); host.remove();
});

test("retry: saving the payment page twice sends the same body twice — no setting appears on the second save", async () => {
  posts.length = 0;
  const m = mountModule("paypal");
  for (const s of [...m.host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]) act(() => { s.click(); });
  const form = m.host.querySelector("form")!;
  for (let i = 0; i < 2; i++) await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  const saves = posts.filter((p) => p.url === "/api/setup/step");
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1]!.body, saves[0]!.body);
  assert.deepEqual(Object.keys((saves[1]!.body as { data: object }).data), ["values", "skipped"]);
  m.unmount();
});

test("a module that takes no money has no payment warning", () => {
  const m = mountModule("youtube");
  assert.ok(m.host.querySelector("h3"), "vacuity anchor: the YouTube page rendered its steps");
  assert.equal(warning(m.host), null);
  m.unmount();
});
