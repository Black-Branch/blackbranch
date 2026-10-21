// CONTRACT GUARD: wsFrames.ts registry  ⇄  what stream-api actually broadcasts
//
// The frame registry is the decoupling substrate the modular architecture leans
// on (north-star invariant 3). But stream-api is plain JS, so nothing forces its
// broadcast() calls to match the TypeScript union — the registry was a DOCUMENT,
// trusted to be right. It was not: when this guard was first written it found
// THREE frames the hand-written registry had missed (showAlert, updateSupportBar,
// timerState), one of which — timerState — is a whole subsystem.
//
// This test reads stream-api's source and fails if the two sets diverge in
// either direction:
//   • a frame broadcast but not registered  -> consumers have no type for it
//   • a frame registered but never broadcast -> the registry documents a lie
//
// Deliberately a source scan, not a runtime check: booting stream-api in a test
// would need Postgres, OBS and the platform tokens, and would still only observe
// the frames that happened to fire.
//
// Run: node --test app/lib/wsFrameContract.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STREAM_FRAME_TYPES } from "./wsFrames.ts";
import { stripComments } from "./testSource.ts";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../../../stream-api");

// `type:` literals that are NOT outbound WS frames. Each needs a reason — an
// entry here is a claim that something named `type` never reaches broadcast().
const NOT_A_FRAME = new Map<string, string>([
  [
    "donation",
    "webhooks.js:121 — INBOUND Streamlabs socket payload, described in a comment " +
      "({ type:'donation', ... }). Arrives from the outside; never broadcast.",
  ],
]);

// Files whose `type:` literals are a provider's wire format, not frames. Each needs a reason.
const NOT_SCANNED = new Map<string, string>([
  [
    "aiAdapter.generated.js",
    "the AI adapter's generated copy (config/ai-adapter.mjs): Anthropic/OpenAI message blocks " +
      "(text, tool_use, function). It imports nothing, so it cannot reach broadcast().",
  ],
]);

/**
 * Strip comments before scanning. Without this the guard trips on prose: the
 * `donation` literal above lives only in a `//` comment, and a registry entry
 * mentioned in a doc block would look like a real broadcast.
 */

/**
 * Frame names as they appear in stream-api source.
 *
 * The `[^a-zA-Z_]` prefix is load-bearing: a bare /type:/ also matches
 * `segment_type:` (radio-dj's banter/news/shoutout/station_id) and `eventType:`,
 * which would smuggle four non-frames into the expected set.
 */
function scanBroadcastTypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  // The install's owner/ folder broadcasts too (the meter, the radio); its frames are
  // registered like any other.
  const src_ = (f: string) => f.endsWith(".js") && !f.endsWith(".test.js") && !NOT_SCANNED.has(f);
  const owned = existsSync(join(apiDir, "owner")) ? readdirSync(join(apiDir, "owner")).filter(src_).map((f) => `owner/${f}`) : [];
  for (const file of [...readdirSync(apiDir).filter(src_), ...owned]) {
    const src = stripComments(readFileSync(join(apiDir, file), "utf8"));
    for (const m of src.matchAll(/(?:^|[^a-zA-Z_])type:\s*['"]([a-zA-Z_:]+)['"]/g)) {
      const name = m[1]!;
      if (NOT_A_FRAME.has(name)) continue;
      const where = found.get(name) ?? [];
      if (!where.includes(file)) where.push(file);
      found.set(name, where);
    }
  }
  return found;
}

test("every frame stream-api broadcasts is in the registry", () => {
  const broadcast = scanBroadcastTypes();
  const registered = new Set<string>(STREAM_FRAME_TYPES);

  const unregistered = [...broadcast.entries()]
    .filter(([name]) => !registered.has(name))
    .map(([name, files]) => `${name} (${files.join(", ")})`);

  assert.deepEqual(
    unregistered,
    [],
    "stream-api broadcasts frames the registry does not know about — add them to " +
      "StreamFrame in wsFrames.ts (and the REGISTERED lock), or add them to " +
      "NOT_A_FRAME here with a reason if they never reach broadcast()"
  );
});

// Frames only an install's site plugin sends (stream-api/owner/): registered for the clients that
// read them, and absent from a tree with no owner folder. Exact — checked against the owner folder
// wherever it exists.
const OWNER_FRAMES = ["meterState", "bot_mode", "bot_active", "bot_tools"];
const OWNER_PRESENT = existsSync(join(apiDir, "owner"));

test("the owner-only frames are exactly the ones the owner folder sends", { skip: OWNER_PRESENT ? false : "no owner folder in this tree" }, () => {
  const broadcast = scanBroadcastTypes();
  const onlyOwner = [...broadcast.entries()].filter(([, files]) => files.every((f) => f.startsWith("owner/"))).map(([n]) => n);
  assert.deepEqual(onlyOwner.filter((n) => STREAM_FRAME_TYPES.includes(n as never)).sort(), [...OWNER_FRAMES].sort());
});

test("every registered frame is actually broadcast by stream-api", () => {
  const broadcast = scanBroadcastTypes();

  const orphaned = STREAM_FRAME_TYPES.filter((name) => !broadcast.has(name) && (OWNER_PRESENT || !OWNER_FRAMES.includes(name)));

  assert.deepEqual(
    orphaned,
    [],
    "the registry documents frames stream-api never sends — either the producer " +
      "was removed (delete the variant) or it is now built somewhere this scan " +
      "cannot see (a dynamic `type`), which is itself worth fixing"
  );
});

test("the exhaustiveness lock covers the union (no silent drift)", () => {
  // STREAM_FRAME_TYPES derives from Record<StreamFrameType, true>, so a variant
  // added to the union without a lock entry is a COMPILE error. This asserts the
  // runtime shape too, so the list can be trusted by the scans above.
  assert.ok(STREAM_FRAME_TYPES.length > 0, "registry is empty");
  assert.equal(
    new Set(STREAM_FRAME_TYPES).size,
    STREAM_FRAME_TYPES.length,
    "duplicate frame names in the registry"
  );
});

test("NOT_A_FRAME entries still exist in the source (no stale exclusions)", () => {
  // An exclusion that no longer matches anything is dead weight that hides the
  // next real one. If the comment//payload it describes is gone, delete the entry.
  const raw = readdirSync(apiDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(apiDir, f), "utf8"))
    .join("\n");

  for (const [name, reason] of NOT_A_FRAME) {
    assert.ok(
      raw.includes(`'${name}'`) || raw.includes(`"${name}"`),
      `NOT_A_FRAME has a stale entry "${name}" — no longer in stream-api source. Reason given: ${reason}`
    );
  }
});
