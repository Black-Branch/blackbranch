// The reply jump against the REAL scroll engine. The pure plan cannot see the
// failure this pins: useAnchoredChat corrects an anchored feed back to the
// bottom on its next scroll event, so a jump that only wrote scrollTop would
// "work" for one frame and snap back (the same lesson as the PgUp key).
//
// `.ts` extensions are REQUIRED on these imports.

import test from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";
import { useAnchoredChat } from "./useAnchoredChat.ts";
import { useReplyJump } from "./useReplyJump.ts";
import { onChatNotice } from "./chatNotice.ts";
import type { ChatMsg } from "./chatMsg.ts";

installResizeObserverStub();
// jsdom has no CSS.escape; the hook uses it to build the row selector.
const g = globalThis as unknown as { CSS?: { escape: (s: string) => string } };
if (!g.CSS) g.CSS = { escape: (s) => s.replace(/["\\]/g, "\\$&") };

const SCROLL_H = 4000, CLIENT_H = 600;
const row = (id: number, extra: Partial<ChatMsg> = {}) =>
  ({ id, platform: "native", username: `u${id}`, message: `message ${id}`, ...extra }) as ChatMsg;

async function mount(rowTopOf: Record<string, number>, messages: ChatMsg[]) {
  const doc = dom.window.document;
  const el = doc.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: SCROLL_H, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: CLIENT_H, configurable: true });
  el.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: CLIENT_H, right: 300, width: 300, height: CLIENT_H, x: 0, y: 0, toJSON() {} });
  for (const [key, top] of Object.entries(rowTopOf)) {
    const r = doc.createElement("div");
    r.setAttribute("data-chat-row-key", key);
    // Viewport-relative, as the DOM reports it: content top minus scrollTop.
    r.getBoundingClientRect = () => ({ top: top - el.scrollTop, left: 0, bottom: top - el.scrollTop + 40, right: 300, width: 300, height: 40, x: 0, y: 0, toJSON() {} });
    el.appendChild(r);
  }
  el.scrollTop = SCROLL_H - CLIENT_H;
  const h = await mountHook(() => {
    const eng = useAnchoredChat<ChatMsg>({ items: messages, getKey: (m) => `${m.platform}:${m.id}` });
    if (!eng.scrollRef.current) eng.scrollRef.current = el;
    const jump = useReplyJump({ scrollRef: eng.scrollRef, messages, pause: eng.pause, anchorToBottom: eng.anchorToBottom });
    return { eng, jump };
  });
  // jsdom does not clamp scrollTop, so the engine's mount-time "assert the
  // bottom" (scrollTop = scrollHeight) leaves a value no browser would report.
  // Put it where a browser would: the real bottom.
  el.scrollTop = SCROLL_H - CLIENT_H;
  return { h, el };
}

test("a jump far up the list SURVIVES the engine's next scroll event, and the feed is paused", async () => {
  const msgs = [row(1), row(2, { reply_to_id: 1, reply_to_username: "u1", reply_to_text: "message 1" })];
  const { h, el } = await mount({ "native:1": 1000, "native:2": 3900 }, msgs);
  assert.equal(h.current.eng.anchored, true);
  await h.act(() => { h.current.jump.onReplyJump(msgs[1]!); });
  await h.act(() => { h.current.eng.onScroll(); });
  assert.equal(el.scrollTop, 1000 - (CLIENT_H - 40) / 2, "centred on the target — not snapped back to the bottom");
  assert.equal(h.current.eng.anchored, false);
  assert.equal(h.current.jump.flashKey, "native:1");
});

test("a reply with NO id (a platform chatter) jumps by author and quoted text", async () => {
  const msgs = [
    { ...row(0), id: "tw-1", platform: "twitch", username: "dana", message: "honey is tasty and good" } as ChatMsg,
    row(2, { reply_to_id: null, reply_to_username: "Dana", reply_to_text: "honey is tasty" }),
  ];
  const { h } = await mount({ "twitch:tw-1": 1000, "native:2": 3900 }, msgs);
  await h.act(() => { h.current.jump.onReplyJump(msgs[1]!); });
  assert.equal(h.current.jump.flashKey, "twitch:tw-1");
});

test("a target that is already on screen is tinted without pausing the live feed", async () => {
  const msgs = [row(1), row(2, { reply_to_id: 1, reply_to_username: "u1", reply_to_text: "message 1" })];
  const { h, el } = await mount({ "native:1": 3500, "native:2": 3900 }, msgs);
  await h.act(() => { h.current.jump.onReplyJump(msgs[1]!); });
  assert.equal(h.current.eng.anchored, true);
  assert.equal(el.scrollTop, SCROLL_H - CLIENT_H);
  assert.equal(h.current.jump.flashKey, "native:1");
});

test("a target that is not loaded says so, and nothing moves", async () => {
  const msgs = [row(2, { reply_to_id: 1, reply_to_username: "u1", reply_to_text: "message 1" })];
  const { h, el } = await mount({ "native:2": 3900 }, msgs);
  const heard: string[] = [];
  const off = onChatNotice((t) => heard.push(t));
  await h.act(() => { h.current.jump.onReplyJump(msgs[0]!); });
  off();
  assert.deepEqual(heard, ["That message is too far back to jump to."]);
  assert.equal(el.scrollTop, SCROLL_H - CLIENT_H);
  assert.equal(h.current.jump.flashKey, null);
});
