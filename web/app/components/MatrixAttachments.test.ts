// A decrypted attachment becomes a same-origin blob: URL, so the type it is labelled with decides
// whether "open in new tab" shows a picture or runs a page. Every blob here takes the media
// allowlist's type (app/lib/mediaHeaders.ts, tested by running it there), never the sender's.
// MatrixAttachments.tsx is a client component node --test cannot render, so this is a scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "MatrixAttachments.tsx"), "utf8");
const src = stripComments(raw);

test("END anchor: the file was read to its last component", () => {
  assert.match(raw, /<audio src=\{src\} controls[^\n]*\/>\n\s*<\/div>\n\s*\);\n\}\n$/);
});

test("every Blob takes blobMediaType, and nothing labels one with the sender's mimetype", () => {
  const blobs = src.match(/new Blob\([^)]*\)/g) ?? [];
  assert.equal(blobs.length, 2, "expected the two decrypted-attachment blobs");
  for (const b of blobs) assert.match(b, /\{ type: blobMediaType\(/, b);
  assert.doesNotMatch(src, /type: \(?(info\?\.)?mimetype/);
  assert.match(src, /import \{ blobMediaType \} from "@\/app\/lib\/mediaHeaders";/);
});
