// No WS frame handler casts a frame to a hand-written shape.
//
// The stream-api socket's frames are a typed union (wsFrames.ts). A handler that
// casts instead of narrowing reads whatever field it imagined: the popped-out
// user card cast `delete` to `{ id }` and read `.id` off a frame that carries
// `messageId`, so deletions never reached it. Narrowing on `data.type` gives the
// real fields, checked by tsc.
//
// The scan: every non-test file under app/ that subscribes to the socket or takes
// a frame, minus wsFrames.ts (the contract itself). In each, the handler's frame
// parameter must never be cast (`data as …`) and nothing may `as unknown as`.
//
// Run: node --test app/lib/wsFrameCasts.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./testSource.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const CONSUMER = /\buseChatSocket\(|:\s*(?:ChatSocketEvent|StreamFrame)\b/;

const consumers = walk(APP)
  .filter((f) => !f.endsWith("wsFrames.ts") && !f.endsWith("useChatSocket.ts"))
  .map((f) => ({ f, raw: readFileSync(f, "utf8") }))
  .filter(({ raw }) => CONSUMER.test(stripComments(raw)));

/** The names a file gives its frame parameter: `(data: ChatSocketEvent)`, `useChatSocket((f) =>`. */
function frameParams(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/\b(\w+)\s*:\s*(?:ChatSocketEvent|StreamFrame)\b/g)) names.add(m[1]!);
  for (const m of src.matchAll(/useChatSocket\(\s*\(?\s*(\w+)\s*\)?\s*=>/g)) names.add(m[1]!);
  return names;
}

test("the scan found the socket's consumers (guarding the scan, not the result)", () => {
  // useChatMessages, ChatOverlay, the pop-out card, the timer, the sponsor state, the mod history.
  assert.ok(consumers.length >= 6, `only ${consumers.length} consumer files found — the walk is reading nothing`);
  for (const name of ["useChatMessages.ts", "ChatOverlay.tsx", "userLiveFrames.ts", "ChatHistorySection.tsx"]) {
    assert.ok(consumers.some(({ f }) => f.endsWith(name)), `${name} is no longer seen as a consumer — update the scan`);
  }
});

test("no frame handler casts a frame by hand", () => {
  for (const { f, raw } of consumers) {
    const rel = relative(APP, f);
    // Read whole: the bytes read are the bytes on disk. A short read would turn
    // the negative assertions below green over a hole.
    assert.equal(Buffer.byteLength(raw), statSync(f).size, `${rel} was not read whole`);
    const src = stripComments(raw);
    const params = frameParams(src);
    assert.ok(params.size > 0, `${rel}: no frame parameter found — the scan cannot judge this file`);
    assert.doesNotMatch(src, /\bas unknown as\b/, `${rel}: \`as unknown as\` — narrow on the frame's type instead`);
    for (const p of params) {
      assert.doesNotMatch(src, new RegExp(`\\(\\s*${p}\\s+as\\b|\\b${p}\\s+as\\s`),
        `${rel}: the frame parameter \`${p}\` is cast — narrow on \`${p}.type\` and use the union's fields (wsFrames.ts)`);
    }
  }
});
