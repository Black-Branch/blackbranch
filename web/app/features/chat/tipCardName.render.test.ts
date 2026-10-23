// A tip card shows the name the tipper typed, even for a viewer who turned on "Show Matrix
// username".
//
// The defect: ChatMessage swapped every row's name for its Matrix id when that setting was on.
// A tip card (`system: "donation"`) carries the tipper's account id for badges, colour and style,
// so the swap put their unique username back on a card where they had chosen the name to show.
//
// Run: node --test app/features/chat/tipCardName.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import { installResizeObserverStub, installRafStub } from "../../lib/testTsx.ts";

installResizeObserverStub();
installRafStub();
for (const k of ["HTMLElement", "Node", "Element"] as const) {
  (globalThis as Record<string, unknown>)[k] ??= dom.window[k];
}
const { default: ChatMessage } = await import("./ChatMessage.tsx");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ChatMessage>[0];
type Msg = Props["msg"];

const TIP = {
  id: 51, platform: "native", system: "donation", username: "Secret Santa", matrixId: "@casey:site.test",
  amount: 5, currency: "USD", message: "keep it up", ts: 1,
} as unknown as Msg;
const LINE = { id: 52, platform: "native", username: "Casey", matrixId: "@casey:site.test", message: "hi", ts: 1 } as unknown as Msg;

const mounted: (() => Promise<void>)[] = [];
test.afterEach(async () => { for (const u of mounted.splice(0)) await u(); });

async function nameShown(msg: Msg, showMatrixName: boolean): Promise<string> {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ChatMessage, { msg, emotes: {}, showMatrixName })); });
  mounted.push(async () => { await act(async () => { root.unmount(); }); host.remove(); });
  return host.querySelector(".chat-un-style")?.textContent ?? "";
}

test("a tip card keeps the typed name when the viewer shows Matrix usernames", async () => {
  assert.equal(await nameShown(TIP, true), "Secret Santa", "the unique username came back on the tip card");
});

test("original path: the setting off shows the typed name too", async () => {
  assert.equal(await nameShown(TIP, false), "Secret Santa");
});

test("an ordinary line still swaps to the Matrix username when asked", async () => {
  assert.notEqual(await nameShown(LINE, true), "Casey", "the setting stopped working for ordinary lines");
});

test("restart and retry: remounting the card, and toggling the setting off and on, keep the typed name", async () => {
  assert.equal(await nameShown(TIP, true), "Secret Santa");
  assert.equal(await nameShown(TIP, false), "Secret Santa");
  assert.equal(await nameShown(TIP, true), "Secret Santa");
});
