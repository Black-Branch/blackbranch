// Guards for the shared broadcast WebSocket. One connection per page,
// ref-counted, fanned out — otherwise a live mobile viewer holds THREE
// sockets to the same endpoint, each parsing every frame.
//
// Run: node --test app/lib/wsSocketShare.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const APP = join(process.cwd(), "app");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
  }
}

test("exactly three files construct a WebSocket: the shared client hook, the server-side eventsub and the rig page", () => {
  // The whole point of the shared connection is that no OTHER client code
  // opens its own socket to the BROADCAST feed. automodEventSub.ts is server-side
  // (started from instrumentation.ts) and out of scope. RigOverlay.tsx opens a
  // different socket — /rig, keyed, two-way, one per OBS browser source — and
  // never the broadcast feed.
  const files: string[] = [];
  for (const p of walk(APP)) {
    if (stripComments(readFileSync(p, "utf8")).includes("new WebSocket(")) files.push(p.slice(APP.length + 1));
  }
  assert.deepEqual(files.sort(), ["components/RigOverlay.tsx", "lib/automodEventSub.ts", "lib/useChatSocket.ts"],
    "a new WebSocket() constructor appeared outside useChatSocket — client code " +
    "must subscribe to the shared connection, not open its own socket");
});

// `SponsorClockBadge` (a leaf mounted PER CHAT ROW, up to MAX_SCROLLBACK
// concurrent rows) must not call `useSponsorState()` — a `useChatSocket` subscriber — directly, so every
// mounted row opened its own subscription to the shared socket's fan-out,
// each receiving EVERY frame type. Fixed by hoisting the ONE subscription
// into `SponsorClockProvider` (SponsorClockContext.tsx, mirrors
// BadgesContext.tsx, mounted once in layout.tsx); `SponsorClockBadge` now
// reads via `useSponsorClock()` (React context), never `useChatSocket`
// itself. Pinned the same way the WebSocket-construction test above already
// pins its own invariant: enumerate every DIRECT `useChatSocket(` caller by
// name, so a future per-row (or per-anything-repeated) subscriber is a named
// diff in this list, not a silent fan-out regression.
test("useChatSocket is called directly only by page-scoped hooks — never by a per-row component", () => {
  const callers: string[] = [];
  for (const p of walk(APP)) {
    if (/\buseChatSocket\(/.test(stripComments(readFileSync(p, "utf8")))) {
      callers.push(p.slice(APP.length + 1));
    }
  }
  // Vacuity anchors — this assertion is otherwise NEGATIVE ("no per-row
  // caller"), and a negative assertion goes green over a broken/empty scan
  // (feedback: "a truncated scan is vacuous only if the assertion is
  // negative"). Prove the scan actually walked real files and found the one
  // caller that must always be there (the hook's own definition, which
  // matches the same `useChatSocket(` substring in its signature).
  assert.ok(callers.length > 0, "vacuity anchor: the scan found NO useChatSocket callers at all — broken scan");
  assert.ok(callers.includes("lib/useChatSocket.ts"),
    "vacuity anchor: useChatSocket's own definition is missing from the scan");

  assert.deepEqual(
    callers.sort(),
    [
      "features/chat/ChatOverlay.tsx",
      // One mounted section (the mod panel's place, or its pop-out); its frames feed "Follow new
      // messages" only while that switch is on.
      "features/moderation/sections/ChatHistorySection.tsx",
      "lib/useChatMessages.ts",
      "lib/useChatSocket.ts", // the definition itself, not a call site
      "lib/useSponsorState.ts", // called ONLY from SponsorClockContext.tsx
      "lib/useStreamTimer.ts",
      "lib/useUserLiveMessages.ts",
    ],
    "a new (or moved) direct useChatSocket() caller appeared — if it is a " +
    "component mounted more than once (a per-row leaf, a list item, …), hoist " +
    "the subscription into a Provider (SponsorClockContext.tsx is the " +
    "reference shape) instead of subscribing per mount"
  );
  assert.ok(!callers.includes("components/SponsorClockBadge.tsx"),
    "SponsorClockBadge opened its own useChatSocket subscription again — read " +
    "the pool via useSponsorClock() (SponsorClockContext) instead");
});

// The test above pins direct `useChatSocket(`
// callers, but the real bug shape was `SponsorClockBadge` calling the
// WRAPPER hook `useSponsorState()` directly — a call that never contains the
// substring `useChatSocket(` at all (that literal only appears inside
// `useSponsorState.ts` itself). The test above catches a raw
// `useChatSocket(() => {})` call in `SponsorClockBadge.tsx`, but it would
// NOT catch the real bug shape (`useSponsorState()` re-added to the badge),
// because that call site has no `useChatSocket(` substring for the other scan
// to find. Same mechanism, same house pattern, applied to the wrapper hook
// specifically: enumerate every direct `useSponsorState(` caller by name.
test("useSponsorState is called directly only by SponsorClockContext — never by SponsorClockBadge or any other consumer", () => {
  const callers: string[] = [];
  for (const p of walk(APP)) {
    if (/\buseSponsorState\(/.test(stripComments(readFileSync(p, "utf8")))) {
      callers.push(p.slice(APP.length + 1));
    }
  }
  // Vacuity anchors, same reasoning as the useChatSocket scan above: this
  // assertion is otherwise NEGATIVE, and a negative assertion goes green over
  // a broken/empty scan.
  assert.ok(callers.length > 0, "vacuity anchor: the scan found NO useSponsorState callers at all — broken scan");
  assert.ok(callers.includes("lib/useSponsorState.ts"),
    "vacuity anchor: useSponsorState's own definition is missing from the scan");

  assert.deepEqual(
    callers.sort(),
    [
      "lib/SponsorClockContext.tsx", // the Provider — the ONE legitimate caller
      "lib/useSponsorState.ts",      // the definition itself, not a call site
    ],
    "a new (or moved) direct useSponsorState() caller appeared — every consumer " +
    "of the sponsor pool other than SponsorClockContext.tsx must read it via " +
    "useSponsorClock() (React context), never call the wrapper hook itself"
  );
  assert.ok(!callers.includes("components/SponsorClockBadge.tsx"),
    "SponsorClockBadge called useSponsorState() directly again — this IS the " +
    "literal round-1 bug (a fresh useChatSocket subscriber per chat row); read " +
    "the pool via useSponsorClock() (SponsorClockContext) instead"
  );
});

test("the shared connection keeps its documented semantics", () => {
  const src = stripComments(readFileSync(join(APP, "lib", "useChatSocket.ts"), "utf8"));
  assert.match(src, /if \(c\.open\) sub\.onOpen\?\.\(\);/,
    "the synthetic onOpen for late subscribers is gone — a consumer mounting " +
    "after connect (a gated `live &&` subscriber, e.g.) would never see connected=true");
  assert.match(src, /if \(c\.subs\.size === 0 && conn === c\) \{\n\s*conn = null;/,
    "last-unsubscriber teardown lost its conn-clear-first ordering — onclose " +
    "would schedule a reconnect for a connection nobody holds");
  assert.match(src, /for \(const s of Array\.from\(c\.subs\)\) \{\n\s*try \{\n\s*s\.onEvent\(data\);\n\s*\} catch \{\}/,
    "per-subscriber try/catch around fan-out is gone — one throwing handler " +
    "starves every other consumer of the frame");
});
