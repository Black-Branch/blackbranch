// The Stream tab mounted for real: the SSR frame, income off by default and NOT REQUESTED, the
// switch asking for it, the live view, a past stream's review, the empty install.
// Run: node --test app/features/stream/streamTab.render.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { StreamTab } = await import("./StreamTab.tsx");
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
  { key: "native", label: "Site player", setUp: true, embed: { source: "native", on: true }, title: null, category: null, titleNote: "Plays the stream.place stream", manageUrl: null, setupHref: "/admin/platforms?sub=streamplace" },
  { key: "kick", label: "Kick", setUp: false, embed: null, title: null, category: null, titleNote: "Not set up", manageUrl: null, setupHref: "/admin/platforms?sub=kick" },
] };
const doctor = { rows: [{ id: "a", title: "Database", status: "ok" }, { id: "b", title: "Backups", status: "fail" }] };

let calls: string[] = [];
let bodies: string[] = [];
function serve(opts: { live?: boolean; empty?: boolean } = {}) {
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
    else if (u.startsWith("/api/admin/stream/platforms")) body = platforms;
    else if (u.startsWith("/api/admin/stream")) body = opts.live === false ? { live: { live: false }, dash: null, last: opts.empty ? null : { ...past, earnedCents: income ? 999 : null }, atMs: now } : liveReply(income);
    else if (u.startsWith("/api/admin/doctor")) body = doctor;
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
    assert.match(html, /No embed on the site/);
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
    assert.deepEqual(JSON.parse(bodies[bodies.length - 1]!), { value: ["twitch", "youtube"] }, "the whole list of what is off — this one plus the ones already off");
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
