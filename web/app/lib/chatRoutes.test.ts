// Two chat pages, two jobs:
//   /chat          — the broadcaster's own chat WINDOW: pauses when scrolled up, keeps history.
//   /overlay/chat  — the OBS browser source: transparent, always follows, 60 rows.
//
// The window behaviours (ChatWindow) and the source behaviours (ChatOverlay)
// would each break the other's use, so they are separate pages.
// Both keep the isolated "ov:" settings keyspace — see overlayScope.test.ts.
//
// Run: node --test app/lib/chatRoutes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string, tail: RegExp) => {
  const raw = readFileSync(join(here, "..", rel), "utf8");
  assert.match(raw.slice(-200), tail, `${rel} did not end as expected — truncated read`);
  return stripComments(raw);
};

test("/chat renders the window", () => {
  const src = read("chat/page.tsx", /\/>;\s*}\s*$/);
  assert.match(src, /import \{ ChatWindow \} from "@\/app\/features\/chat"/);
  assert.match(src, /<ChatWindow scaleFactor=\{scaleFactor\} initialMessages=\{messages\} initialEmotes=\{initialEmotes\} \/>/);
  assert.doesNotMatch(src, /ChatOverlay/, "the OBS source moved to /overlay/chat");
});

test("/overlay/chat renders the OBS source, with the same ?scale= contract", () => {
  const src = read("overlay/chat/page.tsx", /\/>;\s*}\s*$/);
  assert.match(src, /import \{ ChatOverlay \} from "@\/app\/features\/chat"/);
  assert.match(src, /<ChatOverlay scaleFactor=\{scaleFactor\} initialMessages=\{messages\} initialEmotes=\{initialEmotes\} \/>/,
    "the OBS source opens with its rows and emotes in the HTML too");
  assert.match(src, /Math\.min\(4, Math\.max\(0\.5, parseFloat\(scale \?\? "1\.5"\) \|\| 1\.5\)\)/,
    "the OBS URL's ?scale= keeps its range and default — a scene points at it");
});

test("the chat feature exports both entry points", () => {
  const src = read("features/chat/index.ts", /ChatWindow";\s*$/);
  assert.match(src, /export \{ default as ChatOverlay \} from "\.\/ChatOverlay";/);
  assert.match(src, /export \{ default as ChatWindow \} from "\.\/ChatWindow";/);
});

test("robots keeps the overlay directory out of the index", () => {
  const src = read("robots.ts", /\};\s*}\s*$/);
  assert.match(src, /disallow: \["\/api\/", "\/chat", "\/overlay", "\/popout", "\/mod", "\/admin"\]/);
});
