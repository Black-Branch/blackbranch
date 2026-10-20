// The notification menu is reachable from BOTH places the design promises, and
// the SDK's misleading mute helper stays out of the codebase.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/notificationWiring.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

const TIMELINE = "app/features/community/Timeline.tsx";
const COLUMN = "app/features/community/ChannelColumn.tsx";

/** Every non-test .ts/.tsx file under `dir`, relative to the repo root, whose
 *  STRIPPED source matches `pattern` — a mention in a comment does not count. */
function filesMatching(dir: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(process.cwd(), d), { withFileTypes: true })) {
      const rel = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      if (pattern.test(stripComments(readFileSync(join(process.cwd(), rel), "utf8")))) hits.push(rel);
    }
  };
  walk(dir);
  return hits;
}

test("the channel header renders a bell that opens the notification menu", () => {
  const src = read(TIMELINE);
  assert.match(src, /NotificationMenu/, "Timeline must import and render the shared menu");
  assert.match(src, /aria-label="Notification settings"/,
    "the bell needs an accessible name — an icon-only control is nameless otherwise");
  assert.match(src, /BellSimple|Bell\b/, "the bell icon must be rendered");
});

test("a channel row opens the same menu on right-click AND on long-press", () => {
  const src = read(COLUMN);
  assert.match(src, /onContextMenu=/, "right-click is the desktop gesture");
  assert.match(src, /useLongPress\(/, "touch has no right-click; long-press is the equivalent");
  assert.match(src, /NotificationMenu/, "the row must open the SAME menu, not a second one");
});

test("client.setRoomMutePushRule appears NOWHERE in the app", () => {
  // Despite its name it writes a room-kind dont_notify rule — this design's
  // "mentions only", not its "nothing". Calling it would leave mentions ringing
  // in a muted channel.
  assert.deepEqual(filesMatching("app", /setRoomMutePushRule/), []);
});

test("setRoomReadMarkers is written from exactly the two known places — a third writer is a defect, not a feature", () => {
  // Checking only that NotificationMenu.tsx and readReceipts.ts each contain
  // the string would never look for anyone ELSE writing a read marker, so a
  // third writer would ship green. Walk the whole tree the way the
  // setRoomMutePushRule test above does, and allow only the two writers the
  // design names.
  // The read-receipt hook's write lives in matrixPrivacy.ts (sendReadMarker),
  // which decides public vs private — readReceipts.ts calls it.
  const ALLOWED = new Set([
    join("app", "features", "community", "NotificationMenu.tsx"),
    join("app", "lib", "matrixPrivacy.ts"),
  ]);
  const writers = filesMatching("app", /setRoomReadMarkers/);
  assert.deepEqual(
    writers.filter((f) => !ALLOWED.has(f)).sort(),
    [],
    "a read marker must only ever be written from the menu's mark-as-read or the read-receipt hook"
  );
  // Both known writers must actually be found, or the scan above proves
  // nothing (it would pass the same way over a tree with none at all).
  for (const f of ALLOWED) assert.ok(writers.includes(f), `${f} must call setRoomReadMarkers`);
});

// Vacuity anchor: if the files above ever stop being read, every assertion
// here would pass over an empty string. Assert the sources are non-trivial.
test("the scanned files are real", () => {
  assert.ok(read(TIMELINE).length > 2000, "Timeline.tsx should be substantial");
  assert.ok(read(COLUMN).length > 2000, "ChannelColumn.tsx should be substantial");
});
