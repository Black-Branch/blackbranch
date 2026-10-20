import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url), "utf8"));
const player = read("../features/player/StreamplaceThinPlayer.tsx");
const clientError = read("./clientError.ts");
const sink = read("../api/client-error/route.ts");
const proxy = read("./whepProxy.ts");
const relay = read("../api/streamplace/whep/route.ts");

test("the player reports at each of its three decisions, before the teardown", () => {
  const sr = player.indexOf("const scheduleReconnect = (reason: string) =>");
  assert.ok(sr > 0, "scheduleReconnect takes a reason");
  const end = player.indexOf("retryCountRef.current += 1", sr);
  assert.ok(end > sr, "the increment that bounds the slice was not found — a rename would silently widen this to end-of-file");
  const srBody = player.slice(sr, end);
  assert.match(srBody, /reportPlayerEvent\("reconnect", reason\)/);
  assert.match(player, /reportPlayerEvent\("failed", reason\)/);
  assert.match(player, /reportPlayerEvent\("ended", "track-ended"\)/);
  assert.match(player, /nodeRef\.current = res\.headers\.get\("x-playback-server"\)/);
});

test("every caller names its reason", () => {
  for (const reason of ['"watchdog"', '"grace-expired"', '`state:${st}`', '`relay:${res.status}`', '"fetch-threw"', '"max-reconnects"', '"relay:429"']) {
    assert.ok(player.includes(reason), reason);
  }
});

test("the sink and the client agree that player is a source", () => {
  assert.match(clientError, /\| "player"/);
  assert.match(sink, /"player"/);
});

test("the relay names its node and warns on upstream trouble", () => {
  assert.match(proxy, /console\.warn\("\[whep\] upstream %d from %s/);
  assert.match(proxy, /console\.warn\("\[whep\] playback server unreachable: %s"/);
  assert.match(relay, /"x-playback-server": r\.server/);
});

test("vacuity anchors", () => {
  // The literal last TWO non-blank lines of each file, comments stripped — a
  // bare /\}$/ alone would also match a file truncated one line short of its
  // real end (many things end in "}"); two consecutive literal lines is a
  // much narrower coincidence.
  assert.match(player.trimEnd(), /  \}\);\n\}$/);
  assert.match(proxy.trimEnd(), /  \};\n\}$/);
  assert.match(relay.trimEnd(), /  \}\);\n\}$/);
  assert.match(clientError.trimEnd(), /  \};\n\}$/);
  assert.match(sink.trimEnd(), /  \}\n\}$/);
});
