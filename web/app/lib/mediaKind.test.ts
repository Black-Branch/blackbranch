// One label for "this message is a media attachment" — the reply quote, the
// thread chip and the threads list all used to hand-roll "📷 Image", and batch
// 1 showed a new renderer silently breaking a name-scanned invariant. The scan
// below makes "every preview site uses the helper" a fact.
//
// Run: node --test app/lib/mediaKind.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { mediaKindLabel } from "./mediaKind.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

test("label table", () => {
  assert.equal(mediaKindLabel("m.room.message", "m.image"), "📷 Image");
  assert.equal(mediaKindLabel("m.sticker", undefined), "📷 Image");
  assert.equal(mediaKindLabel("m.room.message", "m.video"), "🎬 Video");
  assert.equal(mediaKindLabel("m.room.message", "m.audio"), "🎵 Audio");
  assert.equal(mediaKindLabel("m.room.message", "m.file"), "📎 File");
  assert.equal(mediaKindLabel("m.room.message", "m.text"), null);
  assert.equal(mediaKindLabel("m.room.message", undefined), null);
  assert.equal(mediaKindLabel("m.room.message", 42), null);
});

test("every preview site uses the helper and carries no literal media label", () => {
  const row = read("app/components/MatrixMessageRow.tsx", /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/);
  const panel = read("app/features/community/ThreadsListPanel.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.equal((row.match(/mediaKindLabel\(/g) ?? []).length, 2, "reply quote + thread chip");
  assert.equal((panel.match(/mediaKindLabel\(/g) ?? []).length, 1, "threads list preview");
  for (const [name, src] of [["row", row], ["panel", panel]] as const) {
    assert.doesNotMatch(src, /"📷 Image"|"📎 File"|"🎬 Video"|"🎵 Audio"/, `${name} must not hand-roll a media label`);
  }
});

test("the row dispatches video and audio to their own renderers", () => {
  const row = read("app/components/MatrixMessageRow.tsx", /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/);
  assert.match(row, /content\.msgtype === "m\.video"[\s\S]{0,80}<MatrixVideo content=\{content\} \/>/);
  assert.match(row, /content\.msgtype === "m\.audio"[\s\S]{0,80}<MatrixAudio content=\{content\} \/>/);
  const att = read("app/components/MatrixAttachments.tsx", /<\/div>\s*\);\s*}\s*$/);
  // No Range support means metadata fetches the whole file, so what may load
  // before play is decided by videoPlaybackMode — never a bare preload.
  assert.match(att, /const mode = videoPlaybackMode\(info, Boolean\(enc\)\);/);
  assert.match(att, /if \(mode === "loop"\) return <LoopClip /);
  assert.match(att, /<video[\s\S]{0,200}controls[\s\S]{0,80}preload=\{mode === "preview" \? "metadata" : "none"\}[\s\S]{0,40}playsInline/, "a click-to-play video fetches nothing until play is pressed");
  const loop = att.slice(att.indexOf("function LoopClip("), att.indexOf("export function MatrixAudio("));
  assert.ok(loop.length > 0, "LoopClip must sit between MatrixVideo and MatrixAudio");
  assert.match(loop, /<video[\s\S]{0,120}muted[\s\S]{0,20}loop[\s\S]{0,20}playsInline/, "a Discord gif plays silent and looping");
  assert.doesNotMatch(loop, /\bcontrols\b/, "a Discord gif shows no controls");
  assert.doesNotMatch(loop, /autoPlay/, "it starts from the on-screen observer, never autoPlay — that would ignore reduced motion and off-screen rows");
  assert.match(loop, /prefers-reduced-motion: reduce/);
  assert.match(att, /<audio[\s\S]{0,120}controls[\s\S]{0,120}preload="none"/);
});

// Vacuity anchor at the END: the helper discriminates.
test("the helper genuinely discriminates", () => {
  assert.notEqual(mediaKindLabel("m.room.message", "m.image"), mediaKindLabel("m.room.message", "m.text"));
});
