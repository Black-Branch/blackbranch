// Your own lines in the /chat window wear your ACCOUNT's colour. An "ov:" copy
// of your colour, seeded from the site's key the first time the window opened
// and never refreshed, would never see a colour picked on the site (or on
// another device), not even after a reload. So the window reads the site's key
// live and refreshes it from /api/me/color.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/chat/chatWindowOwnColor.render.test.ts

import "../../lib/testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";

installResizeObserverStub();
const g = globalThis as unknown as Record<string, unknown>;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
g.StorageEvent ??= dom.window.StorageEvent;
// The page is /chat: the "ov:" keyspace is live here (settingsScope reads the pathname).
dom.window.history.replaceState(null, "", "/chat");
// No socket in a unit test.
(dom.window as unknown as { WebSocket: unknown }).WebSocket = class { close() {} addEventListener() {} removeEventListener() {} };
(globalThis as unknown as { WebSocket: unknown }).WebSocket = (dom.window as unknown as { WebSocket: unknown }).WebSocket;

const { default: ChatWindow } = await import("./ChatWindow.tsx");
const { BadgesProvider } = await import("../../lib/BadgesContext.tsx");
const { createRoot } = await import("react-dom/client");

const ME = "@casey:example.tv";
let accountColor = "#00aa00";
(globalThis as unknown as { fetch: unknown }).fetch = (url: string) => {
  const u = String(url);
  const body = u.startsWith("/api/me/color") ? { color: accountColor }
    : u.startsWith("/api/me") ? { signedIn: true, isMod: false, isAdmin: false, matrixId: ME, canonicalId: "c0ffee000001" }
    : {};
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
};

const own = {
  id: 1, platform: "native", username: "casey", message: "hello from me", ts: Date.now(),
  matrixId: ME, canonicalId: "c0ffee000001", usernameColor: "#123456",
};

/** The colour the row's name is drawn in, as the browser would read it. */
function nameColour(container: HTMLElement): string {
  const name = [...container.querySelectorAll<HTMLElement>("button[style]")].find((el) => el.textContent?.startsWith("casey") && el.style.color);
  assert.ok(name, "the own row's name is on the page");
  return name!.style.color;
}

async function mount() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(BadgesProvider, null, React.createElement(ChatWindow, { initialMessages: [own] as never })));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { container, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

test("your own lines wear the account's colour, not a stale window copy", async () => {
  resetStorage();
  // The stale state: the window seeded its copy long ago; the site has the new pick.
  dom.window.localStorage.setItem("ov:chatUsernameColor", "#ff0000");
  dom.window.localStorage.setItem("chatUsernameColor", "#ff0000");
  accountColor = "#00aa00";
  const w = await mount();
  try {
    assert.equal(nameColour(w.container), rgb("#00aa00"), "the account's colour reached the window on open");
  } finally { await w.unmount(); }
});

test("a colour picked in another tab reaches an open window without a reload", async () => {
  resetStorage();
  accountColor = "#00aa00";
  const w = await mount();
  try {
    assert.equal(nameColour(w.container), rgb("#00aa00"));
    // Another tab saves a new colour: the browser fires `storage` here.
    await act(async () => {
      dom.window.localStorage.setItem("chatUsernameColor", "#ffaa00");
      dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "chatUsernameColor", newValue: "#ffaa00" }));
    });
    assert.equal(nameColour(w.container), rgb("#ffaa00"));
    assert.equal(dom.window.localStorage.getItem("ov:chatUsernameColor"), null, "the window keeps no copy of its own");
  } finally { await w.unmount(); }
});
