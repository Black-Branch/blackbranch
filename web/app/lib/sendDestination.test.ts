import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLATFORM_COLORS } from "./platformColors.ts";
import { ROUTABLE_PLATFORMS, isRoutablePlatform } from "./platforms.ts";
import { defaultDest, shouldPrune, ENCRYPTED_DEST, SUPPORT_DEST, composerAccent } from "./sendDestination.ts";
import { stripComments } from "./testSource.ts";

test("no linked platforms → native", () => assert.equal(defaultDest([null]), null));
// The hook's cycle includes "all" from ONE linked platform, so this shape can
// only reach defaultDest from an older/partial cycle — the contract (last entry
// wins) is what's pinned here.
test("one linked platform, no all in cycle → that platform", () =>
  assert.equal(defaultDest([null, "twitch"]), "twitch"));
test("any linked + all in cycle → all", () => {
  assert.equal(defaultDest([null, "twitch", "kick", "all"]), "all");
  // The 1-linked case: the default IS the fan-out.
  assert.equal(defaultDest([null, "twitch", "all"]), "all");
});

test("the cycle offers 'all' from ONE linked platform", () => {
  // The hook can't be rendered under node --test, so pin the condition at the
  // source, like the 🔒-ordering test below.
  const src = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "useSendDestination.ts"), "utf8"));
  assert.match(src, /if \(linkedDests\.length >= 1\) c\.push\("all"\)/,
    "'all' is gated away from single-platform users again — it is offered at one link");
});

test("a single-target fan-out still tints the native line", () => {
  // "all" with one linked platform fans out to one target. stream-api only
  // stores destPlatforms at ≥2 entries, so without an explicit destPlatform the
  // native line would render bare — strictly worse than forcing the platform.
  const route = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../api/chat/send/route.ts"), "utf8"));
  const fanout = route.slice(route.indexOf('forced_destination === "all"'));
  assert.ok(fanout.length > 100, "the all fan-out branch is gone from the send route");
  assert.match(fanout, /targets\.length === 1 \? \{ destPlatform: targets\[0\] \}/,
    "a one-target all-send no longer passes destPlatform — the native line loses its tint");
});
test("prune only when fetch succeeded and value missing", () => {
  assert.equal(shouldPrune("all", [null, "twitch"], true), true);
  assert.equal(shouldPrune("all", [null, "twitch"], false), false); // failed fetch NEVER prunes
  assert.equal(shouldPrune("twitch", [null, "twitch"], true), false);
});

test("the encrypted choice survives a load where the subscription is not yet known", () => {
  // Same failure as the deploy-window reset, via a DIFFERENT fetch. The 🔒
  // entry only joins the cycle once /api/me lands, but the prune fires off the
  // linked-accounts fetch — so in the window between them the cycle genuinely
  // lacks 🔒, and a naive prune drops a Supporter's stored choice on every
  // single page load.
  assert.equal(shouldPrune(ENCRYPTED_DEST, [null, "twitch"], true, false), false);
  // Once the answer IS known and the viewer is not a Supporter, it prunes.
  assert.equal(shouldPrune(ENCRYPTED_DEST, [null, "twitch"], true, true), true);
  // And it stays when the cycle offers it.
  assert.equal(shouldPrune(ENCRYPTED_DEST, [null, ENCRYPTED_DEST, "twitch"], true, true), false);
  // The guard is scoped to the sentinel — an unknown subscription must not
  // freeze pruning of an unlinked PLATFORM, which is a different question.
  assert.equal(shouldPrune("all", [null, "twitch"], true, false), true);
});

test("defaultDest never lands on a sentinel — it filters them itself", () => {
  // defaultDest returns the LAST real entry. Since cycle 7 the filtering lives
  // INSIDE the helper rather than at each call site: the support sentinel is in
  // EVERY main-app cycle, so a no-links user's cycle is [null, "support"] and
  // any unfiltered caller would arm support mode as that user's default —
  // Gadget's panel opening on every fresh load. Internal filtering makes new
  // call sites safe by construction instead of by discipline.
  assert.equal(defaultDest([null, ENCRYPTED_DEST]), null, "no-links Supporter → native");
  assert.equal(defaultDest([null, SUPPORT_DEST]), null, "no-links non-Supporter → native");
  assert.equal(defaultDest([null, ENCRYPTED_DEST, SUPPORT_DEST]), null);
  assert.equal(defaultDest([null, ENCRYPTED_DEST, "twitch"]), "twitch");
  assert.equal(defaultDest([null, SUPPORT_DEST, "twitch", "all"]), "all");
  assert.equal(defaultDest([null, ENCRYPTED_DEST, "twitch", "kick", "all"]), "all");
});

test("a stored support sentinel is prunable noise, not a destination", () => {
  // Parallels the stored-🔒 rule: the hook never honours it on restore (see the
  // init-guard test below), and shouldPrune treats it like any absent value —
  // no encryptKnown-style grace window, because support has no async gate: when
  // it is enabled at all, it is in the cycle from the first render.
  assert.equal(shouldPrune(SUPPORT_DEST, [null, "twitch"], true), true);
});

test("the sentinel filter lives INSIDE defaultDest — call sites get it for free", () => {
  // The filter lives in defaultDest itself, not at each call site — a
  // discipline every caller would have to re-remember, and with a sentinel in
  // EVERY main-app cycle and more than one caller (leaveSupport), one forgotten
  // filter would arm support as someone's default. This pins that it stays
  // there.
  const src = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sendDestination.ts"), "utf8"));
  const fn = src.slice(src.indexOf("export function defaultDest"), src.indexOf("export function shouldPrune"));
  const filterIdx = fn.indexOf(".filter");
  const encIdx = fn.indexOf("ENCRYPTED_DEST");
  const supIdx = fn.indexOf("SUPPORT_DEST");
  assert.ok(filterIdx !== -1, "defaultDest no longer filters at all");
  assert.ok(encIdx > filterIdx, "defaultDest's filter lost the encrypted sentinel");
  assert.ok(supIdx > filterIdx, "defaultDest's filter lost the support sentinel");
  // …and the hook's fallback path still derives from it (the raw cycle is
  // safe to pass — that is the point). The fallback lives once, in
  // restoreDisplaced, which both sentinel restores delegate to.
  const hook = stripComments(hookSrc());
  const restore = hook.slice(hook.indexOf("const restoreDisplaced"), hook.indexOf("const leaveSupport"));
  assert.ok(restore.indexOf("defaultDest(") !== -1, "restoreDisplaced no longer derives the default");
});

test("the destination cycle holds only places — neither 🔒 nor Gadget", () => {
  // Pinned at the source, since the cycle is built inside a hook.
  const src = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "useSendDestination.ts"),
    "utf8"
  ));
  const cycle = src.slice(src.indexOf("const destCycle"), src.indexOf("}, [linkedDests])"));
  assert.ok(cycle.includes("...linkedDests") && cycle.includes('"all"'), "vacuity: the cycle body was found");
  const encIdx = cycle.indexOf("ENCRYPTED_DEST");
  const supIdx = cycle.indexOf("SUPPORT_DEST");
  // 🔒 is not in the cycle: it is armed from the tools popover or `/r`, so
  // tapping through to a platform never lands on a mode that hides the
  // message. It must still be a legitimate state for the PRUNE, or an armed 🔒
  // would be disarmed by the next account-links fetch.
  assert.equal(encIdx, -1, "🔒 is back in the send-to cycle");
  assert.match(src, /canEncrypt \? \[\.\.\.destCycle, ENCRYPTED_DEST\] : destCycle/,
    "the prune must still accept an armed 🔒 for a Supporter");
  assert.equal((src.match(/shouldPrune\([a-zA-Z]+, offered,/g) ?? []).length, 2,
    "both prunes (live + stored) must judge against `offered`, not the bare cycle");
  //
  // THE SUPPORT BOT IS NOT IN THE CYCLE. Not "is placed carefully in it" —
  // absent. As a cycle entry it could only be reached by stepping THROUGH it, so
  // every user changing destination would pass through a support conversation,
  // and living in `forcedDest` would mean capturing/displacing/restoring it
  // around every real destination. It is `supportArmed`. If this assertion
  // fails, someone has put a mode back into the destination cycle.
  assert.equal(supIdx, -1,
    "SUPPORT_DEST is back in the destination cycle — Gadget is a mode, not a place");
});

// The persist effect isn't unit-testable without a React renderer, so pin the
// invariant at the source: the one-time DEFAULT must never be written to
// localStorage as if the user chose it. If it were, a 1-linked-platform user
// would get that platform persisted and the "all" default would never apply
// after they linked a second (the default effect is gated on the key == null).
//
// The guard is "the recorded choice still MATCHES the live destination", not
// "a choice was made at some point". A boolean cannot tell a PRUNE from a
// decision: the render-phase prune moves `forcedDest` without touching the
// flag, so the persist effect would fire on the forcedDest→null transition and
// write "native" over a platform the user had actually picked — which then
// blocks the "all" default forever. Comparing values makes a prune
// structurally unable to masquerade as a choice.
test("the send-to default is never persisted — only explicit user choices", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "useSendDestination.ts"),
    "utf8"
  );
  const persist = stripComments(src.slice(src.indexOf("Persist the chosen target")));
  const guardIdx = persist.indexOf("if (chosenDest.current !== forcedDest) return");
  assert.ok(
    persist.indexOf("if (chosenDest.current === undefined) return") !== -1,
    "the persist effect no longer refuses to write when nothing was ever chosen"
  );
  // Anchored on the KEY, not on the write helper (the destination lives in
  // window-scoped storage, `wsSet`) — the invariant is "the guard precedes any
  // write of this key", which has nothing to do with which helper performs it.
  // The `!== -1` assertion below is what makes a moved anchor a loud failure
  // instead of a vacuous pass; keep it.
  const writeIdx = persist.indexOf('"chatTargetDest"');
  assert.ok(guardIdx !== -1,
    "persist effect must early-return unless the recorded choice IS the live destination");
  assert.ok(
    writeIdx !== -1 && writeIdx > guardIdx,
    "the choice-matches-destination guard must precede any chatTargetDest write"
  );
});

// ── 🔒 must never be PERSISTED ───────────────────────────────────────────────
//
// Otherwise the default chat mode becomes the redacted input. Arming 🔒 is an
// explicit choice, so writing it to storage the INSTANT it is armed — while
// the disarm only runs after a SUCCESSFUL send — means every arm that does not
// end in a successful send sticks forever and re-arms the composer on every
// later load. Two ordinary ways in: arm it and change your mind, or arm it and
// have the send refused by the cooldown (which deliberately leaves it armed so
// the draft can be retried).

const hookSrc = () => readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "useSendDestination.ts"),
  "utf8"
);

/**
 * STRIP COMMENTS BEFORE MEASURING ORDER. Every assertion below asks "does X
 * appear before Y in the code", and this file is heavily commented — `wsPin`
 * appears in the prose explaining why `wsClear` must precede it, 450
 * characters before the call it describes, so an unstripped scan fails against
 * CORRECT code. A source scan that reads comments is measuring the
 * explanation, not the behaviour, and it fails in BOTH directions: it can also
 * pass on a comment that merely mentions the right identifier.
 *
 * Deliberately crude (no string/regex-literal awareness) — it only ever runs
 * over this one hook, which has no `//` inside a string.
 */
// Line-wise, NOT a bare `//` strip. A one-liner
// (`.replace(/\/\/[^\n]*/g, "")`) also eats the rest of any line containing a
// `//` inside a STRING — `"http://…"` becomes `"http:` — which corrupts exactly
// the kind of source these tests then measure positions in.
// (The suite-wide copies live in testSource.ts.)

test("the 🔒 sentinel is never written to storage", () => {
  const src = hookSrc();
  const persist = stripComments(src.slice(src.indexOf("Persist the chosen target")));
  const skipIdx = persist.indexOf(`if (forcedDest === ENCRYPTED_DEST) return`);
  const writeIdx = persist.indexOf('wsSet("chatTargetDest"');
  assert.ok(skipIdx !== -1, "the persist effect no longer skips the 🔒 sentinel");
  assert.ok(writeIdx !== -1, "anchor lost — the persist effect no longer writes the key");
  assert.ok(skipIdx < writeIdx, "the sentinel skip must come BEFORE any write, or it persists");
  // Support cannot reach this effect at all — it is not a destination — which
  // is a better answer than remembering to skip it.
  assert.equal(persist.indexOf("SUPPORT_DEST"), -1,
    "SUPPORT_DEST is back in the persist path — support state must not live in forcedDest");
});

test("a stored sentinel is never honoured on load, and is cleared", () => {
  const src = hookSrc();
  // (a) the initial state must not come up armed from a stale stored value…
  const init = stripComments(src.slice(src.indexOf("const [forcedDest"), src.indexOf("// ORDER MATTERS")));
  assert.match(init, /if \(stored === ENCRYPTED_DEST \|\| stored === SUPPORT_DEST\) return null/,
    "a stored sentinel would be restored as the armed destination");
  // …(b) and the stale key must be cleared, or the one-time default (gated on
  // the key being null) can never re-derive and the user is stranded native.
  const mount = stripComments(src.slice(src.indexOf("// ORDER MATTERS"), src.indexOf("const [linkedDests")));
  const clearIdx = mount.indexOf("wsClear");
  const pinIdx = mount.indexOf("wsPin");
  assert.ok(clearIdx !== -1, "the stale sentinel is never cleared from storage");
  assert.ok(pinIdx !== -1, "anchor lost — the mount effect no longer pins");
  // ORDER IS THE WHOLE POINT. wsPin seeds this window from localStorage, so
  // pinning first copies the sentinel into sessionStorage and the clear then
  // leaves it behind there — the bug survives its own fix, in one tier.
  assert.ok(clearIdx < pinIdx, "wsClear must run BEFORE wsPin or the sentinel is re-seeded");
});

test("resetting after an encrypted send restores what 🔒 displaced", () => {
  // A SECOND bug in the same three lines, found while fixing the first: reset
  // went straight to the computed default, so choosing Twitch, sealing one
  // message and sending it left the composer on "all" — and PERSISTED it,
  // because the reset counts as an explicit choice. Silently changing who
  // receives your next message is the same class of failure the window-scoping
  // fix exists to prevent, reached from a different direction.
  const src = hookSrc();
  // The restore contract lives in ONE shared function (restoreDisplaced) —
  // both sentinels delegate to it, so the contract is pinned there once and
  // the delegations are pinned separately below.
  const restore = stripComments(src.slice(src.indexOf("const restoreDisplaced"), src.indexOf("const leaveSupport")));
  // Anchored on the CALL, not on the identifier. Bare `prior` still appears in
  // `const prior = ref.current` after the whole restore branch is deleted — so
  // matching it would pass against code that had the bug back. Assert on the
  // thing that does the work.
  const restoreIdx = restore.search(/setForcedDest\(prior\.dest\)/);
  const defaultIdx = restore.indexOf("defaultDest(");
  assert.ok(restoreIdx !== -1, "restoreDisplaced no longer puts back the displaced destination");
  assert.ok(defaultIdx !== -1, "restoreDisplaced no longer has a fallback default at all");
  assert.ok(restoreIdx < defaultIdx,
    "the captured destination must be preferred OVER the computed default");
  // The early return is what makes it a preference rather than both running.
  assert.match(restore, /setForcedDest\(prior\.dest\);\s*return;/,
    "restoring must short-circuit, or the default overwrites it immediately after");
  assert.match(src, /const resetDest = \(\) => restoreDisplaced\(preEncrypt\)/,
    "resetDest must delegate to the shared restore — a hand-rolled copy can drift");
  // The capture itself has to exist, and has to keep its re-arm guard:
  // re-arming an already-armed 🔒 keeps the ORIGINAL captured value (prev),
  // never overwrites it with the sentinel itself. With one sentinel there is
  // no cross-sentinel detour to guard.
  const apply = stripComments(src.slice(src.indexOf("const applyDest"), src.indexOf("const restoreDisplaced")));
  // 🔒 is armed only by a direct jump, so what it displaces is exactly what is
  // held now.
  assert.match(apply,
    /preEncrypt\.current =\s*next === ENCRYPTED_DEST \? \(forcedDest === ENCRYPTED_DEST \? prev : realPrior\) : undefined/,
    "the encrypted capture lost its re-arm guard");
  assert.equal(apply.indexOf("SUPPORT_DEST"), -1,
    "applyDest handles SUPPORT_DEST again — support must not travel through the destination");
});

test("leaving Gadget cannot touch the destination at all", () => {
  // Leaving the support bot touches no destination state whatsoever: support
  // does not live in `forcedDest`, so leaving it puts nothing back — and every
  // restore is a chance to write the wrong one. There is nothing to get wrong.
  const src = hookSrc();
  const leave = stripComments(src.slice(src.indexOf("const leaveSupport"), src.indexOf("const setDest")));
  assert.ok(leave.length > 0 && leave.length < 400, "the slice between leaveSupport and setDest moved — update this scan");
  assert.match(leave, /const leaveSupport = \(\) => setSupportArmed\(false\)/,
    "leaveSupport is doing more than clearing its own boolean");
  for (const forbidden of ["setForcedDest", "restoreDisplaced", "chosenDest", "wsSet"]) {
    assert.equal(leave.indexOf(forbidden), -1,
      `leaveSupport touches ${forbidden} — closing a Gadget thread must not move the destination`);
  }
});

// ── an arm→leave round trip must leave ZERO trace ────────────────────────────
//
// The failure: "send to:" comes back as the site instead of "all" after a
// redacted send or after closing the support bubble. The chain: a LOAD-TIME
// support greeting arms the sentinel before the linked-accounts fetch has
// applied the "all" default, so it displaces `null`; closing restores that null
// AS AN EXPLICIT CHOICE, which persists "native" — and a stored "native" blocks
// the one-time "all" default on every later load. A restore is a return to the
// status quo, not a fresh choice.

test("arming a sentinel is not a user choice — the record moves only for real destinations", () => {
  const src = hookSrc();
  const apply = stripComments(src.slice(src.indexOf("const applyDest"), src.indexOf("const restoreDisplaced")));
  assert.match(apply,
    /if \(next !== ENCRYPTED_DEST\) chosenDest\.current = next/,
    "applyDest must not record arming 🔒 as choosing a destination");
  assert.doesNotMatch(apply, /^\s*chosenDest\.current = next;\s*$/m,
    "an unconditional choice write in applyDest persists a destination the user never chose");
  // What is CAPTURED as `chosen` must compare the record to the live value,
  // not merely test that some choice exists. If a prune has already moved
  // `forcedDest` out from under the record, the value being captured is the
  // PRUNED one — which nobody chose — and capturing it as chosen would let a
  // later restore persist it. Same predicate as the persist guard, deliberately.
  assert.match(apply, /chosen: chosenDest\.current === forcedDest/,
    "the capture records 'a choice exists' rather than 'THIS value was chosen'");
});

test("restoring from a sentinel restores the CHOICE along with the value", () => {
  // Restoring an un-chosen prior as if chosen is the persistence poison: the
  // persist effect then writes "native" for a user who never chose anything.
  const src = hookSrc();
  const fn = stripComments(src.slice(src.indexOf("const restoreDisplaced"), src.indexOf("// ── Gadget")));
  const flagIdx = fn.indexOf("chosenDest.current = prior.chosen ? prior.dest : undefined");
  const destIdx = fn.search(/setForcedDest\(prior\.dest\)/);
  assert.ok(flagIdx !== -1,
    "restoreDisplaced restores the value but not the recorded choice — and an un-chosen " +
    "prior must restore `undefined`, never the value, or the persist guard agrees with itself");
  assert.ok(destIdx !== -1, "restoreDisplaced lost its restore");
  assert.ok(flagIdx < destIdx,
    "the choice must be restored BEFORE the state write — the persist effect " +
    "fires on the state change and reads the record as it stands then");
  // The defensive fallback must not persist a computed default either.
  assert.match(fn, /chosenDest\.current = undefined;\s*setForcedDest\(defaultDest/,
    "the computed-default fallback must not be recorded as a choice");
});

test("the poisoned-storage amnesty runs once and only touches 'native'", () => {
  // Storage written during the bug era holds an explicit "native" nobody chose.
  // It is indistinguishable from a real choice, so it is cleared exactly ONCE
  // (latched) — a genuine native-chooser is one tap from native again, a
  // poisoned user gets their "all" fan-out back for good.
  const src = hookSrc();
  // Anchored past the imports (wsPin appears in the import list too) — same
  // landmark the stored-sentinel test uses to bound the mount effect.
  // The amnesty lives in `runNativeAmnesty(latch)` and the latch is a named
  // constant, because CLOSING THE WRITE PATH IS NOT THE WHOLE FIX: a profile
  // already carrying a poisoned "native" is only healed by a NEW latch, and an
  // old one is burned everywhere. Scan the helper, not the mount effect.
  const mount = stripComments(src.slice(src.indexOf("function runNativeAmnesty"), src.indexOf("export function useSendDestination")));
  assert.match(mount, /if \(!lsGet\(latch\)\)/, "the amnesty must be latched, not repeated");
  assert.match(mount, /lsSet\(latch, "1"\)/, "the latch must be written");
  assert.match(mount, /if \(wsGet\("chatTargetDest"\) === "native"\) wsClear\("chatTargetDest"\)/,
    "the amnesty must clear ONLY a stored native — a platform choice is untouched");
  // It must run before the pin, or the pin seeds the poisoned value into the
  // window tier where the clear can't reach it — same trap as the sentinel clear.
  // It must run before the pin, or the pin seeds the poisoned value into the
  // window tier where the clear cannot reach it — same trap as the sentinel clear.
  const effect = stripComments(src.slice(src.indexOf("// ORDER MATTERS"), src.indexOf("const [linkedDests")));
  assert.ok(effect.indexOf("runNativeAmnesty") < effect.indexOf("wsPin"),
    "the amnesty must precede wsPin");

  // The per-WINDOW half: the poison also lives in each window's
  // sessionStorage, and the device latch only cures the first window to run it
  // — a second long-lived poisoned tab would keep its own "native" forever.
  // Each window must heal its session tier once…
  assert.match(mount, /if \(!ssGet\(latch\)\)/,
    "the per-window amnesty half is gone — a second poisoned tab is never cleaned");
  // …but ONLY when localStorage does not also say native: both tiers agreeing
  // is a post-fix explicit choice (wsSet writes both), which must survive.
  assert.match(mount,
    /ssGet\("chatTargetDest"\) === "native" && lsGet\("chatTargetDest"\) !== "native"/,
    "the both-tiers guard is gone — a new window seeded from a post-fix explicit native would be wiped");
  // ssRemove, never wsClear, in the per-window half — localStorage may hold
  // ANOTHER window's legitimate platform choice, and wsClear would delete it.
  assert.match(mount, /ssRemove\("chatTargetDest"\)/,
    "the per-window half must remove only this window's session copy");
});

test("the popover's encrypt toggle-off restores, it does not choose native", () => {
  // setDest(null) on disarm was the second poisoner: an explicit "native" the
  // user never picked, persisted, blocking the "all" default thereafter.
  const input = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../features/chat/ChatInput.tsx"), "utf8"));
  assert.match(input, /encryptArmed \? resetDest\(\) : setDest\(ENCRYPTED_DEST\)/,
    "toggling 🔒 off must go through resetDest — the restore path");
  assert.doesNotMatch(input, /setDest\(encryptArmed \? null/,
    "the old disarm-to-native ternary is back — that persists a choice nobody made");
});

// ── composerAccent: ONE destination signal, two consumers ────────────────────
// The chat input area takes the colour of the selected destination, as the
// send button does. The risk in adding the field was never the styling — it
// was ending up with TWO copies of the precedence that can disagree, so these
// pin that there is exactly one.

const accentArgs = { platformColors: PLATFORM_COLORS, isRoutable: isRoutablePlatform };

test("the accent precedence: cheer > 🔒 > reply platform > sticky destination", () => {
  const base = { cheerActive: false, encryptArmed: false, forcedDest: null, ...accentArgs };
  // Cheer outranks everything — it is the only irreversible one.
  assert.equal(composerAccent({ ...base, cheerActive: true, encryptArmed: true, forcedDest: "twitch" }), "#eab308");
  // 🔒 outranks the reply tint: an encrypted message never leaves the site, so
  // painting the replied-to platform's colour would promise the opposite.
  assert.equal(
    composerAccent({ ...base, encryptArmed: true, replyPlatform: "twitch", forcedDest: "kick" }),
    "var(--color-encrypted)");
  // A reply outranks the sticky destination — that is where it actually goes.
  assert.equal(
    composerAccent({ ...base, replyPlatform: "twitch", forcedDest: "kick" }),
    PLATFORM_COLORS.twitch);
  assert.equal(composerAccent({ ...base, forcedDest: "kick" }), PLATFORM_COLORS.kick);
  // "all" gets the SITE's accent. No single platform brand is honest for a
  // fan-out, but the site's own accent is not a platform brand, and with the
  // field excluded from the global focus ring (polishFollowups test 1) the
  // accent border is what marks "send to: all" as a chosen destination rather
  // than an unstyled default.
  assert.equal(composerAccent({ ...base, forcedDest: "all" }), "var(--accent)");
});

test("nothing worth signalling → null, so both consumers fall to their neutral", () => {
  const base = { cheerActive: false, encryptArmed: false, ...accentArgs };
  assert.equal(composerAccent({ ...base, forcedDest: null }), null, "plain native is not a signal");
  // A reply to a NON-routable platform is a native reply; it routes nowhere.
  assert.equal(composerAccent({ ...base, forcedDest: null, replyPlatform: "discord" }), null);
});

test("every routable platform has a colour, so the null fallback is unreachable", () => {
  // For a routable platform missing from the map the function returns null
  // (→ the user's own send colour), where an inline chain would fall back to a
  // literal `var(--accent)`. Identical as long as the map covers every routable
  // platform — this is what keeps that true, and it is the only thing making
  // the two forms equivalent.
  for (const p of ROUTABLE_PLATFORMS) {
    assert.ok(PLATFORM_COLORS[p], `routable platform ${p} has no brand colour`);
  }
});

test("ChatInput computes the signal ONCE and hands the same value to both ends", () => {
  const src = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../features/chat/ChatInput.tsx"), "utf8"));
  const calls = src.match(/composerAccent\(/g) ?? [];
  assert.equal(calls.length, 1, "the precedence must be computed once, not per consumer");
  assert.match(src, /const accent = composerAccent\(/, "anchor lost — the accent is no longer named");
  // Both consumers must read that one binding. A field saying Twitch beside a
  // button saying encrypted is worse than no signal at all.
  assert.match(src, /backgroundColor: sendBtnColor/, "the send button no longer takes the signal");
  assert.match(src, /sendBtnColor = accent \?\?/, "the button forked away from the shared accent");
  assert.match(src, /accentColor=\{accent\}/, "the field forked away from the shared accent");
});

test("the field takes the accent as a BORDER — never a fill, never a tint", () => {
  const css = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../globals.css"), "utf8"));
  const start = css.indexOf('.chat-input-field[data-accent="on"]');
  assert.ok(start !== -1, "the accented-field rule is gone — the field lost the destination signal");
  const block = css.slice(start, css.indexOf("}", css.indexOf("}", start) + 1) + 1);
  assert.match(block, /border-color:/, "the accent must colour the border");
  // The whole safety argument. The field is a text surface and the platform
  // palette is pastel (kick #7dd9a8, twitch #e697ce): a 10% background tint of
  // one of those lifts the field enough to drop the `text-muted` placeholder
  // from 3.84:1 to roughly 2:1, under AA. A border costs nothing.
  assert.doesNotMatch(block, /background(-color|-image)?:/,
    "an accent FILL/TINT on the field fails placeholder contrast — border only");
  // Focus is carried by the border alone here (the field has no ring by
  // design), so an accented field still needs a brighter focused state.
  assert.match(css.slice(start), /\[data-accent="on"\]:focus\s*\{\s*border-color: var\(--composer-accent\)/,
    "an accented field must still show focus — it has no other affordance");
});

test("the accent is a data attribute, not an inline borderColor", () => {
  const src = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../components/ChatComposerField.tsx"), "utf8"));
  assert.match(src, /data-accent=\{accentColor \? "on" : undefined\}/,
    "the accent hook for CSS is gone");
  // An inline borderColor beats the `focus:border-edge-bright` utility
  // unconditionally, freezing the border at one colour and costing the field
  // its only focus affordance.
  assert.doesNotMatch(src, /borderColor:/,
    "an inline borderColor would override the focus state and freeze the border");
  // The Matrix composer shares this field: a room has exactly one destination,
  // so there is nothing to signal there and it must stay neutral.
  const matrix = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../components/MatrixInput.tsx"), "utf8"));
  assert.doesNotMatch(matrix, /accentColor/,
    "the Matrix composer has one destination — it must not take a destination accent");
});


test("composerAccent: a bound window (a DM) outranks everything — the line goes there and nowhere else", () => {
  const base = { cheerActive: false, encryptArmed: false, forcedDest: null, ...accentArgs };
  assert.equal(
    composerAccent({ ...base, boundAccent: "var(--color-encrypted)", cheerActive: true, supportArmed: true, encryptArmed: true, forcedDest: "twitch" }),
    "var(--color-encrypted)");
  assert.equal(composerAccent({ ...base, boundAccent: null, forcedDest: "twitch" }), PLATFORM_COLORS.twitch, "unbound: unchanged");
});
