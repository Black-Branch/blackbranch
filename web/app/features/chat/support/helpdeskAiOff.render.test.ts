// With no AI help desk on an install, a typed question sent to the relay is held 30 s and then
// answered "I can't reach my brain" — and the relay's queue fills until every question is
// refused. So a typed question never leaves the browser while free text is off: the desk
// answers at once and hands back the menu. A real mount of the hook, both ways, and a retry.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/features/chat/support/helpdeskAiOff.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "../../../lib/testDom.ts";
import "../../../lib/testTsx.ts";
import { setSupportFacts, NO_FREE_TEXT, SUPPORT_ROOT } from "../../../lib/support/flows.ts";

const { useSupportConversation } = await import("./useSupportConversation.ts");

const ON = { off: [], purchasable: true, subscriptions: true, tts: true, freeText: true };

async function mountDesk() {
  const asked: string[] = [];
  const h = await mountHook(() => useSupportConversation({
    onReport: async () => {},
    onTicket: async () => {},
    onFreeText: async (text) => { asked.push(text); return "an AI answer"; },
  }));
  await h.act(() => h.current.open("hi"));
  return { h, asked };
}
const lastBot = (h: Awaited<ReturnType<typeof mountDesk>>["h"]) =>
  [...(h.current.state?.msgs ?? [])].reverse().find((m) => m.role === "bot")?.text;

test("AI off: a typed question is answered at once with the menu line, and nothing is sent to the AI", async () => {
  setSupportFacts({ ...ON, freeText: false });
  const { h, asked } = await mountDesk();
  await h.act(() => h.current.sendText("how do I change my name colour"));
  assert.deepEqual(asked, [], "the AI route was never called");
  assert.equal(lastBot(h), NO_FREE_TEXT);
  assert.equal(h.current.state?.awaiting, "options", "the menu has the floor again");
  assert.equal(h.current.state?.options.length, SUPPORT_ROOT.length);
  assert.ok(!h.current.state?.options.some((o) => o.key === "other"), "no 'Something else' to pick");
  // Retry: a second question gets the same answer, still without the AI.
  await h.act(() => h.current.sendText("and another thing"));
  assert.deepEqual(asked, []);
  assert.equal(lastBot(h), NO_FREE_TEXT);
  await h.unmount();
});

test("AI off: the report collectors still take typed text (a bug description is not a question)", async () => {
  setSupportFacts({ ...ON, freeText: false });
  const tickets: string[] = [];
  const h = await mountHook(() => useSupportConversation({
    onReport: async () => {},
    onTicket: async (_k, body) => { tickets.push(body); },
    onFreeText: async () => { throw new Error("must not be called"); },
  }));
  await h.act(() => h.current.open("hi"));
  await h.act(() => h.current.pick("report-bug"));
  await h.act(() => h.current.sendText("the player froze"));
  assert.deepEqual(tickets, ["the player froze"]);
  await h.unmount();
});

test("AI on: the same typed question goes to the AI, as before", async () => {
  setSupportFacts(ON);
  const { h, asked } = await mountDesk();
  await h.act(() => h.current.sendText("how do I change my name colour"));
  assert.deepEqual(asked, ["how do I change my name colour"]);
  assert.equal(lastBot(h), "an AI answer");
  await h.unmount();
});
