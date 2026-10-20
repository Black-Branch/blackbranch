// The chat box's field: its Enter is the page's only Send key, and it carries no destination
// tag (the terminal's fade and the yellow [#site] room mark are the marks).
//
// Run: node --test app/components/chatComposerMark.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../lib/testTsx.ts";
const { ChatComposerField } = await import("./ChatComposerField.tsx");

const html = (value = "") => renderToStaticMarkup(createElement(ChatComposerField, {
  value, onChange: () => {}, onKeyDown: () => {}, inputRef: createRef<HTMLTextAreaElement>(), emotes: {}, maxLength: 200,
  placeholder: "Send a message…", showEmotePicker: false, setShowEmotePicker: () => {},
}));

test("the field's Enter says Send — it sends", () => {
  assert.match(html(), /<textarea[^>]*enterKeyHint="send"|<textarea[^>]*enterkeyhint="send"/i);
});

test("no tag, empty or typing; the field's name is its placeholder", () => {
  for (const value of ["", "hello there"]) {
    const out = html(value);
    assert.doesNotMatch(out, /chat-input-mark|public chat/, `no tag with value ${JSON.stringify(value)}`);
    assert.match(out, /aria-label="Send a message…"/);
  }
  assert.ok(html("x").includes("textarea"), "end of file: the field rendered");
});
