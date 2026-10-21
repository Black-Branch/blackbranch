// The on-device diagnostic URL switches (?kbdebug, ?backdebug, ?playerdebug, ?chipdebug) are not
// mounted in a production build unless it was built to carry them. Every switch reads the ONE gate.
// Run: node --test app/lib/debugFlags.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { debugFlagsOn } from "./debugFlags.ts";

const APP = join(import.meta.dirname, "..");

test("a production build has no debug switches; a development build, or one built with NEXT_PUBLIC_DEBUG_FLAGS=1, has them", () => {
  assert.equal(debugFlagsOn({ NODE_ENV: "production" }), false);
  assert.equal(debugFlagsOn({ NODE_ENV: "production", NEXT_PUBLIC_DEBUG_FLAGS: "0" }), false);
  assert.equal(debugFlagsOn({ NODE_ENV: "production", NEXT_PUBLIC_DEBUG_FLAGS: "1" }), true);
  assert.equal(debugFlagsOn({ NODE_ENV: "development" }), true);
  assert.equal(debugFlagsOn({}), true, "a test run (no NODE_ENV) keeps the switches its tests drive");
});

test("each switch reads the gate before it reads the URL", () => {
  const sites: [string, RegExp][] = [
    ["components/chrome/BackDebugOverlay.tsx", /if \(!DEBUG_FLAGS_ON \|\| version === "ssr" \|\| !backDebugEnabled\(\)\) return null;/],
    ["lib/chrome/pageBackSentinel.ts", /if \(!DEBUG_FLAGS_ON\) return false;\s+try \{\s+return window\.location\.search\.includes\("backdebug=1"\);/],
    ["lib/useViewportHeightVar.ts", /if \(DEBUG_FLAGS_ON && \/\[\?&\]kbdebug\/\.test\(location\.search\)\) \{/],
    ["features/player/usePlayerDebug.ts", /if \(!DEBUG_FLAGS_ON\) return null;\s+const sw = readPlayerDebugSwitch\(/],
    ["components/EarnChip.tsx", /if \(!DEBUG_FLAGS_ON \|\| !new URLSearchParams\(window\.location\.search\)\.has\("chipdebug"\)\) return;/],
  ];
  for (const [file, re] of sites) {
    const src = readFileSync(join(APP, file), "utf8");
    assert.match(src, re, `${file} reads its switch without the gate`);
    assert.match(src, /import \{ DEBUG_FLAGS_ON \} from "(@\/app\/lib\/debugFlags|(\.\.?\/)+debugFlags\.ts)";/, `${file} does not import the gate`);
  }
});

test("the gate is a build-time constant Next can inline", () => {
  const src = readFileSync(join(APP, "lib", "debugFlags.ts"), "utf8");
  // Next replaces process.env.NODE_ENV and NEXT_PUBLIC_* only when written out literally.
  assert.match(src, /export const DEBUG_FLAGS_ON = debugFlagsOn\(\{ NODE_ENV: process\.env\.NODE_ENV, NEXT_PUBLIC_DEBUG_FLAGS: process\.env\.NEXT_PUBLIC_DEBUG_FLAGS \}\);\n$/);
});
