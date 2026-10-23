// The chat box grows while you type in it — including when it was focused before the page
// finished loading (#165/#166).
//
// The defect: the composer grows only while `focused && text` (ChatInput's `composing`), and
// `focused` was set ONLY by React's onFocus. On a phone the server-rendered box can be tapped
// before React hydrates; that focus event happens before React listens, so `focused` stayed false
// and the box stayed one line tall however much was typed — until something moved focus out and
// back (cycling Send to did), which finally fired onFocus. It was never the Send-to mode; it was
// the first focus. The fix: typing in the box is itself proof it has focus.
//
// Run: node --test app/features/chat/composerFocus.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, mountHook } from "../../lib/testDom.ts";
import { stripComments } from "../../lib/testSource.ts";

await import("../../lib/testTsx.ts");
const { useComposerFocus } = await import("./useComposerFocus.ts");

function field() {
  const el = dom.window.document.createElement("textarea");
  dom.window.document.body.appendChild(el);
  return el;
}

test("a box focused before the page was live grows on the first keystroke", async () => {
  const el = field();
  el.focus(); // the tap that landed before React was listening — no onFocus will ever arrive
  const ref = { current: el as unknown as HTMLTextAreaElement };
  const h = await mountHook(() => useComposerFocus(ref));
  assert.equal(h.current.focused, false, "React did not see the focus");
  await h.act(() => h.current.noteInput());
  assert.equal(h.current.focused, true, "typing proves the box has focus");
  await h.unmount();
  el.remove();
});

test("original path: focus and blur still drive it", async () => {
  const el = field();
  const ref = { current: el as unknown as HTMLTextAreaElement };
  const h = await mountHook(() => useComposerFocus(ref));
  await h.act(() => h.current.onFocus());
  assert.equal(h.current.focused, true);
  await h.act(() => h.current.onBlur());
  assert.equal(h.current.focused, false);
  await h.unmount();
  el.remove();
});

test("typing into a box that does NOT have focus (a programmatic fill) does not claim focus", async () => {
  const el = field();
  const other = field();
  other.focus();
  const ref = { current: el as unknown as HTMLTextAreaElement };
  const h = await mountHook(() => useComposerFocus(ref));
  await h.act(() => h.current.noteInput());
  assert.equal(h.current.focused, false, "a draft restored into an unfocused box stays collapsed");
  await h.unmount();
  el.remove();
  other.remove();
});

test("retry: blurred, then typed into again after a refocus React missed, it grows again", async () => {
  const el = field();
  const ref = { current: el as unknown as HTMLTextAreaElement };
  const h = await mountHook(() => useComposerFocus(ref));
  await h.act(() => h.current.onFocus());
  await h.act(() => h.current.onBlur());
  el.focus();
  await h.act(() => h.current.noteInput());
  assert.equal(h.current.focused, true);
  await h.unmount();
  el.remove();
});

test("restart: a remounted composer over a box that kept focus grows on the next keystroke", async () => {
  const el = field();
  el.focus();
  const ref = { current: el as unknown as HTMLTextAreaElement };
  const first = await mountHook(() => useComposerFocus(ref));
  await first.unmount();
  const again = await mountHook(() => useComposerFocus(ref));
  assert.equal(again.current.focused, false);
  await again.act(() => again.current.noteInput());
  assert.equal(again.current.focused, true);
  await again.unmount();
  el.remove();
});

test("wiring: ChatInput takes `focused` from the hook and tells it about every keystroke", () => {
  const src = stripComments(readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"));
  assert.match(src, /const \{ focused, onFocus: onFieldFocus, onBlur: onFieldBlur, noteInput \} = useComposerFocus\(inputRef\);/);
  assert.match(src, /const onComposerChange = useCallback\(\(v: string\) => \{\n\s*noteInput\(\);/);
  assert.match(src, /onFocus=\{onFieldFocus\}/);
  assert.match(src, /onBlur=\{onFieldBlur\}/);
  assert.doesNotMatch(src, /useState\(false\);\n\s*const composing/, "a second focus state is back");
  assert.match(src.trimEnd(), /\n\}$/, "END anchor");
});
