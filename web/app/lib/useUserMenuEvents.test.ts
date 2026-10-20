// The user-menu event hub's ONE-HOST law: narrow layouts mount more than one
// UserMenu, and if every mounted hub answered every open event, "Your profile"
// would open TWO stacked Account cards. The rule has two halves, and each is
// worthless without the other:
//   1. every open handler stands down when a sibling already claimed
//      (e.defaultPrevented), so exactly one hub opens a surface;
//   2. every dispatcher of a hub-claimed open event sends a CANCELABLE event
//      (dispatchClaimable) — preventDefault on a non-cancelable event is a
//      silent no-op, so a bare `new CustomEvent(...)` re-opens the bug.
// The render tests pin half 1; the source scan pins half 2.
//
// Run: node --test app/lib/useUserMenuEvents.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dom, React, act } from "./testDom.ts";

// claimableEvent constructs `new CustomEvent(...)` through the bare global;
// under node --test that resolves to NODE's own CustomEvent, which jsdom's
// window.dispatchEvent rejects as a foreign realm's Event. Point the global
// at jsdom's constructor so the dispatch path is the one the browser runs.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = dom.window.CustomEvent;

const { useUserMenuEvents } = await import("./useUserMenuEvents.ts");
const { dispatchClaimable } = await import("./claimableEvent.ts");
const { createRoot } = await import("react-dom/client");

function Hub({ log, name }: { log: string[]; name: string }) {
  useUserMenuEvents({
    onProfileCard: () => log.push(`${name}:profile`),
    onAccountSettings: () => log.push(`${name}:settings`),
    onSupport: (d) => log.push(`${name}:support:${d?.giftUsername ?? ""}`),
    onProfileSynced: () => log.push(`${name}:synced`),
  });
  return null;
}

function mountHubs(log: string[]) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      React.createElement(React.Fragment, null,
        React.createElement(Hub, { log, name: "a", key: "a" }),
        React.createElement(Hub, { log, name: "b", key: "b" }),
      ),
    ),
  );
  return { unmount: () => act(() => root.unmount()) };
}

test("two mounted hubs, ONE answers an open — and the dispatcher still sees it claimed", () => {
  const log: string[] = [];
  const { unmount } = mountHubs(log);
  let claimed = false;
  act(() => { claimed = dispatchClaimable("bb:open-profile-card"); });
  assert.deepEqual(log, ["a:profile"], "exactly one Account card host answers (two = the stacked-cards bug)");
  assert.equal(claimed, true, "the dispatcher's fallback must still stay closed");
  log.length = 0;
  act(() => { dispatchClaimable("bb:open-account-settings"); });
  assert.deepEqual(log, ["a:settings"], "the settings jump is one-host too");
  log.length = 0;
  act(() => { dispatchClaimable("bb:open-support", { giftUsername: "@k:site.test" }); });
  assert.deepEqual(log, ["a:support:@k:site.test"], "support opens once, detail intact");
  unmount();
});

test("broadcasts still reach EVERY hub — claiming those would break the others' refresh", () => {
  const log: string[] = [];
  const { unmount } = mountHubs(log);
  act(() => { dom.window.dispatchEvent(new dom.window.Event("bb:profile-synced")); });
  assert.deepEqual(log.sort(), ["a:synced", "b:synced"]);
  unmount();
});

test("with NO hub mounted, the dispatch reports unclaimed — the dispatcher's fallback contract survives the guard", () => {
  let claimed = true;
  act(() => { claimed = dispatchClaimable("bb:open-profile-card"); });
  assert.equal(claimed, false);
});

// ── half 2: every dispatcher of a hub-claimed open event is cancelable ───────
// A bare `new CustomEvent("bb:open-support")` compiles, runs, and quietly
// re-opens the double-card bug for its event. Scan the app tree: the hub's
// claimed names may only be dispatched via dispatchClaimable. (open-points-wallet
// et al. — events the hub does not claim — are out of scope on purpose.)
const HUB_CLAIMED = [
  "bb:open-support", "bb:open-store", "bb:open-modpanel",
  "bb:open-profile-card", "bb:open-account-settings",
  "bb:open-linked-accounts", "bb:open-chat-appearance",
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      yield p;
    }
  }
}

test("no hub-claimed open event is dispatched as a bare (non-cancelable) event anywhere in app/", () => {
  const APP = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  let dispatchers = 0;
  let filesScanned = 0;
  for (const file of walk(APP)) {
    filesScanned++;
    const src = readFileSync(file, "utf8");
    for (const name of HUB_CLAIMED) {
      if (!src.includes(`"${name}"`)) continue;
      if (src.includes(`dispatchClaimable("${name}"`)) dispatchers++;
      // Any construction of an Event/CustomEvent with a claimed name is the
      // bug shape, wherever the dispatch happens.
      if (new RegExp(`new (Custom)?Event\\(\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(src)) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "bare dispatch of a hub-claimed event — the one-host guard cannot see it");
  // Vacuity anchors: the scan walked a real tree and saw the real dispatchers.
  assert.ok(filesScanned > 300, `scanned ${filesScanned} files — a broken walk would pass the empty check above`);
  assert.ok(dispatchers >= 6, `saw ${dispatchers} dispatchClaimable call sites — fewer means the scan lost the tree it audits`);
});
