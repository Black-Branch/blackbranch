"use client";

import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { useMatrixSettings } from "@/app/lib/useMatrixSettings";

// The hook-bearing half of SecureAccountPrompt, split into its own chunk:
// useMatrixSettings drags in the matrix-js-sdk crypto stack, and this only
// renders for a signed-in, synced client that hasn't dismissed the prompt —
// the outer component gates all of that before importing this file.
export default function SecureAccountPromptInner({ onDismiss }: { onDismiss: () => void }) {
  // consumeVerification: false — this mount only reads flowState. With the
  // default it would take the incoming verification request away from Devices
  // & Security and render nothing for it.
  const { flowState } = useMatrixSettings({ consumeVerification: false });
  const needs = flowState === "setup" || flowState === "restore" || flowState === "orphaned";
  if (!needs) return null;

  function secure() {
    // dispatchClaimable, not a bare CustomEvent: the hub's one-host guard
    // reads defaultPrevented, which only a cancelable event carries
    // (useUserMenuEvents.ts).
    dispatchClaimable("bb:open-account-settings");
    onDismiss();
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[calc(var(--z-nudge)_+_20)] p-3 pointer-events-none">
      <div
        className="pointer-events-auto mx-auto max-w-md rounded-xl glass px-3 py-3 modal-in pb-safe"
        // The pop-ups' glass look (round 2a — Card fill is gone). Amber = "act
        // on this" (security); inline because .glass's own border is unlayered
        // and would beat a Tailwind border utility.
        style={{
          borderColor: "rgb(251 191 36 / 0.2)",
          ["--safe-min" as string]: "0.75rem",
        }}
      >
        <div className="flex items-start gap-2.5">
          <span className="text-amber-300 text-base leading-none mt-0.5">🔒</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-strong font-medium">Secure your account</p>
            <p className="text-2xs text-secondary leading-snug mt-0.5">
              Private rooms are end-to-end encrypted. Set up encryption and{" "}
              <span className="text-body">save your recovery key</span> — it’s the only way to read
              your encrypted history if you sign in on a new device. You’ll also verify this device so
              others know it’s really you.
            </p>
          </div>
          <button onClick={onDismiss} className="shrink-0 text-muted hover:text-strong text-sm px-1" aria-label="Later">
            ✕
          </button>
        </div>
        <div className="flex justify-end gap-2 mt-2.5">
          <button onClick={onDismiss} className="px-3 py-1.5 text-xs text-secondary hover:text-strong hover:bg-surface-1 rounded-lg transition-colors">
            Later
          </button>
          <button
            onClick={secure}
            className="px-3 py-1.5 text-xs font-semibold text-on-accent rounded-lg hover:brightness-110 transition-all"
            style={{ backgroundColor: "var(--accent)" }}
          >
            Secure my account
          </button>
        </div>
      </div>
    </div>
  );
}
