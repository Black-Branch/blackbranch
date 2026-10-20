// Run: node --test app/lib/deviceHealth/loafSummary.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { addLoaf, emptyLoaf, reduceScriptSrc, WORST_KEPT } from "./loafSummary.ts";

const O = "https://site.test";

test("a third-party script URL keeps only its host; ours keeps the path without a query", () => {
  assert.equal(reduceScriptSrc("https://cdn.x.com/a/b.js?token=abc#f", O), "cdn.x.com");
  assert.equal(reduceScriptSrc("https://site.test/_next/static/chunks/9.js?v=1", O), "/_next/static/chunks/9.js");
  assert.equal(reduceScriptSrc("chrome-extension://abc/x.js", O), "extension");
  assert.equal(reduceScriptSrc("moz-extension://abc/x.js", O), "extension");
  assert.equal(reduceScriptSrc("", O), "");
  assert.equal(reduceScriptSrc("blob:https://site.test/uuid", O), "other");
});

test("keeps exactly the 10 worst by blocking time, and counts every frame", () => {
  const acc = emptyLoaf();
  for (let i = 1; i <= 25; i++) addLoaf(acc, { duration: 100 + i, blockingDuration: i * 10, startTime: i }, O);
  assert.equal(acc.n, 25);
  assert.equal(acc.blockMs, (25 * 26 / 2) * 10);
  assert.equal(acc.worst.length, WORST_KEPT);
  assert.deepEqual(acc.worst.map((f) => f.b), [250, 240, 230, 220, 210, 200, 190, 180, 170, 160]);
});

test("scripts are reduced and capped", () => {
  const acc = emptyLoaf();
  const scripts = Array.from({ length: 30 }, (_, i) => ({
    sourceURL: `https://ads.example/t.js?id=${i}`, sourceFunctionName: "f".repeat(200), invoker: "x", duration: 5, forcedStyleAndLayoutDuration: 2,
  }));
  addLoaf(acc, { duration: 300, blockingDuration: 250, startTime: 9, scripts }, O);
  const s = acc.worst[0]?.s ?? [];
  assert.ok(s.length <= 5);
  assert.equal(s[0]?.src, "ads.example");
  assert.equal(s[0]?.fn.length, 60);
});
