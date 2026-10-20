// Guards for the Matrix panel refresh path.
//
// Two separate defects, one blast radius: the community panels re-rendering far
// more than they need to.
//
// Room filter — MatrixEventEvent.Decrypted is a CLIENT-wide event, so a panel
// registering its room-scoped `refresh` on it directly re-runs its full
// aggregation pass on every late decrypt anywhere — and the Community Hub
// auto-joins the whole space tree, so a member sits in dozens of rooms.
//
// Stable callbacks — `rowPropsEqual` compares `onEdit` first-class. A
// handleEdit memoised on `[edits]`, where `aggregateEdits` allocates a fresh
// Map on every refresh(), churns on every timeline event and fails the memo
// for every row: one incoming message re-renders the entire 200-row window,
// each row re-running its thread scan.
//
// These are static guards because the defect is a *dependency array*, not a
// behaviour: it cannot be observed without a full React render harness, but it
// is trivially visible in the source, and it regresses the instant someone
// "helpfully" adds edits back to the dep list to silence the lint rule.
//
// Run: node --test app/lib/matrixRoomEvents.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const COMMUNITY = join(process.cwd(), "app", "features", "community");
const PANELS = ["Timeline.tsx", "ThreadPanel.tsx", "ThreadsListPanel.tsx", "ForumView.tsx"];

function src(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

// ── The client-wide listener must be room-filtered ───────────────────────────

test("the shared helper filters Decrypted by room id", () => {
  const s = src(join(process.cwd(), "app", "lib", "matrixRoomEvents.ts"));
  assert.match(s, /ev\.getRoomId\(\) === room\.roomId/,
    "the room guard is gone — every panel would refresh on decrypts in unrelated rooms again");
  assert.match(s, /client\?\.on\(MatrixEventEvent\.Decrypted, onDecrypted\)/,
    "the guarded handler is no longer the one registered");
});

for (const p of PANELS) {
  test(`${p} subscribes through the helper, not a hand-rolled listener`, () => {
    const s = src(join(COMMUNITY, p));
    assert.match(s, /subscribeRoomRefresh\(room, client, refresh/,
      "this panel no longer goes through the shared subscription");
    assert.doesNotMatch(s, /MatrixEventEvent\.Decrypted/,
      "a raw client-wide Decrypted listener is back — it would fire for every joined room");
  });
}

test("Timeline and ForumView keep the Members listener; the thread panels do not", () => {
  // ForumView renders sender display names, so membership changes must repaint
  // it. The thread panels don't, and subscribing would be pure overhead.
  for (const p of ["Timeline.tsx", "ForumView.tsx"]) {
    assert.match(src(join(COMMUNITY, p)), /\{ members: true \}/, `${p} lost its Members subscription`);
  }
  for (const p of ["ThreadPanel.tsx", "ThreadsListPanel.tsx"]) {
    assert.doesNotMatch(src(join(COMMUNITY, p)), /\{ members: true \}/,
      `${p} subscribed to Members — it does not render membership-derived content`);
  }
});

// ── Row callbacks must be referentially stable ───────────────────────────────

/** The dep array of the useCallback whose body starts at `from`. */
function depsOf(s: string, from: number): string {
  const end = s.indexOf("}, [", from);
  assert.ok(end > from, "could not find the useCallback dep array — re-scope this guard");
  return s.slice(end + 3, s.indexOf("]", end) + 1);
}

// handleEdit/handleMention live in useMatrixEditComposer, so the stability
// invariant is pinned ONCE, on the hook, plus a per-panel pin that they
// actually consume it (a panel pasting its own copy back in is the regression
// these exist to catch).
test("useMatrixEditComposer callbacks are identity-stable ([] deps, ref reads)", () => {
  const s = src(join(COMMUNITY, "useMatrixEditComposer.ts"));
  for (const name of ["handleEdit", "cancelEdit", "stopEditing", "handleMention", "peekMentions", "clearMentions", "sendEdit"]) {
    const at = s.indexOf(`const ${name} = useCallback(`);
    assert.ok(at > 0, `${name} is no longer a useCallback — its identity churns every render`);
    assert.equal(depsOf(s, at), "[]",
      `${name} took a dependency; aggregateEdits reallocates every refresh, so any dep on ` +
      "mutable state re-creates the row callbacks per event and defeats the MatrixMessageRow memo");
  }
  assert.match(s, /live\.current\.edits\.get\(id\)/,
    "handleEdit no longer reads edits through the live ref, so it must be closing over stale state");
});

for (const p of ["Timeline.tsx", "ThreadPanel.tsx"]) {
  test(`${p} takes its edit/mention callbacks from the shared hook`, () => {
    const s = src(join(COMMUNITY, p));
    assert.match(s, /\{ editing, handleEdit, cancelEdit, stopEditing, handleMention, peekMentions, clearMentions, sendEdit \} = useMatrixEditComposer\(/,
      "this panel no longer destructures the shared edit composer");
    assert.doesNotMatch(s, /const handleEdit = useCallback\(/,
      "handleEdit was pasted back in beside the hook — the copies can drift again");
    assert.doesNotMatch(s, /const handleMention = useCallback\(/,
      "handleMention was pasted back in beside the hook");
  });
}

test("ThreadPanel's onVote is stable across renders", () => {
  const s = src(join(COMMUNITY, "ThreadPanel.tsx"));
  assert.match(s, /const voteCb = useCallback\(/,
    "onVote is an inline arrow again — it defeats the memo for every forum row");
  assert.match(s, /const onVote = isForum \? voteCb : undefined/,
    "the isForum gate no longer selects the memoized callback");
});

test("rowPropsEqual still compares onEdit — the guard above is only load-bearing if it does", () => {
  const s = src(join(process.cwd(), "app", "components", "MatrixMessageRow.tsx"));
  assert.match(s, /a\.onEdit !== b\.onEdit/,
    "if the comparator stops checking onEdit these stability guards are pointless — re-scope them");
});
