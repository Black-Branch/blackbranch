// A bridged custom-emoji reaction must not load a 32 px CROP thumbnail — for a
// GIF, that is one frozen frame. Body emotes load the download and animate; the
// pill must do the same.
//
// Run: node --test app/lib/reactionPillImage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = readFileSync(join(webRoot, "app/components/ReactionPicker.tsx"), "utf8");

test("the read reaches the end of the picker", () => {
  assert.match(raw.slice(-300), /document\.body\s*\);\s*}\s*$/);
});

const src = stripComments(raw);

test("ReactionKey loads a bridged emoji from the download, never a thumbnail", () => {
  const fn = src.slice(src.indexOf("export function ReactionKey("), src.indexOf("const KIND_ITEMS"));
  assert.ok(fn.length > 0);
  assert.match(fn, /const src = mxc \? mxcToDownload\(mxc\) : null;/);
  assert.doesNotMatch(fn, /mxcToHttp\(/);
});

// Vacuity anchor at the END: the slice is the real function, not empty.
test("the slice is bounded by real markers", () => {
  assert.ok(src.indexOf("export function ReactionKey(") < src.indexOf("const KIND_ITEMS"));
});
