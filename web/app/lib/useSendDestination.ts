import { useState, useEffect, useMemo, useRef } from "react";
// `.ts` extensions are REQUIRED here, same rule as windowScoped.ts: this hook
// is exercised under `node --test` (useSendDestination.render.test.ts), which
// cannot resolve extensionless TypeScript specifiers. `tsconfig` sets
// `allowImportingTsExtensions`. Dropping them doesn't fail the build — it kills
// the render tests, the only tests that see this hook's behaviour rather than
// its source.
import { getJson } from "./http.ts";
import { lsGet, lsSet } from "./safeLocalStorage.ts";
import { wsGet, wsSet, wsPin, wsClear, ssGet, ssSet, ssRemove } from "./windowScoped.ts";
import { canCrossPost, DEST_ORDER } from "./platforms.ts";
import { defaultDest, shouldPrune, ENCRYPTED_DEST, SUPPORT_DEST } from "./sendDestination.ts";

/**
 * How long to wait before the single retry of the linked-accounts fetch.
 * Short enough that the composer settles before anyone reads the label, long
 * enough to outlast a token refresh or a deploy-window blip.
 *
 * @test-only exported purely so useSendDestination.render.test.ts waits on THIS
 * number instead of a copy of it. A test sleeping a hard-coded 1500ms against a
 * constant someone later raises is a flake that only appears in CI.
 */
export const RETRY_MS = 1500;

/**
 * Which round of the stored-`"native"` amnesty this build runs.
 *
 * BUMPING THIS IS HOW A FIX REACHES PROFILES ALREADY BROKEN BY A BUG.
 * Closing the write path only stops NEW poisoning. A stored `"native"` is
 * indistinguishable from a real choice, the one-time default is gated on the key
 * being null, and the previous latch is long since burned on every live profile
 * — so without a new latch, everyone the bug already caught stays on
 * "send to: <site>" forever and the fix looks like it did nothing.
 *
 * `2` retires the values written by the split-prune defect: the render prune
 * moved `forcedDest` without clearing the choice flag, so the persist effect
 * wrote `"native"` over destinations people really had chosen. See
 * `chosenDest` below for the write path itself.
 *
 * `3` retires "native" one FINAL time. The writer left standing after every
 * defect writer was closed was the design itself: cycling the send-to button
 * passed THROUGH native and each step persisted durably, so one interrupted
 * de-select/re-select on a phone stored a "native" nobody meant. That control is
 * gone — the destination is a MENU now (SendToButton), so every stored value is
 * a destination someone picked by name, never a step on the way to another one.
 * A deliberate native therefore persists like any other choice, and a `v4` is
 * not needed: there is no pass-through left to have written a bad value.
 *
 * The trade is deliberate and is the same one `v1` made: a genuine
 * native-chooser re-derives to "all" ONCE and is one tap from native again,
 * while a poisoned profile gets its fan-out back for good. Only bump this when a
 * defect has actually been writing bad values — it is not free.
 *
 * @test-only exported so the render tests pre-burn THIS latch rather than a
 * literal. Pre-burning `"destNativeAmnesty1"` while the hook had moved on would
 * leave every test in that file silently running the amnesty it believed it had
 * disabled — and the amnesty tests at the bottom of it asserting nothing.
 */
export const NATIVE_AMNESTY_LATCH = "destNativeAmnesty3";

/**
 * Retire a stored `"native"` once per device and once per window.
 *
 * TWO LATCHES, NOT ONE, and they clear different tiers. The poison lives in
 * localStorage (the seed for new windows) AND in each window's own
 * sessionStorage, which survives reloads — so a device-only amnesty cures the
 * first window to run it and leaves every other long-lived tab carrying its own
 * copy forever.
 *
 * Parameterised rather than copied per round: the two tiers have subtly
 * different rules (below), and a second hand-written pair would drift from this
 * one the first time either rule changed.
 */
function runNativeAmnesty(latch: string): void {
  // The DEVICE half. Clears both tiers, because localStorage is what seeds
  // every future window.
  if (!lsGet(latch)) {
    lsSet(latch, "1");
    if (wsGet("chatTargetDest") === "native") wsClear("chatTargetDest");
  }
  // The per-WINDOW half. The `lsGet !== "native"` guard is what protects a
  // genuine explicit native: a new window seeded from that choice sees
  // "native" in BOTH tiers and is left alone, while poisoned session copies
  // stand alone (the device half already cleared localStorage) and are removed.
  // ssRemove, never wsClear, here — localStorage may hold another window's
  // legitimate platform choice.
  if (!ssGet(latch)) {
    ssSet(latch, "1");
    if (ssGet("chatTargetDest") === "native" && lsGet("chatTargetDest") !== "native") {
      ssRemove("chatTargetDest");
    }
  }
}

/**
 * Once per window: the old design kept a picked "site only" in THIS window's
 * sessionStorage only ("native" there, nothing in localStorage). Only a pick ever
 * wrote it, so it is carried into the durable choice — otherwise the next session
 * would silently fall back to posting everywhere for the people who chose not to.
 * Per-window latch, not a bare condition: later, "native" here with another
 * window's platform in localStorage is a normal state, not the old one.
 *
 * @test-only exported so the render tests pre-burn THIS latch, like the amnesty's.
 */
export const NATIVE_CARRY_LATCH = "destNativeCarry1";

function carrySessionNative(): void {
  if (ssGet(NATIVE_CARRY_LATCH)) return;
  ssSet(NATIVE_CARRY_LATCH, "1");
  if (ssGet("chatTargetDest") === "native" && lsGet("chatTargetDest") !== "native") {
    wsSet("chatTargetDest", "native");   // the session-only form is replaced by the durable one
  }
}

// The destination is chosen from a MENU (SendToButton), never by stepping
// through values, so every choice is deliberate and every choice persists
// across sessions (localStorage) — a platform id, "all", or the "native"
// sentinel for "this site only". A choice is distinct from "no value yet",
// which is what lets the default (linked accounts → "all", see below) apply
// until someone picks something, and never after. A restored value that's no
// longer linked is dropped back to native once the account list loads (the
// prune effect below), but ONLY on a successful fetch — see shouldPrune.
/**
 * @param canEncrypt Does this viewer have an active Supporter subscription?
 *   `null`/`undefined` means NOT YET KNOWN, and is distinct from `false` —
 *   see the prune guard below, which must not act on an unanswered question.
 * THERE IS NO `supportEnabled` PARAMETER, and its absence is the point. A
 * flag doing double duty — gating the `/support` command AND putting a support
 * entry in the send-to cycle — lets enabling the command without the panel arm
 * a destination the cycle does not contain, which is precisely what the prune
 * deletes. The help desk is not a destination at all: it is `supportArmed`,
 * its own boolean, and this hook has no opinion about whether a composer
 * offers it. The flag lives on ChatInput, where it gates the command and the
 * button — the two things it honestly describes.
 */
export function useSendDestination(canEncrypt: boolean | null = null) {
  const [forcedDest, setForcedDest] = useState<string | null>(() => {
    const stored = wsGet("chatTargetDest");
    // A STORED SENTINEL IS NEVER HONOURED. Neither is ever written (see the
    // persist effect below), but a stale value in localStorage restoring as the
    // armed destination would bring the composer up armed, so the next message
    // would be sealed without anyone choosing to, or bounce off the cooldown.
    // For support the same restore would open the help desk's panel on every
    // load. Treated as "no stored choice"; the mount effect clears the stale
    // key so the ordinary default can re-derive instead of pinning this window
    // native.
    if (stored === ENCRYPTED_DEST || stored === SUPPORT_DEST) return null;
    return stored === "native" ? null : stored || null;
  });
  // Pin this window's destination on mount — this call is doing real work.
  // The persist effect below is gated on the recorded choice, so a RESTORED
  // value is never written back. Without an explicit pin, a window that only
  // ever INHERITED its destination keeps reading through to localStorage, and
  // so still follows whichever window last changed it — which is precisely the
  // mis-send ("my message went to Twitch") window-scoping exists to stop, and
  // it would go on happening to the passive window most likely to be caught out.
  // ORDER MATTERS: clear a stale 🔒 BEFORE pinning. `wsPin` seeds this
  // window's copy from localStorage, so pinning first would copy the sentinel
  // into sessionStorage and the clear would leave it behind there. Clearing
  // first leaves the pin with no seed, which reads back as `null` — the state
  // the one-time default below is gated on, so the user lands on their real
  // default rather than being stranded on native.
  useEffect(() => {
    // FIRST, before the amnesty (whose per-window half would delete it): carry a
    // "site only" stored by the old session-only design into the durable choice.
    carrySessionNative();
    runNativeAmnesty(NATIVE_AMNESTY_LATCH);
    const stale = wsGet("chatTargetDest");
    if (stale === ENCRYPTED_DEST || stale === SUPPORT_DEST) wsClear("chatTargetDest");
    wsPin("chatTargetDest");
  }, []);
  // Platforms the user has actually linked AND can cross-post to (excludes
  // YouTube while its cross-post is unavailable). Drives the destination toggle
  // so it only ever offers verified destinations.
  const [linkedDests, setLinkedDests] = useState<string[]>([]);
  // Linked-accounts fetch state. "pending" gates the prune/default below so a
  // persisted destination isn't touched before the list is known; only "ok"
  // (the fetch actually SUCCEEDED) may prune or default — a failed fetch
  // ("error") must never act on an empty/unknown linked list, that was the
  // deploy-window bug that wiped everyone's "all" (spec: Send-to). A failed
  // RE-fetch never downgrades "ok" (the list it loaded still stands).
  const [fetchStatus, setFetchStatus] = useState<"pending" | "error" | "ok">("pending");
  // WHICH destination the user explicitly chose — not merely THAT they chose
  // one. `undefined` = never chosen; `null` = they explicitly chose native.
  //
  // A boolean is not enough. The prune lives in TWO halves with different
  // triggers: the render half keys on `forcedDest` and runs every render, the
  // storage half keys on the stored string and only runs when [fetchStatus,
  // destCycle, canEncrypt] change. Any render that moves `forcedDest` out of the
  // cycle WITHOUT the cycle changing therefore runs the render prune alone —
  // and only the storage half clears a flag. The persist effect would then fire
  // on the forcedDest→null transition with the flag still true and write
  // "native" for someone who had chosen a PLATFORM, which permanently blocks
  // the "all" default (its gate is the key being null).
  //
  // Recording the VALUE closes it structurally: the persist effect writes only
  // when the choice and the live destination still agree, so a prune — which
  // moves one and not the other — can never masquerade as a choice. Reachable
  // at least via `restoreDisplaced` re-arming the flag with a since-pruned
  // destination, and via arming 🔒 while `canEncrypt` is false.
  const chosenDest = useRef<string | null | undefined>(undefined);
  // Guards the one-time default so cycling back to native (an explicit choice)
  // sticks instead of being re-defaulted on the next render/load.
  const defaulted = useRef(false);

  // Load the user's linked cross-post destinations, and reload when the Linked
  // Accounts panel links/unlinks in this tab (it fires "bb:accounts-changed")
  // so the toggle doesn't offer a just-unlinked platform until refresh.
  //
  // ONE RETRY BEFORE GIVING UP. "error" is terminal for the whole session:
  // the default effect below requires "ok", so a single failed call leaves a
  // user with linked platforms sitting on `forcedDest === null` — the composer
  // reads "send to: <site>" until they reload, an intermittent "defaults to
  // site-only on page load" that heals on the next load. One request is not
  // evidence that an account has no links; it is evidence that one request
  // failed. A transient 401 during a MAS token refresh is enough.
  // The retry must NOT downgrade an "ok" — a later failed refetch keeps the
  // list it already loaded, same rule as `load()`'s own finally.
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Has any load SUCCEEDED? Tracked here rather than read back out of
    // `fetchStatus`, because scheduling the retry from inside a setState updater
    // would double-schedule it — React may invoke an updater more than once.
    let succeeded = false;
    const load = (isRetry = false) => {
      getJson<{ accounts?: { platform: string }[] }>("/api/account-links")
        .then(d => {
          if (cancelled || !d.accounts) return;
          succeeded = true;
          const linked = new Set<string>(d.accounts.map(a => a.platform).filter(canCrossPost));
          setLinkedDests(DEST_ORDER.filter(p => linked.has(p)));
          setFetchStatus("ok");
        })
        .catch(() => {})
        .finally(() => {
          if (cancelled || succeeded) return;
          // First failure: stay "pending" and try once more. Pending is the safe
          // state — it prunes nothing and defaults nothing, so the retry window
          // cannot itself cause a wrong destination.
          if (!isRetry) {
            retry = setTimeout(() => { retry = null; load(true); }, RETRY_MS);
            return;
          }
          setFetchStatus(s => (s === "pending" ? "error" : s));
        });
    };
    const reload = () => load();
    load();
    window.addEventListener("bb:accounts-changed", reload);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      window.removeEventListener("bb:accounts-changed", reload);
    };
  }, []);

  // The destinations the menu offers, in order: native → each linked
  // destination → "all" (offered from ONE linked platform up — even when the
  // only real difference between `send to: all` and `send to: twitch` is the
  // visual formatting). This also sets the DEFAULT: `defaultDest` takes the
  // list's last entry, so every linked user lands on "all" — linked accounts
  // default to cross-posting (owner decision; said at linking time and in the
  // linking panel, crossPostCopy.ts).
  // 🔒 is NOT in the list. It is armed only from the tools popover or `/r`.
  // While it IS armed, the button disarms it — see SendToButton's `onDisarm`.
  //
  // Supporters only. A lapsed subscription drops it, and the prune below then
  // moves a stored 🔒 back to native on the next successful account-links fetch.
  //
  // THE HELP DESK IS NOT IN HERE. A destination answers *where does this
  // message go*; the help desk is *who am I talking to instead*. It has its own
  // button and its own boolean — see `supportArmed` below.
  const destCycle = useMemo<(string | null)[]>(() => {
    const c: (string | null)[] = [null];
    c.push(...linkedDests);
    if (linkedDests.length >= 1) c.push("all");
    return c;
  }, [linkedDests]);

  // What a stored/live destination may legitimately be: the cycle, plus 🔒 for
  // a Supporter. The prune judges against THIS, not the cycle — 🔒 is not in
  // the cycle but is still a real state, and pruning it would disarm it on the
  // next account-links fetch.
  const offered = useMemo<(string | null)[]>(
    () => (canEncrypt ? [...destCycle, ENCRYPTED_DEST] : destCycle),
    [destCycle, canEncrypt],
  );

  // Drop a sticky destination that's no longer offered (account unlinked, or a
  // stale/persisted value) back to native — but only on a SUCCESSFUL fetch, so
  // a failed fetch (e.g. a deploy-window blip) never wipes the user's choice.
  //
  // State adjust during render (no effect pass) — this half is unchanged.
  if (
    fetchStatus !== "pending" && forcedDest &&
    shouldPrune(forcedDest, offered, fetchStatus === "ok", canEncrypt != null)
  ) setForcedDest(null);

  // ...and the STORED copy is disowned separately, on its own merits. A render
  // pass may neither write refs nor touch storage, so a prune that only drops
  // the live value leaves the other two thirds of the cleanup undone:
  //   • the CHOICE would survive, so the persist effect below would
  //     immediately write "native" for someone who had chosen a PLATFORM —
  //     permanent: a stored "native" blocks the "all" default on every later
  //     load.
  //   • the STORED string would survive, and the one-time default is gated on
  //     that key being null — so the default would be blocked by the very value
  //     the prune had just rejected. Stored "kick" + linked twitch ⇒ "send to:
  //     <site>" on every refresh, forever — presenting as browser-specific,
  //     because it depends entirely on what one profile happens to have stored.
  //
  // Keyed on the STORED value, not on `forcedDest`. Three reasons, all
  // load-bearing:
  //   • it is what the default effect actually reads, so it is the thing whose
  //     staleness causes the bug;
  //   • it keeps this effect free of setState, so it neither cascades renders
  //     nor trips `react-hooks/set-state-in-effect` (an ERROR in the lint gate)
  //     the way a forcedDest-keyed version does;
  //   • SENTINELS are never persisted, so an armed 🔒 leaving the cycle can
  //     never reach this code — the key still holds the real destination 🔒
  //     displaced, which is judged on its own merits and correctly left alone.
  // Declared BEFORE the default and persist effects so it runs first in the
  // same commit: the default sees a cleared key, the persist a cleared choice.
  useEffect(() => {
    const storedDest = wsGet("chatTargetDest");
    // "native" is the STORED SPELLING of `null`, not a cycle entry — the
    // cycle carries `null` for it — so `shouldPrune` finds it "missing" every
    // single time and would delete every explicit native choice on sight. It is
    // also the one destination that can never go stale: native is always
    // available. The render-phase prune never meets this case because it keys
    // on `forcedDest`, which is `null` for native and short-circuits.
    if (
      storedDest && storedDest !== "native" &&
      shouldPrune(storedDest, offered, fetchStatus === "ok", canEncrypt != null)
    ) {
      chosenDest.current = undefined;
      wsClear("chatTargetDest");
    }
  }, [fetchStatus, offered, canEncrypt]);

  // Default to the most-linked destination the cycle offers, once, the first
  // time we have a real (successful) linked-accounts list and the user has
  // neither an explicit stored choice nor already cycled this session. An
  // effect, not a render-phase adjustment like the prune above: it mutates a
  // ref, and React's rules disallow reading/writing refs during render (only
  // state may be adjusted there).
  //
  // The last clause asks whether there is a REAL destination to default to,
  // not how long the cycle is. `destCycle.length > 1` is satisfied vacuously by
  // the sentinels: a Supporter with no linked platforms has cycle [null, 🔒], so
  // the one-shot `defaulted` would latch against a cycle offering nothing, and
  // the default could never fire again after they linked a platform.
  // `defaultDest` already filters sentinels, so asking it directly is both
  // correct and derived — one fewer number that can disagree with the cycle it
  // describes.
  useEffect(() => {
    if (
      fetchStatus === "ok" && !defaulted.current &&
      wsGet("chatTargetDest") == null && forcedDest === null &&
      defaultDest(destCycle) !== null
    ) {
      defaulted.current = true;
      setForcedDest(defaultDest(destCycle));
    }
  }, [fetchStatus, forcedDest, destCycle]);

  /**
   * The destination 🔒 displaced, so a sent redacted message can put back what
   * the user actually had. `undefined` = nothing captured (not armed). `dest`
   * null is a real captured value meaning native.
   *
   * `chosen` — was the displaced value itself an explicit user choice? — is
   * the half that keeps a round trip clean. A sentinel can be armed BEFORE the
   * linked-accounts fetch has applied the "all" default, so it displaces
   * `null`. Restoring that null as an explicit choice would persist "native"
   * for a user who never chose anything — which then blocks the "all" default
   * on every later load (its gate is the key being null). Restoring the CHOICE
   * along with the value makes an arm→leave round trip leave zero trace:
   * nothing persists, and the one-time default can still fire.
   *
   * There is no second one of these for support: the help desk is not a
   * destination, so it displaces nothing — see `supportArmed`.
   */
  type Displaced = { dest: string | null; chosen: boolean };
  const preEncrypt = useRef<Displaced | undefined>(undefined);
  // 🔒 is not in the cycle, so it is only ever armed by a direct jump, which
  // displaces exactly what is held — there is no tap-gesture pass-through to
  // track.

  // Every explicit choice funnels through here, so the sentinel bookkeeping
  // cannot be forgotten by whoever adds the next caller. Capture only on the way
  // IN — re-arming an already-armed 🔒 keeps the ORIGINAL captured value and
  // never records the sentinel itself.
  const applyDest = (next: string | null) => {
    const prev = preEncrypt.current;
    const realPrior: Displaced =
      forcedDest === ENCRYPTED_DEST
        ? (prev ?? { dest: null, chosen: false })
        // `chosenDest.current === forcedDest`, not merely "a choice exists".
        // If a prune has moved `forcedDest` out from under the recorded choice
        // the two disagree, and what we are capturing is the PRUNED value —
        // which nobody chose. Same predicate the persist effect uses, for the
        // same reason.
        : { dest: forcedDest, chosen: chosenDest.current === forcedDest };
    preEncrypt.current =
      next === ENCRYPTED_DEST ? (forcedDest === ENCRYPTED_DEST ? prev : realPrior) : undefined;
    // Arming 🔒 is entering a MODE, not choosing a destination. The recorded
    // choice only moves for real destinations; the sentinel is never persisted
    // regardless, so nothing is lost by leaving it alone here.
    if (next !== ENCRYPTED_DEST) chosenDest.current = next;
    setForcedDest(next);
  };

  // THE restore path for 🔒 — put back exactly what was displaced, value AND
  // choice. Falling straight to `defaultDest` would SILENTLY CHANGE the user's
  // sticky destination: choose Twitch, seal one message, and the composer
  // comes back on "all" — persisted, because it counted as a choice. And
  // restoring an UN-chosen prior as if chosen would persist "native" for users
  // who only ever had the default. A restore is a return to the status quo,
  // not a fresh choice — it persists exactly what the status quo would have
  // persisted, which can be nothing.
  const restoreDisplaced = (ref: { current: Displaced | undefined }) => {
    const prior = ref.current;
    ref.current = undefined;
    if (prior !== undefined) {
      // An un-chosen prior restores `undefined`, not the value. Recording the
      // value here would make the persist effect agree with itself and write a
      // choice the user never made.
      chosenDest.current = prior.chosen ? prior.dest : undefined;
      setForcedDest(prior.dest);
      return;
    }
    // Defensive only (arming always captures): the computed default, without
    // persisting it — defaults re-derive every load rather than being written.
    // defaultDest filters the sentinel out itself, so a Supporter with no
    // linked platforms (cycle [null, 🔒]) can never be handed 🔒 back here.
    chosenDest.current = undefined;
    setForcedDest(defaultDest(destCycle));
  };

  // ── The help desk: a MODE, not a destination ────────────────────────────────
  //
  // Support mode lives entirely outside `forcedDest`. As a cycle entry it would
  // have to be armed, displaced, captured, restored and exempted from the
  // prune, and every one of those is a way to corrupt the destination of a
  // message. Instead the destination is simply UNTOUCHED while you talk to the
  // help desk, so leaving support cannot write anything at all — there is
  // nothing to put back.
  const [supportArmed, setSupportArmed] = useState(false);
  const armSupport = () => setSupportArmed(true);
  const leaveSupport = () => setSupportArmed(false);

  // Choose a destination by name — the Send-to menu, or the tools popover's
  // "Redacted message" row. The ONLY way a destination changes by hand, so every
  // stored value is one somebody picked: it persists, and it cannot be
  // re-defaulted away on the next load.
  const setDest = (d: string | null) => applyDest(d);

  // Disarm 🔒 back to what it displaced: 🔒 is the one mode that does NOT
  // stick. Everything else on the toggle is a mode you keep until you change
  // it; redaction is a thing you do to one message, and leaving it armed would
  // silently seal the next one — which, with a cooldown behind it, would be
  // refused rather than sent. Runs after a successful redacted send and on the
  // popover's toggle-off.
  const resetDest = () => restoreDisplaced(preEncrypt);

  // Persist the chosen target across sessions — but ONLY an explicit user
  // choice, never the one-time default. Persisting the default would write
  // e.g. "twitch" for a 1-linked-platform user as if they'd picked it, which
  // then blocks the "all" default from ever applying after they link a second
  // platform (the default effect above is gated on the key being null).
  // Leaving the default un-persisted lets it re-derive every load; `defaulted`
  // still prevents in-session flapping. An explicit choice of native writes the
  // "native" sentinel rather than clearing the key — otherwise the default
  // would just re-apply on the next load.
  //
  // THE GUARD: the recorded choice must still MATCH the live destination. A
  // prune moves `forcedDest` and leaves the choice where it was, so the two
  // disagree and nothing is written — a boolean could not tell a prune from a
  // decision and would write "native" over a platform the user had actually
  // picked. Picking native still persists, because `applyDest(null)` records
  // `null` and the two agree.
  useEffect(() => {
    if (chosenDest.current === undefined) return;
    if (chosenDest.current !== forcedDest) return;
    // 🔒 IS NEVER PERSISTED. Arming it goes through an explicit-choice path,
    // so writing it here the INSTANT it is armed — while the disarm
    // (`resetDest`) only runs after a SUCCESSFUL send — would make every arm
    // that does not end in a successful send stick forever and re-arm the
    // composer on the next load. The two ways in are ordinary: arm it and
    // change your mind, or arm it and have the send REFUSED by the cooldown
    // (the refusal deliberately leaves the toggle armed so the draft can be
    // retried — see ChatInput). Skipping the write leaves the stored value at
    // whatever real destination 🔒 displaced, which is what should come back
    // on the next load.
    // Do NOT "fix" the underlying stickiness by disarming on a failed send —
    // that turns a cooldown retry into a plaintext message.
    // (Support needs no skip here: `supportArmed` is separate state and never
    // reaches this effect.)
    if (forcedDest === ENCRYPTED_DEST) return;
    // Every choice is durable, native included: it was picked by name from the
    // menu, so it is never a pass-through (see NATIVE_AMNESTY_LATCH).
    wsSet("chatTargetDest", forcedDest ?? "native");
  }, [forcedDest]);

  // `linkedDests` is exposed as well as the menu's list because the two answer
  // different questions: the list is what the menu offers (it also carries the
  // native null and the "all" pseudo-destination), while this is strictly
  // "platforms this person can actually post to" — which is what gates the
  // `/twitch`-family slash commands.
  return {
    forcedDest, destCycle, linkedDests, setDest, resetDest,
    supportArmed, armSupport, leaveSupport,
  };
}
