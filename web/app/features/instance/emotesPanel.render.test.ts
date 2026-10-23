// Admin Panel → Platforms → Emotes, mounted: every set the site reads, a channel set without its
// channel id says so and links where it is set, Check and Refresh go through the mod emote route
// and show each set's count, and switching a set off / approvals are said to be a later release
// (no setting is behind them), never offered as a dead control.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/emotesPanel.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: EmotesPanel } = await import("./EmotesPanel.tsx");
const { buildInstanceView } = await import("../../lib/instanceAdminView.ts");
const { createRoot } = await import("react-dom/client");

let sent: unknown[] = [];
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body ?? "{}")));
  const body = { ok: true, wouldLoad: 120, count: 120, slices: [{ id: "7tv:global", fresh: 50, prev: 50, kept: "fresh" }, { id: "7tv:channel", fresh: 9, prev: 12, kept: "last-good" }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

/** An install view with the Twitch channel and broadcaster id set, no Kick channel. */
function inst() {
  const v = buildInstanceView(null);
  const set = (key: string, display: string) => {
    const k = v.keys.find((x) => x.key === key)!;
    k.packages = k.packages.map((p) => ({ ...p, display, source: "database" }));
  };
  set("platform.twitch.channel", "casey");
  set("platform.twitch.broadcasterId", "4242");
  return v;
}

async function mount(go: (id: string) => void = () => {}) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(EmotesPanel as never, { inst: inst(), note: () => {}, go })); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

test("every set is listed; Kick's without a Kick channel says so and links Kick", async () => {
  const opened: string[] = [];
  const { el, done } = await mount((id) => opened.push(id));
  const ids = [...el.querySelectorAll("[data-set]")].map((x) => x.getAttribute("data-set"));
  assert.deepEqual(ids, ["7tv:global", "bttv:global", "ffz:global", "twitch:channel", "7tv:channel", "bttv:channel", "ffz:channel", "7tv:kick"]);
  assert.deepEqual([...el.querySelectorAll("[data-missing]")].map((x) => x.getAttribute("data-set")), ["7tv:kick"]);
  await act(async () => { (el.querySelector('[data-set="7tv:kick"] button') as HTMLButtonElement).click(); });
  assert.deepEqual(opened, ["platforms/kick"]);
  await done();
});

test("Check and Refresh ask the mod emote route and show each set's count", async () => {
  const { el, done } = await mount();
  sent = [];
  await act(async () => { (el.querySelector("[data-emotes-check]") as HTMLButtonElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(el.querySelector('[data-set="7tv:global"]')?.textContent ?? "", /50 emotes/);
  assert.match(el.querySelector('[data-set="7tv:channel"]')?.textContent ?? "", /9 emotes, keeping the last 12/);
  await act(async () => { (el.querySelector("[data-emotes-refresh]") as HTMLButtonElement).click(); });
  assert.deepEqual(sent, [{ action: "check" }, { action: "refresh" }]);
  await done();
});

test("switching a set off and approvals: said to be a later release, no control", async () => {
  const { el, done } = await mount();
  const card = el.querySelector('[aria-label="Approvals"]')!;
  assert.match(card.textContent ?? "", /later release/);
  assert.equal(card.querySelectorAll("button, input, [role=switch]").length, 0);
  await done();
});
