// web/app/components/communityAvatarInline.test.ts
// The head's avatar is the FIRST thing in the name line, in every layout: Compact and Bubbles
// show it there, one row tall like live chat's, with the text the full row width; Cozy (the
// default, client polish Task 24) lifts that same element into the Discord gutter from
// globals.css. There is still no separate gutter column in the markup.
// The Cozy structure and tokens: matrixMessageRow.render.test.ts.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/communityAvatarInline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../lib/testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = stripComments(readFileSync(path.join(here, "MatrixMessageRow.tsx"), "utf8"));

test("no gutter column and no gutter-width indents in the markup", () => {
  assert.doesNotMatch(src, /rowBasisCalc\('2\.6/, "the 2.6-basis gutter (and the reply preview's matching indent) is gone");
  assert.doesNotMatch(src, /size=\{34\}/, "no second, big gutter avatar");
});

test("the head row's name line starts with the avatar, a step the timeline picks (line, xs in Compact) × Avatar size", () => {
  const header = src.match(/\) : \(\s*<div className="mx-head flex items-baseline gap-1\.5 flex-wrap leading-tight">([\s\S]*?)\{badges\.map/);
  assert.ok(header, "the name line precedes the badges");
  assert.match(header?.[1] ?? "", /<Avatar mxcUrl=\{avatarUrl\} name=\{senderLabel\} size=\{avatarStep\} scaled box="--mx-avatar-box" thumb=\{gutterAvatar \? GUTTER_AVATAR_PX : undefined\} \/>/);
  assert.match(src, /avatarStep = "line",/, "the default stays one chat line");
});

test("a grouped row keeps its time, as a hover tooltip on the text", () => {
  assert.match(src, /title=\{grouped \? shortTime : undefined\}/);
  assert.match(src, /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/, "vacuity anchor");
});
