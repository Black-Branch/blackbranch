// A staff line may be 500 characters; YouTube's live chat takes 200. The YouTube copy goes as
// parts of at most 200, split at a word boundary, in order, with no marker — nothing dropped.
// The site arms the echo of every part (stream-api platformParts), or each part would come back
// from YouTube as a new line.
// Run: node --test app/lib/youtubeParts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { youtubeParts, sendInParts } from "./youtubeParts.ts";
import { stripComments } from "./testSource.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${String(i).padStart(3, "0")}`).join(" ");

test("a 450-character staff line reaches YouTube as three parts, each ≤200, in order", async () => {
  const line = words(60).slice(0, 450);
  assert.equal(line.length, 450);
  const sent: string[] = [];
  const r = await sendInParts(line, async (part) => { sent.push(part); return { ok: true, platformMsgId: `LCC.${sent.length}` }; });
  assert.equal(sent.length, 3);
  for (const p of sent) assert.ok(p.length <= 200, `a part of ${p.length}`);
  assert.equal(sent.join(" "), line, "nothing dropped, nothing reordered");
  for (const p of sent) assert.doesNotMatch(p, /^\s|\s$/, "split at a word boundary, no stray space");
  assert.deepEqual(r, { ok: true, platformMsgId: "LCC.1" }, "the first part's id keys the copy");
});

test("a line within the limit goes as it is, in one part", async () => {
  const line = "  hello   there ";
  assert.deepEqual(youtubeParts(line), [line]);
  assert.deepEqual(youtubeParts("x".repeat(200)), ["x".repeat(200)]);
  const sent: string[] = [];
  await sendInParts(line, async (p) => { sent.push(p); return { ok: true }; });
  assert.deepEqual(sent, [line]);
});

test("a word longer than the limit is cut, never dropped, and never inside a surrogate pair", () => {
  const long = "😀".repeat(150); // 300 UTF-16 units
  const parts = youtubeParts(`hi ${long} bye`);
  for (const p of parts) assert.ok(p.length <= 200);
  assert.equal(parts.join("").replace(/ /g, ""), `hi${long}bye`);
  for (const p of parts) assert.doesNotMatch(p, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/, "a split emoji");
});

test("retry: a part that fails stops the rest, and the failure is what the route reports", async () => {
  const sent: string[] = [];
  const r = await sendInParts(words(60).slice(0, 450), async (p) => {
    sent.push(p);
    return sent.length === 2 ? { ok: false, error: "unavailable", reason: "upstream", code: "youtube.quota" } : { ok: true };
  });
  assert.equal(sent.length, 2, "a part after a failure would arrive out of order");
  assert.deepEqual(r, { ok: false, error: "unavailable", reason: "upstream", code: "youtube.quota" });
});

test("wiring: the YouTube sender posts in parts, and both send paths arm every part's echo", () => {
  const pc = stripComments(readFileSync(new URL("./platformChat.ts", import.meta.url), "utf8"));
  assert.match(pc, /return sendInParts\(message, \(part\) => postYouTubeLine\(/);
  const route = stripComments(readFileSync(new URL("../api/chat/send/route.ts", import.meta.url), "utf8"));
  assert.match(route, /\.\.\.\(targets\.includes\("youtube"\) \? youtubeEchoParts\(red\.platformText\) : \{\}\)/, "the send-to-all path");
  assert.match(route, /\.\.\.\(platformTarget === "youtube" \? youtubeEchoParts\(platformOutgoingText\(outgoingMessage, reply_to_username\)\) : \{\}\)/, "the single-platform path");
});
