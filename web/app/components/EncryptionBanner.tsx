"use client";

import { useState } from "react";
import type { EncryptionVerdict } from "@/app/lib/encryptionMemory";

// The community timeline's line above a DM's messages: "Not encrypted" (with Enable), or
// "Session unverified" while this device is not cross-signed.
//
// It reads the APP-WIDE verdict (useEncryptionStatus, which the caller passes in), available
// synchronously from the first render — the remembered verdict before Matrix has checked — so for
// anyone whose verdict was ever seen the line is decided in the first render, never a late
// insertion that pushes the messages down (dm-crypto-research D, client polish Task 11).
// It warns only on "red" — THIS device is not cross-signed (the old per-room check's question).
// "yellow" is this device verified while another of the account's devices is not (Devices &
// Security's broadcast): nothing to say in a conversation. An unknown verdict shows nothing
// rather than holding an empty box that would then collapse under the messages.

export function EncryptionBanner({ encrypted, verdict, onEnable }: {
  encrypted: boolean;
  verdict: EncryptionVerdict;
  /** Turn encryption on for this room. */
  onEnable: () => Promise<void>;
}) {
  const [enabling, setEnabling] = useState(false);
  const box = "mx-2 mt-1 h-7 px-3 rounded-md flex items-center gap-2 text-xs";

  if (!encrypted) {
    return (
      <div data-encryption-banner="" className={`${box} bg-raised/60 text-secondary`}>
        <span>🔓</span>
        <span className="flex-1">Not encrypted</span>
        <button
          onClick={() => { setEnabling(true); void onEnable().finally(() => setEnabling(false)); }}
          disabled={enabling}
          className="text-body-dim hover:text-strong underline disabled:opacity-50"
        >
          {enabling ? "Enabling…" : "Enable E2EE"}
        </button>
      </div>
    );
  }

  if (verdict !== "red") return null;

  return (
    <div data-encryption-banner="" className={`${box} bg-yellow-900/20 border border-yellow-700/30 text-yellow-400/80`}>
      <span>⚠️</span>
      <span className="truncate">Session unverified — open Devices &amp; Security to verify</span>
    </div>
  );
}
