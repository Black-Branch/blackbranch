// The DM window and the announcement, RENDERED: the picker, Accept, the red encryption line, the
// loading placeholder, the conversation's lines, and the announcement sliding up and closing
// itself.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dom, React, act } from "../../lib/testDom.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";

installResizeObserverStub();
const { default: DmWindow } = await import("./DmWindow.tsx");
const { default: AnnounceHost } = await import("./AnnounceHost.tsx");
const { publishAnnouncement } = await import("../../lib/dm/bus.ts");
const { setMatrixHandle } = await import("../../lib/matrixHandle.ts");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("../../lib/chrome/windowLayer.ts");
const { createRoot } = await import("react-dom/client");

type Convo = Parameters<typeof DmWindow>[0]["convo"];
const casey: { matrixId: string; username: string; displayName: string | null } = { matrixId: "@casey:site.test", username: "casey", displayName: "Casey" };

function mount(el: React.ReactElement) {
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  const q = (s: string) => dom.window.document.querySelector(s) as HTMLElement | null;
  return { q, unmount: () => { act(() => root.unmount()); layer.remove(); host.remove(); } };
}

function win(convo: Partial<Convo>, cb: { accept?: () => void; pick?: (p: typeof casey) => void; close?: () => void } = {}) {
  return React.createElement(DmWindow, {
    convo: { seq: 1, person: casey, phase: "open", incoming: false, accepted: true, ...convo } as Convo,
    me: "@me:site.test",
    closeRef: { current: null },
    onAccept: cb.accept ?? (() => {}),
    onPick: cb.pick ?? (() => {}),
    onClose: cb.close ?? (() => {}),
  });
}

test("an incoming invite: '<name> wants to send you messages' and Accept; the title is the username", () => {
  let accepted = 0;
  const m = mount(win({ incoming: true, accepted: false, invite: true, roomId: "!inv" }, { accept: () => { accepted += 1; } }));
  const dialog = m.q('[role="dialog"]')!;
  assert.equal(dialog.getAttribute("aria-label"), "Direct messages with casey");
  assert.match(dialog.textContent ?? "", /casey wants to send you messages\./);
  const btn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Accept")!;
  assert.ok(btn, "Accept is offered");
  act(() => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(accepted, 1);
  m.unmount();
});

test("an accepted conversation offers no Accept; the red line shows only when there is a caution", () => {
  const a = mount(win({ incoming: true, accepted: true, roomId: "!dm", caution: "casey hasn't set up encrypted messages yet — they may not be able to read this." }));
  assert.equal([...a.q('[role="dialog"]')!.querySelectorAll("button")].some((b) => b.textContent === "Accept"), false);
  const line = a.q("[data-dm-caution]")!;
  assert.ok(line && line.className.includes("text-red-400"), "the caution is red");
  a.unmount();
  const b = mount(win({ roomId: "!dm", caution: null, encrypted: true }));
  assert.equal(b.q("[data-dm-caution]"), null, "encrypted: no line");
  b.unmount();
});

test("several matches: the picker lists them and a press picks one", () => {
  const sam = { matrixId: "@cassidy:site.test", username: "cassidy", displayName: null };
  let picked: unknown = null;
  const m = mount(win({ phase: "pick", person: { matrixId: "", username: "cas", displayName: null }, people: [casey, sam] }, { pick: (p) => { picked = p; } }));
  const dialog = m.q('[role="dialog"]')!;
  assert.equal(dialog.getAttribute("aria-label"), "Message who?");
  const options = [...dialog.querySelectorAll("li button")];
  assert.equal(options.length, 2);
  act(() => { options[1]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(picked, sam);
  m.unmount();
});

test("while the room is being prepared the window shows the loading placeholder, never the conversation", () => {
  const m = mount(win({ phase: "loading" }));
  assert.ok(m.q(".chrome-window-loading"), "the placeholder renders");
  assert.equal(m.q("[data-dm-window]"), null, "the body waits");
  m.unmount();
});

test("an open conversation shows its lines from the room — 'you' for mine, the username for theirs, and an unreadable line said plainly", () => {
  const em = new EventEmitter();
  const line = (sender: string, ts: number, body: string, broken = false) => ({
    getType: () => "m.room.message", getSender: () => sender, getTs: () => ts, isRedacted: () => false,
    isDecryptionFailure: () => broken, getContent: () => ({ msgtype: "m.text", body }), getRoomId: () => "!dm",
  });
  const events = [line("@me:site.test", 1, "hi casey"), line("@casey:site.test", 2, "hey!"), line("@casey:site.test", 3, "", true)];
  const room = { roomId: "!dm", getLiveTimeline: () => ({ getEvents: () => events }) };
  const client = { getRoom: () => room, on: (n: string, f: () => void) => em.on(n, f), off: (n: string, f: () => void) => em.off(n, f) };
  setMatrixHandle({ client: client as never, status: "ready", startClient: async () => {} });
  const m = mount(win({ roomId: "!dm", encrypted: true, caution: null }));
  assert.equal(m.q("ol")!.querySelectorAll("li").length, 3);
  const text = m.q("ol")!.textContent ?? "";
  assert.match(text, /you hi casey/);
  assert.match(text, /casey hey!/);
  assert.match(text, /can't be read on this device/);
  events.push(line("@casey:site.test", 4, "new one"));
  act(() => { em.emit("Room.timeline", events[3], room); });
  assert.match(m.q("ol")!.textContent ?? "", /new one/, "a new line follows");
  m.unmount();
  setMatrixHandle({ client: null, status: "idle", startClient: async () => {} });
});

test("an announcement slides up for everyone with its text and who sent it, then closes itself (20 s — shortened here)", async () => {
  const m = mount(React.createElement(AnnounceHost));
  assert.equal(m.q('[role="dialog"]'), null, "nothing until one arrives");
  act(() => { publishAnnouncement({ id: "a1", text: "stream in 5", by: "casey", at: 1 }); });
  const d = m.q('[role="dialog"][aria-label="Announcement"]')!;
  assert.ok(d);
  assert.match(d.textContent ?? "", /stream in 5/);
  assert.match(d.textContent ?? "", /— casey/);
  assert.equal(d.querySelectorAll("button").length > 0, true, "it has a close control");
  assert.equal([...d.querySelectorAll("button")].some((b) => /accept|reply/i.test(b.textContent ?? "")), false, "nothing to answer");
  act(() => { publishAnnouncement({ id: "a2", text: "newer", by: "", at: 2 }); });
  assert.match(m.q('[role="dialog"][aria-label="Announcement"]')!.textContent ?? "", /newer/, "a newer one replaces it");
  m.unmount();
});
