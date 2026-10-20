// In mode 1 (one panel at a time — phones) every full-panel view draws a ← at
// the left of its header: Timeline (back to channels), the members view, a
// thread opened from the list. A small ✕ at the far right of the threads LIST
// is easy to miss, so this pins the ← on both thread views.
//
// Run: node --test app/features/community/threadsBack.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../lib/testSource.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => stripComments(readFileSync(join(HERE, f), "utf8"));

test("ThreadsListPanel draws a ← when given onBack", () => {
  const src = read("ThreadsListPanel.tsx");
  assert.match(src, /onBack\?: \(\) => void;/, "the prop exists");
  assert.match(src, /\{onBack && \(\s*<button onClick=\{onBack\} aria-label="Back"/, "the ← button is gated on onBack and labelled Back");
});

test("MatrixView hands the list a back action in mode 1 only", () => {
  const src = read("MatrixView.tsx");
  assert.match(src, /<ThreadsListPanel[^>]*onBack=\{mode === 1 \? closeThreadsList : undefined\}/);
});

test("a thread opened straight from a message still gets a ← in mode 1", () => {
  const src = read("MatrixView.tsx");
  assert.match(src, /onBack=\{threadsListOpen \? closeThread : mode === 1 \? closeRightThread : undefined\}/);
});

// Vacuity anchor at the END: the files scanned are the real panels.
test("the scan reads the real files", () => {
  assert.match(read("ThreadsListPanel.tsx"), /export function ThreadsListPanel\(/);
  assert.match(read("MatrixView.tsx"), /const closeThreadsList = useCallback/);
});
