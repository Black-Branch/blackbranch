// The setup pages, mounted for real: opaque buttons, a Check per pasted value
// (format first, then the live test), the Stripe price on the Stripe page, the donate link and the
// OBS note on the modules page, the time zone list filled from the browser, the zone beside
// the quiet hour, and what the community step made.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/features/setup/SetupWizard.pages.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

// Every request the page makes. Answers are set per test.
const posts: { url: string; body: unknown }[] = [];
let answer: (url: string, body: unknown) => unknown = () => ({});
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : null;
  posts.push({ url: String(url), body });
  return new Response(JSON.stringify(answer(String(url), body)), { status: 200, headers: { "content-type": "application/json" } });
};

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
const { SetupWizard } = await import("./SetupWizard.tsx");
const { moduleSetupPage } = await import("../../lib/setup/setupPages.ts");
const { SITE_FIELDS } = await import("../../lib/setup/setupValidate.ts");
const { createRoot } = await import("react-dom/client");

const ADDRESSES = { origin: "https://site.test", apiOrigin: "https://api.site.test", matrixOrigin: "https://matrix.site.test", serverName: "site.test" };
const ORDER = ["recovery", "site", "points", "modules", "module:stripe", "community", "finish"];

function mount(step: string, data: Record<string, unknown>) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
    React.createElement(SetupWizard, { view: { phase: "wizard", me: "@casey:site.test", step, order: ORDER, data }, siteName: "Gadget", serverName: "site.test", domain: "site.test", token: null }))));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
const stripeData = (values: Record<string, string> = {}) => ({ page: moduleSetupPage("stripe", ADDRESSES, { wizard: true }), values, isSet: {}, skipped: [] });
const type = (el: HTMLInputElement, v: string) => act(() => {
  const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  set.call(el, v); el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const submit = async (host: HTMLElement) => { await act(async () => { host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); };

test("W14: every button on a setup page has an opaque background — no translucent surface a see-through theme erases", () => {
  for (const [step, data] of [["module:stripe", stripeData()], ["site", { fields: SITE_FIELDS, values: {}, icons: { upload: true, staged: false } }],
    ["modules", { modules: [{ id: "obs", label: "OBS control", description: "d", on: true, hasSetup: true, note: "n" }], core: [], later: [] }]] as const) {
    const m = mount(step, data as Record<string, unknown>);
    const buttons = [...m.host.querySelectorAll("button")].filter((b) => b.getAttribute("role") !== "switch");
    assert.ok(buttons.length >= 1, `vacuity anchor: ${step} drew no button`);
    // The file picker's own button is styled too (file:bg-raised).
    for (const f of m.host.querySelectorAll('input[type="file"]')) assert.match(f.className, /file:bg-raised/);
    for (const b of buttons) {
      assert.doesNotMatch(b.className, /\bbg-surface-/, `${step}: "${b.textContent}" has a translucent background`);
      assert.match(b.className, /\bbg-(raised|strong)\b/, `${step}: "${b.textContent}" has no explicit background`);
    }
    m.unmount();
  }
});

test("contract 6: the Stripe page has the price field with its own Check; a product id is refused by its shape without asking anyone", async () => {
  posts.length = 0;
  const m = mount("module:stripe", stripeData());
  const field = m.host.querySelector('input[id="bb-stripe.supporterPriceId"]') as HTMLInputElement;
  assert.ok(field, "the price field is on the Stripe page");
  type(field, "prod_QxYzAbCdEf");
  await click(m.host.querySelector('button[aria-label="Check Supporter subscription price"]')!);
  assert.match(m.host.textContent ?? "", /✗ a price id starts price_ \(not the product id, prod_\)/);
  assert.equal(posts.length, 0, "a value of the wrong shape never reaches the server");
  // …and Continue refuses it too, naming the field.
  await submit(m.host);
  assert.match(m.host.querySelector('[role="alert"]')?.textContent ?? "", /Supporter subscription price: a price id starts price_/);
  assert.equal(posts.length, 0);
  m.unmount();
});

test("a well-shaped price: Check saves the page (staying on it), then runs the price's live check, and shows its words", async () => {
  posts.length = 0;
  answer = (url) => url === "/api/setup/test" ? { ok: true, results: [{ package: "web", ok: true, detail: "found: $5.00 a month (test)" }] } : { ok: true };
  const m = mount("module:stripe", stripeData());
  type(m.host.querySelector('input[id="bb-stripe.supporterPriceId"]') as HTMLInputElement, "price_1QxYzAbCdEf");
  const check = m.host.querySelector('button[aria-label="Check Supporter subscription price"]')!;
  await click(check);
  assert.deepEqual(posts.map((p) => p.url), ["/api/setup/step", "/api/setup/test"]);
  assert.deepEqual(posts[0]!.body, { step: "module:stripe", data: { values: { "stripe.supporterPriceId": "price_1QxYzAbCdEf" }, skipped: [] }, stay: true });
  assert.deepEqual(posts[1]!.body, { key: "stripe.supporterPriceId" });
  assert.match(m.host.textContent ?? "", /✓ found: \$5\.00 a month \(test\)/);
  // Retry: a second press sends the same two requests again — nothing accumulates.
  await click(check);
  assert.deepEqual(posts.slice(2), posts.slice(0, 2));
  answer = () => ({});
  m.unmount();
});

test("restart: the page drawn again from what was saved shows the saved price and offers the same Check", () => {
  const m = mount("module:stripe", stripeData({ "stripe.supporterPriceId": "price_1QxYzAbCdEf" }));
  assert.equal((m.host.querySelector('input[id="bb-stripe.supporterPriceId"]') as HTMLInputElement).value, "price_1QxYzAbCdEf");
  assert.ok(m.host.querySelector('button[aria-label="Check Supporter subscription price"]'));
  m.unmount();
});

test("the modules page: the OBS note says where its setup went (W3); the donate link is checked before it is saved", async () => {
  posts.length = 0;
  const data = { modules: [{ id: "obs", label: "OBS control", description: "d", on: true, hasSetup: true, note: "Its setup is in the Admin Panel (Utility → OBS)." }], core: [], later: [], donateUrl: "" };
  const m = mount("modules", data);
  assert.match(m.host.textContent ?? "", /Its setup is in the Admin Panel \(Utility → OBS\)/);
  const link = m.host.querySelector("#bb-donate-url") as HTMLInputElement;
  type(link, "ko-fi.com/casey");
  await submit(m.host);
  assert.equal(posts.length, 0, "an address without https:// is refused before saving");
  assert.match(m.host.textContent ?? "", /Donate link: a full https:\/\/ address/);
  type(link, "https://ko-fi.com/casey");
  await submit(m.host);
  assert.deepEqual(posts.map((p) => p.body), [{ step: "modules", data: { modules: { obs: true }, core: [], donateUrl: "https://ko-fi.com/casey" } }]);
  m.unmount();
});

test("W1: the time zone field is a list of every zone, filled from this browser when nothing is saved — and that is what is saved", async () => {
  posts.length = 0;
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.ok(browser, "vacuity anchor: this runtime has a zone to fill in");
  const m = mount("site", { fields: SITE_FIELDS, values: { SITE_NAME: "Gadget" }, icons: { upload: false, staged: false } });
  const tz = m.host.querySelector('input[id="bb-SITE_TIME_ZONE"]') as HTMLInputElement;
  assert.equal(tz.getAttribute("list"), "bb-time-zones");
  assert.ok(m.host.querySelectorAll('datalist[id="bb-time-zones"] option').length > 300, "every zone the browser knows");
  assert.equal(tz.value, browser);
  assert.match(m.host.textContent ?? "", /Filled in from this browser/);
  await submit(m.host);
  assert.equal((posts[0]!.body as { data: Record<string, string> }).data.SITE_TIME_ZONE, browser, "the zone shown is the zone saved");
  // Cleared on purpose: it stays empty (UTC, and the page says so) — the browser's zone does not come back.
  type(tz, "");
  assert.equal(tz.value, "");
  assert.match(m.host.textContent ?? "", /Empty means UTC/);
  m.unmount();
  // A saved zone is kept, never overwritten by the browser's.
  const saved = mount("site", { fields: SITE_FIELDS, values: { SITE_NAME: "Gadget", SITE_TIME_ZONE: "Pacific/Auckland" }, icons: { upload: false, staged: false } });
  assert.equal((saved.host.querySelector('input[id="bb-SITE_TIME_ZONE"]') as HTMLInputElement).value, "Pacific/Auckland");
  assert.doesNotMatch(saved.host.textContent ?? "", /Filled in from this browser/);
  saved.unmount();
});

test("W22: the streamer display name is on Your site with the value the server starts it from", () => {
  const m = mount("site", { fields: SITE_FIELDS, values: { SITE_NAME: "Gadget", STREAMER_DISPLAY_NAME: "casey" }, icons: { upload: false, staged: false } });
  assert.equal((m.host.querySelector('input[id="bb-STREAMER_DISPLAY_NAME"]') as HTMLInputElement).value, "casey");
  m.unmount();
});

test("R1.8: the quiet hour names its zone — and says (UTC) when none was set", () => {
  const base = { quietHour: 4, bugReports: false, pending: [], hostRequests: false, signup: undefined, alerts: { set: null, words: "" }, backup: {} };
  const utc = mount("finish", { ...base, timeZone: null });
  assert.match(utc.host.textContent ?? "", /The hour is in \(UTC\) — no time zone was set on Your site/);
  utc.unmount();
  const la = mount("finish", { ...base, timeZone: "America/New_York" });
  assert.match(la.host.textContent ?? "", /The hour is in America\/New_York\./);
  la.unmount();
});

test("W12: the community step says what was made", () => {
  const m = mount("community", { federation: false, registration: "closed", hub: "!a:site.test", general: "!b:site.test", serverName: "site.test", hostRequests: true,
    made: "Made: the space “Gadget” (your community's home) and #general for chat. They belong to your account, and you are in each." });
  assert.match(m.host.textContent ?? "", /✓ Made: the space “Gadget”/);
  assert.doesNotMatch(m.host.textContent ?? "", /the space and #general exist/);
  m.unmount();
});

test("the read-aloud switch is a switch, sent as the setting's own words", async () => {
  posts.length = 0;
  const { wizardListPage } = await import("../../lib/setup/setupPages.ts");
  const m = mount("core:voice", { page: wizardListPage("voice", ADDRESSES), values: { "tts.enabled": "false" }, isSet: {}, skipped: [] });
  const sw = m.host.querySelector('button[role="switch"]')!;
  assert.ok(sw, "tts.enabled is drawn as a switch");
  await click(sw);
  await submit(m.host);
  assert.equal((posts[0]!.body as { data: { values: Record<string, string> } }).data.values["tts.enabled"], "true");
  m.unmount();
});
