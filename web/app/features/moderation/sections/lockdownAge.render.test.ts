// The Lockdown screen, mounted: the account-age lever's line comes from the lockdown view's
// `checkable` (stream-api /lockdown/checkable) — each uncheckable platform says "age unknown — not
// held", and the old "holds ALL Kick chat" / "under 7d" for every platform is gone.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/moderation/sections/lockdownAge.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../../lib/testDom.ts";
import "../../../lib/testTsx.ts";
const { default: LockdownSection } = await import("./LockdownSection.tsx");
const { createRoot } = await import("react-dom/client");

let state: Record<string, unknown> = {};
globalThis.fetch = (async () => new Response(JSON.stringify(state), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

const base = { signupsDisabled: false, crosspostDisabled: false, minAccountAgeDays: 0, ingestPaused: [], subOnly: false, expiresAt: null, live: false, reason: null, updatedBy: null, updatedAt: null, homeserver: null };

async function ageText(over: Record<string, unknown>) {
  state = { ...base, ...over };
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(LockdownSection as never, { note: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const unknown = [...el.querySelectorAll("[data-age-unknown]")].map((n) => n.textContent);
  const lever = [...el.querySelectorAll("div")].find((d) => d.textContent?.startsWith("Minimum account age") && d.className.includes("leading-tight"));
  const detail = lever?.nextElementSibling?.textContent ?? "";
  const out = { unknown, detail, all: el.textContent ?? "" };
  await act(async () => { root.unmount(); el.remove(); });
  return out;
}

test("armed, Kick uncheckable: Twitch and YouTube held under 7d; 'Age unknown on Kick — not held'", async () => {
  const r = await ageText({ minAccountAgeDays: 7, checkable: { twitch: true, kick: false, youtube: true, streamplace: false, native: true } });
  assert.match(r.detail, /^Holding Twitch and YouTube accounts under 7d\./);
  assert.deepEqual(r.unknown, ["Age unknown on Kick — not held.", "Age unknown on Streamplace — not held."]);
  assert.doesNotMatch(r.all, /ALL Kick chat/);
});

test("an older server with no checkable answer: no platform named, nothing claimed about Kick", async () => {
  const r = await ageText({ minAccountAgeDays: 0 });
  assert.match(r.detail, /^Holds new platform accounts for review, where the platform says how old an account is\./);
  assert.deepEqual(r.unknown, []);
  assert.doesNotMatch(r.all, /ALL Kick chat|Kick publishes no account age/);
});
