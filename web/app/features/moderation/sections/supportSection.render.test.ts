// Admin Panel → Site → Support tickets, mounted: the "Forward to Black Branch" switch, a Send per
// ticket and Send all (skipping what was sent). This release has no transport (ticketForward.ts),
// so the page shows them switched off with one line saying so; with one, they send.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/moderation/sections/supportSection.render.test.ts
import "../../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../../lib/testDom.ts";
import "../../../lib/testTsx.ts";
const { default: SupportSection } = await import("./SupportSection.tsx");
const { forwarding, forwardTickets } = await import("../../../lib/ticketForward.ts");
const { createRoot } = await import("react-dom/client");

const tickets = [
  { id: 1, kind: "bug", body: "The player froze.", transcript: null, created_at: new Date().toISOString(), who: "casey" },
  { id: 2, kind: "other", body: "How do I link Kick?", transcript: null, created_at: new Date().toISOString(), who: "robin" },
];
let fwd: unknown = { available: false, on: false, sent: [] };
let sent: { url: string; body: unknown }[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (init?.method === "POST") sent.push({ url: u, body: JSON.parse(String(init.body)) });
  const body = u === "/api/mod/support" ? { tickets, reports: [] } : u === "/api/admin/support/forward" && init?.method !== "POST" ? fwd : { ok: true, sent: [2], skipped: [1] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(SupportSection as never, { note: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

test("this release: the seam cannot send, and says so", async () => {
  assert.deepEqual(forwarding(), { available: false, on: false, sent: [] });
  assert.deepEqual(await forwardTickets([1]), { ok: false, error: "Forwarding tickets to Black Branch arrives in a later release." });
});

test("without a transport: the switch, Send and Send all are there, switched off, with one line saying why", async () => {
  fwd = { available: false, on: false, sent: [] };
  const { el, done } = await mount();
  const card = el.querySelector('[aria-label="Forward to Black Branch"]')!;
  assert.equal(card.getAttribute("data-forwarding"), "later");
  assert.equal((card.querySelector("[role=switch]") as HTMLButtonElement).disabled, true);
  assert.equal((card.querySelector("[data-send-all]") as HTMLButtonElement).disabled, true);
  assert.match(card.textContent ?? "", /arrives in a later release/);
  assert.equal(el.querySelectorAll("[data-send]").length, 2, "a Send per ticket");
  for (const b of el.querySelectorAll("[data-send]")) assert.equal((b as HTMLButtonElement).disabled, true);
  await done();
});

test("with a transport: a sent ticket says Sent; Send sends one; Send all asks for every open one", async () => {
  fwd = { available: true, on: true, sent: [1] };
  const { el, done } = await mount();
  const one = el.querySelector('[data-send="1"]') as HTMLButtonElement;
  assert.equal(one.textContent, "Sent");
  assert.equal(one.disabled, true);
  sent = [];
  await act(async () => { (el.querySelector('[data-send="2"]') as HTMLButtonElement).click(); });
  await act(async () => { (el.querySelector("[data-send-all]") as HTMLButtonElement).click(); });
  assert.deepEqual(sent, [{ url: "/api/admin/support/forward", body: { ids: [2] } }, { url: "/api/admin/support/forward", body: { all: true } }]);
  await done();
});
