// Bridged Discord custom-emoji reactions arrive with key ":OMEGALUL:" and the
// emoji image's mxc in `fi.mau.discord.reaction` (bridge config
// custom_emoji_reactions: false). The bridge relays a Matrix reaction to
// Discord ONLY when its key is that mxc (portal.go handleMatrixReaction), so a
// site user's tap sends the mxc as the key. Both spellings must count as ONE
// reaction pile with one image.
//
// Run: node --test app/lib/matrixReactions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateReactions } from "./matrixReactions.ts";

const MXC = "mxc://site.test/abcdef123456";

// Minimal stand-in for MatrixEvent — only what aggregateReactions reads.
function ev(id: string, sender: string, content: Record<string, unknown>, redacted = false) {
  return {
    getId: () => id,
    getSender: () => sender,
    getType: () => "m.reaction",
    isRedacted: () => redacted,
    getContent: () => content,
  } as unknown as import("matrix-js-sdk").MatrixEvent;
}

const bridged = ev("$r1", "@discord_100000000000000001:site.test", {
  "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: ":OMEGALUL:" },
  "fi.mau.discord.reaction": { id: "1", mxc: MXC, name: "OMEGALUL" },
  "com.beeper.reaction.shortcode": ":OMEGALUL:",
});
const mineViaMxc = ev("$r2", "@k:site.test", {
  "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: MXC },
  "com.beeper.reaction.shortcode": ":OMEGALUL:",
});
const thumbsUp = ev("$r3", "@casey:site.test", {
  "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
});

test("a bridged shortcode reaction carries its image", () => {
  const agg = aggregateReactions([bridged], "@k:site.test").get("$msg")!;
  assert.deepEqual(agg, [{ key: ":OMEGALUL:", count: 1, mine: null, mxc: MXC }]);
});

test("the site user's mxc-keyed reaction folds into the same pile and is 'mine'", () => {
  const agg = aggregateReactions([bridged, mineViaMxc], "@k:site.test").get("$msg")!;
  assert.deepEqual(agg, [{ key: ":OMEGALUL:", count: 2, mine: "$r2", mxc: MXC }]);
});

test("a plain unicode reaction is untouched and has no image", () => {
  const agg = aggregateReactions([thumbsUp], "@k:site.test").get("$msg")!;
  assert.deepEqual(agg, [{ key: "👍", count: 1, mine: null, mxc: null }]);
});

test("an mxc key with no shortcode still groups by the mxc and keeps the image", () => {
  const bare = ev("$r4", "@k:site.test", {
    "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: MXC },
  });
  const agg = aggregateReactions([bare], "@k:site.test").get("$msg")!;
  assert.deepEqual(agg, [{ key: MXC, count: 1, mine: "$r4", mxc: MXC }]);
});

test("a redacted reaction does not count", () => {
  const gone = ev("$r5", "@k:site.test", { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" } }, true);
  assert.equal(aggregateReactions([gone], "@k:site.test").get("$msg"), undefined);
});

test("a tap on a custom pile sends the mxc as the key and repeats the shortcode", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "useRoomActions.ts"), "utf8"));
  assert.match(src, /key: extra \? extra\.mxc : key/, "the reaction key must be the mxc when extra is given");
  assert.match(src, /"com\.beeper\.reaction\.shortcode": extra\.shortcode/, "the shortcode must ride along");
});

test("the row memo compares mxc, so a late-arriving Discord emoji image repaints", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "MatrixMessageRow.tsx"), "utf8")
  );
  assert.match(
    src,
    /x\.mine !== y\.mine \|\| x\.mxc !== y\.mxc/,
    "the row memo must see an image change, or a late-arriving Discord emoji never repaints"
  );
});

// Vacuity anchor at the END: the fold is real — two spellings, one pile.
test("folding keeps ONE pile and raises its count", () => {
  const one = aggregateReactions([bridged], "@k:site.test").get("$msg")!.length;
  const two = aggregateReactions([bridged, mineViaMxc], "@k:site.test").get("$msg")!.length;
  assert.equal(one, two);
  assert.equal(aggregateReactions([bridged, mineViaMxc], "@k:site.test").get("$msg")![0]!.count, 2);
});
