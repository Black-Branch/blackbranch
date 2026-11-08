// The composer's own avatar button (UserMenu): a person with no picture — /api/avatar/me answers
// 404 — sees the coloured letter circle, never the browser's broken-image icon. Including when
// the 404 landed before React attached its onError (a cached 404, a server-rendered page).
//
// jsdom loads no images: `complete`/`naturalWidth` are stubbed on the image prototype BEFORE the
// ref attaches, which is exactly what a real browser reports for a picture that has failed.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/userMenuAvatar.render.test.ts
import "../lib/testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";

installResizeObserverStub();
// The idle prefetch of the card's data: nothing to fetch here.
(globalThis as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});

let broken = true;
const proto = dom.window.HTMLImageElement.prototype;
Object.defineProperty(proto, "complete", { configurable: true, get: () => true });
Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => (broken ? 0 : 64) });

const { default: UserMenu } = await import("./UserMenu.tsx");
const { createRoot } = await import("react-dom/client");

async function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(UserMenu, { matrixId: "@kay:site.test" })); });
  return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

test("no avatar → letter circle, no img", async () => {
  broken = true;
  const m = await mount();
  const btn = m.host.querySelector("button")!;
  assert.ok(btn, "the avatar button rendered");
  assert.ok(btn.querySelector("img") === null, "no broken image is left on screen");
  assert.equal(btn.textContent?.trim(), "K", "the person's letter shows");
  const circle = btn.querySelector("[data-letter-circle]") as HTMLElement | null;
  assert.ok(circle, "the shared letter circle (Avatar.tsx) is what renders");
  assert.ok(circle!.style.backgroundColor, "the circle is coloured");
  await m.unmount();
});

test("a picture that loaded → the picture", async () => {
  broken = false;
  const m = await mount();
  const img = m.host.querySelector("button img");
  assert.ok(img, "the picture shows");
  assert.match(img!.getAttribute("src") ?? "", /^\/api\/avatar\/me\?v=/);
  await m.unmount();
});

test("vacuity: UserMenu draws its fallback with the shared letter circle", () => {
  const src = readFileSync(new URL("./UserMenu.tsx", import.meta.url), "utf8");
  assert.match(src, /<LetterCircle\b/);
  assert.match(src, /useImgFallback\(/);
});
