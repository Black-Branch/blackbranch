"use client";

import { useMatrixSettings } from "@/app/lib/useMatrixSettings";
import { useStartMatrixClient } from "@/app/lib/MatrixClientContext";
import MatrixOnboarding from "@/app/components/MatrixOnboarding";
import { EncryptionSection } from "./MatrixSettings/EncryptionSection";
import { VerificationSection } from "./MatrixSettings/VerificationSection";
import { DeviceSection } from "./MatrixSettings/DeviceSection";

export default function MatrixSettings({
  onEncryptionChange,
}: {
  onEncryptionChange?: (status: "green" | "yellow" | "red") => void;
}) {
  // The other place the client is legitimately wanted without the community
  // being open: Devices & Security is *about* the Matrix session, so opening it
  // is intent. This panel is lazily imported by AccountCard, so mounting it
  // means the user actually navigated here.
  useStartMatrixClient();
  const state = useMatrixSettings({ onEncryptionChange });

  return (
    <div className="text-strong w-full">
      <MatrixOnboarding />
      <EncryptionSection {...state} />
      {state.verifyPhase !== "idle" && <VerificationSection {...state} />}
      <DeviceSection {...state} />
    </div>
  );
}
