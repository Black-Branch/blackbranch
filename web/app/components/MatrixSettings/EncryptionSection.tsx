"use client";

import type { MatrixSettingsState } from "@/app/lib/useMatrixSettings";
import { Spinner } from "../Spinner";
import { BootSequence } from "@/app/components/chrome";
import { MATRIX_READINESS_KEY } from "@/app/lib/MatrixClientContext";
import { FRESH_DEVICE_ACTION } from "@/app/lib/matrixDeviceKeys";

const MATRIX_BOOT = [MATRIX_READINESS_KEY] as const;

type Props = Pick<
  MatrixSettingsState,
  | "status"
  | "retry"
  | "crossSigningOk"
  | "hasCrossSigningKeys"
  | "flowState"
  | "backupActive"
  | "verifyPending"
  | "restoreResult"
  | "showRecoveryKey"
  | "setShowRecoveryKey"
  | "recoveryKeyInput"
  | "setRecoveryKeyInput"
  | "recoveryKeyVisible"
  | "setRecoveryKeyVisible"
  | "restoring"
  | "restoreProgress"
  | "restoreError"
  | "setRestoreError"
  | "restoreNeedsFreshDevice"
  | "startDeviceOver"
  | "applyRecoveryKey"
  | "dismissRecoveryKey"
  | "startFreshFromKeyError"
  | "showSetupFlow"
  | "setShowSetupFlow"
  | "setupStep"
  | "generatedKey"
  | "setupError"
  | "setSetupError"
  | "keyCopied"
  | "keyVisible"
  | "setKeyVisible"
  | "generateAndSetupEncryption"
  | "rotateRecoveryKey"
  | "finishSetup"
  | "copyKey"
  | "resetApprovalUrl"
  | "dismissResetApproval"
>;

function KeyDisplay({
  generatedKey,
  keyVisible,
  setKeyVisible,
  keyCopied,
  copyKey,
  finishSetup,
  isNew,
}: {
  generatedKey: string;
  keyVisible: boolean;
  setKeyVisible: (v: boolean) => void;
  keyCopied: boolean;
  copyKey: () => Promise<void>;
  finishSetup: () => Promise<void>;
  isNew: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-green-400 font-medium">
        {isNew ? "Encryption set up!" : "New recovery key generated"}
      </p>
      <p className="text-3xs text-secondary leading-relaxed">
        {isNew
          ? "Save this recovery key somewhere safe (a password manager is ideal). It's the only way to verify a new browser or phone and restore your encrypted history — if you lose it and lose your verified devices, that history is gone for good."
          : "Save this recovery key in your password manager. Your existing verifications are unchanged."}
      </p>
      <div className="bg-scrim border border-edge rounded-lg px-2.5 py-2 font-mono text-3xs break-all leading-relaxed relative">
        {keyVisible ? (
          <span className="text-body select-all">{generatedKey}</span>
        ) : (
          <span className="text-muted select-none tracking-widest">{"•".repeat(32)}</span>
        )}
        <button
          onClick={() => setKeyVisible(!keyVisible)}
          className="absolute top-1.5 right-1.5 text-3xs px-1.5 py-0.5 rounded bg-surface-2 hover:bg-surface-3 text-muted hover:text-body-dim transition-colors"
        >
          {keyVisible ? "Hide" : "Show"}
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={copyKey}
          className="flex-1 text-xs py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-edge text-body transition-colors"
        >
          {keyCopied ? "Copied!" : "Copy key"}
        </button>
        <button
          onClick={finishSetup}
          className="flex-1 text-xs py-1.5 rounded-lg bg-green-400/15 hover:bg-green-400/25 border border-green-400/25 text-green-300 transition-colors"
        >
          I&apos;ve saved it
        </button>
      </div>
    </div>
  );
}

export function EncryptionSection(p: Props) {
  if (p.crossSigningOk === null) {
    return (
      <div className="px-3 py-2.5 border-b border-edge">
        <p className="text-3xs uppercase tracking-wide text-muted mb-2">Encryption</p>
        {p.status === "ready" ? (
          <p className="text-xs text-muted">Checking…</p>
        ) : (
          // The spoken warmup: the client's own stages, with the retry, in
          // place of a bare "Not connected".
          <BootSequence keys={MATRIX_BOOT} label="Connecting to Matrix" onRetry={p.retry} compact />
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2.5 border-b border-edge">
      <p className="text-3xs uppercase tracking-wide text-muted mb-2">Encryption</p>

      {p.crossSigningOk ? (
        // ── Verified branch ────────────────────────────────────────────────
        p.setupStep === "show_key" ? (
          <KeyDisplay
            generatedKey={p.generatedKey}
            keyVisible={p.keyVisible}
            setKeyVisible={p.setKeyVisible}
            keyCopied={p.keyCopied}
            copyKey={p.copyKey}
            finishSetup={p.finishSetup}
            isNew={false}
          />
        ) : p.showSetupFlow ? (
          <div className="space-y-2">
            {!p.setupError ? (
              <>
                <p className="text-3xs text-secondary leading-relaxed">
                  This generates a new recovery key and re-encrypts your secrets. Device verifications are{" "}
                  <span className="text-body">not affected</span>.
                </p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => p.rotateRecoveryKey()}
                    disabled={p.setupStep === "generating"}
                    className="flex-1 text-xs py-1.5 rounded-lg bg-yellow-400/20 hover:bg-yellow-400/30 border border-yellow-400/30 text-yellow-200 transition-colors disabled:opacity-40"
                  >
                    {p.setupStep === "generating" ? "Generating…" : "Generate new key"}
                  </button>
                  <button
                    onClick={() => { p.setShowSetupFlow(false); p.setSetupError(null); }}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-3xs text-yellow-400/80">{p.setupError}</p>
                <button
                  onClick={() => { p.setShowSetupFlow(false); p.setSetupError(null); }}
                  className="w-full text-3xs text-muted hover:text-secondary transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xs text-green-400 mb-1">This device is verified</p>
            {p.restoreResult && <p className="text-3xs text-secondary">{p.restoreResult}</p>}
            {p.backupActive === false && (
              <p className="text-3xs text-yellow-400/80 mt-1 leading-relaxed">
                No recovery key saved — you won&apos;t be able to verify a new browser without one.
              </p>
            )}
            <button
              onClick={() => p.setShowSetupFlow(true)}
              className="mt-2 text-3xs text-muted hover:text-secondary transition-colors"
            >
              {p.backupActive === false ? "Generate a recovery key →" : "Rotate recovery key →"}
            </button>
          </div>
        )
      ) : (
        // ── Unverified branch ──────────────────────────────────────────────
        p.resetApprovalUrl ? (
          // MSC4312 consent: the server holds the reset until the user
          // approves it on their account page. Nothing has changed yet —
          // "Try again" re-runs the reset, which succeeds once approved.
          <div className="space-y-2">
            <p className="text-xs text-yellow-300 font-medium">One more step</p>
            <p className="text-3xs text-secondary leading-relaxed">
              For your security, replacing encryption keys needs your approval on your account
              page. Approve it there, then come back and try again.
            </p>
            <div className="flex gap-1.5">
              <a
                href={p.resetApprovalUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-1 text-center text-xs py-1.5 rounded-lg bg-yellow-400/20 hover:bg-yellow-400/30 border border-yellow-400/30 text-yellow-200 transition-colors"
              >
                Open account page
              </a>
              <button
                onClick={() => { p.dismissResetApproval(); p.generateAndSetupEncryption(true); }}
                disabled={p.setupStep === "generating"}
                className="flex-1 text-xs py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors disabled:opacity-40"
              >
                {p.setupStep === "generating" ? "Resetting…" : "I've approved — try again"}
              </button>
            </div>
            <button
              onClick={() => p.dismissResetApproval()}
              className="w-full text-3xs text-muted hover:text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : p.setupStep === "show_key" ? (
          <KeyDisplay
            generatedKey={p.generatedKey}
            keyVisible={p.keyVisible}
            setKeyVisible={p.setKeyVisible}
            keyCopied={p.keyCopied}
            copyKey={p.copyKey}
            finishSetup={p.finishSetup}
            isNew
          />
        ) : p.showSetupFlow ? (
          <div className="space-y-2">
            {!p.setupError ? (
              p.flowState === "setup" ? (
                <>
                  <p className="text-3xs text-secondary leading-relaxed">
                    This will create new cross-signing keys and a recovery key for your account.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => p.generateAndSetupEncryption(false)}
                      disabled={p.setupStep === "generating"}
                      className="flex-1 text-xs py-1.5 rounded-lg bg-yellow-400/20 hover:bg-yellow-400/30 border border-yellow-400/30 text-yellow-200 transition-colors disabled:opacity-40"
                    >
                      {p.setupStep === "generating" ? "Setting up…" : "Set up encryption"}
                    </button>
                    <button
                      onClick={() => { p.setShowSetupFlow(false); p.setSetupError(null); }}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                // Reached from "Lost your recovery key?" — the account HAS an
                // identity, so the honest offer is the reset with its cost
                // stated, never a "set up" that would hit the second-identity
                // guard and error its way here.
                <>
                  <p className="text-3xs text-secondary leading-relaxed">
                    Without your recovery key this device can&apos;t restore the old encryption.
                    Starting fresh replaces your encryption keys — previously encrypted messages
                    will stay unreadable, and your other devices will need verifying again.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => { p.setSetupError(null); p.generateAndSetupEncryption(true); }}
                      disabled={p.setupStep === "generating"}
                      className="flex-1 text-xs py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors disabled:opacity-40"
                    >
                      {p.setupStep === "generating" ? "Resetting…" : "Start fresh"}
                    </button>
                    <button
                      onClick={() => { p.setShowSetupFlow(false); p.setSetupError(null); }}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )
            ) : (
              <>
                <p className="text-3xs text-yellow-400/80">{p.setupError}</p>
                <p className="text-3xs text-secondary leading-relaxed">
                  If you have it saved, enter your recovery key instead. Or start fresh — this will
                  replace your old encryption keys. Any previously encrypted messages will become
                  unreadable.
                </p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      p.setShowSetupFlow(false);
                      p.setSetupError(null);
                      p.setShowRecoveryKey(true);
                    }}
                    className="flex-1 text-xs py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-edge text-body transition-colors"
                  >
                    Enter recovery key
                  </button>
                  <button
                    onClick={() => { p.setSetupError(null); p.generateAndSetupEncryption(true); }}
                    disabled={p.setupStep === "generating"}
                    className="flex-1 text-xs py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors disabled:opacity-40"
                  >
                    {p.setupStep === "generating" ? "Resetting…" : "Start fresh"}
                  </button>
                </div>
                <button
                  onClick={() => { p.setShowSetupFlow(false); p.setSetupError(null); }}
                  className="w-full text-3xs text-muted hover:text-secondary transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : p.flowState === "orphaned" ? (
          // 4S exists but the server has no published identity — a previous
          // setup was interrupted. The saved recovery key unlocks an identity
          // the server never received, so the only way forward is a reset.
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-yellow-400 text-sm">⚠</span>
              <p className="text-xs text-yellow-300 font-medium">Encryption needs a reset</p>
            </div>
            <p className="text-3xs text-secondary leading-relaxed">
              A previous encryption setup didn&apos;t complete, so your saved recovery key can&apos;t
              work. Start fresh to create new keys — previously encrypted messages will stay
              unreadable.
            </p>
            {p.setupError && <p className="text-3xs text-yellow-400/80">{p.setupError}</p>}
            <button
              onClick={() => { p.setSetupError(null); p.generateAndSetupEncryption(true); }}
              disabled={p.setupStep === "generating"}
              className="w-full text-xs py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors disabled:opacity-40"
            >
              {p.setupStep === "generating" ? "Resetting…" : "Start fresh"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {p.verifyPending ? (
              <div className="flex items-center gap-2 py-0.5">
                <Spinner />
                <p className="text-xs text-body-dim">{p.restoreResult ?? "Confirming verification…"}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-yellow-400 text-sm">⚠</span>
                  <p className="text-xs text-yellow-300 font-medium">
                    {p.flowState === "setup" ? "Encryption not set up" : "Device not verified"}
                  </p>
                </div>
                <p className="text-3xs text-secondary leading-relaxed">
                  {p.flowState === "setup"
                    ? "Encryption isn't set up on this account yet."
                    : "Paste your recovery key to verify this browser session and restore encrypted messages — or verify from one of your other devices."}
                </p>

                {/* A restore whose verification never landed. Rendered HERE,
                    outside the key-entry panel: applyRecoveryKey closes that
                    panel on its way out, so an error shown only inside it would
                    be an error nobody sees. */}
                {p.restoreNeedsFreshDevice && p.restoreError && (
                  <div className="space-y-1.5">
                    <p className="text-3xs text-red-400 leading-relaxed">{p.restoreError}</p>
                    <button
                      onClick={p.startDeviceOver}
                      className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-red-300 transition-colors"
                    >
                      {FRESH_DEVICE_ACTION} →
                    </button>
                  </div>
                )}

                {!p.showRecoveryKey ? (
                  <div className="space-y-1.5">
                    {p.flowState !== "setup" && (
                      <>
                        <button
                          onClick={() => p.setShowRecoveryKey(true)}
                          className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-yellow-400/10 hover:bg-yellow-400/20 border border-yellow-400/30 text-yellow-300 transition-colors"
                        >
                          Enter recovery key
                        </button>
                        {/* The reset must be reachable WITHOUT a key: gating
                            "Start fresh" behind a typed key's mismatch error
                            would dead-end exactly the person a reset exists for.
                            Restore stays the loud default; this is the quiet way out. */}
                        <button
                          onClick={() => { p.setRestoreError(null); p.setShowSetupFlow(true); }}
                          className="w-full text-3xs text-muted hover:text-secondary transition-colors"
                        >
                          Lost your recovery key? Start fresh →
                        </button>
                      </>
                    )}
                    {p.flowState === "setup" && (
                      <button
                        onClick={() => p.setShowSetupFlow(true)}
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-yellow-400/10 hover:bg-yellow-400/20 border border-yellow-400/30 text-yellow-300 transition-colors"
                      >
                        Set up encryption →
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="relative">
                      <input
                        type={p.recoveryKeyVisible ? "text" : "password"}
                        value={p.recoveryKeyInput}
                        onChange={(e) => {
                          p.setRecoveryKeyInput(e.target.value);
                          p.setRestoreError(null);
                        }}
                        onPaste={() => p.setRecoveryKeyVisible(false)}
                        placeholder="EsT6 2bX9 ..."
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full bg-surface-2 border border-edge rounded-lg text-xs text-strong placeholder-faint px-2.5 py-2 pr-12 outline-none focus:border-edge-strong font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => p.setRecoveryKeyVisible(!p.recoveryKeyVisible)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-3xs px-1.5 py-0.5 rounded bg-surface-2 hover:bg-surface-3 text-muted hover:text-body-dim transition-colors"
                      >
                        {p.recoveryKeyVisible ? "Hide" : "Show"}
                      </button>
                    </div>
                    {p.restoreError && (
                      <>
                        <p className="text-3xs text-red-400">{p.restoreError}</p>
                        {(p.restoreError.includes("doesn't match") ||
                          p.restoreError.includes("bad MAC")) && (
                          <button
                            onClick={p.startFreshFromKeyError}
                            className="text-3xs text-muted hover:text-secondary transition-colors"
                          >
                            Key won&apos;t work? Start fresh →
                          </button>
                        )}
                      </>
                    )}
                    {p.restoreProgress && (
                      <p className="text-3xs text-secondary">
                        Importing… {p.restoreProgress.imported} / {p.restoreProgress.total}
                      </p>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        onClick={p.applyRecoveryKey}
                        disabled={p.restoring || !p.recoveryKeyInput.trim()}
                        className="flex-1 text-xs py-1.5 rounded-lg bg-yellow-400/20 hover:bg-yellow-400/30 border border-yellow-400/30 text-yellow-200 transition-colors disabled:opacity-40"
                      >
                        {p.restoring ? "Verifying…" : "Verify this device"}
                      </button>
                      <button
                        onClick={p.dismissRecoveryKey}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {p.restoreResult && (
                  <p className="text-3xs text-secondary">{p.restoreResult}</p>
                )}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
