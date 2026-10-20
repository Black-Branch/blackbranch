"use client";

import type { MatrixSettingsState } from "@/app/lib/useMatrixSettings";
import { Spinner } from "../Spinner";

type Props = Pick<
  MatrixSettingsState,
  | "verifyPhase"
  | "verifyPeer"
  | "sasEmoji"
  | "acceptIncoming"
  | "declineVerify"
  | "confirmSas"
  | "mismatchSas"
>;

export function VerificationSection(p: Props) {
  return (
    <div className="px-3 py-2.5 border-b border-edge">
      <p className="text-3xs uppercase tracking-wide text-muted mb-2">Verification</p>

      {p.verifyPhase === "incoming" && (
        <div className="space-y-2">
          <p className="text-xs text-body font-medium">Verification request</p>
          <p className="text-3xs text-secondary leading-relaxed">
            {p.verifyPeer} wants to verify this session.
          </p>
          <div className="flex gap-1.5">
            <button
              onClick={p.acceptIncoming}
              className="flex-1 text-xs py-1.5 rounded-lg bg-green-400/15 hover:bg-green-400/25 border border-green-400/25 text-green-300 transition-colors"
            >
              Accept
            </button>
            <button
              onClick={p.declineVerify}
              className="flex-1 text-xs py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary transition-colors"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {p.verifyPhase === "outgoing" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-xs text-body-dim">Waiting for {p.verifyPeer} to accept…</p>
          </div>
          <button
            onClick={p.declineVerify}
            className="text-3xs text-muted hover:text-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {p.verifyPhase === "sas" && !p.sasEmoji && (
        <div className="flex items-center gap-2 py-0.5">
          <Spinner />
          <p className="text-xs text-body-dim">Generating verification codes…</p>
        </div>
      )}

      {p.verifyPhase === "sas" && p.sasEmoji && (
        <div className="space-y-2">
          <p className="text-xs text-body font-medium">Do these match on {p.verifyPeer}?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {p.sasEmoji.map(([emojiChar, emojiName], i) => (
              <div
                key={i}
                className="flex flex-col items-center bg-surface-1 rounded-lg py-1.5 px-1 gap-0.5"
              >
                <span className="text-lg leading-none">{emojiChar}</span>
                <span className="text-3xs text-muted text-center leading-tight">
                  {emojiName}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={p.confirmSas}
              className="flex-1 text-xs py-1.5 rounded-lg bg-green-400/15 hover:bg-green-400/25 border border-green-400/25 text-green-300 transition-colors"
            >
              They match ✓
            </button>
            <button
              onClick={p.mismatchSas}
              className="flex-1 text-xs py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors"
            >
              Don&apos;t match
            </button>
          </div>
        </div>
      )}

      {p.verifyPhase === "waiting" && (
        <div className="flex items-center gap-2 py-0.5">
          <Spinner />
          <p className="text-xs text-body-dim">Waiting for {p.verifyPeer} to confirm…</p>
        </div>
      )}

      {p.verifyPhase === "done" && (
        <p className="text-xs text-green-400">Verification complete!</p>
      )}
      {p.verifyPhase === "cancelled" && (
        <p className="text-xs text-secondary">Verification cancelled.</p>
      )}
      {p.verifyPhase === "error" && (
        <p className="text-xs text-red-400">Verification failed. Try again.</p>
      )}
    </div>
  );
}
