// The public chat-history route's rate limit, run for real, plus the route's wiring (scan: the
// route imports through the @/ alias, which node --test cannot resolve).
// Run: node --test app/lib/chatHistoryLimit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatHistoryLimited } from "./chatHistoryLimit.ts";
import { stripComments } from "./testSource.ts";

test("a signed-out address gets 20 pages a minute, then 429s", () => {
  const key = "ip:198.51.100.7";
  for (let i = 0; i < 20; i++) assert.equal(chatHistoryLimited(key, false), false, `request ${i + 1}`);
  assert.equal(chatHistoryLimited(key, false), true);
  assert.equal(chatHistoryLimited("ip:198.51.100.8", false), false, "another address is unaffected");
});

test("a signed-in viewer scrolling back gets 60 a minute", () => {
  const key = "ip:198.51.100.9";
  for (let i = 0; i < 60; i++) assert.equal(chatHistoryLimited(key, true), false, `request ${i + 1}`);
  assert.equal(chatHistoryLimited(key, true), true);
});

test("the route checks the limit, by address, before it reads anything", () => {
  const raw = readFileSync(join(process.cwd(), "app", "api", "chat", "history", "route.ts"), "utf8");
  assert.match(raw, /hasMore: rows\.length >= limit \};\n\}\n$/, "END of route.ts not read");
  const src = stripComments(raw);
  const get = src.slice(src.indexOf("export async function GET("), src.indexOf("export type HistoryViewer"));
  assert.match(get, /if \(chatHistoryLimited\(ipKey\(req\), viewer\.me !== null\)\) \{\s*return new Response\("Too Many Requests", \{ status: 429/);
  assert.ok(get.indexOf("chatHistoryLimited(") < get.indexOf("loadChatHistory("), "the limit is checked before the query runs");
});
