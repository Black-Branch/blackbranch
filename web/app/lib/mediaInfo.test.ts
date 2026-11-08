// What a picked file posts as, and the copy of the two composer notes.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/mediaInfo.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { pickMsgtype, uploadLimitBytes, tooLargeNote, uploadFailedNote, attachmentCaption, attachmentName } from "./mediaInfo.ts";
import type { MatrixClient } from "matrix-js-sdk";

test("mediaInfo kinds: mp4 → video, ogg → audio, png → image, pdf → file", () => {
  assert.equal(pickMsgtype("video/mp4"), "m.video");
  assert.equal(pickMsgtype("audio/ogg"), "m.audio");
  assert.equal(pickMsgtype("image/png"), "m.image");
  assert.equal(pickMsgtype("application/pdf"), "m.file");
  assert.equal(pickMsgtype(""), "m.file", "a file the browser could not type is a plain file");
});

test("the notes: whole MB rounded down, the file named", () => {
  assert.deepEqual(tooLargeNote(50 * 1024 * 1024), ["Too large — the limit is 50 MB", "Too large — 50 MB max", "Over 50 MB"]);
  assert.equal(tooLargeNote(50 * 1024 * 1024 - 1)[0], "Too large — the limit is 49 MB");
  assert.deepEqual(uploadFailedNote("clip.mp4"), ["Couldn't upload clip.mp4 — try again", "Couldn't upload — try again", "Upload failed"],
    "a shorter form, so a phone never shows a cut sentence");
});

test("uploadLimitBytes asks once per client; retry: a failed ask is asked again", async () => {
  let asks = 0;
  const ok = { getMediaConfig: async () => { asks++; return { "m.upload.size": 1234 }; } } as unknown as MatrixClient;
  assert.equal(await uploadLimitBytes(ok), 1234);
  assert.equal(await uploadLimitBytes(ok), 1234);
  assert.equal(asks, 1, "cached");

  let fails = 0;
  const bad = { getMediaConfig: async () => { fails++; throw new Error("offline"); } } as unknown as MatrixClient;
  assert.equal(await uploadLimitBytes(bad), null);
  assert.equal(await uploadLimitBytes(bad), null);
  assert.equal(fails, 2, "a failure is not cached");

  const silent = { getMediaConfig: async () => ({}) } as unknown as MatrixClient;
  assert.equal(await uploadLimitBytes(silent), null, "no limit stated → null");
});

test("a caption is body when filename is set and differs", () => {
  assert.equal(attachmentCaption("look", "a.png"), "look");
  assert.equal(attachmentCaption("a.png", "a.png"), null);
  assert.equal(attachmentCaption("a.png", undefined), null, "no filename: body is the name (older senders, bridges)");
  assert.equal(attachmentCaption("  ", "a.png"), null, "blank is no caption");
  assert.equal(attachmentName({ body: "look", filename: "a.png" }, "file"), "a.png");
  assert.equal(attachmentName({ body: "a.png" }, "file"), "a.png");
  assert.equal(attachmentName({}, "file"), "file");
});
