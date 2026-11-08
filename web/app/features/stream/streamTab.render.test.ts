// The Stream tab mounted for real: the SSR frame, income off by default and NOT REQUESTED, the
// switch asking for it, the live view, a past stream's review, the empty install; the ONE Platforms
// card (#247: site side + chat readers, one row per platform), the OBS card (the rig page's own
// component) and the settings jumps into the Admin window.
// Run: node --test app/features/stream/streamTab.render.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
import { adminRail } from "../instance/adminLayout.ts";
// dispatchClaimable builds the event with the bare global CustomEvent; point it at jsdom's realm.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = dom.window.CustomEvent;
const { StreamTab } = await import("./StreamTab.tsx");
const { SETTINGS_JUMPS } = await import("./StreamSettings.tsx");
const { createRoot } = await import("react-dom/client");
// next/link's prefetch schedules through `self.requestIdleCallback`; jsdom's globals have no `self`.
(globalThis as unknown as { self: unknown }).self ??= globalThis;

const now = Date.now();
const curve = [0, 1, 2].map((i) => ({ ms: now - (3 - i) * 60_000, total: 10 + i, twitch: 6, youtube: 4 + i, kick: 0, streamplace: 0 }));
const velocity = Array.from({ length: 30 }, (_, i) => ({ ms: now - (30 - i) * 60_000, total: i % 3 }));
const money = { earnedCents: 1234, byPlatform: { twitch: 1234 }, events: [{ id: 1, ms: now - 60_000, platform: "twitch", username: "casey", eventType: "bits", cents: 1234 }], offStreamCents: 500 };
const liveReply = (income: boolean) => ({
  live: { live: true, viaSnapshot: false, streamId: "s-live", startedMs: now - 3_600_000, viewers: { twitch: 6, youtube: 6, kick: null, streamplace: 0, total: 12 } },
  dash: { curve, velocity, income: income ? money : null }, last: null, atMs: now,
});
const past = { streamId: "s-old", segments: 2, startedMs: now - 86_400_000, endedMs: now - 80_000_000, durationMs: 6_400_000, peakViewers: 40, avgViewers: 20, messages: 900, earnedCents: null as number | null };
const platforms = { platforms: [
  { key: "twitch", label: "Twitch", setUp: true, embed: { source: "twitch", on: true }, title: "A stream title", category: "Just Chatting", titleNote: "From Twitch", manageUrl: "https://dashboard.twitch.tv/", setupHref: "/admin/platforms?sub=twitch" },
  { key: "youtube", label: "YouTube", setUp: true, embed: { source: "youtube", on: false }, title: null, category: null, titleNote: "Read while live on YouTube", manageUrl: null, setupHref: "/admin/platforms?sub=youtube" },
  { key: "native", label: "Site player", setUp: true, embed: { source: "native", on: true }, title: null, category: null, titleNote: "Plays the Streamplace stream", manageUrl: null, setupHref: "/admin/platforms?sub=streamplace" },
  { key: "kick", label: "Kick", setUp: false, embed: { source: "kick", on: false }, title: null, category: null, titleNote: "Not set up", manageUrl: null, setupHref: "/admin/platforms?sub=kick" },
] };
const rigOn = { on: true, error: null, connected: 1, pages: [{ since: new Date(now - 7_200_000).toISOString(), level: 5, scene: "Main" }], scenes: ["Intro", "Main", "BRB"], scene: "Main", speaking: false, sink: "satellite", url: "http://site.test/overlay/rig?key=SECRETKEY" };
const doctor = { rows: [{ id: "a", title: "Database", status: "ok" }, { id: "b", title: "Backups", status: "fail" }] };

const readers = { reachable: true, health: { ok: false, bot: "off", readers: {
  twitch: { state: "running", since: new Date(now - 600_000).toISOString() },
  youtube: { state: "failed", since: new Date(now - 60_000).toISOString(), error: "Chromium could not start: libnss3.so missing" },
} } };

let calls: string[] = [];
let bodies: string[] = [];
function serve(opts: { live?: boolean; empty?: boolean; readers?: unknown; rig?: unknown; platforms?: unknown } = {}) {
  calls = [];
  bodies = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(init?.method && init.method !== "GET" ? `${init.method} ${u}` : u);
    if (typeof init?.body === "string") bodies.push(init.body);
    const income = u.includes("income=1");
    let body: unknown = {};
    if (u.startsWith("/api/admin/stream/sessions/")) body = { summary: { ...past, earnedCents: income ? 999 : null }, curve, chat: [{ ms: now - 600_000, count: 5 }, { ms: now - 300_000, count: 9 }], income: income ? money : null };
    else if (u.startsWith("/api/admin/stream/sessions")) body = { sessions: opts.empty ? [] : [{ ...past, earnedCents: income ? 999 : null }], sort: "date" };
    else if (u.startsWith("/api/admin/stream/platforms")) body = opts.platforms ?? platforms;
    else if (u.startsWith("/api/admin/stream/readers")) body = opts.readers ?? readers;
    else if (u.startsWith("/api/admin/stream")) body = opts.live === false ? { live: { live: false }, dash: null, last: opts.empty ? null : { ...past, earnedCents: income ? 999 : null }, atMs: now } : liveReply(income);
    else if (u.startsWith("/api/admin/doctor")) body = doctor;
    else if (u.startsWith("/api/admin/rig")) body = init?.method === "POST" ? { ok: true } : (opts.rig ?? rigOn);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
}

async function mount(active = true) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(StreamTab, { active })); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); }); el.remove(); } };
}
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => resetStorage());

test("the SSR frame reads as loading, income off, and no money", () => {
  const out = renderToStaticMarkup(createElement(StreamTab, { active: false }));
  assert.match(out, /Loading/);
  assert.match(out, /role="switch" aria-checked="false" aria-label="Show income"/);
  assert.doesNotMatch(out, /\$/);
});

test("an inactive tab asks for nothing", async () => {
  serve();
  const m = await mount(false);
  try { assert.deepEqual(calls, []); } finally { await m.done(); }
});

test("live, income off: graphs and platforms draw, no money is REQUESTED and none is shown", async () => {
  serve();
  const m = await mount();
  try {
    assert.ok(calls.length > 0);
    assert.ok(calls.filter((u) => u.startsWith("/api/admin/stream")).every((u) => !u.includes("income=1")), `money asked for: ${calls.join(", ")}`);
    const html = m.el.innerHTML;
    assert.match(html, /data-live="1"/);
    assert.match(html, /data-chart="viewers"/);
    assert.match(html, /data-chart="chat"/);
    assert.match(html, /data-composition/);
    assert.match(html, /data-income-hidden/);
    assert.doesNotMatch(html, /data-chart="earned"/);
    assert.doesNotMatch(html, /\$/);
    assert.match(html, /A stream title/);
    assert.match(html, /Not set up — set it up/);
    assert.doesNotMatch(html, /No embed on the site/, "Kick's embed is a switch like the others (decision 0135)");
    assert.ok(m.el.querySelector('[data-platform="kick"] [aria-label="Kick on the watch page"]'), "the Kick row carries its embed switch");
    assert.match(html, /1 failing/);
    assert.match(html, /First to look at: Backups/);
  } finally { await m.done(); }
});

test("the income switch asks for money, draws it, and is remembered", async () => {
  serve();
  const m = await mount();
  try {
    const sw = m.el.querySelector('[aria-label="Show income"]') as HTMLButtonElement;
    await act(async () => { sw.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await settle();
    assert.ok(calls.some((u) => u === "/api/admin/stream?income=1"), calls.join(", "));
    const html = m.el.innerHTML;
    assert.match(html, /data-chart="earned"/);
    assert.match(html, /\$12\.34/);
    assert.match(html, /data-off-stream/);
    assert.equal(dom.window.localStorage.getItem("bb_stream_income"), "1");
  } finally { await m.done(); }
});

test("picking a past stream opens its review; the live row is not in the drop-down twice", async () => {
  serve();
  const m = await mount();
  try {
    const sel = m.el.querySelector('select[aria-label="Pick a stream"]') as HTMLSelectElement;
    assert.deepEqual([...sel.options].map((o) => o.value), ["", "s-old"]);
    assert.match(sel.options[0]!.textContent ?? "", /Live now/);
    await act(async () => { sel.value = "s-old"; sel.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await settle();
    assert.ok(calls.some((u) => u.startsWith("/api/admin/stream/sessions/s-old?income=0")), calls.join(", "));
    assert.match(m.el.innerHTML, /data-review/);
    assert.match(m.el.innerHTML, /2 parts/);
    assert.match(m.el.innerHTML, /Back to the live stream/);
  } finally { await m.done(); }
});

test("offline: the last stream card; an empty install says how to start", async () => {
  serve({ live: false });
  let m = await mount();
  try {
    assert.match(m.el.innerHTML, /data-live="0"/);
    assert.match(m.el.innerHTML, /data-last-stream/);
  } finally { await m.done(); }
  serve({ live: false, empty: true });
  m = await mount();
  try {
    assert.match(m.el.innerHTML, /No streams recorded yet/);
    assert.match(m.el.innerHTML, /href="\/admin\/platforms"/);
  } finally { await m.done(); }
});

test("an embed switch writes the ONE setting through the Admin Panel's writer; the last one on cannot go off", async () => {
  serve();
  const m = await mount();
  try {
    const tw = m.el.querySelector('[aria-label="Twitch on the watch page"]') as HTMLButtonElement;
    assert.ok(tw, "the Twitch embed switch is drawn");
    assert.equal(tw.disabled, false, "two sources are on, so either may go off");
    await act(async () => { tw.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await settle();
    assert.ok(calls.includes("PUT /api/admin/instance/player.embedsOff"), calls.join(", "));
    assert.deepEqual(JSON.parse(bodies[bodies.length - 1]!), { value: ["twitch", "youtube", "kick"] }, "the whole list of what is off — this one plus the ones already off");
    const yt = m.el.querySelector('[aria-label="YouTube on the watch page"]') as HTMLButtonElement;
    assert.equal(yt.getAttribute("aria-checked"), "false");
  } finally { await m.done(); }
  // One source on: its switch is held.
  const one = platforms.platforms.map((r) => (r.key === "native" ? { ...r, embed: { source: "native", on: false } } : r));
  const realFetch = globalThis.fetch;
  serve();
  const served = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => String(url).startsWith("/api/admin/stream/platforms")
    ? Promise.resolve(new Response(JSON.stringify({ platforms: one }), { status: 200, headers: { "content-type": "application/json" } }))
    : served(url, init)) as typeof fetch;
  const m2 = await mount();
  try {
    assert.equal((m2.el.querySelector('[aria-label="Twitch on the watch page"]') as HTMLButtonElement).disabled, true);
  } finally { await m2.done(); globalThis.fetch = realFetch; }
});

test("chat readers: each platform's reader state from the ingest, a failed one with its one-line reason", async () => {
  serve();
  const m = await mount();
  try {
    assert.ok(calls.includes("/api/admin/stream/readers"), calls.join(", "));
    const tw = m.el.querySelector('[data-reader="twitch"]')!;
    assert.equal(tw.getAttribute("data-state"), "running");
    assert.match(tw.textContent ?? "", /Chat reader: Reading · 10m ago/);
    const yt = m.el.querySelector('[data-reader="youtube"]')!;
    assert.equal(yt.getAttribute("data-state"), "failed");
    assert.match(yt.textContent ?? "", /Failed/);
    assert.equal(m.el.querySelector('[data-platform="youtube"] [data-reader-error]')?.textContent, "Chromium could not start: libnss3.so missing");
    assert.match(m.el.innerHTML, /Chat bot: off/);
  } finally { await m.done(); }
});

test("chat readers: each platform's live detection shows as a chip, with why it can't tell and YouTube's auto-stop note", async () => {
  const at = new Date(now - 60_000).toISOString();
  serve({ readers: { reachable: true, health: { ...readers.health, liveness: {
    twitch: { state: "live", since: at, lastAnswerAt: at, scheduledStart: null, evidence: "helix-live", misses: 0, stale: false },
    youtube: { state: "unknown", since: at, lastAnswerAt: null, scheduledStart: null, evidence: "unrecognized-page", misses: 0, stale: true },
    kick: null, streamplace: null,
  } } } });
  const m = await mount();
  try {
    const tw = m.el.querySelector('[data-platform="twitch"] [data-live]')!;
    assert.equal(tw.getAttribute("data-live"), "live");
    assert.equal(tw.textContent, "Live");
    const ytRow = m.el.querySelector('[data-platform="youtube"]')!;
    const yt = ytRow.querySelector("[data-live]")!;
    assert.equal(yt.getAttribute("data-live"), "unknown");
    // The chip beside the name says the state; why it can't tell is the line under it (#247: a long
    // reason no longer pushes the row's embed switch onto a line of its own).
    assert.equal(yt.textContent, "Can't tell");
    assert.equal(ytRow.querySelector("[data-live-why]")?.textContent, "Can't tell: YouTube showed a consent or bot-check page");
    assert.match(ytRow.querySelector("[data-live-note]")?.textContent ?? "", /No answer for over 15 min/);
    assert.match(ytRow.querySelector("[data-youtube-note]")?.textContent ?? "", /only when auto-stop is on in YouTube Studio/);
    assert.equal(m.el.querySelector('[data-platform="twitch"] [data-youtube-note]'), null, "the note is YouTube's only");
  } finally { await m.done(); }
});

test("chat readers: the ingest not answering says so plainly — never an empty list that reads as fine", async () => {
  serve({ readers: { reachable: false } });
  const m = await mount();
  try {
    const p = m.el.querySelector('[data-readers="unreachable"]');
    assert.ok(p, m.el.innerHTML.slice(0, 200));
    assert.match(p!.textContent ?? "", /did not answer — no platform chat is coming in through it/);
    assert.equal(m.el.querySelector("[data-reader]"), null);
    assert.ok(m.el.querySelector('[data-platform="twitch"] [aria-label="Twitch on the watch page"]'), "the site's side still draws: the rows stay, only the reader lines are missing");
  } finally { await m.done(); }
  serve({ readers: { reachable: true, health: { ok: true, readers: {}, bot: "off" } } });
  const none = await mount();
  try {
    assert.match(none.el.querySelector('[data-readers="none"]')?.textContent ?? "", /No platform is set up to read chat from/);
  } finally { await none.done(); }
});

// ── #247: ONE Platforms card — a row per platform, the site's side and the chat reader's together ──
const at = new Date(now - 60_000).toISOString();
const live = (state: string, o: Record<string, unknown> = {}) => ({ state, since: at, lastAnswerAt: at, scheduledStart: null, evidence: "", misses: 0, stale: false, ...o });
const allStates = { reachable: true, health: { ok: false, bot: "running", readers: {
  twitch: { state: "running", since: new Date(now - 600_000).toISOString() },
  youtube: { state: "failed", since: new Date(now - 60_000).toISOString(), error: "Chromium could not start: libnss3.so missing\n  at launch" },
  kick: { state: "off", since: at },
  streamplace: { state: "starting", since: new Date(now - 30_000).toISOString() },
  zzz: { state: "running", since: at },
}, liveness: {
  twitch: live("live", { evidence: "helix-live" }),
  youtube: live("upcoming", { scheduledStart: new Date(now + 3_600_000).toISOString() }),
  kick: live("offline"),
  streamplace: live("unknown", { evidence: "unrecognized-page" }),
} } };
const rowOf = (el: HTMLElement, key: string) => el.querySelector(`[data-platform="${key}"]`) as HTMLElement | null;

test("one card, one row per platform: no separate chat readers card; site rows in order, a reader-only platform after", async () => {
  serve({ readers: allStates });
  const m = await mount();
  try {
    assert.equal(m.el.querySelector('[data-section="readers"]'), null, "the readers card is merged, not kept beside");
    const card = m.el.querySelector('[data-section="platforms"]')!;
    const keys = [...card.querySelectorAll("li[data-platform]")].map((li) => li.getAttribute("data-platform"));
    assert.deepEqual(keys, ["twitch", "youtube", "native", "kick", "streamplace", "zzz"], "every platform once; nothing the reader knows is dropped");
    assert.match(card.textContent ?? "", /Chat bot: running/);
    assert.match(card.textContent ?? "", /Embed switches apply to viewers at their next page load/);
  } finally { await m.done(); }
});

test("the merged row in each state: reading, failed with its one line, off, starting, no reader, not set up", async () => {
  const withSp = { platforms: [...platforms.platforms, { key: "streamplace", label: "Streamplace", setUp: true, embed: { source: "streamplace", on: false }, title: null, category: null, titleNote: "Not read", manageUrl: null, setupHref: "/admin/platforms?sub=streamplace" }] };
  serve({ readers: allStates, platforms: withSp });
  const m = await mount();
  try {
    // Reading + Live + embed switch + title + its link, all in Twitch's ONE row.
    const tw = rowOf(m.el, "twitch")!;
    assert.equal(tw.querySelector("[data-reader]")?.getAttribute("data-state"), "running");
    assert.match(tw.querySelector("[data-reader]")!.textContent ?? "", /^Chat reader: Reading · 10m ago$/);
    assert.equal(tw.querySelector("[data-live]")?.textContent, "Live");
    assert.ok(tw.querySelector('[aria-label="Twitch on the watch page"]'));
    assert.match(tw.querySelector("[data-title]")?.textContent ?? "", /A stream title · Just Chatting/);
    assert.match(tw.textContent ?? "", /Change the title on Twitch/);
    // Failed: the reason's first line only; scheduled chip; both YouTube notes kept.
    const yt = rowOf(m.el, "youtube")!;
    assert.equal(yt.querySelector("[data-reader]")?.getAttribute("data-state"), "failed");
    assert.equal(yt.querySelector("[data-reader-error]")?.textContent, "Chromium could not start: libnss3.so missing");
    assert.match(yt.querySelector("[data-live]")?.textContent ?? "", /^Scheduled for /);
    assert.match(yt.textContent ?? "", /Read while live on YouTube/);
    assert.match(yt.textContent ?? "", /Read-only here: setting titles and scheduling on YouTube comes with 1.0/);
    assert.ok(yt.querySelector("[data-youtube-note]"));
    // Off: no "since"; not set up: the setup jump, the switch, the offline chip.
    const kick = rowOf(m.el, "kick")!;
    assert.equal(kick.querySelector("[data-reader]")?.textContent, "Chat reader: Off");
    assert.equal(kick.querySelector("[data-admin-jump]")?.getAttribute("data-admin-jump"), "platforms/kick");
    assert.match(kick.textContent ?? "", /Not set up — set it up/);
    assert.equal(kick.querySelector("[data-live]")?.textContent, "Offline");
    assert.ok(kick.querySelector('[aria-label="Kick on the watch page"]'));
    // Starting + can't tell and why.
    const sp = rowOf(m.el, "streamplace")!;
    assert.match(sp.querySelector("[data-reader]")?.textContent ?? "", /^Chat reader: Starting · /);
    assert.equal(sp.querySelector("[data-live]")?.textContent, "Can't tell");
    assert.match(sp.querySelector("[data-live-why]")?.textContent ?? "", /^Can't tell: \S/);
    assert.equal(tw.querySelector("[data-live-why]"), null, "only a can't-tell has a reason line");
    assert.match(sp.textContent ?? "", /Not read/);
    // The site player has no chat reader: no reader line, no chip — its switch and note only.
    const site = rowOf(m.el, "native")!;
    assert.equal(site.querySelector("[data-reader]"), null);
    assert.equal(site.querySelector("[data-live]"), null);
    assert.match(site.textContent ?? "", /Plays the Streamplace stream/);
    // A platform only the reader knows: its reader line, no switch.
    const zzz = rowOf(m.el, "zzz")!;
    assert.equal(zzz.querySelector("[data-reader]")?.getAttribute("data-state"), "running");
    assert.equal(zzz.querySelector('[role="switch"]'), null);
  } finally { await m.done(); }
});

test("phone first: a row folds — its first line wraps, nothing in it refuses to shrink", () => {
  const src = readFileSync(join(import.meta.dirname, "StreamPlatforms.tsx"), "utf8");
  const firstLine = /<div className="(flex min-h-7[^"]*)">\s*<PlatformIcon/.exec(src);
  assert.ok(firstLine, "the row's first line is found");
  assert.match(firstLine![1]!, /\bflex-wrap\b/, "the first line wraps on a narrow pane");
  assert.match(src, /data-live=\{r\.live\.state\}[\s\S]{0,200}max-w-full[^"]*break-words/, "a long can't-tell chip breaks inside the pane");
  assert.doesNotMatch(src, /whitespace-nowrap|min-w-\[/, "no fixed or unbreakable width in the card");
});

test("the Refresh on the one card asks both: the platforms and the chat readers", async () => {
  serve();
  const m = await mount();
  try {
    calls = [];
    const btn = [...m.el.querySelectorAll('[data-section="platforms"] button')].find((b) => b.textContent === "Refresh") as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await settle();
    assert.ok(calls.includes("/api/admin/stream/platforms"), calls.join(", "));
    assert.ok(calls.includes("/api/admin/stream/readers"), calls.join(", "));
  } finally { await m.done(); }
});

// ── #247: the OBS card is Utility › OBS's own component ────────────────────────────────────────────
test("the OBS card: status light, scene buttons and the two tests; a scene tap goes down the rig route", async () => {
  serve();
  const m = await mount();
  try {
    const obs = m.el.querySelector('[data-section="obs"]')!;
    assert.ok(obs, "the OBS card is on the tab");
    assert.equal(obs.getAttribute("data-rig-panel"), "on");
    assert.equal(obs.querySelector("[data-rig-light]")?.getAttribute("data-rig-light"), "on");
    assert.match(obs.textContent ?? "", /Connected since/);
    const scenes = [...obs.querySelectorAll('[aria-label="OBS scenes"] button')].map((b) => b.textContent);
    assert.deepEqual(scenes, ["Intro", "Main", "BRB"]);
    assert.ok([...obs.querySelectorAll("button")].some((b) => b.textContent === "Test voice"));
    assert.ok([...obs.querySelectorAll("button")].some((b) => b.textContent === "Test sound"));
    assert.doesNotMatch(obs.innerHTML, /SECRETKEY|key=/, "the browser source address and its key stay on the admin page — a stream screen is on camera");
    const brb = [...obs.querySelectorAll("button")].find((b) => b.textContent === "BRB") as HTMLButtonElement;
    await act(async () => { brb.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await settle();
    assert.ok(calls.includes("POST /api/admin/rig"), calls.join(", "));
    assert.deepEqual(JSON.parse(bodies[bodies.length - 1]!), { action: "scene", name: "BRB" });
    assert.match(obs.querySelector('[role="status"]')?.textContent ?? "", /Asked OBS to show BRB/);
  } finally { await m.done(); }
});

test("the OBS card with the module off, or no rig page, says so in one line; an inactive tab does not ask", async () => {
  serve({ rig: { on: false, error: null, connected: 0, pages: [], scenes: [], scene: null, speaking: false, sink: null, url: null } });
  let m = await mount();
  try {
    const obs = m.el.querySelector('[data-section="obs"]')!;
    assert.equal(obs.getAttribute("data-rig-panel"), "off");
    assert.match(obs.textContent ?? "", /The OBS module is off/);
  } finally { await m.done(); }
  serve({ rig: { ...rigOn, connected: 0, pages: [], scenes: [] } });
  m = await mount();
  try {
    assert.match(m.el.querySelector('[data-section="obs"]')?.textContent ?? "", /No rig page is connected/);
    assert.equal(m.el.querySelector('[data-section="obs"] [data-rig-light]')?.getAttribute("data-rig-light"), "off");
  } finally { await m.done(); }
  serve();
  m = await mount(false);
  try { assert.ok(!calls.some((u) => u.includes("/api/admin/rig")), calls.join(", ")); } finally { await m.done(); }
});

test("the OBS card and Utility › OBS are ONE component: both mount RigPanel, and the controls live only there", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dirname, rel), "utf8");
  const tab = read("StreamTab.tsx");
  const admin = read("../instance/AdminPanel.tsx");
  const index = read("../instance/index.ts");
  assert.match(tab, /import \{ RigPanel \} from "@\/app\/features\/instance";/);
  assert.match(tab, /<RigPanel frame=\{OBS_FRAME\} active=\{active\} \/>/);
  assert.match(admin, /import RigPanel from "\.\/RigPanel";/);
  assert.match(admin, /<RigPanel note=\{note\} \/>/);
  assert.match(index, /export \{ default as RigPanel \} from "\.\/RigPanel";/);
  // No copy: the scene and test controls' words are written in RigPanel.tsx and nowhere in this feature.
  const rig = read("../instance/RigPanel.tsx");
  for (const words of ["Test voice", "Test sound", 'aria-label="OBS scenes"', "action: \"scene\""]) {
    assert.ok(rig.includes(words), `RigPanel has ${words}`);
    for (const f of ["StreamTab.tsx", "StreamPlatforms.tsx", "StreamSettings.tsx", "AdminJump.tsx", "StreamHealth.tsx", "StreamIncome.tsx", "StreamCharts.tsx"]) {
      assert.ok(!read(f).includes(words), `${f} carries its own copy of ${words}`);
    }
  }
});

// ── #247: settings reach — jumps into the Admin window ─────────────────────────────────────────────
test("the settings jumps name Timer, Support bar, Effects and OBS — each a real Admin Panel place", () => {
  assert.deepEqual(SETTINGS_JUMPS.map((j) => j.place), ["utility/timer", "utility/bar", "utility/effects", "utility/obs"]);
  const ids = new Set(adminRail().map((x) => x.id));
  for (const j of SETTINGS_JUMPS) assert.ok(ids.has(j.place), `${j.place} is not in the Admin Panel's rail`);
});

test("a settings jump opens the Admin window at its place (claimed: the stream stays); unclaimed it is the /admin deep link", async () => {
  serve();
  const m = await mount();
  const asked: unknown[] = [];
  const host = (e: Event) => { e.preventDefault(); asked.push((e as CustomEvent).detail); };
  try {
    const links = [...m.el.querySelectorAll('[data-section="settings"] a')] as HTMLAnchorElement[];
    assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute("href")]), [
      ["Timer", "/admin/utility?sub=timer"], ["Support bar", "/admin/utility?sub=bar"],
      ["Effects", "/admin/utility?sub=effects"], ["OBS", "/admin/utility?sub=obs"],
    ]);
    dom.window.addEventListener("bb:open-adminpanel", host);
    const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => { links[1]!.dispatchEvent(click); });
    assert.deepEqual(asked, [{ place: "utility/bar" }]);
    assert.equal(click.defaultPrevented, true, "a host took it: the page does not navigate away from the stream");
    dom.window.removeEventListener("bb:open-adminpanel", host);
  } finally { dom.window.removeEventListener("bb:open-adminpanel", host); await m.done(); }
});

// ── restart and retry ──────────────────────────────────────────────────────────────────────────────
test("restart: the tab closed and opened again reads everything fresh — the merged rows and the OBS card come back", async () => {
  serve({ readers: allStates });
  let m = await mount();
  await m.done();
  serve({ readers: allStates });
  m = await mount();
  try {
    assert.ok(calls.includes("/api/admin/stream/platforms") && calls.includes("/api/admin/stream/readers") && calls.includes("/api/admin/rig"), calls.join(", "));
    assert.equal(rowOf(m.el, "twitch")?.querySelector("[data-reader]")?.getAttribute("data-state"), "running");
    assert.equal(m.el.querySelector('[data-section="obs"]')?.getAttribute("data-rig-panel"), "on");
  } finally { await m.done(); }
});

test("retry: a chat-reader read that failed says so, and Refresh fills the rows' reader lines", async () => {
  serve();
  const served = globalThis.fetch;
  let failOnce = true;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/stream/readers") && failOnce) { failOnce = false; return Promise.resolve(new Response("{}", { status: 502 })); }
    return served(url, init);
  }) as typeof fetch;
  const m = await mount();
  try {
    assert.match(m.el.querySelector('[data-readers="unknown"]')?.textContent ?? "", /Couldn't ask the chat reader service/);
    assert.equal(m.el.querySelector("[data-reader]"), null);
    assert.ok(rowOf(m.el, "twitch")?.querySelector("[data-title]"), "the site's side is there while the readers are not");
    const btn = [...m.el.querySelectorAll('[data-section="platforms"] button')].find((b) => b.textContent === "Refresh") as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await settle();
    assert.equal(m.el.querySelector('[data-readers="unknown"]'), null);
    assert.equal(rowOf(m.el, "twitch")?.querySelector("[data-reader]")?.getAttribute("data-state"), "running");
  } finally { await m.done(); globalThis.fetch = served; }
});

test("retry: a scene switch OBS refused says why, and the next tap goes through", async () => {
  serve();
  const served = globalThis.fetch;
  let refuse = true;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/rig") && init?.method === "POST" && refuse) {
      refuse = false;
      return Promise.resolve(new Response(JSON.stringify({ ok: false, code: "not_connected" }), { status: 409, headers: { "content-type": "application/json" } }));
    }
    return served(url, init);
  }) as typeof fetch;
  const m = await mount();
  try {
    const obs = m.el.querySelector('[data-section="obs"]')!;
    const tap = async (name: string) => {
      const b = [...obs.querySelectorAll("button")].find((x) => x.textContent === name) as HTMLButtonElement;
      await act(async () => { b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      await settle();
    };
    await tap("BRB");
    assert.match(obs.querySelector('[role="status"]')?.textContent ?? "", /Not switched: no rig page is connected/);
    await tap("BRB");
    assert.match(obs.querySelector('[role="status"]')?.textContent ?? "", /Asked OBS to show BRB/);
  } finally { await m.done(); globalThis.fetch = served; }
});

// Vacuity anchor for the source scans above: they read real files with real content.
test("vacuity: the scanned sources are the real ones", () => {
  const tab = readFileSync(join(import.meta.dirname, "StreamTab.tsx"), "utf8");
  const plat = readFileSync(join(import.meta.dirname, "StreamPlatforms.tsx"), "utf8");
  const rig = readFileSync(join(import.meta.dirname, "../instance/RigPanel.tsx"), "utf8");
  assert.ok(tab.length > 3000 && tab.includes("export function StreamTab"), "StreamTab.tsx read");
  assert.ok(plat.length > 3000 && plat.includes("export function StreamPlatforms"), "StreamPlatforms.tsx read");
  assert.ok(rig.length > 3000 && rig.includes("export default function RigPanel"), "RigPanel.tsx read");
});
