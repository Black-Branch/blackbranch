// Polish handoff A8: a failed DM open showed the SDK's raw `e.message` to the person. Plain
// words on screen; the detail to the console only.
// Run: node --test app/features/dm/dmErrorWording.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("DmHost never puts an error's own message on screen", () => {
  const src = readFileSync(new URL("./DmHost.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /error: [^\n]*\$\{e\.message\}/, "no `${e.message}` in a shown error");
  assert.match(src, /console\.warn\("\[dm\] could not open the conversation:", e\);/);
  assert.match(src, /error: "Couldn't open the conversation — try again in a moment\." \}/);
  assert.match(src.trimEnd(), /\}$/);
});
