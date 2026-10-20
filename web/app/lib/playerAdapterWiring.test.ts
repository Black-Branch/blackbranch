// Guards on the wiring. Source scans, because the behaviour lives in a hook and
// a .tsx that node --test cannot execute — the same reason the rest of this
// suite scans source. Run: node --test app/lib/playerAdapterWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, "..", "features", "player", "usePlayerAdapter.ts");
const twitchPath = join(here, "..", "features", "player", "TwitchPlayer.tsx");
const areaPath = join(here, "..", "features", "player", "StreamPlayerArea.tsx");
const hook = () => stripComments(readFileSync(hookPath, "utf8"));
const twitch = () => stripComments(readFileSync(twitchPath, "utf8"));
const area = () => stripComments(readFileSync(areaPath, "utf8"));

test("ADDITIVE RULE: nothing renders behind an awaited script", () => {
  // A blocked API script must not delay or prevent a frame. ready() is
  // synchronous precisely so the mount decision needs no await.
  assert.match(twitch(), /ready\(/, "the mount decision must consult the synchronous ready()");
  assert.doesNotMatch(twitch(), /\bawait\b/, "TwitchPlayer must not await anything before rendering");
  assert.match(hook(), /if\s*\(!create\)\s*return/, "the hook must be inert when no adapter can be built");
});

test("TwitchPlayer keeps the plain iframe for the no-script path", () => {
  const src = twitch();
  assert.match(src, /<iframe/, "the no-script path must still render Twitch's plain iframe");
  assert.match(src, /twSrc/, "the plain iframe must use the URL we already ship");
});

test("the container-or-iframe choice is made ONCE, not upgraded later", () => {
  // Swapping a playing iframe for an adapter-built one when a script arrives
  // late would black the video on every visit, for a benefit nobody can see.
  const src = twitch();
  assert.match(src, /useState\(\s*\(\)\s*=>/, "the decision must be a mount-time initialiser");
  assert.doesNotMatch(src, /setUseAdapter/, "the mount decision must have no setter");
});

test("the correction runs on visibility, not on a timer", () => {
  const src = hook();
  assert.match(src, /visibilitychange/, "the trigger must be the visibility event");
  assert.doesNotMatch(src, /setInterval/, "no polling: drift is sampled at the visibility edges");
});

test("the policy decides — the hook must not re-implement a threshold", () => {
  const src = hook();
  assert.match(src, /liveEdgeAction\(/, "the hook must call the pure policy");
  assert.doesNotMatch(src, /DRIFT_GROWTH_S|MIN_HIDDEN_MS|MIN_SINCE_LOAD_MS/,
    "a threshold was restated outside liveEdge.ts");
});

test("NO AUTOMATIC DEMOTION: an error never switches source or writes a source preference", () => {
  const src = hook();
  assert.doesNotMatch(src, /setSource\(/, "an error path must not move the viewer");
  assert.doesNotMatch(src, /player_live_source|LIVE_SOURCE_KEY/,
    "a source preference must never be written here");
  // The hook DOES persist one thing — this source's own volume — and nothing else.
  const sets = [...src.matchAll(/lsSet\(\s*([A-Za-z_$][\w$]*)/g)];
  assert.ok(sets.length >= 1, "no volume write found — the loop below would pass vacuously");
  for (const m of sets) {
    assert.equal(m[1], "volumeKey", `the hook persists something other than volume: ${m[1]}`);
  }
  assert.match(src, /const volumeKey = volumeKeyFor\(source\)/, "the key must be this source's own");
});

test("a player event never writes app-wide live state", () => {
  assert.doesNotMatch(hook(), /setLive\(/, "player events must not drive app-wide liveness");
});

test("restoring a saved level never unmutes", () => {
  // playerVolume.ts's rule: volume and muted are orthogonal. If restoring a
  // level also cleared muted, play() would be refused on mobile and the viewer
  // would get a dead player instead of a stream.
  //
  // A whole-file negative check, not a slice between two markers: a -1 from
  // either marker yields an empty slice the negative assertion passes over
  // vacuously, and the restore lives INSIDE the adapter.on(...) listener (it
  // must run on the "ready" event, which only arrives there), which would put
  // such a slice's start AFTER its end — also empty, also vacuous. A
  // whole-file check has no boundary to go stale.
  const src = hook();
  assert.ok(src.includes("restorableVolume("), "the saved-volume restore path was not found — was it renamed or removed?");
  assert.doesNotMatch(src, /setMuted\(\s*false\s*\)/, "restoring a volume unmuted the player");
});

test("FINDING 3: the saved volume is restored on the ready event, not synchronously before the handshake", () => {
  // Applying it in the same tick as construction (before the player's
  // handshake) silently loses it. It must be gated on a "ready" PlayerEvent.
  // Search for the CALL "restorableVolume(", not the bare name — the bare
  // name also matches this file's own import statement, which always sits
  // before adapter.on( regardless of where the call itself lives.
  const src = hook();
  assert.match(src, /kind\s*===\s*"ready"/, "there is no ready-event branch to apply the saved volume");
  const onIdx = src.indexOf("adapter.on(");
  const psvIdx = src.indexOf("restorableVolume(");
  assert.ok(onIdx > -1 && psvIdx > -1, "adapter.on( or a restorableVolume(...) call was not found — has the wiring moved?");
  assert.ok(psvIdx > onIdx, "the saved volume must be applied from inside the adapter.on(...) listener, in response to ready — not before it");
});

test("FINDING 3: the volume level is captured on the events the hook already receives, not only at teardown", () => {
  // The unmount cleanup does not run on a tab close or refresh, so a level
  // set and then closed was lost with no other capture point to catch it.
  // The hook factors the read+persist into one captureVolume() helper, so
  // the guard counts ITS call sites, not raw readVolume() text.
  const src = hook();
  assert.match(src, /const captureVolume = \(\) => \{[\s\S]*?adapter\.readVolume\(\)/,
    "captureVolume() no longer reads the adapter's volume back");
  const calls = [...src.matchAll(/captureVolume\(\)/g)].length;
  assert.ok(calls >= 2, `expected at least 2 captureVolume() call sites (the definition's own body does not count as one), found ${calls}`);
});

test("FINDING 2: a late-resolving youtube script upgrades YouTubeFrame instead of leaving it inert forever", () => {
  // Twitch's API BUILDS its own iframe, so its choice is frozen at mount (the
  // test above pins that). YouTube's API only ATTACHES to the iframe that is
  // already there, so an upgrade costs nothing — a viewer who lands on a cold
  // page while the stream is already live must not go the whole session with
  // no adapter just because iframe_api had not finished loading yet.
  const src = area();
  const start = src.indexOf("function YouTubeFrame");
  assert.ok(start > -1, "YouTubeFrame was not found — has it moved?");
  const end = src.indexOf("function StreamPlayerArea", start);
  const frame = src.slice(start, end > -1 ? end : undefined);

  assert.match(frame, /useState\(\s*\(\)\s*=>\s*ready\("youtube"\)\s*\)/,
    "the mount-time snapshot must still come from the synchronous ready()");
  assert.match(frame, /\.load\("youtube"\)\s*\.then\(/,
    "there is no retry against the script loader's own load() promise");
  assert.match(frame, /setScriptReady\(true\)/,
    "nothing ever upgrades the frozen snapshot once the script resolves late");
  // The fix's whole point: create() must be re-evaluated when the upgrade
  // happens, which only follows from depending on the upgraded flag itself —
  // a `create` still keyed only on the stable `ready` prop can never change
  // identity, and usePlayerAdapter would never retry constructing an adapter.
  const createFn = frame.slice(frame.indexOf("const create = useCallback"));
  assert.match(createFn, /\},\s*\[scriptReady\]\)/,
    "create() must depend on the upgraded flag, or a late-arriving script can never attach");
});

test("FINDING 7: script preload is not gated to the Live tab", () => {
  // A viewer who lands on Community or opens a VOD without ever visiting Live
  // used to fetch neither script — inert for the whole session even though
  // load() is idempotent and cheap to call unconditionally.
  assert.doesNotMatch(area(), /if\s*\(tab\s*!==\s*"live"\)\s*return;/,
    "the script preload is still gated to the Live tab only");
});

test("YouTube gets the failure panel too — it is the only source with error DETAIL", () => {
  // playerAdapter.ts's capability table: CAPABILITIES.youtube.errorDetail is
  // true, CAPABILITIES.twitch.errorDetail is false. Mounting the panel only on
  // the source that can't say WHY playback failed, and skipping the one that
  // can (codes 100/101/150/153), ships the program's whole point backwards.
  assert.match(area(), /<PlayerFailurePanel\b/,
    "StreamPlayerArea.tsx (YouTubeFrame) must render PlayerFailurePanel, not just import it");
});

test("FINDING 4: TwitchPlayer empties its own container on teardown — the adapter has no destroy()", () => {
  // adapters/twitch.ts's destroy() removes listeners only; Twitch's API never
  // gives us a way to tear down the <iframe> it builds inside the container.
  // A `parent` or `muted` change recreates the adapter WITHOUT a remount (the
  // `key={twitchChannel}` in StreamPlayerArea.tsx only changes on a channel
  // change), so construct-into-the-same-div would otherwise stack a second
  // Twitch.Player — two embeds, two audio streams — on Settings → Player →
  // "Start stream muted".
  const src = twitch();
  assert.match(src, /useRef<HTMLDivElement>\(null\)/, "no ref onto the container div was found");
  assert.match(src, /ref=\{containerRef\}/, "the container div is not wired to the ref");
  // The clearing effect must be tied to `create`'s own identity — the same
  // trigger usePlayerAdapter's internal effect uses to recreate the adapter —
  // or it would run on the wrong schedule (too often, or not at all).
  const effectBody = src.match(/useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[create\]\s*\);/);
  assert.ok(effectBody, "no useEffect(..., [create]) teardown was found");
  // containerRef.current is captured into a local at effect-run time, not
  // read live inside the cleanup closure (react-hooks/exhaustive-deps: a ref
  // may have already changed by the time cleanup runs).
  assert.match(effectBody![1]!, /=\s*containerRef\.current\s*;/, "containerRef.current is not captured into a local before the cleanup closure");
  assert.match(effectBody![1]!, /return\s*\(\)\s*=>\s*\{\s*\w+\?\.\w+\(\)/, "the teardown does not empty the captured container node");
});

test("every <TwitchPlayer> mount point carries a key — the adapter has no destroy()", () => {
  // adapters/twitch.ts's own header: "THERE IS NO destroy(). Teardown removes
  // our listeners; the caller empties the container." Without a key, a
  // CHANNEL change while the instance stayed mounted would tear down and
  // call create() again, constructing a SECOND Twitch.Player into the SAME
  // <div> instead of a fresh one — two players stacked in one container. A
  // key forces a brand-new <div> (a fresh useId()) instead.
  //
  // This key covers a channel change ONLY — it does not change on `parent` or
  // `muted`, so this guard does NOT cover those: TwitchPlayer.tsx's own
  // teardown effect, keyed on `create`, is what empties the container for a
  // parent/muted change that recreates the adapter without a remount.
  const mounts = area().match(/<TwitchPlayer[\s\S]*?\/>/g) ?? [];
  assert.ok(mounts.length > 0, "expected at least one <TwitchPlayer> mount point");
  for (const m of mounts) {
    assert.match(m, /\bkey=/, `<TwitchPlayer> mounted without a key: ${m.slice(0, 60)}…`);
  }
});

test("VACUITY ANCHOR: all three scanned files were read to the END", () => {
  assert.match(readFileSync(hookPath, "utf8").trimEnd().slice(-30), /\}\s*$/);
  assert.match(readFileSync(twitchPath, "utf8").trimEnd().slice(-30), /\}\s*$/);
  assert.match(readFileSync(areaPath, "utf8").trimEnd().slice(-30), /\}\s*$/);
});
