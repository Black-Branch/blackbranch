// Source scan: both hosts keep Home's headline as a once-consumed story and
// hand it to FeedPanel, which opens its reader on it — the same handoff
// pattern as pendingThread. A headline while News is unarmed arms it first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const readSrc = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), "utf8"));

test("both hosts: pendingStory → HomeTab's onOpenNews → FeedPanel's openStory, arming News when it is closed", () => {
  const dock = readSrc("app/components/BottomDock/index.tsx");
  const sidebar = readSrc("app/features/chat/ChatSidebar.tsx");
  for (const [name, src] of [["dock", dock], ["sidebar", sidebar]] as const) {
    assert.match(src, /const \[pendingStory, setPendingStory\] = useState<RssItem \| null>\(null\);/, name);
    assert.match(src, /const consumeStory = useCallback\(\(\) => setPendingStory\(null\), \[\]\);/, name);
    assert.match(src, /onOpenNews=\{openNewsOn\}/, name);
    assert.match(src, /openStory=\{pendingStory\} onStoryConsumed=\{consumeStory\}/, name);
  }
  assert.match(dock, /if \(armed\.includes\("news"\)\) setOpenTab\("news"\); else onArm\("news"\);/);
  assert.match(sidebar, /if \(armed\.includes\("news"\)\) selectPane\("news"\); else onArmTab\("news"\);/);
});

test("FeedPanel consumes the story once, microtask-deferred, into its reader", () => {
  const panel = readSrc("app/components/FeedPanel/index.tsx");
  assert.match(panel, /openStory\?: RssItem \| null;/);
  assert.match(panel, /Promise\.resolve\(\)\.then\(\(\) => \{ setReading\(openStory\); onStoryConsumed\?\.\(\); \}\);/);
  assert.match(panel, /\}, \[openStory, onStoryConsumed\]\);/);
  assert.match(panel, /\}\s*$/); // END anchor
});
