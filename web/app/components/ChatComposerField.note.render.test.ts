// The composer's refusal note (U1 rework, k 2026-10-18), mounted: one calm,
// dismissible line INSIDE the empty field, where the placeholder sits — never a
// row that grows the composer bar and never an overlay on the chat.
//
// Why "inside the field" is the no-layout-shift proof: the chat list's height is
// the panel minus the bottom Bar, and the Bar is exactly one token tall unless a
// descendant carries `data-chrome-grow` (chrome.css: `.chrome-bar-bottom:has(
// [data-chrome-grow]) { height: auto }`). An absolutely positioned child of the
// field adds no height to it and flags no growth, so the Bar — and therefore the
// list's height and scrollTop — cannot change when the note appears. jsdom has
// no layout, so the test pins exactly those two facts on the rendered DOM.
//
// Run: node --test app/components/ChatComposerField.note.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";

const { ChatComposerField } = await import("./ChatComposerField.tsx");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ChatComposerField>[0];

function mount(over: Partial<Props>) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const props: Props = {
    value: "", onChange: () => {}, onKeyDown: () => {},
    inputRef: React.createRef<HTMLTextAreaElement>(), emotes: {}, maxLength: 500,
    placeholder: "Send a message…", showEmotePicker: false, setShowEmotePicker: () => {},
    ...over,
  };
  const render = (p: Partial<Props>) => act(() => root.render(React.createElement(ChatComposerField, { ...props, ...p })));
  render({});
  return { host, render, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const TEXT = "Kick is followers-only. Follow on Kick to post there, or change Send to.";

test("the note takes the placeholder's place, adds no growth, and is out of flow", () => {
  const without = mount({});
  const growBefore = without.host.querySelectorAll("[data-chrome-grow]").length;
  without.unmount();

  const m = mount({ note: { text: TEXT, onDismiss: () => {} } });
  const note = m.host.querySelector("[data-refusal-note]") as HTMLElement;
  assert.ok(note, "the note rendered");
  assert.equal(note.getAttribute("role"), "status", "announced politely, not as an alert");
  assert.match(note.textContent ?? "", /Kick is followers-only/);
  assert.equal(note.getAttribute("title"), TEXT, "the whole sentence is there even when the line truncates");
  assert.match(note.className, /\babsolute\b/, "out of flow: it adds no height to the field");
  assert.equal(m.host.querySelectorAll("[data-chrome-grow]").length, growBefore, "the note flags no Bar growth");
  assert.equal(m.host.querySelector(".chat-input-placeholder"), null, "one line in the field, not two stacked");
  // The field keeps its accessible name.
  assert.equal(m.host.querySelector("textarea")?.getAttribute("aria-label"), "Send a message…");
  m.unmount();
});

test("dismissible: the ✕ calls onDismiss", () => {
  let dismissed = 0;
  const m = mount({ note: { text: TEXT, onDismiss: () => { dismissed++; } } });
  const x = m.host.querySelector('[data-refusal-note] button[aria-label="Dismiss"]') as HTMLButtonElement;
  assert.ok(x, "a dismiss button");
  act(() => { x.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(dismissed, 1);
  m.unmount();
});

test("typing hides it (the draft owns the field); emptying the field shows it again", () => {
  const m = mount({ note: { text: TEXT, onDismiss: () => {} } });
  m.render({ value: "hello" });
  assert.equal(m.host.querySelector("[data-refusal-note]"), null);
  m.render({ value: "" });
  assert.ok(m.host.querySelector("[data-refusal-note]"));
  m.unmount();
});

// ── Never cut off: the longest form that FITS ───────────────────────────────
// No fixed breakpoint can be right: the note's width depends on the chat font
// size (a setting), the platform's name and how many controls share the row. So
// the field measures — each form's natural width against the slot's — and shows
// the longest that fits. jsdom has no layout, so widths are stubbed: the slot is
// SLOT_W wide and a form is 8px per character.
let SLOT_W = 1000;
const proto = dom.window.HTMLElement.prototype;
Object.defineProperty(proto, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) { return this.hasAttribute("data-note-slot") ? SLOT_W : 0; },
});
Object.defineProperty(proto, "scrollWidth", {
  configurable: true,
  get(this: HTMLElement) { return this.hasAttribute("data-note-form") ? (this.textContent ?? "").length * 8 : 0; },
});

const FORMS = [TEXT, "Kick is followers-only — tap Send to", "Follow on Kick"];
const shown = (h: HTMLElement) => h.querySelector("[data-note-shown]")?.textContent;

test("a wide composer shows the whole sentence", () => {
  SLOT_W = 1000;
  const m = mount({ note: { text: TEXT, forms: FORMS, onDismiss: () => {} } });
  assert.equal(shown(m.host), TEXT);
  m.unmount();
});

test("a narrow one shows the longest SHORT form that fits — never a cut sentence", () => {
  SLOT_W = 300; // 36 chars × 8 = 288 fits; the sentence (72 × 8) does not
  const m = mount({ note: { text: TEXT, forms: FORMS, onDismiss: () => {} } });
  assert.equal(shown(m.host), "Kick is followers-only — tap Send to");
  SLOT_W = 120; // a phone: only "Follow on Kick" (14 × 8 = 112) fits
  m.render({ value: "x" });
  m.render({ value: "" });
  assert.equal(shown(m.host), "Follow on Kick");
  // The whole sentence is still there for a pointer and a screen reader.
  const note = m.host.querySelector("[data-refusal-note]")!;
  assert.equal(note.getAttribute("title"), TEXT);
  assert.equal(note.querySelector(".sr-only")?.textContent, TEXT, "a screen reader hears the full sentence");
  assert.equal(note.querySelector("[data-note-shown]")?.getAttribute("aria-hidden"), "true", "…and not the short one as well");
  m.unmount();
});

test("the measuring copies never show and never take room", () => {
  SLOT_W = 300;
  const m = mount({ note: { text: TEXT, forms: FORMS, onDismiss: () => {} } });
  assert.equal(m.host.querySelectorAll("[data-note-form]").length, FORMS.length, "one measuring copy per form");
  for (const f of m.host.querySelectorAll("[data-note-form]")) {
    const cls = (f as HTMLElement).className;
    assert.match(cls, /\binvisible\b/);
    assert.match(cls, /\babsolute\b/);
    assert.equal(f.getAttribute("aria-hidden"), "true");
  }
  m.unmount();
});

test("readable while the field is FOCUSED and empty, not only at rest", () => {
  SLOT_W = 1000;
  const m = mount({ note: { text: TEXT, forms: FORMS, onDismiss: () => {} } });
  const ta = m.host.querySelector("textarea")!;
  act(() => { ta.focus(); ta.dispatchEvent(new dom.window.FocusEvent("focus")); });
  assert.equal(dom.window.document.activeElement, ta);
  m.render({ value: "", expanded: false });
  assert.equal(shown(m.host), TEXT, "focus alone does not hide the note");
  m.unmount();
});

test("no note: the placeholder as before", () => {
  const m = mount({ note: null });
  assert.equal(m.host.querySelector("[data-refusal-note]"), null);
  assert.equal(m.host.querySelector(".chat-input-placeholder")?.textContent, "Send a message…");
  m.unmount();
});
