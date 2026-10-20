// Round-3 items 8 + 12: the signed-out money funnel stops dead-ending, and
// mod delete grows the same two-step confirm everywhere.
//
// Run: node --test app/lib/funnelRound3.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { dom } from "./testDom.ts"; // installs window/document for claimableEvent
// Node's own global CustomEvent is a different realm from jsdom's EventTarget —
// dispatchEvent rejects it. The product code runs in ONE realm (a browser);
// the test must too.
Object.defineProperty(globalThis, "CustomEvent", { value: dom.window.CustomEvent, configurable: true });
const { dispatchClaimable, claimEvent } = await import("./claimableEvent.ts");

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("8: the claimable handshake distinguishes hosted from unhosted dispatch", () => {
  // The lived bug: the signed-out Qorm pill dispatched bb:open-store to
  // NOBODY (the only listener lives in UserMenu, which needs a matrixId) —
  // a dead click on a money surface. The handshake tells the dispatcher no
  // host is mounted so it can fall back to sign-in.
  assert.equal(dispatchClaimable("bb:open-store", { tab: "topup" }), false,
    "an unhosted open-store reported itself claimed");
  const onStore = (e: Event) => claimEvent(e);
  window.addEventListener("bb:open-store", onStore);
  assert.equal(dispatchClaimable("bb:open-store", { tab: "topup" }), true,
    "a mounted store host did not claim the event — the dispatcher would double-handle with sign-in");
  window.removeEventListener("bb:open-store", onStore);
});

test("8: the hub claims open-store only when it can actually host it", () => {
  // UserMenu mounts even signed out (hooks run; it returns null before the
  // JSX) — so an UNCONDITIONAL claim would swallow the pill's dispatch and
  // then render nothing: the same dead click, now with the fallback disarmed.
  // The hub must claim like onModPanel does — only when a handler is present —
  // and UserMenu must withhold the handler without a matrixId.
  const hub = read("./useUserMenuEvents.ts");
  const onStoreAt = hub.indexOf("const onStore = (e: Event)");
  assert.notEqual(onStoreAt, -1, "vacuity anchor: the onStore listener is gone");
  const handler = hub.slice(onStoreAt, hub.indexOf("};", onStoreAt));
  // The guard also stands down when a SIBLING hub already
  // claimed (e.defaultPrevented — the one-host law, useUserMenuEvents.test.ts);
  // the half this test owns: no handler → no claim.
  assert.match(handler, /if \(e\.defaultPrevented \|\| !ref\.current\.onStore\) return;/,
    "onStore claims even with no handler mounted");
  assert.match(handler, /claimEvent\(e\)/, "onStore never claims — the pill's fallback double-fires");
  const menu = read("../components/UserMenu.tsx");
  assert.match(menu, /onStore: matrixId\s*\?/,
    "UserMenu passes onStore without an identity — a signed-out mount claims and renders nothing");
});

test("8: the Qorm pill falls back to sign-in when nothing hosts the store", () => {
  const src = read("../components/StreamMetaBar.tsx");
  assert.match(src, /dispatchClaimable\("bb:open-store"/,
    "the pill still fires a blind CustomEvent — signed out, that click does nothing at all");
  const at = src.indexOf('dispatchClaimable("bb:open-store"');
  assert.match(src.slice(Math.max(0, at - 300), at + 300), /auth\/signin/,
    "no sign-in fallback — the unclaimed dispatch is still a dead click");
});

test("8: a signed-out donation opens the guest flow, not the sign-in wall", () => {
  // /api/billing/donate supports guests (matrix_id nullable, v-era design) —
  // the ONLY thing refusing guest money was this client branch.
  const src = read("../components/StreamView.tsx");
  const fnAt = src.indexOf("function openSupport(");
  assert.notEqual(fnAt, -1, "vacuity anchor: openSupport is gone from StreamView");
  const fn = src.slice(fnAt, src.indexOf("\n  }", fnAt));
  assert.match(fn, /section === "donation"/,
    "openSupport does not branch on donation — guests still hit the sign-in wall with money in hand");
  assert.match(src, /sections=\{\["donation"\]\}/,
    "no guest donation surface renders — the branch has nowhere to go");
});

test("8: a signed-out subscribe keeps its intent across sign-in", () => {
  // The redirect used to drop WHY the user was signing in — they came back to
  // the home page and had to find the button again.
  const view = read("../components/StreamView.tsx");
  assert.match(view, /sessionStorage\.setItem\("bb_pending-support", section\)/,
    "the sign-in redirect drops the support intent");
  const menu = read("../components/UserMenu.tsx");
  assert.match(menu, /sessionStorage\.getItem\("bb_pending-support"\)/,
    "nothing consumes the pending intent after sign-in — it is stored and forgotten");
  assert.match(menu, /sessionStorage\.removeItem\("bb_pending-support"\)/,
    "the intent is consumed but never cleared — the card would re-open on every future visit");
});

test("8: About and Privacy are reachable signed out, from the CTA row that is always visible", () => {
  // Google OAuth verification wants the privacy policy reachable without
  // signing in. The signed-out chat CTA row is the load-bearing copy of those
  // links (a meta-line copy would be collapsed and `inert` by default), so it
  // is pinned HERE.
  const src = read("../features/chat/ChatSidebar.tsx");
  const at = src.indexOf('href="/auth/signin"');
  assert.notEqual(at, -1, "vacuity anchor: the signed-out sign-in CTA is gone");
  const row = src.slice(at, at + 600);
  assert.match(row, /href="\/about"/, "About left the one row a signed-out visitor always sees");
  assert.match(row, /href="\/legal#privacy"/, "Privacy left the one row a signed-out visitor always sees");
});

test("About and Terms & Privacy live in the account card now that the meta line does not carry them", () => {
  // About/Privacy live on ChatSidebar's signed-out row (pinned above) and in
  // the profile menu — the account card, ProfileCardBody, whose footer carries
  // two links.
  const src = stripComments(readFileSync(new URL("../components/ProfileCardBody.tsx", import.meta.url), "utf8"));
  assert.match(src, /href="\/about"/, "About is missing from the account card footer");
  assert.match(src, /href="\/legal"/, "Terms & Privacy is missing from the account card footer");
  // Vacuity anchor pinned to the file's real tail (verified against the file
  // itself) — not the weaker `/\}\s*$/`, which would pass over a hollowed-out
  // component just as easily as a real one.
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor: ProfileCardBody's closing JSX shape changed");
});

test("12: native mod delete is two-step where it lives — the ⋯ menu, whose label changes", () => {
  // The two-step delete lives in the ⋯ menu only: an arm that speaks only
  // through title=/aria-label is invisible on a phone (the first tap would
  // arm invisibly and the delete would seem not to work), so the ⋯ menu is
  // the one native delete surface, and its arm changes the VISIBLE label.
  const menu = read("../components/MessageContextMenu.tsx");
  assert.match(menu, /confirmDelete/, "MessageContextMenu deletes on one tap");
  assert.match(menu, /Confirm delete\?/, "the armed state never changes the label — the second tap is uninformed");
  const msg = read("../features/chat/ChatMessage.tsx");
  assert.doesNotMatch(msg, /confirmDelete/,
    "a delete arm is back on the action bar — its feedback channel (title=) is invisible on touch");
});
