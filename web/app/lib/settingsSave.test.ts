// Closing Appearance inside the 800 ms debounce used to CANCEL the account save
// (the effect's cleanup cleared the timer on unmount), so the change never
// reached the account. The saver now flushes on close and keeps a failed save
// retryable. Behavioural for the saver (mock timers); a source scan for the
// panel's wiring, anchored at the END of the file.
//
// Run: node --test app/lib/settingsSave.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

await import("./testTsx.ts");
const { createSettingsSaver, SETTINGS_SAVE_DEBOUNCE_MS } = await import("./settingsSave.ts");

test("closing at 100 ms: the save still lands, once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const saver = createSettingsSaver(async () => { calls++; return true; });
  saver.schedule();
  t.mock.timers.tick(100);
  assert.equal(calls, 0, "setup: still inside the debounce");
  const ok = await saver.flush();          // the panel closes
  assert.equal(ok, true);
  assert.equal(calls, 1, "closing inside the debounce must send the save, not cancel it");
  t.mock.timers.tick(SETTINGS_SAVE_DEBOUNCE_MS * 2);
  assert.equal(calls, 1, "and the cancelled timer must not send it a second time");
  assert.equal(saver.state(), "idle");
});

test("bursts are still debounced into one save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const saver = createSettingsSaver(async () => { calls++; return true; });
  for (let i = 0; i < 5; i++) { saver.schedule(); t.mock.timers.tick(100); }
  assert.equal(calls, 0);
  t.mock.timers.tick(SETTINGS_SAVE_DEBOUNCE_MS);
  await Promise.resolve();
  assert.equal(calls, 1);
});

test("a failing save shows as failed and a retry sends it again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fail = true;
  let calls = 0;
  const saver = createSettingsSaver(async () => { calls++; return !fail; });
  saver.schedule();
  assert.equal(await saver.flush(), false);
  assert.equal(saver.state(), "failed", "the panel reads this and offers the retry");
  fail = false;
  assert.equal(await saver.flush(), true, "a flush with nothing pending retries a failed save");
  assert.equal(calls, 2);
  assert.equal(saver.state(), "idle");
  assert.equal(await saver.flush(), true, "nothing owed → nothing sent");
  assert.equal(calls, 2);
});

test("a thrown save (network) is a failure, not an unhandled rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saver = createSettingsSaver(async () => { throw new TypeError("Failed to fetch"); });
  saver.schedule();
  assert.equal(await saver.flush(), false);
  assert.equal(saver.state(), "failed");
});

test("the panel schedules through the saver, flushes on close, and offers the retry", () => {
  const src = stripComments(readFileSync(new URL("../components/ChatSettings.tsx", import.meta.url), "utf8"));
  assert.match(src, /scheduleSettingsSave\(\);/, "a change schedules the account save");
  assert.match(src, /useEffect\(\(\) => \(\) => \{\s*void flushSettingsSave\(\)/, "unmount (close) flushes — never cancels");
  assert.doesNotMatch(src, /clearTimeout\(saveTimer\.current\)/, "the cancelling cleanup is gone");
  assert.match(src, /saveState === "failed"/);
  assert.match(src, /onClick=\{\(\) => void flushSettingsSave\(\)\}/, "the failure line's button retries");
  // END anchor: the component's last lines.
  assert.match(src.trimEnd(), /\{!headerSlot && resetButton\}\s*<\/div>\s*\);\s*\}$/);
});
