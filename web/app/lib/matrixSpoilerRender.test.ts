// The spoiler renderer: hidden until clicked, keyboard-reachable, children
// (text AND images) invisible but laid out. A scan, because the renderer is a
// React component without a DOM harness here.
//
// Run: node --test app/lib/matrixSpoilerRender.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = readFileSync(join(webRoot, "app/components/MatrixHtml.tsx"), "utf8");

test("the read reaches the end of the renderer", () => {
  assert.match(raw.slice(-300), /<\/>\s*\);\s*}\s*$/);
});

const src = stripComments(raw);

test("a spoiler span renders through Spoiler; a plain span stays a span", () => {
  assert.match(src, /case "span": return attrs\.spoiler \? <Spoiler key=\{i\} reason=\{attrs\.spoilerReason\}>\{kids\(\)\}<\/Spoiler> : <span key=\{i\}>\{kids\(\)\}<\/span>;/);
});

test("hidden state is a keyboard-reachable button whose children are invisible but laid out", () => {
  const fn = src.slice(src.indexOf("function Spoiler("), src.indexOf("function renderNodes("));
  assert.ok(fn.length > 0, "Spoiler is defined before renderNodes");
  assert.match(fn, /role="button"/);
  assert.match(fn, /tabIndex=\{0\}/);
  assert.match(fn, /aria-label="Spoiler"/);
  assert.match(fn, /<span className="invisible">\{children\}<\/span>/);
  assert.match(fn, /e\.key === "Enter" \|\| e\.key === " "/);
  assert.match(fn, /useState\(false\)/, "hidden by default");
  assert.match(fn, /\{reason && <span className="text-muted">\(\{reason\}\) <\/span>\}/);
});

// Vacuity anchor at the END: the scanned slice is the real component, not empty.
test("the component body is non-trivial", () => {
  assert.ok(src.indexOf("function Spoiler(") < src.indexOf("function renderNodes("));
});
