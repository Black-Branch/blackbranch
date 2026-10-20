// Which urls in a row become preview cards. Discord's rules: at most five
// embeds per message, and a message that already carries Discord's own unfurl
// (bridged as a discord-embed blockquote) gets no extra cards — otherwise the
// row would fire one card per href INSIDE the embed on top of the embed itself.
//
// Run: node --test app/lib/linkPreviewLimits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { previewCandidates } from "./linkPreviewLimits.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4", "https://a.example/5", "https://a.example/6", "https://a.example/7"];

test("Discord's cap is five", () => {
  // The constant is module-private (check-orphans does not count a test import
  // as a caller); the cap is asserted through behaviour.
  assert.equal(previewCandidates(urls, false).length, 5);
  assert.deepEqual(previewCandidates(urls, false), urls.slice(0, 5));
  assert.deepEqual(previewCandidates(urls.slice(0, 2), false), urls.slice(0, 2));
  assert.deepEqual(previewCandidates([], false), []);
});

test("a message carrying a Discord embed gets no cards at all", () => {
  assert.deepEqual(previewCandidates(urls, true), []);
  assert.deepEqual(previewCandidates(urls.slice(0, 1), true), []);
});

test("the row renders cards ONLY through previewCandidates, on every body path", () => {
  const src = readFileSync(join(webRoot, "app/components/MatrixMessageRow.tsx"), "utf8");
  assert.match(src.slice(-300), /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/);
  const row = stripComments(src);
  assert.match(row, /const cards = previewCandidates\(previewUrls, fromDiscord && !!htmlTree && treeHasEmbed\(htmlTree\.nodes\)\);/);
  assert.match(row, /\{cards\.map\(\(url\) => <LinkPreview key=\{url\} url=\{url\} \/>\)\}/);
  assert.equal((row.match(/<LinkPreview /g) ?? []).length, 1, "one render site, fed by the capped list");
  assert.doesNotMatch(row, /previewUrls\.map\(/, "the uncapped list must never reach LinkPreview");
});

// Vacuity anchor at the END: the function discriminates on both inputs.
test("both inputs matter", () => {
  assert.notDeepEqual(previewCandidates(urls, false), previewCandidates(urls, true));
  assert.notDeepEqual(previewCandidates(urls, false), urls);
});
