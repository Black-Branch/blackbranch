// The open-window count, and the one host that reads it: the compact chat
// composer must not slide up on hover / bottom-edge proximity while a window
// (the mod panel, a page, a dialog) is open over the pane. Typing still opens it.
// Run: node --test app/lib/chrome/openWindows.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../testSource.ts";
import { mountHook } from "../testDom.ts";
import { registerOpenWindow, useAnyWindowOpen } from "./windowLayer.ts";

test("the hook answers true while any registered window is mounted, and re-renders on the change", async () => {
  const h = await mountHook(() => useAnyWindowOpen());
  assert.equal(h.current, false, "nothing open");
  let a!: () => void, b!: () => void;
  await h.act(() => { a = registerOpenWindow(); });
  assert.equal(h.current, true);
  await h.act(() => { b = registerOpenWindow(); });
  await h.act(() => { a(); });
  assert.equal(h.current, true, "one of two closed — still open");
  await h.act(() => { b(); });
  assert.equal(h.current, false, "the last one closed");
  await h.unmount();
});

test("every presentation registers: the dispatcher does it, before it picks a presentation", () => {
  const win = stripComments(readFileSync(new URL("../../components/chrome/Window.tsx", import.meta.url), "utf8"));
  const dispatcher = win.indexOf("export function Window<");
  const firstPresentation = win.indexOf("function WindowBand<");
  const REG = "useEffect(() => registerOpenWindow(), []);";
  const reg = win.indexOf(REG);
  assert.ok(dispatcher > 0 && reg > dispatcher && reg < firstPresentation,
    "the registration sits in the dispatcher, which every presentation passes through");
  assert.equal(win.indexOf("registerOpenWindow()", reg + REG.length), -1, "registered exactly once per Window");
  assert.ok(win.lastIndexOf("function DialogWindow<") > reg, "END anchor: the read reached the last presentation");
});

test("the Bar stands its pointer reveal down on request; the sidebar asks while a window is open", () => {
  const bar = stripComments(readFileSync(new URL("../../components/chrome/Bar.tsx", import.meta.url), "utf8"));
  assert.match(bar, /onRevealChangeRef\.current\?\.\(nearEdge && !standDown\);\s*\}, \[overlay, hidden, nearEdge, standDown\]\);/,
    "proximity is reported as false while standing down, and the report re-fires when that changes");
  assert.match(bar, /data-revealed=\{revealed \|\| \(overlay && !hidden && nearEdge && !standDown\) \|\| undefined\}/,
    "the bar's own proximity reveal stands down too — `revealed` (focus) still shows it");
  assert.ok(bar.lastIndexOf("</div>") > bar.indexOf("data-revealed="), "END anchor");
  const side = stripComments(readFileSync(new URL("../../features/chat/ChatSidebar.tsx", import.meta.url), "utf8"));
  assert.match(side, /const windowOpen = useAnyWindowOpen\(\);/);
  assert.match(side, /standDown=\{windowOpen\}/, "the composer bar stands down while any window is open");
  assert.match(side, /setComposerOpen\(composerHoverRef\.current \|\| composerFocusedRef\.current \|\| composerNearRef\.current\);/,
    "the host's OR is a plain OR — the suppression lives in the Bar, so composerOpen and data-revealed agree");
  assert.ok(side.lastIndexOf("</aside>") > side.indexOf("standDown="), "END anchor");
});
