// Reports (filing one from a message; mods reading them in the Mod Panel) and appointing
// moderators (the Admin Panel's list; /mod and /unmod in the help).
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/reportsAndModerators.render.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { openReportDialog, reportOutcome } = await import("@/app/components/ReportDialog");
const { default: ReportsSection } = await import("@/app/features/moderation/sections/ReportsSection");
const { default: ModeratorList } = await import("@/app/features/moderation/sections/ModeratorList");
const { helpText } = await import("./commands/parse.ts");
const { createRoot } = await import("react-dom/client");

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function serve(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    return Promise.resolve(new Response(JSON.stringify(key ? routes[key] : {}), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return calls;
}
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function button(re: RegExp): HTMLButtonElement | null {
  return ([...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => re.test(b.textContent ?? "")) ?? null;
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}
async function mount(el: React.ReactElement) {
  resetStorage();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, cleanup: () => act(async () => { root.unmount(); host.remove(); }) };
}

test("Report on a platform-only chatter's line sends the MESSAGE (platform + id) and a reason — no identity", async () => {
  const calls = serve({ "/api/support/report": { ok: true } });
  await act(async () => { openReportDialog({ platform: "kick", messageId: 99, name: "rowdy" }); });
  const box = dom.window.document.querySelector('textarea[aria-label="Reason"]') as HTMLTextAreaElement;
  assert.ok(box, "the dialog opened");
  await act(async () => { type(box, "slurs"); });
  await act(async () => { button(/^Send report$/)!.click(); });
  await tick();
  const sent = calls.filter((c) => c.url === "/api/support/report");
  assert.deepEqual(sent.map((c) => c.body), [{ platform: "kick", messageId: 99, reason: "slurs" }]);
  assert.match(dom.window.document.body.textContent ?? "", /Reported — the mods will see it\./);
  await act(async () => { button(/^Cancel$/)!.click(); });
  assert.equal(dom.window.document.querySelector('textarea[aria-label="Reason"]'), null, "the dialog closed");
});

test("the dialog says why a report was refused", () => {
  assert.equal(reportOutcome(400, "self"), "That's your own message.");
  assert.equal(reportOutcome(404, "message_not_found"), "That message is gone.");
  assert.equal(reportOutcome(422, "blocked"), "That reason tripped the word filter — reword it.");
});

test("mods read reports in the Mod Panel: who, by whom, why, the reported line — and resolve them", async () => {
  const calls = serve({ "/api/mod/support": { tickets: [], reports: [{
    id: 5, reason: "slurs", created_at: new Date().toISOString(), reported: "rowdy", reporter: "casey",
    reported_id: null, reported_canonical_id: "0123456789ab", message_platform: "kick", message_id: "99", message_text: "the bad line",
  }] } });
  const { host, cleanup } = await mount(React.createElement(ReportsSection, { note: () => {} }));
  await tick();
  const text = host.textContent ?? "";
  assert.match(text, /rowdy \(no site account\) reported by casey/);
  assert.match(text, /slurs/);
  assert.match(text, /“the bad line”/);
  await act(async () => { button(/^Resolve$/)!.click(); });
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.body), [{ kind: "report", id: 5 }]);
  await cleanup();
});

test("the Admin Panel's Moderators lists the role, adds by name and removes", async () => {
  const calls = serve({ "/api/mod/setmod": { moderators: [{ matrixId: "@rosalind:site.test", displayName: "Rosalind", since: null }] } });
  const { host, cleanup } = await mount(React.createElement(ModeratorList, { note: () => {} }));
  await tick();
  assert.match(host.textContent ?? "", /Rosalind/);
  await act(async () => { type(host.querySelector('input[aria-label="Make a moderator"]') as HTMLInputElement, "@quinn:site.test"); });
  await act(async () => { button(/^Make moderator$/)!.click(); });
  await tick();
  await act(async () => { button(/^Remove moderator$/)!.click(); });
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.body), [
    { targetId: "@quinn:site.test", grant: true },
    { targetId: "@rosalind:site.test", grant: false },
  ]);
  await cleanup();
});

test("/help shows /mod and /unmod to admins only, and there is no /setmod", () => {
  const admin = helpText("", { isMod: true, isAdmin: true });
  assert.match(admin, /^\/mod <user> — Make someone a moderator: the Mod Panel, and mod power in the community rooms$/m);
  assert.match(admin, /^\/unmod <user> — Remove someone's moderator role and their community room power$/m);
  assert.doesNotMatch(admin, /\/setmod|\/unsetmod/);
  assert.doesNotMatch(helpText("", { isMod: true, isAdmin: false }), /^\/mod /m);
  assert.match(helpText("mod", { isMod: true, isAdmin: true }), /^\/mod <user>/m);
});
