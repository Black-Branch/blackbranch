// The boundary that keeps a third-party embed out of app-wide liveness.
// Run: node --test app/lib/playerLivenessBoundary.test.ts
//
// `setLive` is defined and called only in useStreamStatusPoll.ts, so grepping
// StreamView.tsx for `setLive(...)` calls would loop over nothing and pass no
// matter what the code did. Instead this locates every READ of
// `playerLiveHint` (its declaration excepted) and asserts each one falls inside
// the `railStatus` object literal's own braces — a real containment check, not
// a fixed-width slice, so it cannot go vacuous and cannot be fooled by
// something unrelated appearing nearby.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const viewPath = join(here, "..", "components", "StreamView.tsx");
const areaPath = join(here, "..", "features", "player", "StreamPlayerArea.tsx");
const view = () => stripComments(readFileSync(viewPath, "utf8"));

/** The `const railStatus = { ... };` object literal's span in stripped source,
 *  found by brace-matching from its opening `{` — not a fixed character
 *  count, so a comment or a reordered field cannot shrink the window a real
 *  regression needs to land inside. */
function railStatusSpan(src: string): { start: number; end: number } {
  const marker = "const railStatus = {";
  const start = src.indexOf(marker);
  assert.ok(start > -1, "the rail status object was not found — was it renamed?");
  const openBrace = start + marker.length - 1;
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error("railStatus's opening brace is never closed — premise broken");
}

test("the hint reaches the rail's tone and nothing else", () => {
  // Coin earning, support-bar stream tagging and Gadget's live mode all key on
  // app-wide `live`, written only by the ingest poller (useStreamStatusPoll).
  // Every READ of the hint — everywhere but its own declaration — must sit
  // inside railStatus's braces, or it has reached somewhere it must not: a
  // `live={...}` prop, a hook argument, anything computing app-wide `live`.
  const src = view();
  const { start, end } = railStatusSpan(src);

  const decl = src.match(/const \[playerLiveHint,\s*setPlayerLiveHint\]/);
  assert.ok(decl?.index !== undefined, "the hint's own useState declaration was not found — was it renamed?");
  const declStart = decl.index!;
  const declEnd = declStart + decl[0].length;

  let reads = 0;
  for (const m of src.matchAll(/\bplayerLiveHint\b/g)) {
    const at = m.index!;
    if (at >= declStart && at < declEnd) continue; // the binding site, not a read
    reads++;
    assert.ok(
      at >= start && at < end,
      `playerLiveHint read at offset ${at} falls outside railStatus — the rail's tone is the only thing it may reach`,
    );
  }
  assert.ok(reads >= 1, "the hint is declared but never actually read anywhere");
});

test("the hint is scoped to which TwitchPlayer mount produced it, not just a source label", () => {
  // The Live tab's own Twitch mount and the Community tab's featured-streamer
  // mount share ONE onPlayerLive setter (StreamPlayerArea). A tab switch
  // between them unmounts one and mounts the other; the new mount's own
  // reporting effect fires one commit AFTER `currentSource` has already
  // flipped, so a bare source string can't tell which mount a stored hint
  // came from during that one paint. `scope` can, because it travels with
  // the value from the mount that produced it rather than being inferred
  // from state that changes on a different schedule.
  const src = view();
  // Not /scope:\s*"live"/ — that also matches the useState<{ scope: "live" |
  // "community"; ... }> TYPE ANNOTATION at the hint's own declaration, which
  // survives deleting the runtime guard entirely. The actual
  // runtime read is `playerLiveHint?.scope === "live"`.
  assert.match(src, /playerLiveHint\?\.scope\s*===\s*"live"/, "the consumption side never checks the mount's scope");
});

test("both TwitchPlayer mounts pass a scope, so a future third mount is covered too", () => {
  // Counting occurrences, not matching one line: a mount added later without
  // a `scope` prop would fail to typecheck against TwitchPlayerProps, but
  // this also catches it at the source-scan layer, and it does not need
  // updating when a third mount is added correctly.
  const src = stripComments(readFileSync(areaPath, "utf8"));
  const mounts = [...src.matchAll(/<TwitchPlayer\b/g)].length;
  const scoped = [...src.matchAll(/\bscope="(?:live|community)"/g)].length;
  assert.ok(mounts >= 2, "expected at least the Live-tab and Community-tab mounts");
  assert.equal(mounts, scoped, `${mounts} <TwitchPlayer> mount(s) but only ${scoped} pass a scope prop`);
});

test("the hint is cleared when the source changes", () => {
  // A stale `true` from Twitch must not tint the rail after the viewer has
  // moved to YouTube, nor after switching between the Live and Community
  // mounts (that half is `scope`'s job, pinned above).
  assert.match(
    view(),
    /playerLiveHint\??\.(?:scope|source)\s*===|setPlayerLiveHint\(\s*null\s*\)/,
    "nothing resets the hint — it will outlive the source that produced it",
  );
});

test("VACUITY ANCHOR: StreamView.tsx was read to the END", () => {
  // The file's last statement is the lazily-loaded guest support bundle
  // (`const GuestSupportContent = dynamic(...)`), declared after the default
  // export's closing brace — not the component body itself, so the anchor is
  // the trailing `});` of that call, not a bare `}`.
  assert.match(readFileSync(viewPath, "utf8").trimEnd().slice(-30), /\}\)\s*;\s*$/);
});
