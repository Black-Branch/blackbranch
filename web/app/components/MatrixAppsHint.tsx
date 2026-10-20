"use client";

import { useState, useEffect } from "react";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { MatrixAppsList } from "./MatrixAppsList";
import { Q_POINTER_COARSE } from "@/app/lib/deviceQueries";
import { siteName } from "@/app/lib/siteName";

// Contextual nudge: the first time a signed-in mobile user opens the Matrix tab,
// offer the dedicated Matrix apps (Element etc.). Secondary to the PWA install —
// only surfaces here, on demand, once per browser. Listens for the
// `bb:matrix-opened` event ChatSidebar fires.

const DISMISSED_KEY = "bb_matrix_apps_hint";

export default function MatrixAppsHint() {
  const { matrixId } = useMatrixIdentity();
  const [show, setShow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    function onMatrixOpened() {
      if (lsGet(DISMISSED_KEY)) return;
      if (!matrixId) return; // signed-in only
      if (window.matchMedia?.(Q_POINTER_COARSE)?.matches !== true) return; // mobile only
      setShow(true);
    }
    window.addEventListener("bb:matrix-opened", onMatrixOpened);
    return () => window.removeEventListener("bb:matrix-opened", onMatrixOpened);
  }, [matrixId]);

  function dismiss() {
    lsSet(DISMISSED_KEY, "1");
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-(--z-nudge) p-3 pointer-events-none">
      <div
        className="pointer-events-auto mx-auto max-w-md rounded-xl glass modal-in pb-safe"
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-strong font-medium">Chat from your phone</p>
            <p className="text-2xs text-secondary leading-snug">
              Use {siteName()} in a Matrix app — your account works in any of them.
            </p>
          </div>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="shrink-0 px-2.5 py-1.5 text-xs font-semibold text-on-accent rounded-lg hover:brightness-110 transition-all"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {expanded ? "Hide" : "Show apps"}
          </button>
          <button onClick={dismiss} className="tap-hit-44 shrink-0 text-muted hover:text-strong text-sm px-1" aria-label="Dismiss">
            ✕
          </button>
        </div>
        {expanded && (
          <div className="px-3 pb-3 pt-2 max-h-[50vh] overflow-y-auto no-scrollbar border-t border-edge text-strong">
            <MatrixAppsList />
          </div>
        )}
      </div>
    </div>
  );
}
