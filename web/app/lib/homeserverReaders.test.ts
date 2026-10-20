// R2-14: the readers of a signed-in viewer's OWN homeserver — an outside server for a federated
// account, so its answers are user-influenced. Each goes through homeserverFetch, whose deadline
// covers the body (homeserverFetch.test.ts / ssrf.test.ts run that against a trickling server);
// this pins what only the caller decides: the byte cap for what it parses, and that a body it does
// not read is cancelled rather than left holding the connection.
// Run: node --test app/lib/homeserverReaders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const WEB = join(import.meta.dirname, "..", "..");

function read(rel: string): string {
  const raw = readFileSync(join(WEB, rel), "utf8");
  const src = stripComments(raw);
  // END anchor: the last 12 characters of the file (code, never a comment, in each of these)
  // survive the comment strip, so the scan read the whole file.
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-12)), `${rel}: the scan did not reach the END of the file`);
  return src;
}

test("profile reads are capped at 16 KiB a key", () => {
  const src = read("app/lib/matrixProfile.ts");
  assert.match(src, /const PROFILE_KEY_MAX_BYTES = 16 \* 1024;/);
  assert.match(src, /readJsonCapped\(res, PROFILE_KEY_MAX_BYTES\)/);
  assert.doesNotMatch(src, /MATRIX_JSON_MAX_BYTES/);
});

test("a profile write cancels the answer it does not read", () => {
  const src = read("app/lib/matrixProfile.ts");
  const start = src.indexOf("async function setMatrixProfileField(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /res\?\.body\?\.cancel\(\)/);
});

test("the device list is capped at 256 KiB", () => {
  const src = read("app/api/matrix/devices/route.ts");
  assert.match(src, /readJsonCapped\(res, 256 \* 1024\)/);
});

test("a device delete and the presence mirror cancel the answer they do not read", () => {
  assert.match(read("app/api/matrix/devices/[deviceId]/route.ts"), /res\.body\?\.cancel\(\)/);
  assert.match(read("app/lib/presenceServer.ts"), /res\.body\?\.cancel\(\)/);
});

test("the media upload has its own 30 s deadline (it SENDS megabytes) and reads a 4 KiB reply", () => {
  const src = read("app/lib/matrixMediaUpload.ts");
  assert.match(src, /timeoutMs: 30_000/);
  assert.match(src, /readJsonCapped\(upload, 4 \* 1024\)/);
});
