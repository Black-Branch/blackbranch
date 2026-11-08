"use client";

// Person-to-person verification: another person's request (or our own, started from their member
// card) shown where the person is, not only in Settings. "<name> wants to verify you · Accept ·
// Decline" → the 7 emoji with "They match" / "They don't match" → "You verified <name>" or
// "Verification cancelled". The SAS itself is useMatrixVerification's, the same flow Settings runs
// for your own devices; this window only takes the requests of the other kind ("user").

import { useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import type { MatrixClient } from "matrix-js-sdk";
import { Window } from "@/app/components/chrome";
import { getActiveTarget } from "@/app/lib/chrome/windowLayer";
import { useMatrixVerification } from "@/app/lib/useMatrixVerification";
import { useTimers } from "@/app/lib/matrixCrypto";
import { Spinner } from "./Spinner";

const accept = "flex-1 text-xs py-1.5 rounded-lg bg-green-400/15 hover:bg-green-400/25 border border-green-400/25 text-green-300 transition-colors";
const quiet = "flex-1 text-xs py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary transition-colors";
const refuse = "flex-1 text-xs py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors";

export default function UserVerificationWindow({ client, pendingVerification, clearPendingVerification }: {
  client: MatrixClient | null;
  pendingVerification: unknown;
  clearPendingVerification: () => void;
}) {
  const schedule = useTimers();
  const v = useMatrixVerification({
    client, kind: "user", pendingVerification, clearPendingVerification,
    checkCrossSigningStatus: async () => {}, schedule,
  });
  if (v.verifyPhase === "idle") return null;
  return <Shown v={v} />;
}

/** The window, mounted when a request shows (so its placement follows where the person is then). */
function Shown({ v }: { v: ReturnType<typeof useMatrixVerification> }) {
  // A panel in the active pane when there is one (it sits above the chat the person is in), a
  // floating card otherwise — decided when it shows, as the announcement does.
  const [presentation] = useState<"panel" | "floating">(() => {
    const layer = getActiveTarget();
    return layer && layer.offsetWidth > 0 && layer.offsetHeight > 0 ? "panel" : "floating";
  });
  const name = v.verifyPeer;
  const open = v.verifyPhase === "incoming" || v.verifyPhase === "outgoing" || v.verifyPhase === "sas" || v.verifyPhase === "waiting";

  return (
    <Window
      presentation={presentation}
      kind="peek"
      name="Verification"
      mark={<ShieldCheck size={14} weight="bold" />}
      title="Verification"
      defaultSize={{ w: 340, h: 240 }}
      fitHeight
      // Closing an open request declines it, so the other side is not left waiting; closing a
      // finished one (done, cancelled, failed) just dismisses it.
      onClose={() => { if (open) void v.declineVerify(); else v.dismissVerify(); }}
    >
      <div className="flex flex-col gap-2 p-3" data-verification={v.verifyPhase}>
        {/* The user id at every step: a display name is free text, and anyone can take another
            member's. */}
        <p className="text-3xs text-muted break-all" data-peer-id>{v.verifyPeerId}</p>
        {v.verifyPhase === "incoming" && (
          <>
            <p className="text-sm text-body">{name} wants to verify you</p>
            <p className="text-3xs text-secondary leading-relaxed">
              You&apos;ll both see the same emoji. If they match, you can trust that messages with {name} are really theirs.
            </p>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => void v.acceptIncoming()} className={accept}>Accept</button>
              <button type="button" onClick={() => void v.declineVerify()} className={quiet}>Decline</button>
            </div>
          </>
        )}

        {v.verifyPhase === "outgoing" && (
          <>
            <div className="flex items-center gap-2">
              <Spinner />
              <p className="text-xs text-body-dim">Waiting for {name} to accept…</p>
            </div>
            <button type="button" onClick={() => void v.declineVerify()} className="text-3xs text-muted hover:text-secondary transition-colors self-start">
              Cancel
            </button>
          </>
        )}

        {v.verifyPhase === "sas" && !v.sasEmoji && (
          <div className="flex items-center gap-2 py-0.5">
            <Spinner />
            <p className="text-xs text-body-dim">Getting the emoji…</p>
          </div>
        )}

        {v.verifyPhase === "sas" && v.sasEmoji && (
          <>
            <p className="text-xs text-body">Do these match what {name} sees?</p>
            <div className="grid grid-cols-4 gap-1.5">
              {v.sasEmoji.map(([emoji, label], i) => (
                <div key={i} className="flex flex-col items-center bg-surface-1 rounded-lg py-1.5 px-1 gap-0.5">
                  <span className="text-lg leading-none">{emoji}</span>
                  <span className="text-3xs text-muted text-center leading-tight">{label}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => void v.confirmSas()} className={accept}>They match</button>
              <button type="button" onClick={() => void v.mismatchSas()} className={refuse}>They don&apos;t match</button>
            </div>
          </>
        )}

        {v.verifyPhase === "waiting" && (
          <div className="flex items-center gap-2 py-0.5">
            <Spinner />
            <p className="text-xs text-body-dim">Waiting for {name} to confirm…</p>
          </div>
        )}

        {v.verifyPhase === "done" && <p className="text-xs text-green-400">You verified {name}</p>}
        {v.verifyPhase === "cancelled" && <p className="text-xs text-secondary">Verification cancelled</p>}
        {v.verifyPhase === "error" && <p className="text-xs text-red-400">Verification failed. Try again.</p>}
      </div>
    </Window>
  );
}
