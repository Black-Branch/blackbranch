// The rig page's protocol: the page's frame lists equal what stream-api/rig.js sends and reads,
// the page sends exactly the frames it declares, and parseRigFrame takes only well-formed frames —
// a play frame only with a clip path on the api's own origin.
// Run: node --test app/lib/rig/rigProtocol.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "../testSource.ts";
import { RIG_SERVER_FRAMES, RIG_PAGE_FRAMES, parseRigFrame, rigSocketUrl } from "./rigProtocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rigJs = readFileSync(join(here, "../../../../stream-api/rig.js"), "utf8");
const overlay = readFileSync(join(here, "../../components/RigOverlay.tsx"), "utf8");

test("the server's frames: what rig.js sends is the page's list, both ways", () => {
  const code = stripComments(rigJs);
  assert.match(rigJs, /module\.exports = \{ rig, createRig \};\s*$/, "vacuity: read rig.js to its end");
  const sent = [...new Set([...code.matchAll(/type: '(rig\.[a-zA-Z]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(sent.length >= 4, `vacuity: ${sent.length} frames found`);
  assert.deepEqual(sent, [...RIG_SERVER_FRAMES].sort());
});

test("the page's frames: what rig.js reads and what the page sends are the page's list", () => {
  const code = stripComments(rigJs);
  const read = [...new Set([...code.matchAll(/msg\.type (?:===|!==) '(rig\.[a-zA-Z]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(read, [...RIG_PAGE_FRAMES].sort());
  const page = stripComments(overlay);
  const sends = [...new Set([...page.matchAll(/type: "(rig\.[a-zA-Z]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(sends, [...RIG_PAGE_FRAMES].sort());
  assert.match(overlay, /export default function RigOverlay\(\)/, "vacuity: read the overlay");
});

test("parseRigFrame: only well-formed frames; a play frame only for its own clip path", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(parseRigFrame(JSON.stringify({ type: "rig.play", id, url: `/rig/clip/${id}?exp=1&sig=x`, kind: "tts" })),
    { type: "rig.play", id, url: `/rig/clip/${id}?exp=1&sig=x`, kind: "tts" });
  assert.equal(parseRigFrame(JSON.stringify({ type: "rig.play", id, url: "https://elsewhere.test/a.mp3", kind: "tts" })), null);
  assert.equal(parseRigFrame(JSON.stringify({ type: "rig.play", id, url: `/rig/clip/${"f".repeat(32)}?exp=1`, kind: "tts" })), null, "another clip's path");
  assert.equal(parseRigFrame(JSON.stringify({ type: "rig.play", id: "x", url: "/rig/clip/x?" })), null);
  assert.equal(parseRigFrame(JSON.stringify({ type: "rig.play", id, url: `/rig/clip/${id}?e`, kind: "weird" }))?.type, "rig.play");
  assert.deepEqual(parseRigFrame(JSON.stringify({ type: "rig.speaking", on: true })), { type: "rig.speaking", on: true });
  assert.deepEqual(parseRigFrame(JSON.stringify({ type: "rig.setScene", name: "Break" })), { type: "rig.setScene", name: "Break" });
  assert.equal(parseRigFrame(JSON.stringify({ type: "rig.setScene", name: "" })), null);
  assert.equal(parseRigFrame("not json"), null);
  assert.equal(parseRigFrame(JSON.stringify({ type: "message" })), null, "a broadcast frame is not a rig frame");
  assert.equal(rigSocketUrl("wss://api.site.test/"), "wss://api.site.test/rig");
});
