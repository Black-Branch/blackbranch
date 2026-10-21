// Admin Panel → AI → Help Desk shows the picture the help desk uses: the bot account's avatar, and
// the site icon when the bot has none (the avatar route answers 404) or there is no bot account —
// never a broken image. It says how to change it.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/helpdeskPicture.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: HelpdeskPicture, botMatrixId } = await import("./HelpdeskPicture.tsx");
const { createRoot } = await import("react-dom/client");

async function mount(botId: string | null) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(HelpdeskPicture as never, { botId })); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

test("a bot account: its picture from the public avatar route, and the account named in how to change it", async () => {
  const { el, done } = await mount("@helper:site.test");
  const card = el.querySelector("[data-helpdesk-picture]")!;
  assert.equal(card.getAttribute("data-helpdesk-picture"), "bot");
  assert.equal(card.querySelector("img")?.getAttribute("src"), "/api/avatar/public/bot");
  assert.match(card.textContent ?? "", /sign in to the community as @helper:site\.test and set its avatar/);
  await done();
});

test("the bot has no picture (the route answers 404): the site icon takes its place, and the page says why", async () => {
  const { el, done } = await mount("@helper:site.test");
  const img = el.querySelector("img")!;
  await act(async () => { img.dispatchEvent(new dom.window.Event("error")); });
  const card = el.querySelector("[data-helpdesk-picture]")!;
  assert.equal(card.getAttribute("data-helpdesk-picture"), "site-icon");
  assert.equal(card.querySelector("img")?.getAttribute("src"), "/brand/icon-192.png", "the product's set: this test install names no icon folder");
  assert.match(card.textContent ?? "", /shows the site icon: the bot account has no picture/);
  await done();
});

test("no bot account: the site icon from the first frame, never a request for a picture nobody has", async () => {
  const { el, done } = await mount(null);
  assert.equal(el.querySelector("img")?.getAttribute("src"), "/brand/icon-192.png");
  assert.match(el.textContent ?? "", /the bot account \(AI → Chat Bot\)/);
  await done();
});

test("the bot account is read from the settings view: saved, else what the website reads; blank is none", () => {
  const k = (stored: unknown, web: unknown) => ({ keys: [{ key: "bot.matrixId", label: "Bot", kind: "string", tier: "instance",
    stored: stored === null ? null : { display: stored }, packages: [{ package: "web", known: true, display: web }] }] }) as never;
  assert.equal(botMatrixId(k("@a:site.test", "@b:site.test")), "@a:site.test");
  assert.equal(botMatrixId(k(null, "@b:site.test")), "@b:site.test");
  assert.equal(botMatrixId(k(null, "  ")), null);
  assert.equal(botMatrixId({ keys: [] } as never), null);
});
