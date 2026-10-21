// The Admin Panel's setting rows, mounted: a choice and a text box start from the current value, a
// list is its items with add and remove (and a save carries the whole list), every restart setting
// raises the pending-restart banner, and a setting the host applies says "Applying…" on a bundle and
// "Managed outside Black Branch" on an install that is not one.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/keyCards.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: KeyCards } = await import("./KeyCards.tsx");
const { createRoot } = await import("react-dom/client");

type Pkg = "web" | "stream-api" | "stream-ingest";
const key = (over: Record<string, unknown>) => ({
  key: "x", label: "X", description: "", tier: "instance", kind: "string", secret: false, reload: "live", module: "core",
  defaultValue: null, testable: false, envNames: [], hostApplied: false, stored: null, tests: [], disagree: false,
  packages: [{ package: "web" as Pkg, known: true, source: "database", envName: null, display: null as unknown, error: null, envOverrides: false }],
  ...over,
});
const pkg = (p: Pkg, display: unknown, source = "database") => ({ package: p, known: true, source, envName: null, display, error: null, envOverrides: false });

const KEYS = [
  key({ key: "auth.federatedSignin", label: "Sign-in from other Matrix servers", kind: "enum", values: ["off", "on", "allowlist"],
    stored: { display: "allowlist", updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" }, packages: [pkg("web", "allowlist")] }),
  key({ key: "auth.federatedDeny", label: "Servers refused sign-in", kind: "list",
    stored: { display: ["one.test", "two.test"], updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" }, packages: [pkg("web", ["one.test", "two.test"])] }),
  key({ key: "streamer.displayName", label: "Streamer name", packages: [pkg("web", "Casey")] }),
  key({ key: "platform.twitch.channel", label: "Twitch channel", reload: "restart",
    stored: { display: "newchan", updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" },
    packages: [pkg("web", "newchan"), pkg("stream-ingest", "oldchan")] }),
  key({ key: "modules.obs", label: "OBS", kind: "bool", reload: "restart",
    stored: { display: true, updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" },
    packages: [pkg("web", true), pkg("stream-api", true)] }),
  key({ key: "modules.stripe", label: "Card payments", kind: "bool", reload: "live", packages: [pkg("web", true)] }),
  key({ key: "matrix.federation", label: "Federation", kind: "bool", reload: "restart", hostApplied: true,
    stored: { display: true, updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" }, packages: [pkg("web", true)] }),
];
const GROUPS = [{ section: "site", sub: "general", title: "Card", keys: KEYS.map((k) => k.key) }];
const view = (over: Record<string, unknown> = {}) => ({ processes: [], keys: KEYS, botName: null, botSpeakOn: null, canRestart: true, bundle: true, render: null, ...over });

let sent: { url: string; method: string; body: unknown }[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function mount(v = view()) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(KeyCards as never, { view: v, groups: GROUPS, onChanged: () => {}, note: () => {} }));
  });
  return { el, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}
const rowOf = (el: Element, k: string) => el.querySelector(`[data-key="${k}"]`)!;
async function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event(input instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const submit = (form: Element) => act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });

test("a choice and a text box start from what is set now; nothing to save until it changes", async () => {
  const { el, unmount } = await mount();
  const select = rowOf(el, "auth.federatedSignin").querySelector("select")!;
  assert.equal(select.value, "allowlist", "the dropdown shows the current mode, not 'choose…'");
  assert.equal(select.querySelector('option[value=""]'), null);
  const name = rowOf(el, "streamer.displayName").querySelector("input")!;
  assert.equal(name.value, "Casey");
  const save = rowOf(el, "streamer.displayName").querySelector('button[type="submit"]') as HTMLButtonElement;
  assert.equal(save.disabled, true, "unchanged: Save is off");
  sent = [];
  await type(select, "on");
  await submit(rowOf(el, "auth.federatedSignin").querySelector("form")!);
  assert.deepEqual(sent, [{ url: "/api/admin/instance/auth.federatedSignin", method: "PUT", body: { value: "on" } }]);
  await unmount();
});

test("a list is its items: adding one saves the WHOLE list, removing one saves the rest", async () => {
  const { el, unmount } = await mount();
  const row = rowOf(el, "auth.federatedDeny");
  const chips = [...row.querySelectorAll('[aria-label="Servers refused sign-in now"] li')].map((li) => li.querySelector(".font-mono")?.textContent);
  assert.deepEqual(chips, ["one.test", "two.test"]);
  sent = [];
  await type(row.querySelector("input")!, "three.test");
  await submit(row.querySelector("form")!);
  assert.deepEqual(sent.map((x) => x.body), [{ value: ["one.test", "two.test", "three.test"] }], "typing one server keeps the others");
  sent = [];
  await act(async () => { (row.querySelector('button[aria-label="Remove one.test"]') as HTMLButtonElement).click(); });
  assert.deepEqual(sent.map((x) => x.body), [{ value: ["two.test"] }]);
  await unmount();
});

test("a restart setting that is not a switch raises the pending-restart banner with its Restart button", async () => {
  const { el, unmount } = await mount();
  const banner = el.querySelector("[data-pending-restart]")!;
  assert.ok(banner, "the banner is up");
  assert.match(banner.textContent ?? "", /still runs the old value of Twitch channel/);
  assert.match(banner.textContent ?? "", /Restart the /);
  assert.match(rowOf(el, "platform.twitch.channel").textContent ?? "", /Waiting for a restart/);
  await unmount();
});

test("a module the chat service runs: the website follows that service's restart, never 'at once'", async () => {
  // modules.obs, not an owner-only module: the public cut has no site plugin, and KeyCards hides a key
  // of an owner-only module the install does not have — so a radio row is null there.
  const { el, unmount } = await mount();
  const when = rowOf(el, "modules.obs").querySelector('[aria-label="When it applies"]')!.textContent ?? "";
  assert.match(when, /when the .+ restarts — it shows the module from that service's report/);
  assert.doesNotMatch(when, /at once/);
  assert.equal(rowOf(el, "modules.stripe").querySelector('[aria-label="When it applies"]'), null, "a switch only the website reads: no restart list");
  await unmount();
});

test("a host-applied switch on a bundle: Applying… until the host's render answers, then its result", async () => {
  const a = await mount();
  const fed = rowOf(a.el, "matrix.federation");
  assert.ok(fed.querySelector('[role="switch"]'), "the switch is there");
  assert.equal(fed.querySelector("[data-host-apply]")?.getAttribute("data-host-apply"), "applying");
  assert.equal(a.el.querySelector("[data-pending-restart]")?.textContent?.includes("Federation"), false, "it waits for the host, not a restart");
  await a.unmount();
  const b = await mount(view({ render: { ok: false, at: "2026-10-18T09:00:40Z", message: "the homeserver did not start" } }));
  assert.match(rowOf(b.el, "matrix.federation").textContent ?? "", /The server could not apply it: the homeserver did not start/);
  await b.unmount();
});

test("not a bundle: the host-applied switch is 'Managed outside Black Branch', read-only, with where to change it", async () => {
  const { el, unmount } = await mount(view({ bundle: false, canRestart: false }));
  const fed = rowOf(el, "matrix.federation");
  assert.ok(fed.querySelector("[data-managed-outside]"));
  assert.match(fed.textContent ?? "", /Managed outside Black Branch/);
  assert.match(fed.textContent ?? "", /set in the homeserver's own config/);
  assert.equal(fed.querySelector('[role="switch"]'), null, "no switch that would change nothing");
  assert.equal(fed.querySelector("[data-host-apply]"), null);
  // The rest of the card stays editable.
  assert.ok(rowOf(el, "auth.federatedSignin").querySelector("select"));
  await unmount();
});

test("the federation switch's FIRST render is the saved value — never on for an install whose setup saved it off", async () => {
  const fedRow = (stored: unknown, web: unknown) => key({ key: "matrix.federation", label: "Federation", kind: "bool", reload: "restart", hostApplied: true, defaultValue: false,
    stored: stored === undefined ? null : { display: stored, updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" }, packages: [pkg("web", web)] });
  const cases: [string, unknown, unknown, string][] = [
    ["saved off, the website still reading on", false, true, "false"],
    ["saved off", false, false, "false"],
    ["nothing saved (setup left the default), the website reads off", undefined, false, "false"],
    ["nothing saved, the website not reporting yet", undefined, null, "false"],
    ["saved on", true, true, "true"],
  ];
  for (const [name, stored, web, want] of cases) {
    const { el, unmount } = await mount(view({ keys: [fedRow(stored, web)] }));
    const sw = rowOf(el, "matrix.federation").querySelector('[role="switch"]');
    assert.ok(sw, `${name}: the switch is there`);
    assert.equal(sw!.getAttribute("aria-checked"), want, name);
    assert.equal(rowOf(el, "matrix.federation").textContent?.includes(want === "true" ? "On" : "Off"), true, `${name}: the word beside it agrees`);
    await unmount();
  }
});
