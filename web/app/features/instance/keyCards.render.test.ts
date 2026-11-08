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

async function mountGroups(groups: unknown[], keys: unknown[]) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(KeyCards as never, { view: view({ keys }), groups, onChanged: () => {}, note: () => {} }));
  });
  return { el, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}

test("the Install values card: closed, every row its value with a lock, nothing to type or save, even for a database setting", async () => {
  const keys = [
    key({ key: "site.origin", label: "Site address", tier: "install", reload: "restart", envNames: ["SITE_ORIGIN"], packages: [pkg("web", "https://site.test", "env")] }),
    key({ key: "matrix.rooms.hub", label: "Community space room", envNames: ["MATRIX_HUB_ROOM_ID"], packages: [pkg("web", "!space:site.test")] }),
    key({ key: "site.legacyId", label: "Legacy site id", tier: "install", reload: "restart", envNames: ["SITE_LEGACY_ID"], packages: [pkg("web", null, "unset")] }),
  ];
  const card = { section: "site", sub: "general", title: "Install values", readOnly: true, folded: true, blurb: "change it on the server",
    keys: keys.map((k) => k.key), hideUnset: ["site.legacyId"] };
  const { el, unmount } = await mountGroups([card], keys);
  const fold = el.querySelector("details[data-folded-card]") as HTMLDetailsElement;
  assert.ok(fold, "a fold");
  assert.equal(fold.open, false, "closed until opened");
  assert.equal(fold.querySelector("summary")?.textContent, "Install values");
  assert.equal(el.querySelectorAll("[data-key]").length, 2, "the unset legacy id is not a row");
  for (const [k, v] of [["site.origin", "https://site.test"], ["matrix.rooms.hub", "!space:site.test"]] as const) {
    const row = rowOf(el, k);
    assert.ok(row.querySelector("[data-locked-value]")?.textContent?.includes(v), `${k} shows its value`);
    assert.equal(row.querySelector("input, select, button[type=submit]"), null, `${k}: nothing to edit`);
  }
  assert.match(rowOf(el, "matrix.rooms.hub").textContent ?? "", /MATRIX_HUB_ROOM_ID on the server/, "a card without its own note: the env line");
  await unmount();
});

test("a sign-in provider's switch shows the redirect URL to paste at the provider, with a Copy button", async () => {
  const url = "https://matrix.site.test/auth/upstream/callback/01M6W7E48SQRP7WM6CF3PM0QQH";
  const sw = key({ key: "signin.discord.enabled", label: "Sign in with Discord", kind: "bool", reload: "restart", hostApplied: true,
    paste: { label: "Redirect URL to paste at the provider", value: url }, packages: [pkg("web", false)] });
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(KeyCards as never, { view: view({ keys: [sw] }), groups: [{ section: "site", sub: "general", title: "Sign-in providers", keys: [sw.key] }], onChanged: () => {}, note: () => {} }));
  });
  const row = rowOf(el, "signin.discord.enabled");
  const paste = row.querySelector("[data-paste]");
  assert.ok(paste, "the URL is on the switch's row, shown while the switch is off too");
  assert.equal(paste.querySelector("code")?.textContent, url);
  assert.match(paste.textContent ?? "", /Redirect URL to paste at the provider/);
  assert.ok(paste.querySelector('button[aria-label="Copy Redirect URL to paste at the provider"]'));
  // A row without one shows none.
  await act(async () => { root.unmount(); });
  const { el: plain, unmount } = await mount();
  assert.equal(plain.querySelector("[data-paste]"), null);
  await unmount(); el.remove();
});

test("the time zone is picked from a list of zone names, starting from the saved one", async () => {
  const tz = key({ key: "site.timeZone", label: "Time zone", packages: [pkg("web", "Europe/Berlin")] });
  const { el, unmount } = await mountGroups([{ section: "site", sub: "general", title: "Running", keys: ["site.timeZone"] }], [tz]);
  const select = rowOf(el, "site.timeZone").querySelector("select");
  assert.ok(select, "a pick list, not a text box");
  assert.equal(select!.value, "Europe/Berlin");
  const zones = [...select!.querySelectorAll("option")].map((o) => o.value);
  assert.ok(zones.length > 100 && zones.includes("America/New_York"), `${zones.length} zones offered`);
  await unmount();
});

test("Let people make accounts reads Yes or No, and saves the stored open or closed", async () => {
  const reg = key({ key: "matrix.registration", label: "Let people make accounts", kind: "enum", values: ["open", "closed"], packages: [pkg("web", "closed")] });
  const { el, unmount } = await mountGroups([{ section: "site", sub: "general", title: "Community", keys: ["matrix.registration"] }], [reg]);
  const select = rowOf(el, "matrix.registration").querySelector("select")!;
  assert.deepEqual([...select.querySelectorAll("option")].map((o) => [o.value, o.textContent]), [["open", "Yes"], ["closed", "No"]]);
  sent = [];
  await type(select, "open");
  await submit(rowOf(el, "matrix.registration").querySelector("form")!);
  assert.deepEqual(sent, [{ url: "/api/admin/instance/matrix.registration", method: "PUT", body: { value: "open" } }]);
  await unmount();
});

test("a platform id found from its channel is shown, not typed, with Find again; a channel's save says what it found", async () => {
  const ch = key({ key: "platform.twitch.channel", label: "Twitch channel", packages: [pkg("web", "casey")] });
  const id = key({ key: "platform.twitch.broadcasterId", label: "Twitch broadcaster id", packages: [pkg("web", "4242")] });
  const notes: string[] = [];
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(KeyCards as never, { view: view({ keys: [ch, id] }), groups: [{ section: "platforms", sub: "twitch", title: "Twitch", keys: [ch.key, id.key] }], onChanged: () => {}, note: (m: string) => notes.push(m) }));
  });
  const row = rowOf(el, "platform.twitch.broadcasterId");
  assert.equal(row.querySelector("input, select, button[type=submit]"), null, "nothing to type");
  assert.ok(row.querySelector("[data-locked-value]")?.textContent?.includes("4242"));
  assert.ok(row.querySelector("[data-derived-from]"));
  sent = [];
  await act(async () => { (row.querySelector("[data-find-id]") as HTMLButtonElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(sent.map((x) => [x.url, x.method]), [["/api/admin/instance/platform.twitch.broadcasterId/find", "POST"]]);
  // The channel itself stays editable.
  assert.ok(rowOf(el, "platform.twitch.channel").querySelector("input"));
  await act(async () => { root.unmount(); el.remove(); });
});

test("Player: one switch per live source (on = offered), each named in words; a flip saves the whole off-list; the last one on stays on", async () => {
  // The sources are the schema's own list, so a source added there (Kick, ADR 0135) gets a switch with a name.
  const { INSTANCE_KEYS } = await import("../../lib/instanceSchema.generated.mjs");
  const sources = (INSTANCE_KEYS as readonly { key: string; values?: string[] }[]).find((e) => e.key === "player.embedsOff")!.values!;
  assert.deepEqual(sources, ["native", "streamplace", "youtube", "twitch", "kick"]);
  const off = (list: string[]) => key({ key: "player.embedsOff", label: "Player sources switched off", kind: "list", values: sources, packages: [pkg("web", list)] });
  const g = [{ section: "platforms", sub: "player", title: "Player", keys: ["player.embedsOff"] }];
  const a = await mountGroups(g, [off(["youtube"])]);
  const row = rowOf(a.el, "player.embedsOff");
  assert.equal(row.querySelector("input"), null, "no comma list to type");
  const sw = (item: string) => row.querySelector(`[data-item="${item}"] [role=switch]`) as HTMLButtonElement;
  assert.deepEqual(sources.map((i) => sw(i).getAttribute("aria-checked")), ["true", "true", "false", "true", "true"]);
  assert.deepEqual(sources.map((i) => row.querySelector(`[data-item="${i}"] span:not([class])`)?.textContent),
    ["The site's own player", "Streamplace", "YouTube", "Twitch", "Kick"], "each switch is named in words, never the stored value");
  sent = [];
  await act(async () => { sw("twitch").click(); });
  assert.deepEqual(sent, [{ url: "/api/admin/instance/player.embedsOff", method: "PUT", body: { value: ["youtube", "twitch"] } }]);
  await a.unmount();
  const b = await mountGroups(g, [off(["native", "streamplace", "youtube", "kick"])]);
  assert.equal((rowOf(b.el, "player.embedsOff").querySelector('[data-item="twitch"] [role=switch]') as HTMLButtonElement).disabled, true, "the last source on cannot be switched off");
  await b.unmount();
});

test("a read-only card with its own note (the community rooms): the note, never a line to set it on the server", async () => {
  const hub = key({ key: "matrix.rooms.hub", label: "Community space room", envNames: ["MATRIX_HUB_ROOM_ID"], packages: [pkg("web", "!space:site.test")] });
  const card = { section: "site", sub: "general", title: "Community rooms", readOnly: true, readOnlyNote: "Found by the server when it made the community.", keys: [hub.key] };
  const { el, unmount } = await mountGroups([card], [hub]);
  const row = rowOf(el, "matrix.rooms.hub");
  assert.ok(row.querySelector("[data-locked-value]")?.textContent?.includes("!space:site.test"));
  assert.match(row.textContent ?? "", /Found by the server when it made the community\./);
  assert.doesNotMatch(row.textContent ?? "", /on the server, then restart|MATRIX_HUB_ROOM_ID/);
  assert.equal(row.querySelector("input, select, button[type=submit]"), null);
  await unmount();
});

test("after a save the row keeps focus on its input; each Save/Check names its setting", async () => {
  // The panel reloads its view after every save (AdminPanel loadInst): the new view carries the new
  // value and a new saved-at. The row must survive that reload, or focus falls to <body>.
  const name = (v: string, at: string) => key({ key: "streamer.displayName", label: "Streamer name",
    stored: { display: v, updatedBy: "@casey:site.test", updatedAt: at }, packages: [pkg("web", v)] });
  const sw = (on: boolean, at: string) => key({ key: "modules.stripe", label: "Card payments", kind: "bool",
    stored: { display: on, updatedBy: "@casey:site.test", updatedAt: at }, packages: [pkg("web", on)] });
  const secret = key({ key: "stripe.secretKey", label: "Stripe secret key", kind: "secret", secret: true, testable: true,
    stored: { display: "…wxyz", updatedBy: "@casey:site.test", updatedAt: "2026-10-18T09:00:00Z" }, packages: [pkg("web", "…wxyz")] });
  let keys = [name("Casey", "2026-10-18T09:00:00Z"), sw(true, "2026-10-18T09:00:00Z"), secret];
  const groups = [{ section: "site", sub: "general", title: "Card", keys: keys.map((k) => k.key) }];
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => root.render(React.createElement(KeyCards as never, { view: view({ keys }), groups, onChanged: reload, note: () => {} }));
  function reload() { keys = [name("Casey Two", "2026-10-25T09:00:00Z"), sw(false, "2026-10-25T09:00:01Z"), secret]; render(); }
  await act(async () => { render(); });
  const doc = dom.window.document;

  // Enter in the text box saves; the panel reloads; the same input still has focus, with the new value.
  const input = rowOf(el, "streamer.displayName").querySelector("input") as HTMLInputElement;
  input.focus();
  assert.ok(doc.activeElement === input, "focus is on the input before the save");
  await type(input, "Casey Two");
  await submit(rowOf(el, "streamer.displayName").querySelector("form")!);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(rowOf(el, "streamer.displayName").querySelector("input")?.value, "Casey Two", "the reload reached the row");
  assert.ok(input.isConnected, "the row's input survived the reload");
  assert.ok(doc.activeElement === input, `focus stayed on the input, not ${doc.activeElement?.tagName}`);
  // Retry: a second save from the same input keeps focus too (and the draft follows the new value).
  assert.equal(input.value, "Casey Two");

  // A switch flipped from the keyboard keeps focus through its reload.
  const toggle = rowOf(el, "modules.stripe").querySelector('[role="switch"]') as HTMLButtonElement;
  toggle.focus();
  await act(async () => { toggle.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(toggle.getAttribute("aria-checked"), "false", "the reload reached the switch");
  assert.ok(toggle.isConnected && doc.activeElement === toggle, `focus stayed on the switch, not ${doc.activeElement?.tagName}`);

  // Each button names the setting it acts on.
  const labels = [...el.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  for (const want of ["Save Streamer name", "Clear saved Streamer name", "Clear saved Card payments", "Save Stripe secret key", "Clear saved Stripe secret key", "Check Stripe secret key"]) {
    assert.ok(labels.includes(want), `a button named "${want}" (have: ${labels.join(" | ")})`);
  }
  assert.ok(!labels.some((l) => l === "Save" || l === "Check" || l === "Clear saved"), "no bare Save / Check / Clear saved");
  await act(async () => { root.unmount(); el.remove(); });
});

test("a permanent install value says it never changes; only SETTABLE_KEYS rows name blackbranch set", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { INSTANCE_KEYS } = await import("../../lib/instanceSchema.generated.mjs");
  const { KEY_GROUPS } = await import("./adminLayout.ts");
  const REPO = join(import.meta.dirname, "../../../..");
  const bb = readFileSync(join(REPO, "install/blackbranch"), "utf8");
  const settable = bb.match(/\nSETTABLE_KEYS=\(\n?([\s\S]*?)\n?\)/)![1]!.split(/\s+/).filter(Boolean);
  // The install's identity: the rows `blackbranch help` lists as permanent (install/restart-settings.tsv).
  const permanent = readFileSync(join(REPO, "install/restart-settings.tsv"), "utf8").split("\n")
    .map((l) => l.split("\t")).filter((c) => c[1] === "permanent").map((c) => c[0]!);
  assert.ok(settable.length >= 15 && permanent.length >= 7, `vacuity: ${settable.length} settable, ${permanent.length} permanent`);
  const installWeb = (INSTANCE_KEYS as readonly { key: string; tier: string; env: string[]; packages: string[]; label: string }[])
    .filter((e) => e.tier === "install" && e.packages.includes("web"));
  const rows = installWeb.map((e) => key({ key: e.key, label: e.label, tier: "install", reload: "restart", envNames: e.env,
    settable: settable.includes(e.env[0]!), permanent: permanent.includes(e.key), packages: [pkg("web", "x", "env")] }));
  const { el, unmount } = await mountGroups([{ section: "site", sub: "general", title: "Install", keys: rows.map((r) => r.key) }], rows);
  for (const e of installWeb) {
    const text = rowOf(el, e.key).textContent ?? "";
    if (settable.includes(e.env[0]!)) assert.match(text, new RegExp(`sudo blackbranch set ${e.env[0]}`), `${e.key}: a display value names its command`);
    else assert.doesNotMatch(text, /blackbranch set/, `${e.key}: blackbranch set refuses it, so the row never names it`);
    if (permanent.includes(e.key)) {
      assert.match(text, /never changes/, `${e.key}: the identity says it never changes`);
      assert.doesNotMatch(text, /To change it/, `${e.key}: and gives no way to change it`);
    }
  }
  await unmount();
  const card = KEY_GROUPS.find((g) => g.title === "Install values")!;
  assert.match(card.blurb ?? "", /never change/);
  assert.doesNotMatch(card.blurb ?? "", /To change one/);
  // The marks the panel reads are the host's lists.
  const schema = INSTANCE_KEYS as readonly { key: string; env: string[]; settable?: boolean; permanent?: boolean }[];
  assert.deepEqual(schema.filter((e) => e.settable).map((e) => e.env[0]).sort(), [...settable].sort(), "settable = SETTABLE_KEYS");
  assert.deepEqual(schema.filter((e) => e.permanent).map((e) => e.key).sort(), [...permanent].sort(), "permanent = the tsv's permanent rows");
});
