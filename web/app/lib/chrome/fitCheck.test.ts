// Acceptance fit-check: the DM and announce behaviours walked behaviour by
// behaviour against the windowing substrate. (No window diverts all entered
// messages — the terminal and the chat box are used side by side.) Each
// test names the sentence it carries. The binding behaviours run here through
// a fake tenant; the window behaviours (pane, growth, detents, dismiss,
// loading, timed dismiss) are proved by the tests CITED below, and the
// last test is the vacuity guard: every citation must still exist by title.
// Any behaviour that cannot map means the primitive changes.
//
// Run: node --test --experimental-strip-types app/lib/chrome/fitCheck.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bindComposer, releaseComposer, currentBinding, _resetComposerBindingForTests, type ComposerBinding,
} from "../composerBinding.ts";

test.beforeEach(() => _resetComposerBindingForTests());

/** A fake tenant: what a window program must implement to bind. Its close path releases. */
function tenant(id: string) {
  const t = {
    id, open: true, autoDismissMs: undefined as number | undefined,
    requestClose() { if (!t.open) return; t.open = false; releaseComposer(id); },
    room: [] as string[],
    sendTo(_peer: string, label: string): ComposerBinding {
      return { kind: "sendTo", windowId: id, send: async (text) => { t.room.push(text); }, face: { label }, onRelease: () => t.requestClose() };
    },
  };
  return t;
}

/** The composer's side of the seam as far as the BINDING decides it: a bound line goes to the
 *  binding's own send and NEVER the chat wire. ChatInput's
 *  encrypted-sentinel translation (`encryptArmed ? null : forcedDest`) sits inside the fallback. */
function submit(text: string, forcedDest: string | null, wire: (text: string, dest: string | null) => void) {
  const bound = currentBinding();
  if (bound?.kind === "sendTo") void bound.send(text);
  else wire(text, forcedDest);
  return "sent";
}

test("dm: 'the send-to button now shows the pfp of this other user' — the line goes to the DM, the face is the peer's", () => {
  const dm = tenant("dm");
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  const b = currentBinding();
  assert.equal(b?.kind, "sendTo");
  assert.equal(b?.kind === "sendTo" ? b.face.label : null, "peer");
  const wire: Array<[string, string | null]> = [];
  assert.equal(submit("hi", "twitch", (t, d) => wire.push([t, d])), "sent");
  assert.deepEqual(dm.room, ["hi"], "the line went to the conversation");
  assert.deepEqual(wire, [], "and never to the chat wire — not even with the DM as a destination");
});

test("dm: 'toggling the send-to button will revert back to whatever it was prior to the dm and slide the dm window away automatically'", () => {
  const dm = tenant("dm");
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  releaseComposer("dm");                             // the send-to control's click (SendToButton binding.release)
  assert.equal(dm.open, false, "the DM window slid away");
  const wire: Array<[string, string | null]> = [];
  submit("hi", "twitch", (t, d) => wire.push([t, d]));
  assert.deepEqual(wire, [["hi", "twitch"]], "the destination reverted to what it was — the binding never touched forcedDest");
});

test("dm: 'if un-accepted, the window will close after a period of time' — accepting clears the timer; closing releases", () => {
  const dm = tenant("dm");
  dm.autoDismissMs = 30_000;                         // Window.autoDismissMs — the tenant passes it while unaccepted
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  dm.autoDismissMs = undefined;                      // accept: the prop clears, the timer cancels (windowAutoDismiss test 4)
  assert.equal(currentBinding()?.windowId, "dm", "an accepted DM keeps the composer");
  dm.requestClose();                                 // or the timer fired: requestClose → the close path → release
  assert.equal(currentBinding(), null);
});

test("announce: '/announce slides up a message for all active users (auto-closing) … won't change the send-to button'", () => {
  const dm = tenant("dm");
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  const announce = tenant("announce");
  announce.autoDismissMs = 8_000;                    // a peek window with autoDismissMs and NO binding
  assert.equal(currentBinding()?.windowId, "dm", "an announcement never takes the composer");
  announce.requestClose();                           // its timer fired
  assert.equal(currentBinding()?.windowId, "dm", "and its close released nothing it never held");
});

test("last-bind-wins: a DM is open; another DM opens — the first slides away and the second holds the line", () => {
  const dm = tenant("dm");
  const dm2 = tenant("dm2");
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  bindComposer(dm2.sendTo("dm:@other:site.test", "other"));
  assert.equal(dm.open, false);
  assert.equal(currentBinding()?.windowId, "dm2");
  const wire: Array<[string, string | null]> = [];
  submit("hi", "twitch", (t, d) => wire.push([t, d]));
  assert.deepEqual(dm2.room, ["hi"]);
  assert.deepEqual(dm.room, [], "the first conversation got nothing");
  assert.deepEqual(wire, []);
});

/** Behaviours proved by other tests — the citations the appendix carries. */
const CITATIONS: ReadonlyArray<[file: string, title: string, carries: string]> = [
  ["./window.render.test.ts", "panel: portals into the ACTIVE pane's layer; peek is non-modal", "open in pane — 'a dm window … for the chat panel'"],
  ["./window.render.test.ts", "panel task: covered body-region SIBLINGS go inert (counted); layer parent's outside stays live", "the composer stays live under a task window"],
  ["./windowLoading.render.test.ts", "loading renders a placeholder at least `height` tall INSTEAD of the children, then swaps to the children when it clears", "grow with content — 'the window to show a loading animation … as the channel is prepared'"],
  ["./windowLoading.render.test.ts", "readiness composes a compact BootSequence into the placeholder, which then owns the status role", "staged in-window loading"],
  ["./usePanelDrag.render.test.ts", "drag up from contentFit: the cap box is adopted at translate = fit (nothing visible changes), then the scalar follows the finger", "drag detents — 'resizing vertically by dragging the top of the window up or down'"],
  ["./usePanelDrag.render.test.ts", "release nearer the cap snaps to the cap; transitionend restores the resting cap box at translate 0", "drag detents (cap)"],
  ["./usePanelDrag.render.test.ts", "a release below contentFit with the handle still showing PARKS the box there — static repositioning", "static repositioning (L2.1)"],
  ["./usePanelDrag.render.test.ts", "drag down past contentFit follows the finger 1:1; a release with less than MIN_VISIBLE_PX showing dismisses through requestClose (the ONE close path)", "swipe-dismiss — 'swiping it down completely'"],
  ["./usePanelDrag.render.test.ts", "a fast downward flick from below contentFit dismisses; from the cap it stops at contentFit", "swipe-dismiss (flick)"],
  ["./windowAutoDismiss.render.test.ts", "autoDismissMs closes the panel after the interval, through requestClose (once)", "timed dismiss — '/announce … auto-closing'"],
  ["./windowAutoDismiss.render.test.ts", "clearing autoDismissMs before it fires cancels it (an accepted DM stays)", "timed dismiss — 'if un-accepted, the window will close'"],
  ["../composerBinding.test.ts", "last-bind-wins: binding while another window holds the slot dismisses the previous holder FIRST", "one-bound-window law"],
  ["../composerBinding.test.ts", "bind installs the binding; release runs onRelease exactly once and clears the slot", "toggle-to-revert — 'release runs onRelease exactly once'"],
  ["../sendToButton.render.test.ts", "a sendTo binding renders the face even with nowhere else to send, and its click releases — not the menu","the send-to face — 'shows the pfp of this other user'"],
  ["../../features/chat/composerBindingSeam.test.ts", "ChatInput: the binding is read synchronously at send time; a bound line goes to the binding's send, never the wire", "the DM line reaches the conversation"],
];

test("every citation in the appendix still exists by title (vacuity guard)", () => {
  for (const [file, title, carries] of CITATIONS) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(src.includes(`test("${title}"`), `${file} no longer has the test that carries: ${carries} — retitled? update the citation`);
  }
  assert.equal(CITATIONS.length, 15, "fifteen guarded citations — every behaviour another file's test proves, cited by title; the rest are carried by this file's own tests");
});
