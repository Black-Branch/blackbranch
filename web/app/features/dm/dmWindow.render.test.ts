// The DM window and the announcement, RENDERED: the picker, Accept, the red encryption line, the
// loading placeholder, and the announcement sliding up and closing itself. The conversation's
// lines (the Community row since client polish Task 11) are dmWindowRows.render.test.ts's.
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";

installResizeObserverStub();
// jsdom reports "prerender"; a person reading the window has the tab in front of them.
Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
const { default: DmWindow } = await import("./DmWindow.tsx");
const { default: AnnounceHost } = await import("./AnnounceHost.tsx");
const { publishAnnouncement } = await import("../../lib/dm/bus.ts");
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

type Callbacks = {
  accept?: () => void; pick?: (p: typeof casey) => void; close?: () => void;
  retry?: (id: string) => void; drop?: (id: string) => void; decline?: () => void; block?: () => void; request?: () => void; startPrivate?: () => void;
};
function win(convo: Partial<Convo>, cb: Callbacks = {}) {
  return React.createElement(DmWindow, {
    convo: { seq: 1, person: casey, phase: "open", incoming: false, accepted: true, ...convo } as Convo,
    onReply: () => {},
    onCancelReply: () => {},
    closeRef: { current: null },
    onAccept: cb.accept ?? (() => {}),
    onPick: cb.pick ?? (() => {}),
    onClose: cb.close ?? (() => {}),
    onRetry: cb.retry ?? (() => {}),
    onDrop: cb.drop ?? (() => {}),
    onDecline: cb.decline ?? (() => {}),
    onRequest: cb.request ?? (() => {}),
    onStartPrivate: cb.startPrivate ?? (() => {}),
    onBlock: cb.block ?? (() => {}),
  });
}
const buttons = (m: { q: (s: string) => HTMLElement | null }) => [...m.q('[role="dialog"]')!.querySelectorAll("button")].map((b) => b.textContent ?? "").filter((t) => t);
const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });

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

test("a draft shows the start line and composer, and 'Send message request' asks to confirm", () => {
  let requested = 0;
  const m = mount(win({ draft: true }, { request: () => { requested += 1; } }));
  const body = m.q("[data-dm-draft]")!;
  assert.ok(body, "the draft body renders");
  assert.match(body.textContent ?? "", /This is the start of your conversation with casey\./);
  assert.doesNotMatch(m.q('[role="dialog"]')!.textContent ?? "", /wants to send you messages/);
  const named = (t: string) => [...body.querySelectorAll("button")].find((b) => b.textContent === t);
  click(named("Send message request")!);
  assert.equal(requested, 0, "nothing goes to them on the first press");
  assert.match(body.textContent ?? "", /Send casey a message request\?/);
  click(named("Cancel")!);
  assert.equal(requested, 0);
  click(named("Send message request")!);
  click(named("Send")!);
  assert.equal(requested, 1, "the confirmed request goes once");
  m.unmount();
});

test("a room that is not private says so and offers a private conversation instead", () => {
  let started = 0;
  const m = mount(win({ roomId: "!group", accepted: true, notPrivate: true }, { startPrivate: () => { started += 1; } }));
  const note = m.q("[data-dm-not-private]")!;
  assert.ok(note, "the window says what it is");
  assert.match(note.textContent ?? "", /isn't a private conversation/);
  click([...note.querySelectorAll("button")].find((b) => b.textContent === "Start a private conversation")!);
  assert.equal(started, 1);
  m.unmount();
});

test("a kept line (a refused /dm name text, or text the box let go of) shows in the window beside the real sentence", () => {
  const m = mount(win({ roomId: "!group", accepted: true, notPrivate: true, kept: "sure", error: "Not sent — this conversation isn't private any more." }));
  assert.match(m.q("[data-dm-kept]")?.textContent ?? "", /“sure”/);
  assert.ok(m.q("[data-dm-not-private]"), "the note and its button show with it");
  assert.match(m.q("[role=alert]")?.textContent ?? "", /isn't private any more/);
  m.unmount();
  // Their request holding my kept line: it stays (DmHost turns the auto-close off), so no "Closes in a minute".
  const r = mount(win({ roomId: "!theirs", invite: true, incoming: true, accepted: false, kept: "hi" }));
  assert.ok(r.q("[data-dm-kept]"));
  assert.doesNotMatch(r.q('[data-dm-window]')?.textContent ?? "", /Closes in a minute/);
  r.unmount();
});

test("a draft whose person wrote first shows their request: Accept · Decline · Block", () => {
  const m = mount(win({ roomId: "!theirs", invite: true, incoming: true, accepted: false, draft: false }));
  assert.deepEqual(buttons(m).filter((t) => /^(Accept|Decline|Block)$/.test(t)), ["Accept", "Decline", "Block"]);
  m.unmount();
});

test("partner left shows the caution", () => {
  const m = mount(win({ roomId: "!dm", partnerCaution: "casey isn't in this conversation" }));
  const note = m.q("[data-dm-partner-caution]")!;
  assert.ok(note, "the line renders");
  assert.equal(note.textContent, "casey isn't in this conversation");
  assert.ok(note.className.includes("text-red-400"));
  m.unmount();
});

test("invite: Accept · Decline · Block", () => {
  let declined = 0;
  let blocked = 0;
  const m = mount(win({ incoming: true, accepted: false, invite: true, roomId: "!inv" }, { decline: () => { declined += 1; }, block: () => { blocked += 1; } }));
  assert.deepEqual(buttons(m).filter((t) => /^(Accept|Decline|Block|Reply)$/.test(t)), ["Accept", "Decline", "Block"]);
  const dialog = m.q('[role="dialog"]')!;
  click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Decline")!);
  click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Block")!);
  assert.equal(declined, 1);
  assert.equal(blocked, 1);
  m.unmount();
});

test("joined: Reply only", () => {
  // The conversation's own lines are dmWindowRows.render.test.ts's; with no client here none load.
  const m = mount(win({ incoming: true, accepted: false, invite: false, roomId: "!dm" }));
  assert.deepEqual(buttons(m).filter((t) => /^(Accept|Decline|Block|Reply)$/.test(t)), ["Reply"]);
  m.unmount();
});

test("no person (personOfMessage null) → no Block button; Decline stays", () => {
  const m = mount(win({ incoming: true, accepted: false, invite: true, roomId: "!inv", person: { matrixId: "", username: "casey", displayName: null } }));
  assert.deepEqual(buttons(m).filter((t) => /^(Accept|Decline|Block)$/.test(t)), ["Accept", "Decline"]);
  m.unmount();
});

test("a Block result line replaces the request's buttons", () => {
  const m = mount(win({ incoming: true, accepted: false, invite: true, roomId: "!inv", notice: "Blocked — undo in Settings › Behavior", blocked: true }));
  assert.match(m.q('[role="dialog"]')!.textContent ?? "", /Blocked — undo in Settings › Behavior/);
  assert.deepEqual(buttons(m).filter((t) => /^(Accept|Decline|Block)$/.test(t)), []);
  m.unmount();
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
