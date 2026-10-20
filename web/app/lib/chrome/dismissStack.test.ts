// One Escape, one layer — the TOP one.
//
// Per-component Escape listeners on different targets let listener target
// choice decide UI stacking order: a modal listening on `window` and a panel
// on `document` with stopPropagation — document fires first on the bubble
// path, so with a modal open OVER a panel, Escape would close the PANEL
// underneath and leave the modal standing.
//
// So: a module-level LIFO stack with ONE document-level listener. Layers
// push on open (mount order = stacking order), pop on close; Escape dismisses
// exactly the top. Bubble phase on purpose: element-level handlers (an
// input's own Escape, emote autocomplete) still get first claim and can
// stopPropagation to keep it local.
//
// Run: node --test app/lib/dismissStack.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook, act, React } from "../testDom.ts";
import { pushDismissLayer, useEscapeDismiss, dismissTop } from "./dismissStack.ts";

function pressEscape(target: EventTarget = dom.window.document) {
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

test("Escape dismisses the TOP layer only — the modal-over-panel bug", () => {
  const closed: string[] = [];
  const popPanel = pushDismissLayer(() => closed.push("panel"));
  const popModal = pushDismissLayer(() => closed.push("modal"));
  pressEscape();
  assert.deepEqual(closed, ["modal"], "Escape reached the layer UNDER the modal");
  popModal();
  pressEscape();
  assert.deepEqual(closed, ["modal", "panel"], "the panel did not become the top after the modal closed");
  popPanel();
});

test("a layer that unmounts out of order leaves the stack coherent", () => {
  const closed: string[] = [];
  const popA = pushDismissLayer(() => closed.push("a"));
  const popB = pushDismissLayer(() => closed.push("b"));
  const popC = pushDismissLayer(() => closed.push("c"));
  popB(); // middle layer closed by click, not Escape
  pressEscape();
  assert.deepEqual(closed, ["c"]);
  popC(); popA();
});

test("with no layers open, Escape is nobody's business", () => {
  const closed: string[] = [];
  const pop = pushDismissLayer(() => closed.push("x"));
  pop();
  pressEscape();
  assert.deepEqual(closed, [], "a popped layer still closed — the unregister leaked");
});

test("a handled Escape does not ALSO fire legacy window listeners", () => {
  // The double-handling the stack replaces: if a remaining window-level
  // listener also saw the event, one keypress would close two layers.
  let windowSaw = 0;
  const onWin = () => { windowSaw += 1; };
  dom.window.addEventListener("keydown", onWin);
  const pop = pushDismissLayer(() => {});
  pressEscape();
  dom.window.removeEventListener("keydown", onWin);
  pop();
  assert.equal(windowSaw, 0, "the event escaped to window — a legacy listener would double-close");
});

test("other keys pass through untouched", () => {
  let windowSaw = 0;
  const onWin = () => { windowSaw += 1; };
  dom.window.addEventListener("keydown", onWin);
  const pop = pushDismissLayer(() => { throw new Error("a non-Escape key dismissed a layer"); });
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  dom.window.removeEventListener("keydown", onWin);
  pop();
  assert.equal(windowSaw, 1, "a non-Escape key was swallowed");
});

test("dismissTop() closes the top layer only, and reports whether there was one", () => {
  // The system-back sentinel's primitive: a
  // close-request that doesn't come from a keydown at all, so it can't
  // reuse onKeyDown — it needs the same "top of stack" semantics as a bare
  // function call.
  assert.equal(dismissTop(), false, "nothing open — nothing to dismiss");
  const closed: string[] = [];
  const popA = pushDismissLayer(() => closed.push("a"));
  const popB = pushDismissLayer(() => closed.push("b"));
  assert.equal(dismissTop(), true);
  assert.deepEqual(closed, ["b"], "only the top layer closed");
  popB(); popA();
});

test("useEscapeDismiss registers while enabled and pops on disable", async () => {
  const closed: string[] = [];
  let setEnabled: (v: boolean) => void = () => {};
  const hook = await mountHook(() => {
    const [enabled, set] = React.useState(true);
    setEnabled = set;
    useEscapeDismiss(() => closed.push("popover"), { enabled });
    return enabled;
  });
  pressEscape();
  assert.deepEqual(closed, ["popover"]);
  await act(async () => setEnabled(false));
  pressEscape();
  assert.deepEqual(closed, ["popover"], "a disabled (closed) popover still answered Escape");
  await hook.unmount();
});
