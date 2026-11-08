// The composer-binding store, driven through a fake tenant:
// a window program that binds on open and releases from its own close path. No React, no DOM.
//
// Run: node --test --experimental-strip-types app/lib/composerBinding.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  bindComposer, releaseComposer, currentBinding, subscribeComposerBinding,
  _resetComposerBindingForTests, watchBoundText, type ComposerBinding,
} from "./composerBinding.ts";

test.beforeEach(() => _resetComposerBindingForTests());

/** A fake tenant: open, bound; its close path releases (the linkage a real window must implement). */
function tenant(id: string) {
  const t = {
    id, open: true, closes: 0,
    requestClose() { if (!t.open) return; t.open = false; t.closes += 1; releaseComposer(id); },
    sent: [] as string[],
    sendTo(_room: string, label: string): ComposerBinding {
      return { kind: "sendTo", windowId: id, send: async (text) => { t.sent.push(text); }, face: { label }, onRelease: () => t.requestClose() };
    },
  };
  return t;
}

test("bind installs the binding; release runs onRelease exactly once and clears the slot", () => {
  const dm = tenant("dm");
  const release = bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  assert.equal(currentBinding()?.windowId, "dm");
  release();
  assert.equal(currentBinding(), null);
  assert.equal(dm.closes, 1, "releasing the binding dismisses the window");
  release();
  assert.equal(dm.closes, 1, "a second release is a no-op — the slot is empty");
});

test("a window that dismisses on its own releases the slot — and its onRelease does not re-enter", () => {
  const dm = tenant("dm");
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  dm.requestClose();                 // swipe-down: the window's close path calls releaseComposer
  assert.equal(currentBinding(), null);
  assert.equal(dm.closes, 1, "closed once; the store's onRelease call found the window already closed");
});

test("last-bind-wins: binding while another window holds the slot dismisses the previous holder FIRST", () => {
  const dm = tenant("dm");
  const dm2 = tenant("dm2");
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  const order: string[] = [];
  const unsub = subscribeComposerBinding(() => order.push(currentBinding()?.windowId ?? "none"));
  bindComposer(dm2.sendTo("dm:@other:site.test", "other"));
  assert.equal(dm.open, false, "the first DM window was dismissed");
  assert.equal(currentBinding()?.windowId, "dm2", "and the second holds the slot");
  assert.deepEqual(order, ["none", "dm2"], "listeners saw the slot empty, then the new holder — never the old one with the new one installed");
  unsub();
});

test("a stale release (the previous holder's own release fn, after it lost the slot) is a no-op", () => {
  const dm = tenant("dm");
  const dm2 = tenant("dm2");
  const releaseDm = bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  bindComposer(dm2.sendTo("dm:@other:site.test", "other"));
  releaseDm(); // the first window's own release, after it lost the slot
  assert.equal(releaseComposer("dm"), false, "dm no longer holds the slot");
  assert.equal(currentBinding()?.windowId, "dm2", "the second DM's binding is intact");
  assert.equal(dm2.closes, 0);
});

test("re-binding the SAME window replaces its declaration without releasing it", () => {
  const dm = tenant("dm");
  bindComposer(dm.sendTo("dm:@a:site.test", "a"));
  bindComposer(dm.sendTo("dm:@b:site.test", "b"));
  const b = currentBinding();
  assert.equal(b?.kind === "sendTo" ? b.face.label : null, "b");
  assert.equal(dm.closes, 0, "a window updating its own face is not a second window");
});

test("subscribers are notified on bind and on release, and unsubscribe stops them", () => {
  let n = 0;
  const unsub = subscribeComposerBinding(() => { n += 1; });
  const dm = tenant("dm");
  const release = bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  release();
  unsub();
  bindComposer(dm.sendTo("dm:@peer:site.test", "peer"));
  assert.equal(n, 2, "bind + release; nothing after unsubscribe");
});

// ── A line typed for a DM never reaches Live (Task 2 round 2) ─────────────────────────────────
// The chat box, modelled the way ChatInput behaves: Enter with an empty box sends nothing; a bound
// box sends to the binding; otherwise the line goes to Live.
function chatBox() {
  const box = { text: "", live: [] as string[] };
  const stop = watchBoundText(() => box.text, (t) => { box.text = t; });
  const enter = async () => {
    const text = box.text;
    if (!text.trim()) return;
    box.text = "";
    const bound = currentBinding();
    if (bound?.kind === "sendTo") await bound.send(text); else box.live.push(text);
  };
  return { box, enter, stop };
}

/** A DM window that can stop holding the box by itself (their request arrived; someone joined). */
function dmWindow(id: string) {
  const w = {
    holdsBox: true, open: true, kept: undefined as string | undefined, sent: [] as string[],
    binding(): ComposerBinding {
      return {
        kind: "sendTo", windowId: id, face: { label: "casey" },
        send: async (t) => { w.sent.push(t); },
        onRelease: () => { if (w.holdsBox) w.open = false; },   // the person's own release closes it
        keep: (t) => { if (!w.open || w.holdsBox) return false; w.kept = t; return true; },
        takeKept: () => { const k = w.kept; w.kept = undefined; return k; },
      };
    },
  };
  return w;
}

test("a line typed while bound, then the window lets go by itself (each cause): Enter posts NOTHING to Live; the line is in the DM's box", async () => {
  for (const cause of ["their request arrived on my draft", "someone else joined"]) {
    _resetComposerBindingForTests();
    const { box, enter, stop } = chatBox();
    const w = dmWindow("dm:1");
    bindComposer(w.binding());
    box.text = "a private line";
    w.holdsBox = false;                 // the conversation stopped being bindable (cause)
    releaseComposer("dm:1");           // DmHost's binding effect lets go
    assert.equal(w.open, true, cause);
    assert.equal(box.text, "", `${cause}: the chat box is emptied`);
    assert.equal(w.kept, "a private line", `${cause}: the line moved to the DM window`);
    await enter();
    assert.deepEqual(box.live, [], `${cause}: Enter posts nothing to Live`);
    // The person answers (Accept / Reply / Start a private conversation): the box holds the DM again
    // and the kept line comes back into it; Enter sends it into the conversation.
    w.holdsBox = true;
    bindComposer(w.binding());
    assert.equal(box.text, "a private line", `${cause}: the line is back in the box, bound to the DM`);
    await enter();
    assert.deepEqual(w.sent, ["a private line"]);
    assert.deepEqual(box.live, [], cause);
    stop();
  }
});

test("a release the person chose (the window's close, the send-to control) leaves their text where it is", () => {
  const { box, stop } = chatBox();
  const w = dmWindow("dm:1");
  bindComposer(w.binding());
  box.text = "typed";
  releaseComposer("dm:1");             // still bindable: the person's own release
  assert.equal(box.text, "typed");
  assert.equal(w.kept, undefined);
  stop();
});

test("a kept line is never poured over what the person is typing now; it waits in the window", () => {
  const { box, stop } = chatBox();
  const w = dmWindow("dm:1");
  w.kept = "kept line";
  box.text = "something else";
  bindComposer(w.binding());
  assert.equal(box.text, "something else");
  assert.equal(w.kept, "kept line", "still held by the window");
  stop();
});
