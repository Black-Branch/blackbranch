// Admin Panel → Updates, mounted: Apply asks first (an update takes the site down), and while the
// stream is live it is held back with the reason on the page. The server refuses it too
// (app/lib/updates/updates.test.ts).
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/updatesPanel.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: UpdatesPanel } = await import("./UpdatesPanel.tsx");
const { createRoot } = await import("react-dom/client");

const recent = new Date(Date.now() - 3_600_000).toISOString();
const viewOf = (live: boolean | null) => ({
  bundle: true, rows: [], at: recent, live, last: null, state: null,
  check: { at: recent, ok: true, readAt: recent, channel: "stable", current: "1.1.0", refused: null, error: null,
    available: { version: "1.2.0", security: false, published: recent, notes: "" } },
});

let posts: unknown[] = [];
let current = viewOf(false);
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify(current), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(UpdatesPanel as never)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}
const applyButton = (el: Element) => [...el.querySelectorAll("button")].find((b) => /^Apply /.test(b.textContent ?? "")) as HTMLButtonElement;

test("Apply asks first: cancelled, nothing is asked of the box; confirmed, the request goes", async () => {
  current = viewOf(false);
  const { el, unmount } = await mount();
  const asked: string[] = [];
  let answer = false;
  dom.window.confirm = (m?: string) => { asked.push(String(m)); return answer; };
  posts = [];
  await act(async () => { applyButton(el).click(); });
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /Apply 1\.2\.0 now\? A backup is made first, then the site is down for a few minutes/);
  assert.deepEqual(posts, [], "cancelled: no request");
  answer = true;
  await act(async () => { applyButton(el).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(posts, [{ action: "apply", version: "1.2.0" }]);
  await unmount();
});

test("while the stream is live, Apply is held back and the page says why", async () => {
  current = viewOf(true);
  const { el, unmount } = await mount();
  assert.equal(applyButton(el).disabled, true);
  assert.match(el.querySelector("[data-live-hold]")?.textContent ?? "", /The stream is live: an update takes the site down for a few minutes, so Apply waits until the stream ends\./);
  await unmount();
});

test("the release on offer shows its notes from the signed feed (the host's check carries them through)", async () => {
  current = viewOf(false);
  current.check.available.notes = "Fixes the player.\nAdds a Leaderboard switch.";
  const { el, unmount } = await mount();
  assert.ok(el.textContent?.includes("Fixes the player."), "the first line of the notes");
  assert.ok(el.textContent?.includes("Adds a Leaderboard switch."), "every line");
  await unmount();
  current = viewOf(false);
});
