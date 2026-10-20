// web/app/components/communityAvatarInline.test.ts
// Community avatars sit in the NAME LINE, in-line with the username. There is no
// Discord-style left gutter; message text runs the full row width.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/communityAvatarInline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../lib/testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = stripComments(readFileSync(path.join(here, "MatrixMessageRow.tsx"), "utf8"));

test("no gutter column and no gutter-width indents", () => {
  assert.doesNotMatch(src, /rowBasisCalc\('2\.6/, "the 2.6-basis gutter (and the reply preview's matching indent) is gone");
  assert.doesNotMatch(src, /size=\{34\}/, "no big gutter avatar");
});

test("the head row's header starts with a one-row avatar, like live chat", () => {
  const header = src.match(/\{!grouped && \(\s*<div className="flex items-baseline gap-1\.5 flex-wrap leading-tight">([\s\S]*?)\{badges\.map/);
  assert.ok(header, "header precedes the badges");
  // ⑥: the size is the timeline's (14, or 12 in Community › Layout › Compact).
  assert.match(header?.[1] ?? "", /<Avatar mxcUrl=\{avatarUrl\} name=\{senderLabel\} size=\{avatarSize\} \/>/);
  assert.match(src, /avatarSize = 14,/, "the default stays one row (14)");
});

test("a grouped row keeps its time, as a hover tooltip on the text", () => {
  assert.match(src, /title=\{grouped \? shortTime : undefined\}/);
  assert.match(src, /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/, "vacuity anchor");
});
