// Admin Panel › Site › Community, mounted: categories hold their channels in order; every channel
// row says who can see and who can post; the New channel dialog offers encryption only where it can
// be had and says what it costs; the last run says what was put back.
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/features/instance/communityPanel.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: CommunityPanel } = await import("./CommunityPanel.tsx");
const { createRoot } = await import("react-dom/client");

const here = dirname(fileURLToPath(import.meta.url));

const room = (id: number, spaceId: number, name: string, orderKey: string, over: Record<string, unknown> = {}) => ({
  id, spaceId, kind: "text", name, topic: null, avatarMxc: null, orderKey, see: "everyone", post: "everyone",
  retentionDays: 30, encrypted: false, published: true, archived: false, matrixRoomId: null, discordChannelId: null, ...over,
});
const space = (id: number, kind: string, name: string, orderKey: string, parentId: number | null = null) => ({
  id, parentId, kind, name, topic: null, avatarMxc: null, orderKey, matrixRoomId: null, gateTier: kind === "gate" ? "supporter" : null,
});

const VIEW = {
  spaces: [space(1, "hub", "Community", "a0"), space(3, "category", "Stream", "a0", 1), space(2, "category", "Talk", "a1", 1), space(9, "gate", "Supporters", "a2", 1)],
  // Out of order on purpose: the panel shows each category's channels in order-key order.
  rooms: [room(13, 2, "news", "a2"), room(11, 2, "general", "a0"), room(12, 2, "lounge", "a1", { see: "supporters", post: "mods", published: false, retentionDays: null }),
    room(21, 3, "clips", "a0"), room(31, 1, "welcome", "a0")],
  roles: [
    { key: "admin", label: "Admin", level: 100, colour: null, hoist: true, orderKey: "a0", builtin: true },
    { key: "member", label: "Member", level: 0, colour: null, hoist: false, orderKey: "a5", builtin: true },
  ],
  lastApply: {
    id: 4, mode: "apply", startedAt: "2026-10-23T14:02:00Z", finishedAt: "2026-10-23T14:02:05Z", ok: true, error: null, drift: [],
    applied: [{ op: "rename", roomId: "!g:example.tv", label: "#general", from: "general", to: "lobby", putBack: true, said: "rename #general to #lobby" },
      { op: "createRoom", roomId: "!n:example.tv", label: "#news", said: "create #news" }],
  },
  lastReport: null, latestStartedAt: "2026-10-23T14:02:00Z", reconciler: true, canAsk: true, host: null, hostReport: null, retentionCapDays: 365,
};

let sent: { url: string; method: string; body: unknown }[] = [];
/** What the next answers hold: changes to the view, and when a save asked the host. */
const served: { view: Record<string, unknown>; requestedAt: string | null } = { view: {}, requestedAt: null };
let notes: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const body = String(url) === "/api/admin/community" ? { ...VIEW, ...served.view } : { ok: true, id: 99, requestedAt: served.requestedAt };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(CommunityPanel as never, { inst: null, reloadInst: () => {}, note: (m: string) => { notes.push(m); } })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

const text = (n: Element | null | undefined) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = async (n: Element) => { await act(async () => { (n as HTMLElement).click(); }); };
const choose = async (sel: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
};

test("renders categories with their rooms in orderKey order", async () => {
  const { el, done } = await mount();
  const card = el.querySelector('section[aria-label="Channels and categories"]')!;
  assert.ok(card, "the Channels card");
  assert.equal(text(card.querySelector("h2")), "Channels and categories");
  const cats = [...card.querySelectorAll("[data-category]")].map((c) => c.getAttribute("data-category"));
  assert.deepEqual(cats, ["1", "3", "2"], "the community's own channels first, then the categories in order; the hidden supporters space never");
  const names = (id: string) => [...card.querySelectorAll(`[data-category="${id}"] li[data-room] [data-name]`)].map(text);
  assert.deepEqual(names("2"), ["general", "lounge", "news"]);
  assert.deepEqual(names("3"), ["clips"]);
  assert.deepEqual(names("1"), ["welcome"]);
  assert.match(text(card.querySelector('[data-category="2"]')), /^Talk/);
  await done();
});

test("a room row shows both sentences", async () => {
  const { el, done } = await mount();
  assert.equal(text(el.querySelector('li[data-room="11"] [data-sentence]')), "Who can see: Everyone in the community · Who can post: Everyone who can see");
  assert.equal(text(el.querySelector('li[data-room="12"] [data-sentence]')), "Who can see: Supporters and above · Who can post: Mods and above");
  assert.match(text(el.querySelector('li[data-room="11"]')), /30 days/);
  // No days of its own: the server's limit applies (the reconciler writes the cap), never "Forever" while there is one.
  assert.match(text(el.querySelector('li[data-room="12"]')), /Keeps messages: As long as this server allows \(365 days\)/);
  assert.doesNotMatch(text(el.querySelector('li[data-room="12"]')), /Forever/);
  await done();
});

test("the New channel dialog hides the encryption switch while Who can see is Everyone and shows the six-line cost list when it is on", async () => {
  const { el, done } = await mount();
  const open = [...el.querySelectorAll("button")].find((b) => text(b) === "New channel")!;
  await click(open);
  const dialog = el.querySelector('[role="dialog"][aria-label="New channel"]')!;
  assert.ok(dialog, "the dialog opened");
  const see = dialog.querySelector('select[aria-label="Who can see"]') as HTMLSelectElement;
  assert.equal(see.value, "everyone", "Everyone by default");
  assert.ok(dialog.querySelector('[role="switch"][aria-label="Encrypted"]') === null, "no encryption for a channel everyone can see");
  await choose(see, "supporters");
  const sw = dialog.querySelector('[role="switch"][aria-label="Encrypted"]')!;
  assert.ok(sw, "offered once only some can see");
  assert.equal(sw.getAttribute("aria-checked"), "false", "off by default");
  assert.ok(dialog.querySelector("[data-costs]") === null, "no costs before it is on");
  await click(sw);
  const costs = [...dialog.querySelectorAll("[data-costs] li")].map(text);
  assert.deepEqual(costs, [
    "It cannot be switched off later.",
    "Server search cannot see it.",
    "Mods who are not members and the site's word filter cannot read it.",
    "A Discord-linked copy is plain text on Discord.",
    "Newcomers see earlier messages only if key sharing for past messages works.",
    "A lost device without backup loses history.",
  ]);
  // Back to Everyone: the switch goes, and what is sent is never encrypted.
  await choose(see, "everyone");
  assert.ok(dialog.querySelector('[role="switch"][aria-label="Encrypted"]') === null, "gone again at Everyone");
  const name = dialog.querySelector('input[aria-label="Channel name"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "events");
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  sent = [];
  await act(async () => { dialog.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const post = sent.find((s) => s.url === "/api/admin/community/rooms");
  assert.ok(post, JSON.stringify(sent));
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, { spaceId: 1, kind: "text", name: "events", topic: null, see: "everyone", post: "everyone", retentionDays: 30, encrypted: false });
  await done();
});

test("the Runs card shows \"Put back: rename #general to #lobby\" from a fixture run", async () => {
  const { el, done } = await mount();
  const card = el.querySelector('section[aria-label="Last applied"]')!;
  assert.ok(card);
  assert.equal(text(card.querySelector("h2")), "Last applied");
  const lines = [...card.querySelectorAll("[data-line]")].map(text);
  assert.deepEqual(lines, ["Put back: rename #general to #lobby", "Create #news"]);
  await done();
});

test("the Runs card shows a run still going as \"Running since HH:MM\"; one unfinished past the run limit did not finish", async () => {
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const unfinished = (startedAt: string) => ({ ...VIEW.lastApply, startedAt, finishedAt: null, ok: null, applied: [], drift: [] });
  const recent = new Date(Date.now() - 60_000).toISOString();
  served.view = { lastApply: unfinished(recent) };
  let m = await mount();
  try {
    const status = text(m.el.querySelector('section[aria-label="Last applied"] [data-run-status]'));
    assert.equal(status, `Running since ${hhmm(recent)}.`);
  } finally { await m.done(); }
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  served.view = { lastApply: unfinished(stale) };
  m = await mount();
  try {
    const status = text(m.el.querySelector('section[aria-label="Last applied"] [data-run-status]'));
    assert.equal(status, `Started at ${hhmm(stale)} and did not finish.`);
  } finally { served.view = {}; await m.done(); }
});

test("archive and delete ask first, in the panel's words; delete waits for the typed name", async () => {
  const { el, done } = await mount();
  const row = el.querySelector('li[data-room="13"]')!;
  await click([...row.querySelectorAll("button")].find((b) => text(b) === "Archive")!);
  assert.match(text(el.querySelector('[role="dialog"][aria-label="Archive #news"]')), /Hide #news from the community and keep its messages\? People can no longer post in it\./);
  await click([...el.querySelectorAll('[role="dialog"] button')].find((b) => text(b) === "Cancel")!);
  await click([...el.querySelector('li[data-room="13"]')!.querySelectorAll("button")].find((b) => text(b) === "Delete")!);
  const d = el.querySelector('[role="dialog"][aria-label="Delete #news"]')!;
  assert.match(text(d), /Delete #news and its messages for everyone\? Type the channel name to confirm\.\s*This channel was never created on the server, so nothing else is removed\./);
  const go = [...d.querySelectorAll("button")].find((b) => text(b) === "Delete")! as HTMLButtonElement;
  assert.equal(go.disabled, true, "nothing typed yet");
  const input = d.querySelector("input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "news");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(go.disabled, false);
  sent = [];
  await click(go);
  assert.deepEqual(sent[0], { url: "/api/admin/community/rooms/13", method: "DELETE", body: { confirm: "news" } });
  await done();
});

test("moving a channel up writes an order key between its new neighbours", async () => {
  const { el, done } = await mount();
  sent = [];
  await click([...el.querySelector('li[data-room="13"]')!.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Move news up")!);
  const p = sent.find((s) => s.url === "/api/admin/community/rooms/13")!;
  assert.equal(p.method, "PATCH");
  const key = (p.body as { orderKey: string }).orderKey;
  assert.ok(key > "a0" && key < "a1", `between general and lounge: ${key}`);
  await done();
});

test("a save on an install whose reconciler is off says the change waits for it", async () => {
  served.view = { reconciler: false, canAsk: false };
  served.requestedAt = null;
  const { el, done } = await mount();
  try {
    assert.match(text(el), /Changes here are saved, and applied by the reconciler when it is turned on\./);
    notes = [];
    await click([...el.querySelector('li[data-room="13"]')!.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Move news up")!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(notes, ["Saved. Changes are applied by the reconciler when it is turned on."]);
    assert.equal([...el.querySelectorAll("button")].filter((b) => /Check now|Apply now/.test(text(b))).length, 0, "nothing to ask without a host");
  } finally { served.view = {}; await done(); }
});

test("a save that asked the server shows Applying… until a run newer than the request is in the log", async () => {
  served.requestedAt = "2026-10-23T15:00:00Z";
  const { el, done } = await mount();
  try {
    await click([...el.querySelector('li[data-room="13"]')!.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Move news up")!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const card = () => el.querySelector('section[aria-label="Last applied"]')!;
    assert.match(text(card()), /Applying…/, "waiting on the run (the log's newest run is older than the request)");
    // The server's run arrives; the next look finds it.
    served.view = { latestStartedAt: "2026-10-23T15:00:03Z" };
    await act(async () => { await new Promise((r) => setTimeout(r, 3_100)); });
    assert.doesNotMatch(text(card()), /Applying…/);
  } finally { served.view = {}; served.requestedAt = null; await done(); }
});

const openNew = async (el: Element) => {
  await click([...el.querySelectorAll("button")].find((b) => text(b) === "New channel")!);
  return el.querySelector('[role="dialog"][aria-label="New channel"]')!;
};
const keepChoices = (dialog: Element) => [...dialog.querySelectorAll('[role="group"][aria-label="Keep messages"] button')].map(text);

test("with no cap (0) a channel without days of its own keeps messages forever, and the picker says Forever", async () => {
  served.view = { retentionCapDays: 0 };
  const { el, done } = await mount();
  try {
    assert.match(text(el.querySelector('li[data-room="12"]')), /Keeps messages: Forever/);
    const dialog = await openNew(el);
    assert.deepEqual(keepChoices(dialog), ["Forever", "For a set time"]);
  } finally { served.view = {}; await done(); }
});

test("with a cap the picker offers the server's limit, not Forever, and days up to the cap", async () => {
  const { el, done } = await mount();
  const dialog = await openNew(el);
  assert.deepEqual(keepChoices(dialog), ["Server limit (365 days)", "For a set time"]);
  assert.match(text(dialog), /up to 365/);
  // New channels: 30 days for chat; no limit of their own for announcements and forums (ADR 0139).
  const pressed = () => text(dialog.querySelector('[role="group"][aria-label="Keep messages"] button[aria-pressed="true"]'));
  assert.equal(pressed(), "For a set time");
  const kind = (label: string) => [...dialog.querySelectorAll('[role="group"][aria-label="Kind"] button')].find((b) => text(b) === label)!;
  await click(kind("Announcement"));
  assert.equal(pressed(), "Server limit (365 days)");
  await click(kind("Forum"));
  assert.equal(pressed(), "Server limit (365 days)");
  await click(kind("Text"));
  assert.equal(pressed(), "For a set time");
  await done();
});

test("Announcement then back to Text restores the post rule the user had chosen", async () => {
  const { el, done } = await mount();
  const dialog = await openNew(el);
  const post = dialog.querySelector('select[aria-label="Who can post"]') as HTMLSelectElement;
  await choose(post, "supporters");
  const kind = (label: string) => [...dialog.querySelectorAll('[role="group"][aria-label="Kind"] button')].find((b) => text(b) === label)!;
  await click(kind("Announcement"));
  assert.equal((dialog.querySelector('select[aria-label="Who can post"]') as HTMLSelectElement).value, "mods");
  await click(kind("Text"));
  assert.equal((dialog.querySelector('select[aria-label="Who can post"]') as HTMLSelectElement).value, "supporters", "the user's choice, not Mods and above");
  await click(kind("Announcement"));
  await click(kind("Forum"));
  assert.equal((dialog.querySelector('select[aria-label="Who can post"]') as HTMLSelectElement).value, "supporters");
  await done();
});

test("Check now asks for a check, is disabled while it waits, and a refused check says so as a check", async () => {
  served.requestedAt = null;
  const { el, done } = await mount();
  try {
    const btnNamed = (n: string) => [...el.querySelectorAll('section[aria-label="Last applied"] button')].find((b) => text(b) === n) as HTMLButtonElement;
    sent = [];
    // The reconcile route answers like a save does here; give it a time so the page waits.
    served.requestedAt = "2026-10-23T15:00:00Z";
    await click(btnNamed("Check now"));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent.find((s) => s.url === "/api/admin/community/reconcile")?.body, { mode: "report" });
    assert.match(text(el.querySelector('section[aria-label="Last applied"]')), /Checking…/);
    assert.equal(btnNamed("Check now").disabled, true, "no second check while one is pending");
    assert.equal(btnNamed("Apply now").disabled, true);
    // The host could not start the check: said as a check, read from the check's own answer.
    served.view = { hostReport: { ok: false, at: "2026-10-23T15:00:01Z", message: "the community account is not registered" },
      host: { ok: true, at: "2026-10-23T15:00:01Z", message: "started" } };
    await act(async () => { await new Promise((r) => setTimeout(r, 3_100)); });
    const card = text(el.querySelector('section[aria-label="Last applied"]'));
    assert.match(card, /Not checked: the community account is not registered/);
    assert.doesNotMatch(card, /Not applied/);
    assert.equal(btnNamed("Check now").disabled, false);
  } finally { served.view = {}; served.requestedAt = null; await done(); }
});

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
};

test("Roles: a role's name, colour and own group are edited in place; its level and key are not", async () => {
  served.requestedAt = "2026-10-23T15:00:00Z";
  const { el, done } = await mount();
  try {
    const row = () => el.querySelector('section[aria-label="Roles"] li[data-role="admin"]')!;
    assert.equal(el.querySelector('li[data-role="creator"] button'), null, "the Creator is never edited");
    await click(row().querySelector('button[aria-label="Edit Admin"]')!);
    const form = row().querySelector('form[aria-label="Edit Admin"]')!;
    assert.ok(form, "the row opens its editor");
    assert.equal(form.querySelectorAll("input").length, 1, "the name only: no level, no key, and no colour until one is chosen");
    const name = form.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    const saveBtn = () => [...form.querySelectorAll("button")].find((b) => text(b) === "Save") as HTMLButtonElement;
    // Save is off with the reason beside it, tied to the button.
    const reason = () => {
      const id = saveBtn().getAttribute("aria-describedby");
      return id ? form.querySelector(`#${id}`)?.textContent ?? null : null;
    };
    await typeInto(name, "   ");
    assert.equal(saveBtn().disabled, true, "a role needs a name");
    assert.equal(reason(), "A role needs a name.");
    await typeInto(name, "x".repeat(41));
    assert.equal(saveBtn().disabled, true, "40 characters at most");
    assert.equal(reason(), "A name is 40 characters at most.");
    await typeInto(name, "Owner");
    assert.equal(reason(), null, "nothing to fix: no reason, and Save is on");
    await click(form.querySelector('[role="switch"][aria-label="Use a colour"]')!);
    assert.equal(form.querySelectorAll("input").length, 3, "the colour's picker and its text beside the name");
    const colourText = form.querySelector('input[type="text"]:not([aria-label="Name"])') as HTMLInputElement;
    // A half-typed colour never reaches the role (the picker passes on whole colours only): Save stays on.
    await typeInto(colourText, "#33AA5");
    assert.equal(saveBtn().disabled, false);
    assert.equal(reason(), null);
    await typeInto(colourText, "#33AA55");
    const hoist = form.querySelector('[role="switch"][aria-label="Show as its own group in the member list"]')!;
    assert.equal(hoist.getAttribute("aria-checked"), "true", "Admin starts listed apart");
    await click(hoist);
    sent = []; notes = [];
    await click(saveBtn());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent.filter((s) => s.method === "PATCH").map((s) => [s.url, s.body]), [
      ["/api/admin/community/roles/admin", { label: "Owner", colour: "#33aa55", hoist: false }],
    ]);
    assert.deepEqual(notes, ["Saved."], "the same save as every Community change: database first, then the host");
    assert.equal(row().querySelector("form"), null, "the editor closes on a save");

    // No colour: the switch off sends null.
    await click(el.querySelector('section[aria-label="Roles"] li[data-role="member"] button[aria-label="Edit Member"]')!);
    const memberForm = el.querySelector('form[aria-label="Edit Member"]')!;
    assert.equal(memberForm.querySelector('[role="switch"][aria-label="Use a colour"]')!.getAttribute("aria-checked"), "false");
    sent = [];
    await click([...memberForm.querySelectorAll("button")].find((b) => text(b) === "Save")!);
    assert.deepEqual(sent.filter((s) => s.method === "PATCH").map((s) => s.body), [{ label: "Member", colour: null, hoist: false }]);
  } finally { served.requestedAt = null; await done(); }
});

test("no Matrix words where a streamer reads", () => {
  // Each file's own last lines: a short read cannot pass the negative scan below (the vacuity anchor).
  const END: Record<string, RegExp> = {
    "CommunityPanel.tsx": /\{inst && <KeyCards [^\n]*\/>\}\n {4}<\/>\n {2}\);\n\}\n$/,
    "ChannelsPage.tsx": /\n {4}<\/section>\n {2}\);\n\}\n$/,
    "ChannelDialog.tsx": /\n {6}<\/form>\n {4}<\/div>\n {2}\);\n\}\n$/,
    "RolesPage.tsx": /\n {4}<\/section>\n {2}\);\n\}\n$/,
    "RunsCard.tsx": /\n {4}<\/section>\n {2}\);\n\}\n$/,
    "../../lib/community/communityWords.ts": /return kind === "text" \? Math\.min\(30, keepMaxDays\(cap\)\) : null;\n\}\n$/,
  };
  for (const [f, end] of Object.entries(END)) {
    const src = readFileSync(join(here, f), "utf8");
    assert.match(src, end, `vacuity: ${f} was read to its end`);
    const strings = [...src.matchAll(/"([^"\n]{3,})"|>([^<>{}\n]{3,})</g)].map((m) => m[1] ?? m[2]).join(" | ");
    assert.doesNotMatch(strings, /power level|join rule|state event|m\.room|appservice|—/i, f);
  }
});
