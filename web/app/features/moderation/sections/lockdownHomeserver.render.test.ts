// The Lockdown screen says plainly that homeserver sign-up is a separate door: on a bundle the
// signups lever closes it too (and says so), elsewhere it is managed outside Black Branch.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/moderation/sections/lockdownHomeserver.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../../lib/testDom.ts";
import "../../../lib/testTsx.ts";
const { default: LockdownSection } = await import("./LockdownSection.tsx");
const { createRoot } = await import("react-dom/client");

let state: Record<string, unknown> = {};
globalThis.fetch = (async () => new Response(JSON.stringify(state), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

const base = { signupsDisabled: false, crosspostDisabled: false, minAccountAgeDays: 0, ingestPaused: [], subOnly: false, expiresAt: null, live: false, reason: null, updatedBy: null, updatedAt: null };

async function lineFor(over: Record<string, unknown>) {
  state = { ...base, ...over };
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(LockdownSection as never, { note: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const line = el.querySelector("[data-homeserver-signup]");
  const out = { managed: line?.getAttribute("data-homeserver-signup"), text: line?.textContent ?? "" };
  await act(async () => { root.unmount(); el.remove(); });
  return out;
}

test("a bundle with sign-up open: the lever says it closes it too", async () => {
  const r = await lineFor({ homeserver: { managed: "bundle", registration: "open", closedByLockdown: false } });
  assert.equal(r.managed, "bundle");
  assert.equal(r.text, "Homeserver sign-up is open: this lever also closes it while on.");
});

test("lever on: closed by this lockdown, and it opens again when the lockdown lifts", async () => {
  const r = await lineFor({ signupsDisabled: true, homeserver: { managed: "bundle", registration: "closed", closedByLockdown: true } });
  assert.equal(r.text, "Homeserver sign-up: closed by this lockdown; it opens again when the lockdown lifts.");
});

test("not a bundle: managed outside Black Branch, and where to close it", async () => {
  const r = await lineFor({ homeserver: { managed: "outside" } });
  assert.equal(r.managed, "outside");
  assert.match(r.text, /^Homeserver sign-up is separate and managed outside Black Branch: close it in your homeserver's sign-in service/);
  assert.match(r.text, /an account made there can still join the community's rooms/);
});

test("a render that has not landed yet: the line says the homeserver does not have it yet", async () => {
  const r = await lineFor({ signupsDisabled: true, homeserver: { managed: "bundle", registration: "closed", closedByLockdown: true, applied: false } });
  assert.equal(r.text, "Homeserver sign-up: closed by this lockdown; it opens again when the lockdown lifts. Not applied to the homeserver yet — retrying.");
});

test("lever on, sign-up open (an admin opened it during the lockdown): said as kept, not as closing", async () => {
  const r = await lineFor({ signupsDisabled: true, homeserver: { managed: "bundle", registration: "open", closedByLockdown: false, applied: true } });
  assert.equal(r.text, "Homeserver sign-up: open — set in Admin Panel → Site during this lockdown, and left as set.");
});

test("the cross-posting lever names the platforms site chat is sent on to, never YouTube (no posting there in this release)", async () => {
  state = { ...base, homeserver: null };
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(LockdownSection as never, { note: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const text = el.textContent ?? "";
  assert.match(text, /Stops site chat being sent on to Twitch, Kick and Streamplace\./);
  assert.doesNotMatch(text, /sending to [^.]*YouTube/);
  await act(async () => { root.unmount(); el.remove(); });
});
