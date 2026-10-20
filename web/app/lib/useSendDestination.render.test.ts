// Behavioural tests for useSendDestination — RENDERED, not source-scanned.
//
// Why this file exists: sendDestination.test.ts says, correctly, that "the
// persist effect isn't unit-testable without a React renderer", so its
// invariants are pinned by reading source text. That catches the shape of the
// code and misses bugs in its BEHAVIOUR — a prune that leaves both the choice
// flag and the stored key behind (see the two tests below). A source scan
// cannot see that, because every individual line it asserts on is present and
// in the right order.
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot
// resolve extensionless TypeScript specifiers (same rule as windowScoped.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { dom, act, mountHook, resetStorage, serveJson } from "./testDom.ts";
import { useSendDestination, RETRY_MS, NATIVE_AMNESTY_LATCH, NATIVE_CARRY_LATCH } from "./useSendDestination.ts";
import { ENCRYPTED_DEST } from "./sendDestination.ts";

/** Serve /api/account-links; `.set()` changes the answer for the next refetch. */
function serveLinks(platforms: string[]) {
  const shape = (ps: string[]) => ({ accounts: ps.map(p => ({ platform: p })) });
  const box = serveJson(shape(platforms));
  return { set: (ps: string[]) => { box.current = shape(ps); } };
}

/** Mount the hook and return a live handle to its latest return value. */
async function mount(opts: { canEncrypt?: boolean | null } = {}) {
  const h = await mountHook(() => useSendDestination(opts.canEncrypt ?? false));
  return {
    get dest() { return h.current.forcedDest; },
    get cycle() { return h.current.destCycle; },
    get supportArmed() { return h.current.supportArmed; },
    set: (d: string | null) => h.act(() => { h.current.setDest(d); }),
    /** A pick from the Send-to menu (SendToButton's onPick is setDest). */
    pick: (d: string | null) => h.act(() => { h.current.setDest(d); }),
    /** Everything the hook hands the composer — no stepping function among it. */
    get api() { return Object.keys(h.current); },
    reset: () => h.act(() => { h.current.resetDest(); }),
    armSupport: () => h.act(() => { h.current.armSupport(); }),
    leaveSupport: () => h.act(() => { h.current.leaveSupport(); }),
    /** Re-run the linked-accounts fetch the way the Linked Accounts panel does. */
    accountsChanged: () =>
      h.act(async () => { dom.window.dispatchEvent(new dom.window.Event("bb:accounts-changed")); }),
    /** Sit out the hook's single retry delay, plus slack for the refetch itself. */
    waitForRetry: () => h.act(async () => { await new Promise(r => setTimeout(r, RETRY_MS + 250)); }),
    unmount: h.unmount,
  };
}

/** Re-run the linked-accounts fetch the way the Linked Accounts panel does. */
const accountsChanged = () =>
  act(async () => { dom.window.dispatchEvent(new dom.window.Event("bb:accounts-changed")); });

function reset() {
  resetStorage();
  // The hook's one-time amnesty latch would otherwise fire inside a test and
  // clear a "native" the test itself set up. Pre-burn it: these tests are about
  // life AFTER the amnesty, which is the state every real user is in.
  // Keyed on the CURRENT latch, never a literal. Pre-burning an old latch name
  // while the hook has moved on would leave every test below silently running
  // the amnesty it thought it had disabled.
  // And this pre-burn has a COST: the amnesty block never executes under a
  // renderer here, so a stale latch would fail nothing. The tests at the
  // bottom of this file exist to run it.
  dom.window.localStorage.setItem(NATIVE_AMNESTY_LATCH, "1");
  dom.window.sessionStorage.setItem(NATIVE_AMNESTY_LATCH, "1");
  dom.window.sessionStorage.setItem(NATIVE_CARRY_LATCH, "1");
}
const stored = () => dom.window.localStorage.getItem("chatTargetDest");

// ── The prune must not persist a "native" nobody chose ───────────────────────
//
// The prune drops a destination the cycle no longer offers; if it left the
// choice set, the persist effect would immediately write "native" for a user
// who had chosen a PLATFORM, and that stored "native" then blocks the "all"
// default on every later load (the default is gated on the key being null).
// One unlink would poison the account.
test("an in-session prune never persists a 'native' the user did not choose", async () => {
  reset();
  const links = serveLinks(["twitch"]);
  const h = await mount();

  await h.pick("twitch");               // an explicit choice
  assert.equal(h.dest, "twitch");
  assert.equal(stored(), "twitch", "setup: an explicit platform choice persists");

  links.set([]);                        // user unlinks their last platform
  await accountsChanged();

  assert.equal(h.dest, null, "the unavailable destination is dropped");
  assert.notEqual(
    stored(), "native",
    "the prune persisted an explicit 'native' the user never chose, " +
    "and it permanently blocks the 'all' default once they link a platform again"
  );
  await h.unmount();
});

// ── The prune must clear the STORED value, or the default can never re-derive ─
//
// A stored destination that has fallen out of the cycle — an unlinked platform,
// or YouTube, which `canCrossPost` excludes while its cross-post is unavailable
// — was pruned from STATE but left in STORAGE. The one-time default is gated on
// `wsGet("chatTargetDest") == null`, so it was blocked by the very string the
// prune had just rejected, stranding the user on native on every load.
test("a pruned destination is cleared from storage, so the 'all' default re-derives", async () => {
  reset();
  // Stored from an earlier session: a platform this account can no longer post
  // to. userChose is false on a fresh load, so the persist effect is not even
  // involved here — this failure is purely the stale key blocking the default.
  dom.window.localStorage.setItem("chatTargetDest", "kick");
  serveLinks(["twitch"]);

  const h = await mount();

  assert.ok(h.cycle.includes("all"), "setup: one linked platform must offer 'all'");
  assert.equal(
    h.dest, "all",
    "the user has a linked platform and never chose native, so the default must apply — " +
    "instead the pruned 'kick' was still in storage and blocked it on every refresh"
  );
  await h.unmount();
});

// ── Guard the fix's blast radius ─────────────────────────────────────────────

test("a still-valid stored choice is untouched by the prune path", async () => {
  reset();
  dom.window.localStorage.setItem("chatTargetDest", "twitch");
  serveLinks(["twitch", "kick"]);

  const h = await mount();
  assert.equal(h.dest, "twitch", "a destination still in the cycle must survive");
  assert.equal(stored(), "twitch", "and must stay stored");
  await h.unmount();
});

// "native" is the stored SPELLING of null, not a cycle entry — the cycle
// carries `null` for it — so a storage prune keyed on `shouldPrune` finds it
// "missing" every single time and would delete every explicit native choice on
// sight. It is also the one destination that can never go stale.
//
// A deliberate native beats the default across a RELOAD of its own window, and
// across a new session too (see the decision-1 tests below).
test("an explicit native choice still beats the default across a reload", async () => {
  reset();
  const links = serveLinks(["twitch"]);

  const first = await mount();
  await first.pick(null);               // "this site only", picked from the menu
  assert.equal(first.dest, null);
  assert.equal(
    dom.window.sessionStorage.getItem("chatTargetDest"), "native",
    "an explicit native choice persists in this window's own tier"
  );
  await first.unmount();

  // A RELOAD of the same window: sessionStorage kept, hook remounts.
  links.set(["twitch"]);
  const second = await mount();
  assert.equal(second.dest, null, "native was chosen; the 'all' default must not override it");
  await second.unmount();
});

// ── Decision 1: cross-posting is the default; a deliberate choice persists ──
//
// Linked accounts default to posting everywhere ("all"). The control is a menu,
// so every stored value is a destination someone picked by name — and so every
// pick, "this site only" included, survives into the next session instead of
// silently resetting to the fan-out.

/** Close the window and open a new one: the session tier is gone, localStorage seeds. */
function newSession() {
  dom.window.sessionStorage.clear();
  dom.window.sessionStorage.setItem(NATIVE_AMNESTY_LATCH, "1");
}

test("decision 1: with accounts linked and nothing picked, the default is every linked platform — and it is not stored", async () => {
  reset();
  serveLinks(["twitch", "kick"]);
  const h = await mount();
  assert.equal(h.dest, "all");
  assert.equal(stored(), null, "a default re-derives every load; it is never written as if chosen");
  await h.unmount();
});

test("decision 1: a deliberate 'site only' survives a new session (it used to reset to 'all')", async () => {
  reset();
  const links = serveLinks(["twitch", "kick"]);
  const first = await mount();
  await first.pick("twitch");           // a platform choice first…
  await first.pick(null);               // …then "this site only"
  assert.equal(stored(), "native", "the pick is stored durably, over the earlier 'twitch'");
  await first.unmount();

  newSession();
  links.set(["twitch", "kick"]);
  const second = await mount();
  assert.equal(second.dest, null, "the new session keeps 'site only' — the person chose it");
  await second.unmount();
});

test("decision 1: a deliberate platform survives a new session", async () => {
  reset();
  const links = serveLinks(["twitch", "kick"]);
  const first = await mount();
  await first.pick("kick");
  await first.unmount();
  newSession();
  links.set(["twitch", "kick"]);
  const second = await mount();
  assert.equal(second.dest, "kick");
  await second.unmount();
});

// The old design's "site only" lived in this window's sessionStorage alone. A
// window still holding it when the new code first runs must keep it — durably —
// or the next session silently posts everywhere for someone who chose not to.
function oldDesignWindow(sessionNative: boolean) {
  resetStorage();
  dom.window.localStorage.setItem(NATIVE_AMNESTY_LATCH, "1");   // the old code had run here
  dom.window.sessionStorage.setItem(NATIVE_AMNESTY_LATCH, "1");
  dom.window.sessionStorage.setItem("ws.pinned.chatTargetDest", "1");
  if (sessionNative) dom.window.sessionStorage.setItem("chatTargetDest", "native");
}

test("decision 1 carry-over: an old session-only 'site only' becomes the persisted choice, once", async () => {
  oldDesignWindow(true);
  const links = serveLinks(["twitch", "kick"]);
  const first = await mount();
  assert.equal(first.dest, null, "this window stays on 'site only'");
  assert.equal(stored(), "native", "and it is now stored durably");
  await first.unmount();

  newSession();
  links.set(["twitch", "kick"]);
  const second = await mount();
  assert.equal(second.dest, null, "the next session keeps 'site only' instead of falling back to 'all'");
  await second.unmount();
});

test("decision 1 carry-over: no old value → the default 'all', nothing stored", async () => {
  oldDesignWindow(false);
  serveLinks(["twitch", "kick"]);
  const h = await mount();
  assert.equal(h.dest, "all");
  assert.equal(stored(), null);
  assert.equal(dom.window.sessionStorage.getItem("chatTargetDest"), null);
  await h.unmount();
});

test("decision 1: there is no stepping control — nothing but a named pick can store a destination", async () => {
  reset();
  serveLinks(["twitch", "kick"]);
  const h = await mount();
  assert.ok(!h.api.includes("nextDest"), "a cycling function is back — an interrupted tap-through would store a pass-through value");
  assert.deepEqual(h.api.filter((k) => /Dest$/.test(k)).sort(), ["forcedDest", "resetDest", "setDest"]);
  assert.equal(stored(), null, "mounting, loading and defaulting store nothing");
  await h.unmount();
});

test("a FAILED fetch never prunes — the deploy-window reset bug stays fixed", async () => {
  reset();
  dom.window.localStorage.setItem("chatTargetDest", "twitch");
  (globalThis as unknown as { fetch: unknown }).fetch = () => Promise.reject(new Error("offline"));

  const h = await mount();
  assert.equal(h.dest, "twitch", "a failed fetch must never wipe the user's choice");
  assert.equal(stored(), "twitch", "nor clear it from storage");
  await h.unmount();
});

// ── "all" survives close and reopen ─────────────────────────────────────────
//
// "set send to: all -> send a message -> close and reopen -> send to: site.test"
//
// This is the plain-message half of it, and it PASSES — which is exactly why
// this test earns its place: it rules the simple path out. An explicit "all"
// survives a fresh window when the account list is stable; anything that
// overwrites it needs a further condition (a transient cycle, a second
// mounted composer, or the sentinel capture/restore around the load-time
// support bubble — see below).
test("an explicit 'all' survives a close-and-reopen when the account list is stable", async () => {
  reset();
  const links = serveLinks(["twitch", "kick"]);

  const first = await mount();
  await first.pick(null);               // step off the default onto an explicit choice…
  await first.pick("all");              // …and back to "all", picked by name
  assert.equal(stored(), "all", "setup: an explicit 'all' persists");
  await first.unmount();

  dom.window.sessionStorage.clear();     // close and reopen = a new window
  dom.window.sessionStorage.setItem(NATIVE_AMNESTY_LATCH, "1");
  links.set(["twitch", "kick"]);

  const second = await mount();
  assert.equal(second.dest, "all", "the reopened window must come up on 'all'");
  assert.notEqual(stored(), "native", "and nothing may have rewritten the key to 'native'");
  await second.unmount();
});

// ── a PRUNE is not a CHOICE ─────────────────────────────────────────────────
//
// The prune has two halves: the RENDER half keys on `forcedDest` and runs every
// render; the STORAGE half keys on the stored string and only runs when
// [fetchStatus, destCycle, canEncrypt] change — and only the storage half
// clears the choice. So any render that moves `forcedDest` out of the cycle
// WITHOUT the cycle changing runs the render prune alone, and with a boolean
// choice flag the persist effect would fire on the forcedDest→null transition
// with the choice still set — writing "native" over a platform the user really
// did pick, which blocks the "all" default on every later load.
//
// The sequence below is one real way in: the restore path re-arms the choice
// with a destination that was pruned WHILE 🔒 was armed. The cycle does not
// change on the restore, so the storage half never re-runs.
test("a destination pruned while 🔒 was armed cannot come back as a persisted 'native'", async () => {
  reset();
  const links = serveLinks(["twitch", "kick"]);
  const h = await mount({ canEncrypt: true });

  await h.pick("twitch");
  assert.equal(stored(), "twitch", "setup: an explicit platform choice persists");

  // Seal a message: 🔒 displaces "twitch" and remembers it WAS chosen.
  await h.set(ENCRYPTED_DEST);
  assert.equal(h.dest, ENCRYPTED_DEST, "setup: 🔒 is armed");

  // Twitch goes away while 🔒 holds the floor — the storage half prunes the
  // stored "twitch" here, because the cycle changed.
  links.set(["kick"]);
  await h.accountsChanged();

  // Disarm. The restore puts "twitch" back, and now the RENDER half prunes it
  // with no cycle change to wake the storage half.
  await h.reset();

  assert.equal(h.dest, null, "the destination is no longer offered, so it must be dropped");
  assert.notEqual(
    stored(), "native",
    "the prune persisted a 'native' the user never chose, and it " +
    "permanently blocks the 'all' default on every later load"
  );
  await h.unmount();
});

// The other half of the same invariant: an explicit native must STILL persist.
// A guard that simply refused to write "native" anywhere would pass the test
// above and silently break the one destination people choose on purpose: a
// mid-conversation reload would bounce them back to the fan-out.
test("picking native is still a real choice and survives a reload", async () => {
  reset();
  serveLinks(["twitch"]);
  const h = await mount();

  await h.pick(null);
  assert.equal(
    dom.window.sessionStorage.getItem("chatTargetDest"), "native",
    "an explicit native choice must still be written to the window tier"
  );
  await h.unmount();

  const again = await mount();          // reload of the same window
  assert.equal(again.dest, null, "native must survive reloading its own window");
  await again.unmount();
});

// ── The support bot is not a destination ────────────────────────────────────

test("Gadget cannot enter the destination cycle — the hook is not even told about him", async () => {
  reset();
  serveLinks(["twitch"]);
  const h = await mount({ canEncrypt: true });

  assert.ok(!h.cycle.includes("support"),
    "support is back in the cycle — every user changing destination would step through it");
  assert.deepEqual(h.cycle, [null, "twitch", "all"],
    "the cycle is not exactly native → platforms → all (🔒 is not in it)");
  await h.unmount();
});

test("arming and leaving Gadget leaves the destination completely untouched", async () => {
  reset();
  serveLinks(["twitch", "kick"]);
  const h = await mount();

  await h.pick("kick");
  assert.equal(stored(), "kick", "setup");

  await h.armSupport();
  assert.equal(h.supportArmed, true, "the Gadget button armed nothing");
  assert.equal(h.dest, "kick", "arming Gadget moved the destination — it must not");
  assert.equal(stored(), "kick", "arming Gadget wrote to storage — it must not");

  await h.leaveSupport();
  assert.equal(h.supportArmed, false);
  assert.equal(h.dest, "kick", "leaving Gadget moved the destination");
  assert.equal(stored(), "kick", "leaving Gadget wrote to storage");
  await h.unmount();
});

// The load-time greeting arms the support bot BEFORE the linked-accounts fetch
// lands. Were support a `forcedDest`, that would displace `null` and closing
// the bubble would restore it as an explicit choice — persisting "native" and
// blocking the default forever. It cannot happen, and this is the test that
// says so.
test("a Gadget greeting armed before the accounts load cannot block the 'all' default", async () => {
  reset();
  serveLinks(["twitch", "kick"]);
  const h = await mount();

  await h.armSupport();          // the load-time bubble, as ChatSidebar fires it
  await h.leaveSupport();        // …and the user closes it

  assert.equal(h.dest, "all", "the one-time default must still apply after a greeting round trip");
  assert.equal(stored(), null, "a greeting must persist NOTHING — the default re-derives every load");
  await h.unmount();
});

// ── A supporter with nothing linked must not latch the one-shot default ─────
//
// A gate of `destCycle.length > 1` is satisfied by the 🔒 sentinel without
// offering anywhere to send. A Supporter with no links has cycle [null, 🔒] —
// length 2 — so `defaulted` would latch against a cycle with no real
// destination, and the default could never fire again once they linked a
// platform. The gate asks `defaultDest(destCycle) !== null` instead.
test("a supporter with no linked platforms still gets 'all' after linking one", async () => {
  reset();
  const links = serveLinks([]);
  const h = await mount({ canEncrypt: true });

  assert.deepEqual(h.cycle, [null], "setup: nowhere to send yet");
  assert.equal(h.dest, null, "with nothing linked, native is the only answer");

  links.set(["twitch"]);
  await h.accountsChanged();

  assert.equal(h.dest, "all",
    "the one-shot default latched against a cycle that offered no destination, " +
    "so linking a platform never produced the 'all' default");
  await h.unmount();
});

// ── A single failed accounts fetch must not strand the composer ─────────────
//
// "error" is terminal for the session: the default effect requires "ok", so one
// failed call left a linked user reading "send to: site.test" until they
// reloaded — nothing persisted, so it healed next load. That is exactly the
// shape of the intermittent "defaults to site-only on page load/reload" report.
test("one failed accounts fetch is retried, and the default still applies", async () => {
  reset();
  const links = serveLinks(["twitch", "kick"]);
  const realFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  let calls = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
    calls++;
    // Fail only the FIRST attempt — a transient 401 mid token-refresh.
    return calls === 1
      ? Promise.reject(new Error("transient"))
      : (realFetch as (...a: unknown[]) => Promise<Response>)(...args);
  };

  const h = await mount();
  assert.equal(h.dest, null, "before the retry lands there is nothing to default to yet");
  await h.waitForRetry();

  assert.ok(calls >= 2, "the failed fetch was never retried");
  assert.equal(h.dest, "all", "the retry succeeded but the default never applied");
  assert.equal(stored(), null, "a re-derived default must still not be persisted");
  links.set([]);
  await h.unmount();
});

// ── Closing the write path is NOT the whole fix ─────────────────────────────
//
// "I set the output to 'send to: all' and exited the app and opened it back up
// and it was set to 'send to: site.test'" — on a build whose write path was
// already fixed. A profile the bug ALREADY poisoned still holds
// `chatTargetDest = "native"`, the one-time default is gated on that key being
// null, and a previous amnesty latch is burned on every live profile.
//
// So a defect that writes bad persisted values needs TWO fixes, and the second
// is the one users actually feel: stop writing them, AND retire the ones already
// out there. The latch constant is how the second half ships.
//
// These tests deliberately do NOT pre-burn the latch — every other test in
// this file does, which is exactly why this class needs its own tests.
test("a profile already poisoned by the bug recovers its 'all' default", async () => {
  resetStorage();
  // The poisoned state: a stored "native" nobody chose, and the OLD amnesty
  // long since spent.
  dom.window.localStorage.setItem("chatTargetDest", "native");
  dom.window.localStorage.setItem("destNativeAmnesty1", "1");
  dom.window.sessionStorage.setItem("destNativeAmnesty1", "1");
  serveLinks(["twitch", "kick"]);

  const h = await mount();
  assert.equal(
    h.dest, "all",
    "the poisoned 'native' was never retired, so the default stayed blocked — fixing the " +
    "write path alone leaves every already-broken profile exactly as broken"
  );
  await h.unmount();
});

test("the amnesty runs ONCE — a later explicit native still sticks in its window", async () => {
  resetStorage();
  dom.window.localStorage.setItem("chatTargetDest", "native");
  const links = serveLinks(["twitch"]);

  const first = await mount();
  assert.equal(first.dest, "all", "setup: the amnesty cleared the poisoned value");
  await first.pick(null);                       // the user really does choose native
  assert.equal(
    dom.window.sessionStorage.getItem("chatTargetDest"), "native",
    "setup: an explicit native persists in the window tier"
  );
  await first.unmount();

  // A reload of the SAME window. Both latches are spent, so this choice must
  // survive untouched — otherwise the amnesty is not an amnesty, it is a policy
  // of never allowing anyone to choose site.test.
  links.set(["twitch"]);
  const second = await mount();
  assert.equal(second.dest, null, "the amnesty ran twice and ate a real choice");
  await second.unmount();
});

test("the amnesty only ever touches 'native' — a platform choice is untouched", async () => {
  resetStorage();
  dom.window.localStorage.setItem("chatTargetDest", "twitch");
  serveLinks(["twitch", "kick"]);

  const h = await mount();
  assert.equal(h.dest, "twitch", "the amnesty cleared a stored PLATFORM — it must only clear native");
  assert.equal(stored(), "twitch");
  await h.unmount();
});

// ── 🔒 is not a menu destination ────────────────────────────────────────────
//
// It is armed only by a direct jump — the popover row or /r — and a direct jump
// displaces exactly what is held. The Send-to button, while 🔒 is armed, calls
// resetDest (SendToButton's onDisarm; sendToButton.render.test.ts).

test("the menu never offers 🔒", async () => {
  reset();
  serveLinks(["twitch"]);
  const h = await mount({ canEncrypt: true });
  assert.ok(!h.cycle.includes(ENCRYPTED_DEST), "🔒 is in the destination list — it is armed only from the popover or /r");
  await h.unmount();
});

test("disarming 🔒 (the button's onDisarm) puts back what 🔒 displaced", async () => {
  reset();
  serveLinks(["twitch", "kick"]);
  const h = await mount({ canEncrypt: true });
  await h.pick("twitch");
  await h.set(ENCRYPTED_DEST);
  assert.equal(h.dest, ENCRYPTED_DEST, "setup: armed");
  await h.reset();
  assert.equal(h.dest, "twitch", "disarming must put back the displaced destination");
  await h.unmount();
});

test("an armed 🔒 survives an account-links refresh although it is not in the cycle", async () => {
  reset();
  serveLinks(["twitch"]);
  const h = await mount({ canEncrypt: true });
  await h.set(ENCRYPTED_DEST);
  await h.accountsChanged();
  assert.equal(h.dest, ENCRYPTED_DEST, "the prune disarmed 🔒 because it left the cycle");
  await h.unmount();
});

test("control: a direct jump to 🔒 displaces exactly the destination held", async () => {
  reset();
  serveLinks(["twitch", "kick"]);
  const h = await mount({ canEncrypt: true });
  await h.pick("twitch");
  await h.set(ENCRYPTED_DEST);  // the popover row, not a tap
  await h.reset();
  assert.equal(h.dest, "twitch");
  await h.unmount();
});
