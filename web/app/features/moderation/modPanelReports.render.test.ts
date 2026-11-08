// The Mod Panel, mounted: Reports carries the pending count from GET /api/mod/support (KG-18), the
// count follows a resolve, and Mod history names the new actions in words (KG-19).
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/moderation/modPanelReports.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: ModPanel } = await import("./ModPanel.tsx");
const { createRoot } = await import("react-dom/client");

const report = (id: number) => ({
  id, reason: "spam", created_at: new Date().toISOString(), reported: "casey", reporter: "a member",
  reported_id: "@casey:site.test", reported_canonical_id: null, message_platform: null, message_id: null, message_text: null,
});
let pending = [report(1)];
let supportReads = 0;
const logEntries = [
  { id: 3, action: "report_resolved", targetId: "@casey:site.test", targetName: "casey", performedBy: "@m:site.test", modName: "robin", durationMinutes: null, expiresAt: null, reason: "report #1", batchId: null, at: new Date().toISOString() },
  { id: 2, action: "identity_merged", targetId: "aaaaaaaaaaaa", targetName: "casey", performedBy: "@m:site.test", modName: "robin", durationMinutes: null, expiresAt: null, reason: "merged in bbbbbbbbbbbb", batchId: null, at: new Date().toISOString() },
  { id: 1, action: "held_released", targetId: "@casey:site.test", targetName: "casey", performedBy: "@m:site.test", modName: "robin", durationMinutes: null, expiresAt: null, reason: "held by link_gate · #4", batchId: null, at: new Date().toISOString() },
];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  let body: unknown = {};
  if (u === "/api/mod/support" && init?.method === "POST") { pending = []; body = { ok: true }; }
  else if (u === "/api/mod/support") { supportReads++; body = { tickets: [], reports: pending }; }
  else if (u.startsWith("/api/mod/log")) body = { entries: logEntries };
  else if (u.startsWith("/api/mod/chat-history")) body = { messages: [], nextCursor: null };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function mount(props: Record<string, unknown> = {}) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(ModPanel as never, props)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

const reportsTab = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => b.querySelector(".chrome-tab-label")?.textContent === "Reports") ?? null;

test("ModPanel shows the pending count on Reports", async () => {
  pending = [report(1)];
  const { el, done } = await mount();
  const tab = reportsTab(el);
  assert.ok(tab, "the Reports place is in the rail");
  assert.equal(tab.querySelector("[data-count]")?.getAttribute("data-count"), "1");
  assert.match(tab.textContent ?? "", /1 waiting/, "a screen reader hears the count");
  assert.match(el.querySelector(".chrome-rail-picker")?.textContent ?? "", /Chat history · 1 report/, "the folded picker says it too");
  await done();
});

test("no pending report, no count", async () => {
  pending = [];
  const { el, done } = await mount();
  assert.equal(reportsTab(el)?.querySelector("[data-count]") == null, true, "no count drawn");
  assert.doesNotMatch(el.querySelector(".chrome-rail-picker")?.textContent ?? "", /report/);
  await done();
});

test("retry: resolving the report takes the count away (the list is read again)", async () => {
  pending = [report(1)];
  const { el, done } = await mount({ initialPlace: "reports" });
  assert.equal(reportsTab(el)?.querySelector("[data-count]")?.getAttribute("data-count"), "1");
  const resolve = [...el.querySelectorAll("button")].find((b) => b.textContent === "Resolve")!;
  await act(async () => { resolve.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(reportsTab(el)?.querySelector("[data-count]") == null, true, "no count drawn");
  await done();
});

test("restart: a new mount reads the count from the server again (nothing kept in the page)", async () => {
  pending = [report(1), report(2)];
  const before = supportReads;
  const { el, done } = await mount();
  assert.ok(supportReads > before);
  assert.equal(reportsTab(el)?.querySelector("[data-count]")?.getAttribute("data-count"), "2");
  assert.match(el.querySelector(".chrome-rail-picker")?.textContent ?? "", /2 reports/);
  await done();
});

test("Mod history names merges, resolutions and releases in words", async () => {
  const { el, done } = await mount({ initialPlace: "history" });
  const shown = [...el.querySelectorAll("[data-action]")].map((s) => s.textContent);
  assert.deepEqual(shown, ["Report resolved", "Identities merged", "Held message allowed"]);
  await done();
});
