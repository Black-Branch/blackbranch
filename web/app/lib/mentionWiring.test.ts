// The mention highlight is actually wired to the rows, and stays visually
// distinct from the jump-to-message flash.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/mentionWiring.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
const ROW = "app/components/MatrixMessageRow.tsx";

test("the row takes a mentioned prop and honours it in the comparator", () => {
  const src = read(ROW);
  assert.match(src, /mentioned\?: boolean/, "the prop must be declared");
  assert.match(src, /a\.mentioned !== b\.mentioned/,
    "without this the memo keeps a stale highlight when an edit adds a mention");
});

// The mention mark lives in globals.css (`.chat-row-mention-mx`) so the
// "Mentions of me" switch can hide it. The two invariants below read the CSS
// as well as the row.
const CSS = "app/globals.css";

test("a mention and a jump-to highlight are different paint, so both can show", () => {
  const src = read(ROW);
  const css = read(CSS);
  assert.match(css, /\.chat-row-mention-mx \{ border-left: 2px solid/, "the mention bar");
  assert.match(src, /mentioned \? "chat-row-mention-mx"/, "the row no longer carries the mention class");
  assert.match(src, /bg-accent\/15/, "the jump-to flash must still exist");
});

test("the mention wash and the jump wash cannot both paint background-color at once", () => {
  // Both washes set background-color on the SAME element. The mention wash is
  // unlayered CSS, which beats the layered jump utility — so it must step aside
  // for a highlighted row itself (`:not([data-hl])`), and the row must set
  // data-hl exactly when it is highlighted.
  const src = read(ROW);
  const css = read(CSS);
  assert.match(css, /\.chat-row-mention-mx:not\(\[data-hl\]\) \{ background:/,
    "the mention wash would paint over the jump flash");
  assert.doesNotMatch(css, /\.chat-row-mention-mx \{[^}]*background/, "an unguarded mention wash");
  assert.match(src, /data-hl=\{highlighted \? "" : undefined\}/);
});

test("both timelines compute the prop from the shared helper", () => {
  for (const f of ["app/features/community/Timeline.tsx", "app/features/community/ThreadPanel.tsx"]) {
    const src = read(f);
    assert.match(src, /mentionsMe\(/, `${f} must derive the flag, not guess it`);
    assert.match(src, /mentioned=\{/, `${f} must pass it to the row`);
  }
});

// Vacuity anchor: the row file must still END with its memo export — eight
// scans depend on that line, and a reorder would silently void them.
test("the row file still ends with its memo export", () => {
  const raw = readFileSync(join(process.cwd(), ROW), "utf8").trimEnd();
  assert.ok(
    raw.endsWith("export const MatrixMessageRow = memo(MatrixMessageRowImpl, rowPropsEqual);"),
    "MatrixMessageRow.tsx must end with the memo export"
  );
});
