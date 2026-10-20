"use client";

import { useState } from "react";
import { usePwaInstall } from "@/app/lib/usePwaInstall";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { useClientValue } from "@/app/lib/useClientState";
import { Q_POINTER_COARSE } from "@/app/lib/deviceQueries";
import { siteName } from "@/app/lib/siteName";

// Dismissible bottom banner nudging mobile users to install the site as an app.
// Android/Chrome gets a one-tap Install button (deferred beforeinstallprompt);
// iOS gets the manual Share → Add to Home Screen hint. Hidden once installed
// (standalone), once dismissed, or on non-touch devices.

const DISMISSED_KEY = "bb_pwa_nudge_dismissed";

export default function PwaInstallNudge() {
  const { canInstall, promptInstall, isStandalone, isIos } = usePwaInstall();
  // Hidden during SSR (dismissed=true fallback), then driven by the stored flag
  // and the pointer capability — no mount-effect setState, no flash.
  const lsDismissed = useClientValue(() => !!lsGet(DISMISSED_KEY), true);
  const [dismissedNow, setDismissedNow] = useState(false);
  const dismissed = lsDismissed || dismissedNow;
  const mobile = useClientValue(
    () => window.matchMedia?.(Q_POINTER_COARSE)?.matches === true,
    false
  );

  function dismiss() {
    lsSet(DISMISSED_KEY, "1");
    setDismissedNow(true);
  }

  // Show only on touch devices, not yet installed, not dismissed, and only when we
  // actually have something to offer (a real prompt, or iOS manual steps).
  if (dismissed || isStandalone || !mobile || !(canInstall || isIos)) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[calc(var(--z-nudge)_+_10)] p-3 pointer-events-none">
      <div
        className="pointer-events-auto mx-auto max-w-md flex items-center gap-3 rounded-xl glass px-3 py-2.5 modal-in pb-safe"
        style={{
          ["--safe-min" as string]: "0.625rem",
        }}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm text-strong font-medium">Install {siteName()}</p>
          <p className="text-2xs text-secondary leading-snug">
            {canInstall
              ? "Add it to your home screen for a full-screen, app-like experience."
              : "Tap Share, then “Add to Home Screen” to use it like an app."}
          </p>
        </div>
        {canInstall && (
          <button
            onClick={() => promptInstall()}
            className="shrink-0 px-3 py-1.5 text-xs font-semibold text-on-accent rounded-lg hover:brightness-110 transition-all"
            style={{ backgroundColor: "var(--accent)" }}
          >
            Install
          </button>
        )}
        <button onClick={dismiss} className="tap-hit-44 shrink-0 text-muted hover:text-strong text-sm px-1" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}
