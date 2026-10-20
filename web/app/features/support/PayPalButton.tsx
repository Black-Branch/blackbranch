"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { rememberPayMethod } from "./payMethod";
import { paypalSandbox } from "@/app/lib/paypalSdkEnv";
import type { TipDraft } from "./types";

// PayPal's own gold/blue button, the PayPal/Venmo half of the split tip
// button. The tip form STAYS mounted beside it (PayPal is a first-class
// choice, not a separate screen), so this component itself guarantees the
// order matches what the person sees:
//
//   - The button is rendered from `paypal.Buttons(...)` ONCE per (sdk ready,
//     funding source) — never on a `draft`/`valid` change, which would also
//     kill an open popup mid-approval. `getDraft`/`valid`/`onLockChange`/
//     `onCaptured` are read through refs, kept current by an effect with NO
//     dependency array (runs after every render), so `onClick`/`createOrder`
//     always see the LATEST props without being in the render-once effect's
//     dependency list.
//   - `onClick` is the one moment the amount can still change: if `valid` is
//     false it rejects (PayPal's own SDK then never opens the popup). If
//     valid, it SNAPSHOTS the draft into a ref and locks the caller
//     (`onLockChange(true)`) — from here on, `createOrder` sends that
//     snapshot, never a live re-read of `getDraft()`, so the order and
//     whatever the person sees on screen cannot diverge even though the form
//     never unmounted.
//   - Unlocks on `onCancel`, `onError`, a failed/throwing `createOrder`, and a
//     failed capture. A SUCCESSFUL capture calls `onCaptured()` and does NOT
//     unlock — the caller is expected to move on (DonateClient/SupportContent
//     switch to their "done" view), and re-enabling a form that is about to
//     be replaced only invites a second submit in the gap.
//
// `actions.disable()` (PayPal's own SDK) does NOT change how the button
// LOOKS, so a disabled button is greyed here: the wrapping div gets
// `opacity-50 pointer-events-none` plus `aria-disabled` whenever `!valid`,
// independent of the onClick guard above. The visual state and the actual
// guard are two different mechanisms on purpose, so a CSS regression cannot
// silently reopen a way to pay an invalid amount.
//
// `onApprove` grants nothing and writes nothing by itself — it POSTs to our
// own capture route, which calls PayPal's capture API server-side. The
// capture route in turn writes NOTHING to the database either: the webhook
// (app/api/billing/paypal/webhook/route.ts) is the ONLY writer of PayPal
// payment state. `onCaptured()` just tells the caller the tip is on its way —
// it must never claim the tip is "recorded" or "on stream", because the
// webhook is what actually records it, whenever it arrives.
//
// Nothing here ever reads what PayPal returns about the payer — pinned by
// payerName.scan.test.ts, which scans this file by name.

const SDK_ORIGIN = "https://www.paypal.com/sdk/js";
const SCRIPT_ID = "paypal-sdk-script";

function sdkUrl(clientId: string): string {
  const params = new URLSearchParams({
    "client-id": clientId,
    currency: "USD",
    intent: "capture",
    components: "buttons",
    "enable-funding": "venmo",
    // Both exclusions below are deliberate:
    //   paylater — offers to finance a tip. Not what this page is for.
    //   card     — routes a card tip through PayPal at PayPal's rates, when
    //              the split button's own Card half already takes cards
    //              through Stripe (cheaper, and it's the path that
    //              remembers a signed-in tipper's saved card). A second,
    //              worse card route under the same ▾ is not a fallback,
    //              it's a fee leak.
    "disable-funding": "paylater,card",
  });
  // Sandbox only: present as a US buyer so Venmo (US-only) can be tested.
  // PayPal rejects buyer-country on live, so it is added only on a sandbox answer.
  if (paypalSandbox()) params.set("buyer-country", "US");
  return `${SDK_ORIGIN}?${params.toString()}`;
}

type PaypalOnClickActions = { resolve?: () => unknown; reject?: () => unknown };
type PaypalButtonsConfig = {
  fundingSource: string;
  style: { height: number; shape: string; borderRadius: number; color?: string };
  onClick: (data: unknown, actions: PaypalOnClickActions | undefined) => unknown;
  createOrder: () => Promise<string>;
  onApprove: (data: { orderID: string }) => Promise<void>;
  onError: (err: unknown) => void;
  onCancel: () => void;
};
type PaypalGlobal = {
  Buttons: (config: PaypalButtonsConfig) => { render: (el: HTMLElement) => void; close?: () => void; isEligible?: () => boolean };
  FUNDING: { PAYPAL: string; VENMO: string };
};

function getPaypalGlobal(): PaypalGlobal | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { paypal?: PaypalGlobal }).paypal ?? null;
}

type SdkStatus = "idle" | "loading" | "ready" | "failed" | "retrying";

// ── One SDK load, shared by every consumer ──────────────────────────────
//
// A <script> element fires `error` (or `load`) EXACTLY ONCE, ever. With two
// consumers on one page (TipPayButton's preloading call plus a PayPalButton
// that mounts once a method is chosen), per-instance status plus listeners
// attached to an already-present tag means a late mounter never hears the
// event: it sits on "loading" forever and its failed view + retry button is
// unreachable.
//
// So there is only ONE status. `sdkStatus` below is module-scope, and every
// `usePaypalSdk()` call (any component, any mount time) reads the SAME value
// through `useSyncExternalStore` — the sanctioned pattern for external state
// in this repo (see app/lib/useClientState.ts's header). A component that
// mounts AFTER a failure reads "failed" on its very first render, and a
// `retry()` from ANY consumer moves everyone through "retrying" together, so
// no stale per-instance listener keeps reporting Venmo ineligible after a
// successful retry.
let sdkStatus: SdkStatus = getPaypalGlobal() ? "ready" : "idle";
let sdkClientId: string | null = null;
const sdkListeners = new Set<() => void>();

function notifySdkListeners() {
  for (const fn of sdkListeners) fn();
}

function setSdkStatus(next: SdkStatus) {
  sdkStatus = next;
  notifySdkListeners();
}

function subscribeSdk(cb: () => void): () => void {
  sdkListeners.add(cb);
  return () => { sdkListeners.delete(cb); };
}

function getSdkSnapshot(): SdkStatus {
  return sdkStatus;
}

function getSdkServerSnapshot(): SdkStatus {
  return "idle";
}

/** Creates the `<script>` tag and wires its `load`/`error` straight to the
 *  shared status — called exactly once per real load attempt (the initial
 *  one from `ensureSdkLoad`, or a fresh one from `retry()`). */
function beginSdkScriptLoad(clientId: string) {
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = sdkUrl(clientId);
  script.async = true;
  script.addEventListener("load", () => setSdkStatus("ready"), { once: true });
  script.addEventListener("error", () => setSdkStatus("failed"), { once: true });
  document.body.appendChild(script);
}

/** Idempotent — safe for every consumer that wants the SDK loaded to call on
 *  every mount/enable. Only the FIRST call (status still "idle") actually
 *  creates anything; every later call, from any component, is a no-op,
 *  because the shared status already answers for it. */
function ensureSdkLoad(clientId: string) {
  sdkClientId = clientId;
  if (getPaypalGlobal()) {
    if (sdkStatus !== "ready") setSdkStatus("ready");
    return;
  }
  if (sdkStatus !== "idle") return; // already loading/ready/failed/retrying — nothing to start
  setSdkStatus("loading");
  beginSdkScriptLoad(clientId);
}

function retrySdkLoad() {
  // A clean slate — remove any existing (possibly stuck/blocked) script tag
  // before re-injecting; a blocker being turned off is the only reason a
  // retry can succeed. Bypasses `ensureSdkLoad`'s idle-only guard on
  // purpose: retry must always start a fresh attempt regardless of the
  // current (failed) status.
  document.getElementById(SCRIPT_ID)?.remove();
  setSdkStatus("retrying");
  beginSdkScriptLoad(sdkClientId ?? "");
}

/** @test-only resets the module-shared SDK load state between tests — with
 *  no other way to reset it, state leaked by one test reads as still-loaded
 *  (or still-failed) in the next one. Called from `beforeEach` in every test
 *  file that touches `usePaypalSdk`. */
export function _resetPaypalSdkForTests(): void {
  sdkStatus = getPaypalGlobal() ? "ready" : "idle";
  sdkClientId = null;
  sdkListeners.clear();
}

/** Loads the PayPal SDK script, mirroring useStripe.ts's shape: a
 *  failed/blocked load is state a component can render, never a silent empty
 *  box, and a retry re-injects a fresh <script> tag — a blocker being turned
 *  off is a real reason a retry can succeed. No new npm dependency
 *  (@paypal/react-paypal-js is deliberately not added).
 *
 *  `enabled` lets a CALLER other than the button itself start the load early
 *  — TipPayButton.tsx does this the moment the ▾ menu opens, or at mount for
 *  a remembered paypal/venmo preference, so the SDK is often already "ready"
 *  by the time a PayPalButton actually mounts. When `enabled` is false this
 *  particular call does not itself START a load — it just reads whatever the
 *  SHARED status already is (see above), because another consumer may well
 *  already have started one. */
export function usePaypalSdk(clientId: string, enabled: boolean): { status: SdkStatus; retry: () => void } {
  const status = useSyncExternalStore(subscribeSdk, getSdkSnapshot, getSdkServerSnapshot);

  useEffect(() => {
    if (!enabled) return;
    ensureSdkLoad(clientId);
  }, [clientId, enabled]);

  return { status, retry: retrySdkLoad };
}

/** False unless the SDK is loaded AND PayPal itself reports Venmo eligible
 *  for this browser/region. TipPayButton.tsx uses this to decide whether the
 *  ▾ menu offers a Venmo row at all, and whether a REMEMBERED "venmo"
 *  preference should fall back to "paypal". */
export function venmoEligible(): boolean {
  const paypal = getPaypalGlobal();
  if (!paypal) return false;
  try {
    return Boolean(paypal.Buttons({ fundingSource: paypal.FUNDING.VENMO } as PaypalButtonsConfig).isEligible?.());
  } catch {
    return false;
  }
}

export function PayPalButton({
  clientId,
  fundingSource,
  valid,
  getDraft,
  onLockChange,
  onCaptured,
  purpose = "tip",
}: {
  clientId: string;
  fundingSource: "paypal" | "venmo";
  valid: boolean;
  getDraft: () => TipDraft;
  onLockChange: (locked: boolean) => void;
  onCaptured: () => void;
  /** What the order is for — "points" posts the quiet points-purchase order body
   *  instead of the tip body. TipForm passes "points" when its own
   *  Announce switch is off; everything else is a tip. */
  purpose?: "tip" | "points";
}) {
  const { status, retry } = usePaypalSdk(clientId, true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The "latest ref" pattern: kept current after EVERY render (no dependency
  // array), read only from inside the callbacks below, which live in an
  // effect that deliberately does NOT depend on these — see the file header.
  const validRef = useRef(valid);
  const getDraftRef = useRef(getDraft);
  const onLockChangeRef = useRef(onLockChange);
  const onCapturedRef = useRef(onCaptured);
  const purposeRef = useRef(purpose);
  const draftSnapshotRef = useRef<TipDraft | null>(null);
  useEffect(() => {
    validRef.current = valid;
    getDraftRef.current = getDraft;
    onLockChangeRef.current = onLockChange;
    onCapturedRef.current = onCaptured;
    purposeRef.current = purpose;
  });

  // Render ONCE per (sdk ready, funding source) — see file header. `draft`
  // must NEVER be a dependency here: re-rendering on every keystroke would
  // also kill an open popup mid-approval.
  useEffect(() => {
    if (status !== "ready") return;
    const el = containerRef.current;
    if (!el) return;
    const paypal = getPaypalGlobal();
    if (!paypal) return;
    el.replaceChildren();

    const buttons = paypal.Buttons({
      fundingSource: fundingSource === "venmo" ? paypal.FUNDING.VENMO : paypal.FUNDING.PAYPAL,
      // `color` omitted (Venmo) defaults to Venmo blue. Radius 0:
      // the wrapper below rounds the left edge; the right meets the ▾ flush.
      style:
        fundingSource === "paypal"
          ? { height: 40, shape: "rect", borderRadius: 0, color: "gold" }
          : { height: 40, shape: "rect", borderRadius: 0 },
      onClick: (_data, actions) => {
        // Nothing here assumes more of `actions` than `reject` (the docs
        // name resolve/reject; nothing beyond that is relied on). The valid
        // path deliberately calls nothing on `actions` — PayPal's own SDK
        // proceeds to open the popup when onClick doesn't reject.
        if (!validRef.current) return actions?.reject?.();
        draftSnapshotRef.current = getDraftRef.current();
        rememberPayMethod(fundingSource);
        onLockChangeRef.current(true);
      },
      createOrder: async () => {
        setErr(null);
        const draft = draftSnapshotRef.current;
        if (!draft) {
          // onClick never fired (or rejected) — nothing was ever snapshotted.
          // Defensive only: the real SDK never calls createOrder without a
          // preceding, resolved onClick.
          throw new Error("no draft snapshot — onClick did not run first");
        }
        let res: Response;
        try {
          // `fundingSource` names the pressed button: the order route builds
          // payment_source.<paypal|venmo> from it (where NO_SHIPPING lives).
          res = await postJson("/api/billing/paypal/order",
            purposeRef.current === "points"
              ? { purpose: "points", amount: draft.amount, fundingSource }
              : {
                  amount: draft.amount,
                  message: draft.message.trim() || undefined,
                  displayName: draft.displayName,
                  anonymous: draft.anonymous,
                  fundingSource,
                });
        } catch (e) {
          // A network failure (offline, DNS, refused) rejects `postJson`'s
          // underlying `fetch` itself — this never reaches the `!res.ok`
          // branch below. Caught and handled HERE rather than left to the
          // SDK, because whether a rejected `createOrder` routes into
          // `onError` is undocumented SDK behaviour. Unlock locally,
          // then rethrow so the SDK's own popup handling also sees it fail.
          setErr("Network error. Try again.");
          onLockChangeRef.current(false);
          throw e;
        }
        if (!res.ok) {
          // A 400 here is a rejection the route wrote FOR the person reading
          // it, same shape as DonateClient.startCheckout.
          const message =
            res.status === 400
              ? (await res.text()) || "Something went wrong. Try again."
              : res.status === 401
                ? (await res.text()) || "Sign in to continue."
                : res.status === 503
                  ? "Billing isn’t set up yet."
                  : res.status === 429
                    ? "Too many attempts — try again in a few minutes."
                    : "Something went wrong. Try again.";
          setErr(message);
          onLockChangeRef.current(false);
          throw new Error(message); // tells the SDK the order failed to open
        }
        const body = (await res.json().catch(() => null)) as { orderId?: string } | null;
        if (!body?.orderId) {
          setErr("Couldn’t start checkout.");
          onLockChangeRef.current(false);
          throw new Error("no orderId returned");
        }
        return body.orderId;
      },
      onApprove: async (data) => {
        setBusy(true);
        setErr(null);
        try {
          const res = await postJson("/api/billing/paypal/capture", { orderId: data.orderID });
          if (!res.ok) {
            setErr(`Something went wrong finishing the ${purposeRef.current === "points" ? "purchase" : "tip"}. Try again.`);
            onLockChangeRef.current(false);
            return;
          }
          onCapturedRef.current();
        } catch {
          setErr("Network error. Try again.");
          onLockChangeRef.current(false);
        } finally {
          setBusy(false);
        }
      },
      onError: (err) => {
        // PayPal routes a popup CLOSED before approval through `onError`
        // with "Detected popup close" — not `onCancel`, despite this being exactly the case `onCancel` exists
        // for: the tipper simply closed the window. Every OTHER onError
        // still shows the generic error.
        const message = err instanceof Error ? err.message : String(err);
        if (/popup close/i.test(message)) {
          setErr(null);
          onLockChangeRef.current(false);
          return;
        }
        setErr("Something went wrong. Try again.");
        onLockChangeRef.current(false);
      },
      onCancel: () => {
        // Cancel is NOT an error — the tipper simply closed the popup.
        setErr(null);
        onLockChangeRef.current(false);
      },
    });
    buttons.render(el);
    return () => { buttons.close?.(); };
  }, [status, fundingSource]);

  if (status === "failed" || status === "retrying") {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-sm text-body">We couldn’t load PayPal.</p>
        <p className="text-xs text-secondary">
          An ad blocker, privacy filter or network blocklist is usually what stops it. Nothing has
          been charged.
        </p>
        <button
          type="button"
          onClick={retry}
          disabled={status === "retrying"}
          className="rounded-lg bg-raised px-4 py-2 text-sm font-medium text-heading hover:bg-control transition-colors disabled:opacity-60"
        >
          {status === "retrying" ? "Trying…" : "Try again"}
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 ${!valid ? "opacity-50 pointer-events-none" : ""}`} aria-disabled={!valid || undefined}>
      {(status === "idle" || status === "loading") && <LoadingState className="py-4" label="Loading PayPal…" />}
      {/* `scheme-light` (color-scheme: light) removes white corners: the site is
          `color-scheme: dark`, PayPal's iframe document is not, and a browser
          gives an iframe whose scheme differs from its document's an OPAQUE
          white canvas, which shows through wherever PayPal's button is
          rounded. Matching the scheme makes the canvas transparent again;
          clipping alone hides only the left corners.
          `borderRadius: 0` in the SDK style squares the right edge so it
          meets the ▾ flush; this wrapper rounds the left. `h-10` matches the
          SDK `style.height` exactly. */}
      <div className="h-10 overflow-hidden rounded-l-lg scheme-light">
        <div ref={containerRef} />
      </div>
      {busy && (
        <p className="text-xs text-secondary">
          {purpose === "points" ? "Confirming your purchase…" : "Confirming your tip…"}
        </p>
      )}
      {err && (
        <p role="alert" className="text-xs text-red-400">
          {err}
        </p>
      )}
    </div>
  );
}
